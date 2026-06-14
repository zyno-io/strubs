import { Collection, ObjectId, type Filter } from 'mongodb';

import { config } from '../config';
import { createError } from '../helpers';
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

    async findObjectsNeedingVerification(startedAt: Date, limit: number, volumeIds?: number[]): Promise<ContentDocument[]> {
        const staleSliceConditions = Array.isArray(volumeIds) && volumeIds.length
            ? this.buildStaleSliceConditions(startedAt, volumeIds)
            : [];
        const conditions: Filter<ContentDocument>[] = staleSliceConditions.length
            ? [{ $or: staleSliceConditions }]
            : [this.timestampIsStale('lastVerifiedAt', startedAt)];
        const query: Filter<ContentDocument> = {
            isFile: true,
            $and: conditions
        };
        const cursor = this.collection.find<ContentDocument>(query, {
            sort: { _id: 1 },
            limit
        });
        const objects = await cursor.toArray();
        return objects.map(object => this.normalize(object));
    }

    // Targeted verification resumes by per-slice timestamps. Objects already
    // stamped for every requested volume slice at this run's start time fall out
    // of the query, so a restart continues without a separate cursor.
    async findObjectsOnVolumesNeedingVerification(startedAt: Date, limit: number, volumeIds: number[]): Promise<ContentDocument[]> {
        const staleSliceConditions = this.buildStaleSliceConditions(startedAt, volumeIds);
        if (!staleSliceConditions.length)
            return [];
        const query: Filter<ContentDocument> = {
            isFile: true,
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
