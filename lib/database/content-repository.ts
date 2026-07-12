import { Collection, ObjectId, type AnyBulkWriteOperation, type Filter } from 'mongodb';

import { config } from '../config';
import { constants } from '../constants';
import { createError } from '../helpers';
import {
    createEmptyStorageCounters,
    createEmptyStorageStatsSnapshot,
    type StorageSystemStats,
    type StorageStatsSnapshot
} from '../storage/stats';
import { ContainerCache } from './container-cache';
import type { ContentDocument, ContainerPath, ObjectIdentifier, ObjectVerificationStateUpdate } from './types';

type NormalizeFn = <T extends ContentDocument>(object: T) => T & { id: string; containerId?: string | null };
type MongoIdFn = (id: ObjectIdentifier) => ObjectId | null;

export class ContentRepository {
    constructor(
        private readonly collection: Collection<ContentDocument>,
        private readonly cache: ContainerCache,
        private readonly normalize: NormalizeFn,
        private readonly toMongoId: MongoIdFn
    ) {}

    async createObjectRecord(object: ContentDocument & { id: string; containerId?: ObjectIdentifier }): Promise<void> {
        const { id, ...rest } = object;
        const containerMongoId = this.toMongoId(object.containerId);
        const bucketMongoId = object.bucketId ? this.toMongoId(object.bucketId) : null;
        // An object inside a container MUST carry its bucket. If it didn't, we'd write bucketId:null and
        // the additive backfill ({ bucketId: { $exists: false } }) would then skip it forever, silently
        // excluding it from stats and authorisation. Fail loudly instead. bucketId:null is valid ONLY for
        // a genuine root object (containerId null) -- production has none, and Phase 3 rejects them.
        if (containerMongoId && !bucketMongoId)
            throw createError('EINVAL', 'object in a container must have a bucketId');
        const insertDoc: ContentDocument = {
            ...rest,
            _id: new ObjectId(id),
            containerId: containerMongoId,
            bucketId: bucketMongoId
        };
        await this.collection.insertOne(insertDoc);
    }

    async getObjectById(id: ObjectIdentifier): Promise<ContentDocument> {
        const object = await this.collection.findOne<ContentDocument>({
            _id: this.toMongoId(id) as ObjectId
        });
        if (!object)
            throw createError('ENOENT', 'object not found');
        return this.normalize(object);
    }

    async getObjectByPath(path: string): Promise<ContentDocument> {
        const components = path.split('/');
        const objectName = components.pop();

        if (!objectName)
            throw createError('ENOENT', 'object not found');

        const containerId = components.length
            ? await this.resolveContainer(components)
            : null;

        const object = await this.collection.findOne<ContentDocument>({
            containerId: this.toMongoId(containerId),
            name: objectName
        });

        if (!object)
            throw createError('ENOENT', 'object not found');

        const normalized = this.normalize(object);
        if (normalized.isContainer)
            this.cache.remember(normalized.id, normalized.name, normalized.containerId ?? null);

        return normalized;
    }

    async getObjectsInContainerPath(path: string): Promise<ContentDocument[]> {
        const containerId = path.length ? await this.resolveContainer(path) : null;
        return this.getObjectsInContainer(containerId);
    }

    async getObjectsInContainer(containerId: ObjectIdentifier): Promise<ContentDocument[]> {
        const cursor = this.collection.find<ContentDocument>({
            containerId: this.toMongoId(containerId)
        }, {
            projection: { _id: 1, name: 1, isFile: 1, isContainer: 1, size: 1 }
        });
        const objects = await cursor.toArray();
        return objects.map(object => this.normalize(object));
    }

    async deleteObjectById(id: ObjectIdentifier): Promise<void> {
        await this.collection.deleteOne({
            _id: this.toMongoId(id) as ObjectId
        });
    }

    async backfillSliceSizes(): Promise<number> {
        const result = await this.collection.updateMany(
            {
                isFile: true,
                $or: [
                    { sliceSize: { $exists: false } },
                    { sliceSize: null }
                ]
            },
            [
                {
                    $set: {
                        sliceSize: this.sliceSizeExpression()
                    }
                }
            ]
        );
        return result.modifiedCount ?? 0;
    }

    async computeStorageStats(availableVolumeIds: number[], updatedAt = new Date()): Promise<StorageStatsSnapshot> {
        const snapshot = createEmptyStorageStatsSnapshot(updatedAt);
        const [system] = await this.collection.aggregate<{
            objectCount: number;
            logicalBytes: number;
            dataSliceCount: number;
            paritySliceCount: number;
            dataBytes: number;
            parityBytes: number;
        }>([
            { $match: { isFile: true } },
            {
                $project: {
                    size: { $ifNull: ['$size', 0] },
                    sliceSize: this.sliceSizeExpression(),
                    dataSliceCount: { $size: { $ifNull: ['$dataVolumes', []] } },
                    paritySliceCount: { $size: { $ifNull: ['$parityVolumes', []] } }
                }
            },
            {
                $group: {
                    _id: null,
                    objectCount: { $sum: 1 },
                    logicalBytes: { $sum: '$size' },
                    dataSliceCount: { $sum: '$dataSliceCount' },
                    paritySliceCount: { $sum: '$paritySliceCount' },
                    dataBytes: { $sum: { $multiply: ['$sliceSize', '$dataSliceCount'] } },
                    parityBytes: { $sum: { $multiply: ['$sliceSize', '$paritySliceCount'] } }
                }
            },
            { $project: { _id: 0 } }
        ]).toArray();

        if (system) {
            snapshot.system.objectCount = system.objectCount ?? 0;
            snapshot.system.logicalBytes = system.logicalBytes ?? 0;
            snapshot.system.dataSliceCount = system.dataSliceCount ?? 0;
            snapshot.system.paritySliceCount = system.paritySliceCount ?? 0;
            snapshot.system.dataBytes = system.dataBytes ?? 0;
            snapshot.system.parityBytes = system.parityBytes ?? 0;
            snapshot.system.physicalBytes = snapshot.system.dataBytes + snapshot.system.parityBytes;
        }

        await this.populateVolumeStorageStats(snapshot, 'dataVolumes', 'data');
        await this.populateVolumeStorageStats(snapshot, 'parityVolumes', 'parity');
        await this.populateVolumeObjectStats(snapshot);
        const unavailable = await this.computeUnavailableStorageStats(
            Object.keys(snapshot.volumes).map(Number),
            availableVolumeIds
        );
        snapshot.system.unavailableObjectCount = unavailable.unavailableObjectCount;
        snapshot.system.unavailableLogicalBytes = unavailable.unavailableLogicalBytes;
        snapshot.readableVolumeIds = this.normalizeVolumeIds(availableVolumeIds);
        snapshot.unavailableUpdatedAt = updatedAt;
        return snapshot;
    }

    async computeUnavailableStorageStats(knownVolumeIds: number[], readableVolumeIds: number[]): Promise<Pick<StorageSystemStats, 'unavailableObjectCount' | 'unavailableLogicalBytes'>> {
        const readable = new Set(this.normalizeVolumeIds(readableVolumeIds));
        const unreadable = this.normalizeVolumeIds(knownVolumeIds).filter(volumeId => !readable.has(volumeId));
        if (!unreadable.length) {
            return {
                unavailableObjectCount: 0,
                unavailableLogicalBytes: 0
            };
        }

        const [unavailable] = await this.collection.aggregate<{
            objectCount: number;
            logicalBytes: number;
        }>([
            {
                $match: {
                    isFile: true,
                    $or: [
                        { dataVolumes: { $in: unreadable } },
                        { parityVolumes: { $in: unreadable } }
                    ]
                }
            },
            {
                $project: {
                    size: { $ifNull: ['$size', 0] },
                    paritySliceCount: { $size: { $ifNull: ['$parityVolumes', []] } },
                    unavailableSlices: {
                        $add: [
                            { $size: { $setIntersection: [{ $ifNull: ['$dataVolumes', []] }, unreadable] } },
                            { $size: { $setIntersection: [{ $ifNull: ['$parityVolumes', []] }, unreadable] } }
                        ]
                    }
                }
            },
            { $match: { $expr: { $gt: ['$unavailableSlices', '$paritySliceCount'] } } },
            {
                $group: {
                    _id: null,
                    objectCount: { $sum: 1 },
                    logicalBytes: { $sum: '$size' }
                }
            },
            { $project: { _id: 0 } }
        ]).toArray();

        return {
            unavailableObjectCount: unavailable?.objectCount ?? 0,
            unavailableLogicalBytes: unavailable?.logicalBytes ?? 0
        };
    }

    async findObjectsNeedingVerification(startedAt: Date, limit: number, volumeIds?: number[], afterId?: ObjectIdentifier): Promise<ContentDocument[]> {
        const staleSliceConditions = Array.isArray(volumeIds) && volumeIds.length
            ? this.buildStaleSliceConditions(startedAt, volumeIds)
            : [];
        const conditions: Filter<ContentDocument>[] = staleSliceConditions.length
            ? [{ $or: staleSliceConditions }]
            : [this.timestampIsStale('lastVerifiedAt', startedAt)];
        const afterFilter = this.idAfterFilter(afterId);
        const query: Filter<ContentDocument> = {
            isFile: true,
            ...(afterFilter ?? {}),
            $and: conditions
        };
        const cursor = this.collection.find<ContentDocument>(query, {
            sort: { _id: 1 },
            limit
        });
        const objects = await cursor.toArray();
        return objects.map(object => this.normalize(object));
    }

    // Targeted verification uses per-slice timestamps for correctness and an
    // optional _id cursor to avoid rescanning already passed objects during a run.
    async findObjectsOnVolumesNeedingVerification(startedAt: Date, limit: number, volumeIds: number[], afterId?: ObjectIdentifier): Promise<ContentDocument[]> {
        const staleSliceConditions = this.buildStaleSliceConditions(startedAt, volumeIds);
        if (!staleSliceConditions.length)
            return [];
        const afterFilter = this.idAfterFilter(afterId);
        const query: Filter<ContentDocument> = {
            isFile: true,
            ...(afterFilter ?? {}),
            $or: staleSliceConditions
        };
        const cursor = this.collection.find<ContentDocument>(query, {
            sort: { _id: 1 },
            limit
        });
        const objects = await cursor.toArray();
        return objects.map(object => this.normalize(object));
    }

    async countObjectsVerifiedSince(startedAt: Date, volumeIds?: number[]): Promise<number> {
        if (Array.isArray(volumeIds) && volumeIds.length) {
            const staleSliceConditions = this.buildStaleSliceConditions(startedAt, volumeIds);
            const conditions: Filter<ContentDocument>[] = [{
                $or: [
                    { dataVolumes: { $in: volumeIds } },
                    { parityVolumes: { $in: volumeIds } }
                ]
            }];
            if (staleSliceConditions.length)
                conditions.push({ $nor: staleSliceConditions });
            return this.collection.countDocuments({
                isFile: true,
                $and: conditions
            });
        }
        const query: Filter<ContentDocument> = {
            isFile: true,
            lastVerifiedAt: { $gte: startedAt }
        };
        return this.collection.countDocuments(query);
    }

    async updateObjectVerificationState(
        id: ObjectIdentifier,
        updates: ObjectVerificationStateUpdate
    ): Promise<void> {
        const set: Record<string, unknown> = {};
        const unset: Record<string, unknown> = {};

        if (updates.lastVerifiedAt !== undefined)
            set.lastVerifiedAt = updates.lastVerifiedAt;
        if (updates.sliceErrors !== undefined) {
            if (updates.sliceErrors === null)
                unset.sliceErrors = '';
            else
                set.sliceErrors = updates.sliceErrors;
        }
        if (updates.sliceVerificationTimes !== undefined) {
            if (updates.sliceVerificationTimes === null)
                unset.sliceVerificationTimes = '';
            else
                set.sliceVerificationTimes = updates.sliceVerificationTimes;
        }

        const updateDoc: Record<string, Record<string, unknown>> = {};
        if (Object.keys(set).length)
            updateDoc.$set = set;
        if (Object.keys(unset).length)
            updateDoc.$unset = unset;

        if (!Object.keys(updateDoc).length)
            return;

        await this.collection.updateOne(
            { _id: this.toMongoId(id) as ObjectId },
            updateDoc
        );
    }

    // --- drain/drain support ---

    // Objects with a slice on any of the given volumes, _id-ordered for cursor resume.
    // minSize restricts the scan to objects at or above a size (bytes). The rebalance uses it to shed
    // the big objects first; it's a plain filter on top of the existing _id-ordered scan, so there is
    // no blocking sort to fall over on a multi-million-document volume.
    async findObjectsOnVolume(
        volumeIds: number[],
        limit: number,
        afterId?: ObjectIdentifier,
        opts?: { minSize?: number }
    ): Promise<ContentDocument[]> {
        if (!volumeIds.length)
            return [];
        const afterFilter = this.idAfterFilter(afterId);
        const query: Filter<ContentDocument> = {
            isFile: true,
            ...(afterFilter ?? {}),
            $or: [{ dataVolumes: { $in: volumeIds } }, { parityVolumes: { $in: volumeIds } }]
        };
        if (opts?.minSize)
            (query as Record<string, unknown>).size = { $gte: opts.minSize };
        const objects = await this.collection.find<ContentDocument>(query, { sort: { _id: 1 }, limit }).toArray();
        return objects.map(object => this.normalize(object));
    }

    // Count objects with a slice on the volume. excludeDead omits recoveryComment'd objects
    // (documented-unrecoverable / accepted-loss), so a fully-drained volume whose only remaining
    // refs are dead objects reports 0 -> removable.
    async countObjectsOnVolume(volumeId: number, opts?: { excludeDead?: boolean }): Promise<number> {
        const query: Filter<ContentDocument> = {
            isFile: true,
            $or: [{ dataVolumes: volumeId }, { parityVolumes: volumeId }]
        };
        // This predicate MUST mean exactly what isDocumentedDead() means, or a volume can be reported
        // fully drained while it still holds a live slice -- and then removed. Dead == recoveryComment
        // is a NON-EMPTY STRING; everything else (missing, null, empty, or any non-string) is live.
        //
        // It has to be $expr. Ordinary field queries apply ARRAY-ELEMENT semantics -- `{$gt: ''}` matches
        // a document whose recoveryComment is `['x']`, because an *element* is > '' -- so it would call
        // that dead while isDocumentedDead() (a plain `typeof`) calls it live. Aggregation `$type` has no
        // such semantics: it reports the type of the whole value ('array'), mirroring `typeof` exactly.
        // ($exists:false would call an empty comment dead; $in:[null,''] would call a non-string one
        // dead. Every one of these is the same data-loss shape, approached from a different direction.)
        if (opts?.excludeDead) {
            (query as Record<string, unknown>).$expr = {
                $not: [{
                    $and: [
                        { $eq: [{ $type: '$recoveryComment' }, 'string'] },
                        { $ne: ['$recoveryComment', ''] }
                    ]
                }]
            };
        }
        return this.collection.countDocuments(query);
    }

    // Atomic ref-flip after a slice is relocated + verified. POSITIONAL update (arrayFilters): rewrites
    // only the array element(s) equal to fromVolumeId -> toVolumeId, leaving every OTHER slice position
    // untouched, so a concurrent relocation of a DIFFERENT slice of the same object can't be clobbered
    // by a stale whole-array write. Conditional: applies only if the object still references the source
    // AND does not already reference the target (distinct-volume at commit). move-then-flip.
    async replaceObjectVolumeRef(id: ObjectIdentifier, fromVolumeId: number, toVolumeId: number): Promise<boolean> {
        const result = await this.collection.updateOne(
            {
                _id: this.toMongoId(id) as ObjectId,
                dataVolumes: { $ne: toVolumeId },
                parityVolumes: { $ne: toVolumeId },
                $or: [{ dataVolumes: fromVolumeId }, { parityVolumes: fromVolumeId }]
            },
            { $set: { 'dataVolumes.$[e]': toVolumeId, 'parityVolumes.$[e]': toVolumeId } },
            { arrayFilters: [{ e: fromVolumeId }] }
        );
        return result.modifiedCount === 1;
    }

    private async populateVolumeStorageStats(snapshot: StorageStatsSnapshot, field: 'dataVolumes' | 'parityVolumes', type: 'data' | 'parity'): Promise<void> {
        const rows = await this.collection.aggregate<{
            volumeId: number;
            sliceCount: number;
            bytes: number;
        }>([
            { $match: { isFile: true } },
            {
                $project: {
                    volumeId: `$${field}`,
                    sliceSize: this.sliceSizeExpression()
                }
            },
            { $unwind: '$volumeId' },
            {
                $group: {
                    _id: '$volumeId',
                    sliceCount: { $sum: 1 },
                    bytes: { $sum: '$sliceSize' }
                }
            },
            {
                $project: {
                    _id: 0,
                    volumeId: '$_id',
                    sliceCount: 1,
                    bytes: 1
                }
            }
        ]).toArray();

        for (const row of rows) {
            const stats = this.getOrCreateVolumeStats(snapshot, row.volumeId);
            if (type === 'data') {
                stats.dataSliceCount += row.sliceCount ?? 0;
                stats.dataBytes += row.bytes ?? 0;
            }
            else {
                stats.paritySliceCount += row.sliceCount ?? 0;
                stats.parityBytes += row.bytes ?? 0;
            }
            stats.physicalBytes = stats.dataBytes + stats.parityBytes;
        }
    }

    private async populateVolumeObjectStats(snapshot: StorageStatsSnapshot): Promise<void> {
        const rows = await this.collection.aggregate<{
            volumeId: number;
            objectCount: number;
            logicalBytes: number;
        }>([
            { $match: { isFile: true } },
            {
                $project: {
                    size: { $ifNull: ['$size', 0] },
                    volumeId: {
                        $setUnion: [
                            { $ifNull: ['$dataVolumes', []] },
                            { $ifNull: ['$parityVolumes', []] }
                        ]
                    }
                }
            },
            { $unwind: '$volumeId' },
            {
                $group: {
                    _id: '$volumeId',
                    objectCount: { $sum: 1 },
                    logicalBytes: { $sum: '$size' }
                }
            },
            {
                $project: {
                    _id: 0,
                    volumeId: '$_id',
                    objectCount: 1,
                    logicalBytes: 1
                }
            }
        ]).toArray();

        for (const row of rows) {
            const stats = this.getOrCreateVolumeStats(snapshot, row.volumeId);
            stats.objectCount += row.objectCount ?? 0;
            stats.logicalBytes += row.logicalBytes ?? 0;
        }
    }

    private getOrCreateVolumeStats(snapshot: StorageStatsSnapshot, volumeId: number) {
        const key = String(volumeId);
        snapshot.volumes[key] ??= createEmptyStorageCounters();
        return snapshot.volumes[key];
    }

    private normalizeVolumeIds(volumeIds: number[]): number[] {
        return Array.from(new Set(volumeIds.filter(id => Number.isFinite(id)))).sort((a, b) => a - b);
    }

    private sliceSizeExpression(): Record<string, unknown> {
        return {
            $ifNull: [
                '$sliceSize',
                {
                    $let: {
                        vars: {
                            chunkSize: { $ifNull: ['$chunkSize', config.chunkSize] },
                            size: { $ifNull: ['$size', 0] },
                            dataSliceCount: {
                                $max: [
                                    { $size: { $ifNull: ['$dataVolumes', []] } },
                                    1
                                ]
                            }
                        },
                        in: {
                            $let: {
                                vars: {
                                    sliceDataSize: { $ceil: { $divide: ['$$size', '$$dataSliceCount'] } },
                                    startChunkSize: { $subtract: ['$$chunkSize', constants.FILE_HEADER_SIZE] },
                                    chunkDataSize: { $subtract: ['$$chunkSize', constants.CHUNK_HEADER_SIZE] }
                                },
                                in: {
                                    $add: [
                                        constants.FILE_HEADER_SIZE,
                                        '$$sliceDataSize',
                                        {
                                            $multiply: [
                                                constants.CHUNK_HEADER_SIZE,
                                                {
                                                    $max: [
                                                        1,
                                                        {
                                                            $ceil: {
                                                                $add: [
                                                                    1,
                                                                    {
                                                                        $divide: [
                                                                            {
                                                                                $add: [
                                                                                    { $subtract: ['$$sliceDataSize', '$$startChunkSize'] },
                                                                                    constants.CHUNK_HEADER_SIZE
                                                                                ]
                                                                            },
                                                                            '$$chunkDataSize'
                                                                        ]
                                                                    }
                                                                ]
                                                            }
                                                        }
                                                    ]
                                                }
                                            ]
                                        }
                                    ]
                                }
                            }
                        }
                    }
                }
            ]
        };
    }

    private buildStaleSliceConditions(startedAt: Date, volumeIds: number[]): Filter<ContentDocument>[] {
        const uniqueVolumeIds = Array.from(new Set(volumeIds.filter(id => Number.isFinite(id))));
        if (!uniqueVolumeIds.length)
            return [];

        const conditions: Filter<ContentDocument>[] = [];
        for (let index = 0; index < config.dataSliceCount; index++) {
            conditions.push({
                [`dataVolumes.${index}`]: { $in: uniqueVolumeIds },
                $and: [
                    this.timestampIsStale(`sliceVerificationTimes.data.${index}`, startedAt),
                    this.timestampIsStale('lastVerifiedAt', startedAt)
                ]
            } as Filter<ContentDocument>);
        }
        for (let index = 0; index < config.paritySliceCount; index++) {
            conditions.push({
                [`parityVolumes.${index}`]: { $in: uniqueVolumeIds },
                $and: [
                    this.timestampIsStale(`sliceVerificationTimes.parity.${index}`, startedAt),
                    this.timestampIsStale('lastVerifiedAt', startedAt)
                ]
            } as Filter<ContentDocument>);
        }
        return conditions;
    }

    private timestampIsStale(path: string, startedAt: Date): Filter<ContentDocument> {
        return {
            $or: [
                { [path]: { $lt: startedAt } },
                { [path]: { $exists: false } },
                { [path]: null }
            ]
        } as Filter<ContentDocument>;
    }

    private idAfterFilter(afterId?: ObjectIdentifier): Filter<ContentDocument> | null {
        if (!afterId)
            return null;
        try {
            const mongoId = this.toMongoId(afterId);
            if (!mongoId)
                return null;
            return { _id: { $gt: mongoId } } as Filter<ContentDocument>;
        }
        catch {
            return null;
        }
    }

    async getOrCreateContainer(path: ContainerPath): Promise<string | null> {
        return this.resolveContainer(path, true);
    }

    async resolveContainer(path: ContainerPath, shouldCreateIfNotExists = false): Promise<string | null> {
        return (await this.resolveContainerWithBucket(path, shouldCreateIfNotExists)).containerId;
    }

    // Resolve a container path, returning BOTH the leaf container id and the bucket (top-level) id. The
    // bucket is simply the id of the first path component's container, captured on the first iteration.
    // Any container created along the way is stamped with its bucketId at insert time, so new writes are
    // covered without a backfill; existing containers get their bucketId from backfillBucketIds().
    async resolveContainerWithBucket(
        path: ContainerPath,
        shouldCreateIfNotExists = false
    ): Promise<{ containerId: string | null; bucketId: string | null }> {
        const components = typeof path === 'string'
            ? path.split('/').filter(component => component.length > 0)
            : [ ...path ];

        let containerId: string | null = null;
        let bucketId: string | null = null;
        let shouldSkipLookup = false;

        while (components.length) {
            const name = components.shift();
            if (!name) continue;

            const cachedId = this.cache.get(name, containerId);
            if (cachedId) {
                containerId = cachedId;
                bucketId ??= containerId;
                continue;
            }

            let object: ContentDocument | null = null;

            if (!shouldSkipLookup) {
                object = await this.collection.findOne({
                    containerId: this.toMongoId(containerId),
                    name
                });
            }

            if (!object) {
                if (!shouldCreateIfNotExists)
                    throw createError('ENOENT', 'object not found');

                shouldSkipLookup = true;

                // Preallocate the _id so the bucketId can be stamped in the SAME insert -- atomic, with
                // no window where a crash could leave a new top-level container unstamped. A nested
                // container inherits the already-known bucket; a brand-new top-level container IS its own
                // bucket, so it is stamped with its own preallocated id.
                const newId = new ObjectId();
                const bucketMongoId = bucketId ? this.toMongoId(bucketId) : newId;
                const insertDoc: ContentDocument = {
                    _id: newId,
                    containerId: this.toMongoId(containerId),
                    name,
                    isContainer: true,
                    bucketId: bucketMongoId
                };
                await this.collection.insertOne(insertDoc);
                object = insertDoc;
                object.containerId = containerId;
            }
            else if (!object.isContainer) {
                throw createError('ENOTDIR', 'object is not a container');
            }
            else {
                object.containerId = containerId;
            }

            const ensuredObject = object as ContentDocument;
            const normalized = this.normalize(ensuredObject);
            this.cache.remember(normalized.id, normalized.name, normalized.containerId ?? null);

            containerId = normalized.id;
            bucketId ??= containerId;
        }

        return { containerId, bucketId };
    }

    // One-off backfill of bucketId onto every pre-existing document. Purely additive: it only ever
    // $sets bucketId on documents that lack it ({ bucketId: { $exists: false } }), so it never rewrites
    // an existing value and is safe to re-run and to run alongside live writes (which already carry it).
    //
    // Strategy: the container tree is small (~55k nodes), so load it into memory, resolve each node's
    // root ancestor once (memoised, cycle/orphan guarded), stamp the containers, then stamp their
    // children (files + any still-unstamped sub-containers) with a handful of grouped updateMany calls
    // -- one bounded batch per bucket -- rather than a per-object walk over millions of documents.
    async backfillBucketIds(
        opts: { apply?: boolean; batchSize?: number } = {}
    ): Promise<{ containersStamped: number; objectsStamped: number; skippedContainers: number }> {
        const apply = opts.apply !== false;
        const batchSize = opts.batchSize ?? 1000;

        const containers = await this.collection
            .find({ isContainer: true }, { projection: { _id: 1, containerId: 1, bucketId: 1 } })
            .toArray();

        const parentOf = new Map<string, string | null>();
        for (const c of containers) {
            const cid = (c._id as ObjectId).toHexString();
            const parent = c.containerId ? (c.containerId as ObjectId).toHexString() : null;
            parentOf.set(cid, parent);
        }

        // Resolve the root ancestor (the bucket) for a container id. Returns null if the chain hits a
        // missing parent (orphan) or a cycle -- such nodes are left unstamped rather than mis-bucketed.
        const bucketCache = new Map<string, string | null>();
        const resolveBucket = (start: string): string | null => {
            const chain: string[] = [];
            let current: string | null = start;
            while (current !== null) {
                const cached = bucketCache.get(current);
                if (cached !== undefined) {
                    for (const node of chain) bucketCache.set(node, cached);
                    return cached;
                }
                if (chain.includes(current)) {                     // cycle
                    for (const node of chain) bucketCache.set(node, null);
                    return null;
                }
                chain.push(current);
                if (!parentOf.has(current)) {                      // orphan: parent doc missing
                    for (const node of chain) bucketCache.set(node, null);
                    return null;
                }
                const parent: string | null = parentOf.get(current) ?? null;
                if (parent === null) {                             // reached a root -> current IS the bucket
                    for (const node of chain) bucketCache.set(node, current);
                    return current;
                }
                current = parent;
            }
            return null;
        };

        // Group container ids by their resolved bucket, so children can be stamped per-bucket in bulk.
        // byBucket holds EVERY resolvable container (even already-stamped ones) so that children left
        // unstamped by an earlier partial run still get covered. containerBulk holds only containers that
        // are themselves still missing bucketId, so the dry-run count matches apply's modifiedCount.
        const byBucket = new Map<string, ObjectId[]>();
        const containerBulk: AnyBulkWriteOperation<ContentDocument>[] = [];
        let skippedContainers = 0;
        for (const c of containers) {
            const cid = (c._id as ObjectId).toHexString();
            const bucket = resolveBucket(cid);
            if (!bucket) { skippedContainers++; continue; }
            const bucketOid = new ObjectId(bucket);
            if (c.bucketId === undefined) {
                containerBulk.push({
                    updateOne: {
                        filter: { _id: c._id as ObjectId, bucketId: { $exists: false } },
                        update: { $set: { bucketId: bucketOid } }
                    }
                });
            }
            let ids = byBucket.get(bucket);
            if (!ids) { ids = []; byBucket.set(bucket, ids); }
            ids.push(c._id as ObjectId);
        }

        let containersStamped = 0;
        let objectsStamped = 0;
        if (!apply) {
            // Dry run: report what WOULD be stamped without writing. Exclude sub-containers from the
            // object count -- in apply mode the container pass stamps them first, so the child updateMany
            // only ever touches files; mirror that here so the dry-run numbers match the real run.
            containersStamped = containerBulk.length;
            for (const [bucket, ids] of byBucket) {
                objectsStamped += await this.collection.countDocuments({
                    containerId: { $in: ids },
                    isContainer: { $ne: true },
                    bucketId: { $exists: false }
                });
                void bucket;
            }
            return { containersStamped, objectsStamped, skippedContainers };
        }

        for (let i = 0; i < containerBulk.length; i += batchSize) {
            const res = await this.collection.bulkWrite(containerBulk.slice(i, i + batchSize), { ordered: false });
            containersStamped += res.modifiedCount ?? 0;
        }

        for (const [bucket, ids] of byBucket) {
            const bucketOid = new ObjectId(bucket);
            for (let i = 0; i < ids.length; i += batchSize) {
                const res = await this.collection.updateMany(
                    { containerId: { $in: ids.slice(i, i + batchSize) }, bucketId: { $exists: false } },
                    { $set: { bucketId: bucketOid } }
                );
                objectsStamped += res.modifiedCount ?? 0;
            }
        }

        return { containersStamped, objectsStamped, skippedContainers };
    }

    // --- buckets (a bucket IS a top-level container: containerId null, isContainer true) ---

    async getBucketByName(name: string): Promise<ContentDocument | null> {
        const doc = await this.collection.findOne({ containerId: null, isContainer: true, name });
        return doc ? this.normalize(doc) : null;
    }

    async getBucketById(id: ObjectIdentifier): Promise<ContentDocument | null> {
        const mongoId = this.toMongoId(id);
        if (!mongoId) return null;
        const doc = await this.collection.findOne({ _id: mongoId, containerId: null, isContainer: true });
        return doc ? this.normalize(doc) : null;
    }

    async listBuckets(): Promise<ContentDocument[]> {
        const docs = await this.collection
            .find({ containerId: null, isContainer: true }, { projection: { _id: 1, name: 1, publicRead: 1, publicWrite: 1 } })
            .toArray();
        return docs.map(doc => this.normalize(doc));
    }

    // Set a bucket's access policy. This is the ONLY writer of publicRead/publicWrite and it fires only on
    // an explicit operator action (admin API/UI) -- never automatically -- so it does not mutate existing
    // data as a side effect of the rollout. Scoped to top-level containers so a nested path can't be
    // mistaken for a bucket.
    async setBucketPolicy(id: ObjectIdentifier, policy: { publicRead?: boolean; publicWrite?: boolean }): Promise<boolean> {
        const mongoId = this.toMongoId(id);
        if (!mongoId) return false;
        const set: Record<string, boolean> = {};
        if (policy.publicRead !== undefined) set.publicRead = policy.publicRead;
        if (policy.publicWrite !== undefined) set.publicWrite = policy.publicWrite;
        if (!Object.keys(set).length) return false;
        const res = await this.collection.updateOne(
            { _id: mongoId, containerId: null, isContainer: true },
            { $set: set }
        );
        return res.matchedCount === 1;
    }

    // Per-bucket object count and logical size in a single grouped aggregation over the denormalised
    // bucketId -- the number the UI needs, without a recursive walk of tens of thousands of containers.
    async computeBucketStats(): Promise<Array<{ bucketId: string; objectCount: number; logicalBytes: number }>> {
        const rows = await this.collection.aggregate<{ _id: ObjectId | null; objectCount: number; logicalBytes: number }>([
            { $match: { isFile: true, bucketId: { $ne: null } } },
            {
                $group: {
                    _id: '$bucketId',
                    objectCount: { $sum: 1 },
                    logicalBytes: { $sum: { $ifNull: ['$size', 0] } }
                }
            }
        ]).toArray();
        return rows
            .filter(row => row._id)
            .map(row => ({
                bucketId: (row._id as ObjectId).toHexString(),
                objectCount: row.objectCount ?? 0,
                logicalBytes: row.logicalBytes ?? 0
            }));
    }
}
