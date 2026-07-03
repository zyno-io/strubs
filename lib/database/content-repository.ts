import { Collection, ObjectId, type Filter } from 'mongodb';

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
        const insertDoc: ContentDocument = {
            ...rest,
            _id: new ObjectId(id),
            containerId: this.toMongoId(object.containerId)
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

    // --- drain/evict support ---

    // Objects with a slice on any of the given volumes, _id-ordered for cursor resume.
    async findObjectsOnVolume(volumeIds: number[], limit: number, afterId?: ObjectIdentifier): Promise<ContentDocument[]> {
        if (!volumeIds.length)
            return [];
        const afterFilter = this.idAfterFilter(afterId);
        const query: Filter<ContentDocument> = {
            isFile: true,
            ...(afterFilter ?? {}),
            $or: [{ dataVolumes: { $in: volumeIds } }, { parityVolumes: { $in: volumeIds } }]
        };
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
        if (opts?.excludeDead)
            (query as Record<string, unknown>).recoveryComment = { $exists: false };
        return this.collection.countDocuments(query);
    }

    // Atomic ref-flip after a slice is relocated + verified: only applies if the object still
    // references the source volume (safe against re-runs and concurrent changes). move-then-flip.
    async replaceObjectVolumeRef(id: ObjectIdentifier, fromVolumeId: number, dataVolumes: number[], parityVolumes: number[]): Promise<boolean> {
        const result = await this.collection.updateOne(
            { _id: this.toMongoId(id) as ObjectId, $or: [{ dataVolumes: fromVolumeId }, { parityVolumes: fromVolumeId }] },
            { $set: { dataVolumes, parityVolumes } }
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
        const components = typeof path === 'string'
            ? path.split('/').filter(component => component.length > 0)
            : [ ...path ];

        let containerId: string | null = null;
        let shouldSkipLookup = false;

        while (components.length) {
            const name = components.shift();
            if (!name) continue;

            const cachedId = this.cache.get(name, containerId);
            if (cachedId) {
                containerId = cachedId;
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

                const insertDoc: ContentDocument = {
                    containerId: this.toMongoId(containerId),
                    name,
                    isContainer: true
                };
                const insertResult = await this.collection.insertOne(insertDoc);
                object = {
                    ...insertDoc,
                    _id: insertResult.insertedId
                };

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
        }

        return containerId;
    }
}
