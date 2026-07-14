import { Collection, Db, MongoClient, ObjectId } from 'mongodb';

import { createLogger } from './log';
import { createError } from './helpers';
import { config } from './config';
import { ContainerCache } from './database/container-cache';
import { ContentRepository } from './database/content-repository';
import { VolumeRepository, type VolumeVerifyErrors } from './database/volume-repository';
import { RuntimeConfigRepository } from './database/runtime-config';
import { FaultRepository, type FaultDocument, type FaultUpsert } from './database/fault-repository';
import { StorageStatsRepository } from './database/storage-stats-repository';
import { AdminTokenRepository, type AdminTokenDocument } from './database/admin-token-repository';
import { CredentialRepository, type CredentialDocument, type Grant } from './database/credential-repository';
import type { ContainerPath, ContentDocument, ObjectIdentifier, ObjectVerificationStateUpdate, SliceErrorInfo } from './database/types';
import type { StorageStatsDelta, StorageStatsSnapshot } from './storage/stats';

// The bracket around a volume-table restore. Present means the table is half-written and must not be
// believed; absent means it is whole.
const FLEET_RESTORE_MARKER = 'fleet-restore-in-progress';

// THE NAMESPACE IS NOT BACK YET, AND NOTHING MAY ACT AS THOUGH IT IS.
//
// Recovering the FLEET gets the disks mounted. It does not put a single name back -- Mongo is still empty, and
// the 3.5M objects on the platters are still anonymous. If STRUBS then starts normally on that empty database,
// the snapshot job wakes up, snapshots the nothing it can see, and MOVES THE MANIFEST POINTER to it. The real
// snapshot -- the one holding every name on the array -- is still sitting on the platters, and nothing alive
// knows where. The recovery system would have destroyed the namespace it exists to restore.
//
// So the fleet restore raises this, and only a successful namespace restore lowers it.
const NAMESPACE_RESTORE_MARKER = 'namespace-restore-required';

// A NAMESPACE RESTORE IN FLIGHT.
//
// The restore refuses to apply into a database that already holds objects -- which is right, because doing so
// would overwrite a live namespace with one rebuilt from a snapshot. But it writes CONTAINERS first and objects
// second, so a crash after the very first container leaves a database that is no longer empty and a restore
// that will now refuse to finish what it started. The operator is left with a namespace that is 0.001% restored
// and a tool that will not touch it.
//
// So the restore brackets itself, exactly as the fleet restore does: while this marker is up, a non-empty
// database is not a live array to be protected, it is this restore's own half-finished work, and re-running is
// not an overwrite -- it is a RESUME.
const NAMESPACE_RESTORE_IN_FLIGHT = 'namespace-restore-in-flight';
export type { ContentDocument, ObjectVerificationStateUpdate, SliceErrorInfo, SliceErrorCategory, SliceVerificationTimes } from './database/types';
export type { CredentialDocument, Grant } from './database/credential-repository';
export type { FaultDocument, FaultUpsert } from './database/fault-repository';
export type { StorageStatsDelta, StorageStatsSnapshot } from './storage/stats';

const log = createLogger('database');

export class Database {
    private _client: MongoClient | null = null;
    private _db: Db | null = null;
    private _collections: {
        volumes: Collection<any> | null;
        content: Collection<ContentDocument> | null;
        runtimeConfig: Collection<{ key: string; value: unknown }> | null;
        faults: Collection<FaultDocument> | null;
        storageStats: Collection<any> | null;
        adminTokens: Collection<AdminTokenDocument> | null;
        credentials: Collection<CredentialDocument> | null;
    } = {
        volumes: null,
        content: null,
        runtimeConfig: null,
        faults: null,
        storageStats: null,
        adminTokens: null,
        credentials: null
    };
    private readonly _containerCache = new ContainerCache();
    private _repositories: {
        volumes: VolumeRepository | null;
        content: ContentRepository | null;
        runtimeConfig: RuntimeConfigRepository | null;
        faults: FaultRepository | null;
        storageStats: StorageStatsRepository | null;
        adminTokens: AdminTokenRepository | null;
        credentials: CredentialRepository | null;
    } = {
        volumes: null,
        content: null,
        runtimeConfig: null,
        faults: null,
        storageStats: null,
        adminTokens: null,
        credentials: null
    };

    constructor() {
        setInterval(() => this._cleanObjectCache(), 60000);
    }

    async connect(): Promise<void> {
        try {
            log('connecting to database');

            this._client = await MongoClient.connect(config.mongoUrl);

            this._db = this._client.db('strubs');

            this._collections.volumes = this._db.collection('volumes');
            this._collections.content = this._db.collection('content');
            this._collections.runtimeConfig = this._db.collection('runtimeConfig');
            this._collections.faults = this._db.collection('faults');
            this._collections.storageStats = this._db.collection('storageStats');
            this._collections.adminTokens = this._db.collection('adminTokens');
            this._collections.credentials = this._db.collection('credentials');
            this._repositories = {
                volumes: new VolumeRepository(this._collections.volumes),
                content: new ContentRepository(
                    this._collections.content,
                    this._containerCache,
                    this._normalizeObject.bind(this),
                    this.getMongoId.bind(this),
                    // Lazily resolved: the journal lives in the io layer and reaches back for the fleet's
                    // mount points, so importing it at module scope here would close a cycle.
                    async record => {
                        const { journal } = require('./io/journal') as typeof import('./io/journal');
                        await journal.append({ op: 'container', ts: new Date().toISOString(), ...record });
                    },
                    async id => {
                        const { journal } = require('./io/journal') as typeof import('./io/journal');
                        await journal.append({ op: 'del', ts: new Date().toISOString(), id });
                    }
                ),
                runtimeConfig: new RuntimeConfigRepository(this._collections.runtimeConfig),
                faults: new FaultRepository(this._collections.faults),
                storageStats: new StorageStatsRepository(this._collections.storageStats),
                adminTokens: new AdminTokenRepository(this._collections.adminTokens),
                credentials: new CredentialRepository(this._collections.credentials)
            };
            await this.ensureContentIndexes();
            await this.ensureFaultIndexes();
            await this.ensureRuntimeConfigIndexes();
            await this.adminTokenRepository.ensureIndexes();
            await this.credentialRepository.ensureIndexes();

            log('connected');
        }
        catch (err) {
            throw createError('DBFAIL', 'failed to connect to database', err as Error);
        }
    }

    async getVolumes(): Promise<any[]> {
        return this.volumeRepository.getVolumes();
    }

    async deleteVolume(id: number): Promise<void> {
        await this.volumeRepository.deleteVolume(id);
    }

    async softDeleteVolume(id: number): Promise<void> {
        await this.volumeRepository.softDeleteVolume(id);
    }

    async setVolumePendingSectorHighWater(id: number, count: number): Promise<void> {
        await this.volumeRepository.setPendingSectorHighWater(id, count);
    }

    async updateVolumeFlags(id: number, changes: { isEnabled?: boolean; isReadOnly?: boolean; isDeleted?: boolean; isHealthy?: boolean; isDraining?: boolean; label?: string | null; comment?: string | null }): Promise<void> {
        await this.volumeRepository.updateVolumeFlags(id, changes);
    }

    async createVolume(volumeConfig: any): Promise<void> {
        await this.volumeRepository.createVolume(volumeConfig);
    }

    async setVolumeVerifyErrors(id: number, errors: VolumeVerifyErrors | null): Promise<void> {
        await this.volumeRepository.setVerifyErrors(id, errors);
    }

    async createObjectRecord(object: ContentDocument & { id: string; containerId?: ObjectIdentifier }): Promise<void> {
        await this.contentRepository.createObjectRecord(object);
    }

    async getRuntimeConfig(key: string): Promise<unknown> {
        return this.runtimeConfigRepository.get(key);
    }

    async setRuntimeConfig(key: string, value: unknown): Promise<void> {
        await this.runtimeConfigRepository.set(key, value);
    }

    // Atomic create-if-absent. True if THIS caller created it. See the repository for why the LUKS recovery
    // verifier cannot use the read-then-set pattern.
    async setRuntimeConfigIfAbsent(key: string, value: unknown): Promise<boolean> {
        return this.runtimeConfigRepository.setIfAbsent(key, value);
    }

    // Whether setRuntimeConfigIfAbsent() is genuinely exclusive -- i.e. whether the unique index exists. Index
    // creation is non-fatal, so this is a question, not an assumption.
    async runtimeConfigKeyIsUnique(): Promise<boolean> {
        return this.runtimeConfigRepository.keyIsUnique();
    }

    async deleteRuntimeConfig(key: string): Promise<void> {
        await this.runtimeConfigRepository.delete(key);
    }

    async createAdminToken(doc: { selector: string; secretHash: string; name: string }): Promise<void> {
        await this.adminTokenRepository.create(doc);
    }

    async getAdminTokenBySelector(selector: string): Promise<AdminTokenDocument | null> {
        return this.adminTokenRepository.getBySelector(selector);
    }

    async touchAdminToken(selector: string): Promise<void> {
        await this.adminTokenRepository.touch(selector);
    }

    async listAdminTokens(): Promise<AdminTokenDocument[]> {
        return this.adminTokenRepository.list();
    }

    async setAdminTokenDisabled(selector: string, disabled: boolean): Promise<boolean> {
        return this.adminTokenRepository.setDisabled(selector, disabled);
    }

    async removeAdminToken(selector: string): Promise<boolean> {
        return this.adminTokenRepository.remove(selector);
    }

    async removeAllAdminTokens(): Promise<number> {
        return this.adminTokenRepository.removeAll();
    }

    // --- object-API credentials ---

    async createCredential(doc: CredentialDocument): Promise<void> {
        await this.credentialRepository.create(doc);
    }

    async getCredentialByAccessKeyId(accessKeyId: string): Promise<CredentialDocument | null> {
        return this.credentialRepository.getByAccessKeyId(accessKeyId);
    }

    async listCredentials(): Promise<CredentialDocument[]> {
        return this.credentialRepository.list();
    }

    async setCredentialEnabled(accessKeyId: string, enabled: boolean): Promise<boolean> {
        return this.credentialRepository.setEnabled(accessKeyId, enabled);
    }

    async setCredentialGrants(accessKeyId: string, grants: Grant[]): Promise<boolean> {
        return this.credentialRepository.setGrants(accessKeyId, grants);
    }

    async setCredentialSecretHash(accessKeyId: string, secretHash: string): Promise<boolean> {
        return this.credentialRepository.setSecretHash(accessKeyId, secretHash);
    }

    async touchCredential(accessKeyId: string, when: Date): Promise<void> {
        await this.credentialRepository.touch(accessKeyId, when);
    }

    async removeCredential(accessKeyId: string): Promise<boolean> {
        return this.credentialRepository.remove(accessKeyId);
    }

    // --- buckets ---

    async getBucketByName(name: string): Promise<ContentDocument | null> {
        return this.contentRepository.getBucketByName(name);
    }

    async getBucketById(id: ObjectIdentifier): Promise<ContentDocument | null> {
        return this.contentRepository.getBucketById(id);
    }

    async listBuckets(): Promise<ContentDocument[]> {
        return this.contentRepository.listBuckets();
    }

    async listAllContainers(): Promise<Array<{ id: string; cid: string | null; name: string }>> {
        return this.contentRepository.listAllContainers();
    }

    async restoreContainer(r: { id: string; cid: string | null; name: string; bucketId: string | null; pr?: boolean; pw?: boolean }): Promise<void> {
        return this.contentRepository.restoreContainer(r);
    }

    async restoreObject(r: Record<string, unknown>): Promise<void> {
        return this.contentRepository.restoreObject(r);
    }

    streamAllObjects(): AsyncIterable<{ id: string; cid: string | null; name: string; mime?: string | null; md5?: string | null; size: number; cs: number }> {
        return this.contentRepository.streamAllObjects();
    }

    streamAllObjectIds(): AsyncIterable<string> {
        return this.contentRepository.streamAllObjectIds();
    }

    async countObjects(): Promise<number> {
        return this.contentRepository.countObjects();
    }

    async pruneOutsideNamespace(keep: Set<string>): Promise<number> {
        return this.contentRepository.pruneOutsideNamespace(keep);
    }

    // Write the volume table back, from a bootstrap manifest, on a bare host. Upserted by id so an
    // interrupted recovery can simply be run again -- which is a property you want from the one tool whose
    // entire job is to work when everything else has failed.
    //
    // A HALF-WRITTEN VOLUME TABLE IS WORSE THAN NO VOLUME TABLE, and this writes 30 documents one at a time.
    // Die after 11 of them and Mongo now holds a table that is perfectly well-formed, internally consistent,
    // and describes an array a third the size of the real one. Start STRUBS on it and the missing 19 disks are
    // not "unmounted" -- they are UNKNOWN, so nothing refuses on their behalf, the platter scans never look at
    // them, and every object living on them reads as data loss. The array would report catastrophe while
    // sitting on 90TB of intact slices.
    //
    // So the table is bracketed: say we are writing it, write it, then say it is whole. Anything that finds
    // the marker still set knows the table cannot be trusted -- and, crucially, knows to say so rather than to
    // quietly believe a fleet with holes in it.
    // RAISE THE FLAG BEFORE THE FIRST THING IS TOUCHED, not before the second.
    //
    // A fleet restore adopts the instance identity and THEN writes the volume table, and the marker used to go
    // up between those two. Die in that window and the next boot finds an identity, no marker, and an empty or
    // stale volume table -- and sails straight past both recovery-mode guards, because one only checks for a
    // missing identity and the other only checks for a marker. The fleet comes up believing in whatever disks
    // Mongo happens to list, which after a wiped database is none of them.
    //
    // The bracket has to enclose EVERY mutation the restore makes, so it goes up first, before the identity.
    async beginFleetRestore(expected: number): Promise<void> {
        await this.setRuntimeConfig(FLEET_RESTORE_MARKER, {
            state: 'in-progress',
            expected,
            startedAt: new Date().toISOString()
        });

        // The fleet is being rebuilt from the disks, which means Mongo is not the array's index any more --
        // it is an empty file. The namespace has to be restored before anything is allowed to believe it.
        await this.setRuntimeConfig(NAMESPACE_RESTORE_MARKER, { since: new Date().toISOString() });
    }

    async namespaceRestoreRequired(): Promise<{ since: string } | null> {
        const m = await this.getRuntimeConfig(NAMESPACE_RESTORE_MARKER) as { since?: string } | null;
        return m ? { since: m.since ?? 'unknown' } : null;
    }

    async clearNamespaceRestoreRequired(): Promise<void> {
        await this.deleteRuntimeConfig(NAMESPACE_RESTORE_MARKER);
    }

    async beginNamespaceRestore(): Promise<void> {
        await this.setRuntimeConfig(NAMESPACE_RESTORE_IN_FLIGHT, { startedAt: new Date().toISOString() });
    }

    async namespaceRestoreInFlight(): Promise<{ startedAt: string } | null> {
        const m = await this.getRuntimeConfig(NAMESPACE_RESTORE_IN_FLIGHT) as { startedAt?: string } | null;
        return m ? { startedAt: m.startedAt ?? 'unknown' } : null;
    }

    async endNamespaceRestore(): Promise<void> {
        await this.deleteRuntimeConfig(NAMESPACE_RESTORE_IN_FLIGHT);
    }

    async restoreVolumes(configs: Array<Record<string, unknown>>): Promise<void> {
        // Idempotent: the marker is normally already up (beginFleetRestore, before the identity was adopted).
        // Setting it again costs nothing and means this is still safe if it is ever called on its own.
        await this.beginFleetRestore(configs.length);

        for (const config of configs)
            await this.volumesCollection.updateOne({ id: config.id }, { $set: config }, { upsert: true });

        // CHECK THE IDS, NOT THE COUNT.
        //
        // Counting documents was the obvious thing and it is wrong, because it cannot tell one volume from
        // another. A dirty or forced recovery can leave STALE volume documents behind -- disks from a previous
        // life of this database -- and thirty stale rows will happily satisfy a check for "at least thirty
        // rows" while the volume we actually needed is missing from all of them. The marker comes down, the
        // fleet starts on a hybrid table, and the disk nobody wrote is invisible: every object living only on
        // it reads as data loss.
        //
        // So ask the only question that means anything: is every volume we were told to write ACTUALLY THERE,
        // by id?
        const expected = configs.map(cfg => Number(cfg.id));
        const present = new Set((await this.volumesCollection
            .find({ id: { $in: expected } }, { projection: { id: 1 } })
            .toArray()).map(d => Number(d.id)));

        const absent = expected.filter(id => !present.has(id));
        if (absent.length)
            throw new Error(`the volume table is incomplete: volume(s) ${absent.join(', ')} were not written `
                + `(${present.size} of ${expected.length} landed). Leaving the incomplete-restore marker in place: a `
                + `partial fleet must never be treated as the whole array, because every object living only on the `
                + `disks missing from it would read as data loss.`);

        await this.deleteRuntimeConfig(FLEET_RESTORE_MARKER);
    }

    // Is the volume table known to be half-written? Called before the fleet is allowed to come up, and before
    // any recovery is allowed to draw a conclusion about what is or is not on the platters.
    async fleetRestoreIncomplete(): Promise<{ expected: number; startedAt: string } | null> {
        const marker = await this.getRuntimeConfig(FLEET_RESTORE_MARKER) as
            { state?: string; expected?: number; startedAt?: string } | null;

        if (!marker || marker.state !== 'in-progress') return null;
        return { expected: marker.expected ?? 0, startedAt: marker.startedAt ?? 'unknown' };
    }


    async listContainerEntries(containerId: ObjectIdentifier, opts?: { limit?: number; after?: string }): Promise<{ entries: ContentDocument[]; hasMore: boolean }> {
        return this.contentRepository.listContainerEntries(containerId, opts);
    }

    async resolveContainerStrict(path: ContainerPath): Promise<string | null | undefined> {
        return this.contentRepository.resolveContainerStrict(path);
    }

    async setBucketPolicy(id: ObjectIdentifier, policy: { publicRead?: boolean; publicWrite?: boolean }): Promise<boolean> {
        return this.contentRepository.setBucketPolicy(id, policy);
    }

    async getObjectById(id: ObjectIdentifier): Promise<ContentDocument> {
        return this.contentRepository.getObjectById(id);
    }

    async getObjectsInContainerPath(path: string): Promise<ContentDocument[]> {
        return this.contentRepository.getObjectsInContainerPath(path);
    }

    async getObjectsInContainer(containerId: ObjectIdentifier): Promise<ContentDocument[]> {
        return this.contentRepository.getObjectsInContainer(containerId);
    }

    async getObjectByPath(path: string): Promise<ContentDocument> {
        if (!path || !path.trim())
            throw createError('ENOENT', 'object not found');
        return this.contentRepository.getObjectByPath(path);
    }

    async findObjectsNeedingVerification(startedAt: Date, limit: number, volumeIds?: number[], afterId?: ObjectIdentifier): Promise<ContentDocument[]> {
        return this.contentRepository.findObjectsNeedingVerification(startedAt, limit, volumeIds, afterId);
    }

    async findObjectsOnVolumesNeedingVerification(startedAt: Date, limit: number, volumeIds: number[], afterId?: ObjectIdentifier): Promise<ContentDocument[]> {
        return this.contentRepository.findObjectsOnVolumesNeedingVerification(startedAt, limit, volumeIds, afterId);
    }

    async countObjectsVerifiedSince(startedAt: Date, volumeIds?: number[]): Promise<number> {
        return this.contentRepository.countObjectsVerifiedSince(startedAt, volumeIds);
    }

    async findObjectsOnVolume(volumeIds: number[], limit: number, afterId?: ObjectIdentifier, opts?: { minSize?: number }): Promise<ContentDocument[]> {
        return this.contentRepository.findObjectsOnVolume(volumeIds, limit, afterId, opts);
    }

    async countObjectsOnVolume(volumeId: number, opts?: { excludeDead?: boolean }): Promise<number> {
        return this.contentRepository.countObjectsOnVolume(volumeId, opts);
    }

    async replaceObjectVolumeRef(id: ObjectIdentifier, fromVolumeId: number, toVolumeId: number): Promise<boolean> {
        return this.contentRepository.replaceObjectVolumeRef(id, fromVolumeId, toVolumeId);
    }

    async updateObjectVerificationState(
        id: ObjectIdentifier,
        updates: ObjectVerificationStateUpdate
    ): Promise<void> {
        await this.contentRepository.updateObjectVerificationState(id, updates);
    }

    async upsertFault(fault: FaultUpsert): Promise<void> {
        await this.faultRepository.upsert(fault);
    }

    async listFaults(): Promise<FaultDocument[]> {
        return this.faultRepository.list();
    }

    async deleteFault(key: string): Promise<void> {
        await this.faultRepository.delete(key);
    }

    async getContainer(path: ContainerPath, shouldCreateIfNotExists = false): Promise<string | null> {
        return this.contentRepository.resolveContainer(path, shouldCreateIfNotExists);
    }

    async getOrCreateContainer(path: ContainerPath): Promise<string | null> {
        return this.getContainer(path, true);
    }

    async getOrCreateContainerWithBucket(path: ContainerPath): Promise<{ containerId: string | null; bucketId: string | null }> {
        return this.contentRepository.resolveContainerWithBucket(path, true);
    }

    async backfillBucketIds(opts?: { apply?: boolean; batchSize?: number }): Promise<{ containersStamped: number; objectsStamped: number; skippedContainers: number }> {
        return this.contentRepository.backfillBucketIds(opts);
    }

    async computeBucketStats(): Promise<Array<{ bucketId: string; objectCount: number; logicalBytes: number }>> {
        return this.contentRepository.computeBucketStats();
    }

    async deleteObjectById(id: ObjectIdentifier): Promise<void> {
        await this.contentRepository.deleteObjectById(id);
    }

    async backfillContentSliceSizes(): Promise<number> {
        return this.contentRepository.backfillSliceSizes();
    }

    async computeStorageStats(availableVolumeIds: number[], updatedAt?: Date): Promise<StorageStatsSnapshot> {
        return this.contentRepository.computeStorageStats(availableVolumeIds, updatedAt);
    }

    async refreshStorageStatsUnavailable(readableVolumeIds: number[], updatedAt = new Date()): Promise<StorageStatsSnapshot | null> {
        const snapshot = await this.getStorageStats();
        if (!snapshot)
            return null;
        const knownVolumeIds = Object.keys(snapshot.volumes).map(Number);
        const normalizedReadable = Array.from(new Set(readableVolumeIds.filter(id => Number.isFinite(id)))).sort((a, b) => a - b);
        const unavailable = await this.contentRepository.computeUnavailableStorageStats(knownVolumeIds, normalizedReadable);
        await this.storageStatsRepository.updateUnavailable(unavailable, normalizedReadable, updatedAt);
        return this.getStorageStats();
    }

    async getStorageStats(): Promise<StorageStatsSnapshot | null> {
        return this.storageStatsRepository.get();
    }

    async replaceStorageStats(snapshot: StorageStatsSnapshot): Promise<void> {
        await this.storageStatsRepository.replace(snapshot);
    }

    async applyStorageStatsDelta(delta: StorageStatsDelta, updatedAt?: Date): Promise<void> {
        await this.storageStatsRepository.applyDelta(delta, updatedAt);
    }

    getMongoId(id: ObjectIdentifier): ObjectId | null {
        if (!id) return null;
        if (typeof id === 'string') return new ObjectId(id);
        if (id instanceof ObjectId) return id;
        if (id instanceof Buffer) return new ObjectId(id.toString('hex'));
        throw new Error('unhandled mongo ID type');
    }

    getTimestampFromId(id: string | ObjectId): number {
        const hex = typeof id === 'string' ? id : id.toHexString();
        const tsBuf = Buffer.from(hex, 'hex');
        const ts = tsBuf.readInt32BE(0);
        return ts * 1000;
    }

    private _cleanObjectCache(): void {
        this._containerCache.sweep();
    }

    private async ensureContentIndexes(): Promise<void> {
        try {
            await this.dropInvalidSliceVerificationIndexes();
            await this.contentCollection.createIndexes([
                { key: { containerId: 1, name: 1 }, name: 'containerContents', unique: true },
                { key: { containerId: 1 }, name: 'containerId' },
                // Sparse: pre-backfill documents have no bucketId yet; once backfill completes every
                // document carries one, so the sparse index covers the whole collection. Used by
                // authorisation (bucket lookup by id) and the per-bucket stats aggregation.
                { key: { bucketId: 1 }, name: 'bucketId', sparse: true },
                { key: { lastVerifiedAt: 1 }, name: 'lastVerifiedAt' },
                { key: { sliceErrors: 1 }, name: 'sliceErrors', sparse: true },
                { key: { dataVolumes: 1 }, name: 'dataVolumes', sparse: true },
                { key: { parityVolumes: 1 }, name: 'parityVolumes', sparse: true }
            ]);
        }
        catch (err) {
            log.error('failed to ensure content indexes', err);
            throw err;
        }
    }

    private async dropInvalidSliceVerificationIndexes(): Promise<void> {
        const indexes = await this.contentCollection.indexes();
        const invalidNames = indexes
            .map(index => index.name)
            .filter((name): name is string => typeof name === 'string'
                && /^(data|parity)Volume\d+Verification$/.test(name));
        for (const name of invalidNames) {
            log('dropping invalid content index %s', name);
            await this.contentCollection.dropIndex(name);
        }
    }

    // THE UNIQUE INDEX IS WHAT MAKES setIfAbsent() ATOMIC. Without it, it is not.
    //
    // MongoDB's upsert is only safe against concurrent duplicate inserts when a UNIQUE INDEX exists on the
    // query field. Without one, two concurrent `updateOne({key}, {$setOnInsert}, {upsert:true})` can BOTH miss
    // the (nonexistent) document, BOTH insert, and BOTH report upsertedCount === 1 -- which is precisely the
    // race that `setIfAbsent` was written to close.
    //
    // That matters for exactly one key, and it matters enormously: `luksRecoveryVerifier`. Two first-time
    // encryptions racing with different passphrases would each believe they were first, each bake their own
    // passphrase into a disk's keyslot, and leave the fleet split across two recovery passphrases with only one
    // of them recorded. The index turns the loser's insert into a duplicate-key error, which setIfAbsent
    // reports as "you did not create it" -- and the loser then has to match the winner or be refused.
    private async ensureRuntimeConfigIndexes(): Promise<void> {
        try {
            await this.runtimeConfigCollection.createIndexes([
                { key: { key: 1 }, name: 'runtimeConfigKey', unique: true }
            ]);
        }
        catch (err) {
            // NOT FATAL. Refusing to start would take 130TB offline over an index that exactly one feature
            // needs, and a guard that bricks the array it was written to protect is a guard that has failed.
            // (That has happened here before.)
            //
            // Nothing pretends the guarantee is there when it is not: setIfAbsent() is only exclusive BECAUSE
            // of this index, and the LUKS recovery verifier asks runtimeConfigKeyIsUnique() before recording a
            // first passphrase -- so what fails is ENCRYPTION, loudly, not the array.
            log.error('could not create the unique index on runtimeConfig.key (%s). The array is unaffected, but '
                + 'encryption will refuse to record a first recovery passphrase until this is fixed. A duplicate '
                + 'key in runtimeConfig would explain it.', err);
        }
    }

    private async ensureFaultIndexes(): Promise<void> {
        try {
            await this.faultsCollection.createIndexes([
                { key: { lastSeen: 1 }, name: 'lastSeen' },
                { key: { volumeId: 1 }, name: 'volumeId' },
                { key: { repairStatus: 1 }, name: 'repairStatus', sparse: true }
            ]);
        }
        catch (err) {
            log.error('failed to ensure fault indexes', err);
            throw err;
        }
    }

    private _normalizeObject<T extends ContentDocument>(object: T): T & { id: string; containerId?: string | null } {
        const normalized = { ...object } as T & { id: string; containerId?: string | null };

        if (object._id) {
            normalized.id = object._id.toHexString();
            delete normalized._id;
        }
        else if (object.id) {
            normalized.id = object.id;
        }
        else {
            throw new Error('object missing identifier');
        }

        const containerIdValue = object.containerId;
        if (containerIdValue instanceof ObjectId) {
            normalized.containerId = containerIdValue.toHexString();
        }
        else if (typeof containerIdValue === 'string') {
            normalized.containerId = containerIdValue;
        }
        else if (containerIdValue === null) {
            normalized.containerId = null;
        }
        else {
            delete normalized.containerId;
        }

        const bucketIdValue = object.bucketId;
        if (bucketIdValue instanceof ObjectId) {
            (normalized as ContentDocument).bucketId = bucketIdValue.toHexString();
        }
        else if (typeof bucketIdValue === 'string') {
            (normalized as ContentDocument).bucketId = bucketIdValue;
        }
        else if (bucketIdValue === null) {
            (normalized as ContentDocument).bucketId = null;
        }
        else {
            delete (normalized as ContentDocument).bucketId;
        }

        return normalized;
    }

    private get volumesCollection(): Collection<any> {
        if (!this._collections.volumes)
            throw new Error('database not initialized');
        return this._collections.volumes;
    }

    private get contentCollection(): Collection<ContentDocument> {
        if (!this._collections.content)
            throw new Error('database not initialized');
        return this._collections.content;
    }

    private get runtimeConfigCollection(): Collection<{ key: string; value: unknown }> {
        if (!this._collections.runtimeConfig)
            throw new Error('database not initialized');
        return this._collections.runtimeConfig;
    }

    private get faultsCollection(): Collection<FaultDocument> {
        if (!this._collections.faults)
            throw new Error('database not initialized');
        return this._collections.faults;
    }

    private get storageStatsCollection(): Collection<any> {
        if (!this._collections.storageStats)
            throw new Error('database not initialized');
        return this._collections.storageStats;
    }

    private get adminTokenCollection(): Collection<AdminTokenDocument> {
        if (!this._collections.adminTokens)
            throw new Error('database not initialized');
        return this._collections.adminTokens;
    }

    private get adminTokenRepository(): AdminTokenRepository {
        if (!this._repositories.adminTokens) {
            this._repositories.adminTokens = new AdminTokenRepository(this.adminTokenCollection);
        }
        return this._repositories.adminTokens;
    }

    private get credentialsCollection(): Collection<CredentialDocument> {
        if (!this._collections.credentials)
            throw new Error('database not initialized');
        return this._collections.credentials;
    }

    private get credentialRepository(): CredentialRepository {
        if (!this._repositories.credentials) {
            this._repositories.credentials = new CredentialRepository(this.credentialsCollection);
        }
        return this._repositories.credentials;
    }

    private get volumeRepository(): VolumeRepository {
        if (!this._repositories.volumes) {
            this._repositories.volumes = new VolumeRepository(this.volumesCollection);
        }
        return this._repositories.volumes;
    }

    private get contentRepository(): ContentRepository {
        if (!this._repositories.content) {
            this._repositories.content = new ContentRepository(
                this.contentCollection,
                this._containerCache,
                this._normalizeObject.bind(this),
                this.getMongoId.bind(this)
            );
        }
        return this._repositories.content;
    }

    private get faultRepository(): FaultRepository {
        if (!this._repositories.faults) {
            this._repositories.faults = new FaultRepository(this.faultsCollection);
        }
        return this._repositories.faults;
    }

    private get runtimeConfigRepository(): RuntimeConfigRepository {
        if (!this._repositories.runtimeConfig) {
            this._repositories.runtimeConfig = new RuntimeConfigRepository(this.runtimeConfigCollection);
        }
        return this._repositories.runtimeConfig;
    }

    private get storageStatsRepository(): StorageStatsRepository {
        if (!this._repositories.storageStats) {
            this._repositories.storageStats = new StorageStatsRepository(this.storageStatsCollection);
        }
        return this._repositories.storageStats;
    }
}

export const database = new Database();
