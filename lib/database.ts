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
import type { ContainerPath, ContentDocument, ObjectIdentifier, ObjectVerificationStateUpdate, SliceErrorInfo } from './database/types';
import type { StorageStatsDelta, StorageStatsSnapshot } from './storage/stats';
export type { ContentDocument, ObjectVerificationStateUpdate, SliceErrorInfo, SliceErrorCategory, SliceVerificationTimes } from './database/types';
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
    } = {
        volumes: null,
        content: null,
        runtimeConfig: null,
        faults: null,
        storageStats: null
    };
    private readonly _containerCache = new ContainerCache();
    private _repositories: {
        volumes: VolumeRepository | null;
        content: ContentRepository | null;
        runtimeConfig: RuntimeConfigRepository | null;
        faults: FaultRepository | null;
        storageStats: StorageStatsRepository | null;
    } = {
        volumes: null,
        content: null,
        runtimeConfig: null,
        faults: null,
        storageStats: null
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
            this._repositories = {
                volumes: new VolumeRepository(this._collections.volumes),
                content: new ContentRepository(
                    this._collections.content,
                    this._containerCache,
                    this._normalizeObject.bind(this),
                    this.getMongoId.bind(this)
                ),
                runtimeConfig: new RuntimeConfigRepository(this._collections.runtimeConfig),
                faults: new FaultRepository(this._collections.faults),
                storageStats: new StorageStatsRepository(this._collections.storageStats)
            };
            await this.ensureContentIndexes();
            await this.ensureFaultIndexes();

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

    async deleteRuntimeConfig(key: string): Promise<void> {
        await this.runtimeConfigRepository.delete(key);
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

    async findObjectsOnVolume(volumeIds: number[], limit: number, afterId?: ObjectIdentifier): Promise<ContentDocument[]> {
        return this.contentRepository.findObjectsOnVolume(volumeIds, limit, afterId);
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
