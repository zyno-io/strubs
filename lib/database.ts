import { Collection, Db, MongoClient, ObjectId } from 'mongodb';

import { createLogger } from './log';
import { createError } from './helpers';
import { config } from './config';
import { ContainerCache } from './database/container-cache';
import { ContentRepository } from './database/content-repository';
import { VolumeRepository, type VolumeVerifyErrors } from './database/volume-repository';
import { RuntimeConfigRepository } from './database/runtime-config';
import type { ContainerPath, ContentDocument, ObjectIdentifier, SliceErrorInfo } from './database/types';
export type { ContentDocument, SliceErrorInfo } from './database/types';

const log = createLogger('database');

export class Database {
    private _client: MongoClient | null = null;
    private _db: Db | null = null;
    private _collections: {
        volumes: Collection<any> | null;
        content: Collection<ContentDocument> | null;
        runtimeConfig: Collection<{ key: string; value: unknown }> | null;
    } = {
        volumes: null,
        content: null,
        runtimeConfig: null
    };
    private readonly _containerCache = new ContainerCache();
    private _repositories: {
        volumes: VolumeRepository | null;
        content: ContentRepository | null;
        runtimeConfig: RuntimeConfigRepository | null;
    } = {
        volumes: null,
        content: null,
        runtimeConfig: null
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
            this._repositories = {
                volumes: new VolumeRepository(this._collections.volumes),
                content: new ContentRepository(
                    this._collections.content,
                    this._containerCache,
                    this._normalizeObject.bind(this),
                    this.getMongoId.bind(this)
                ),
                runtimeConfig: new RuntimeConfigRepository(this._collections.runtimeConfig)
            };
            await this.ensureContentIndexes();

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

    async updateVolumeFlags(id: number, changes: { isEnabled?: boolean; isReadOnly?: boolean; isDeleted?: boolean }): Promise<void> {
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

    async findObjectsNeedingVerification(startedAt: Date, limit: number, volumeIds?: number[]): Promise<ContentDocument[]> {
        return this.contentRepository.findObjectsNeedingVerification(startedAt, limit, volumeIds);
    }

    async updateObjectVerificationState(
        id: ObjectIdentifier,
        updates: { lastVerifiedAt?: Date; sliceErrors?: Record<string, SliceErrorInfo> | null }
    ): Promise<void> {
        await this.contentRepository.updateObjectVerificationState(id, updates);
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
            await this.contentCollection.createIndexes([
                { key: { containerId: 1, name: 1 }, name: 'containerContents', unique: true },
                { key: { containerId: 1 }, name: 'containerId' },
                { key: { lastVerifiedAt: 1 }, name: 'lastVerifiedAt' },
                { key: { sliceErrors: 1 }, name: 'sliceErrors', sparse: true }
            ]);
        }
        catch (err) {
            log.error('failed to ensure content indexes', err);
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

    private get runtimeConfigRepository(): RuntimeConfigRepository {
        if (!this._repositories.runtimeConfig) {
            this._repositories.runtimeConfig = new RuntimeConfigRepository(this.runtimeConfigCollection);
        }
        return this._repositories.runtimeConfig;
    }
}

export const database = new Database();
