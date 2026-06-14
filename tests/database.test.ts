import { describe, beforeAll, afterAll, beforeEach, it, expect, vi, type SpyInstance } from 'vitest';
import { MongoClient, ObjectId } from 'mongodb';
import { ContentRepository } from '../lib/database/content-repository';
import { VolumeRepository } from '../lib/database/volume-repository';

type DatabaseClass = typeof import('../lib/database').Database;

describe('database helpers', () => {
    let DatabaseCtor: DatabaseClass;
    let setIntervalSpy: SpyInstance | null = null;

    let intervalCallbackInvoked = false;

    beforeAll(async () => {
        setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: (...args: any[]) => void) => {
            if (!intervalCallbackInvoked) {
                handler();
                intervalCallbackInvoked = true;
            }
            return {} as unknown as NodeJS.Timeout;
        }) as typeof setInterval);
        ({ Database: DatabaseCtor } = await import('../lib/database'));
    });

    afterAll(() => {
        setIntervalSpy?.mockRestore();
    });

    const createDatabase = () => new DatabaseCtor();

    const createDbWithCollections = () => {
        const db = createDatabase();
        const volumes = {
            find: vi.fn()
        };
        const content = {
            find: vi.fn(),
            findOne: vi.fn(),
            aggregate: vi.fn(),
            insertOne: vi.fn(),
            deleteOne: vi.fn(),
            updateOne: vi.fn(),
            updateMany: vi.fn(),
            createIndexes: vi.fn().mockResolvedValue([])
        };
        const storageStats = {
            findOne: vi.fn(),
            updateOne: vi.fn()
        };
        (db as any)._collections = { volumes, content, storageStats };
        (db as any)._repositories = {
            volumes: new VolumeRepository(volumes as any),
            content: new ContentRepository(
                content as any,
                (db as any)._containerCache,
                (db as any)._normalizeObject.bind(db),
                db.getMongoId.bind(db)
            )
        };
        return { db, volumes, content, storageStats };
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('converts different identifier inputs into Mongo ObjectIds', () => {
        const db = createDatabase();
        const objectId = new ObjectId();
        const idStr = objectId.toHexString();
        const idBuf = Buffer.from(idStr, 'hex');

        expect(db.getMongoId(objectId)).toStrictEqual(objectId);
        expect(db.getMongoId(idStr)?.toHexString()).toBe(idStr);
        expect(db.getMongoId(idBuf)?.toHexString()).toBe(idStr);
        expect(db.getMongoId(null)).toBeNull();
        expect(() => db.getMongoId(42 as unknown as string)).toThrow('unhandled mongo ID type');
    });

    it('normalizes database documents', () => {
        const db = createDatabase();
        const objectId = new ObjectId();
        const containerId = new ObjectId();
        const normalized = (db as any)._normalizeObject({
            _id: objectId,
            containerId,
            name: 'photos',
            isContainer: true
        });

        expect(normalized.id).toBe(objectId.toHexString());
        expect(normalized.containerId).toBe(containerId.toHexString());
        expect(normalized._id).toBeUndefined();
        expect(normalized.name).toBe('photos');
    });

    it('normalizes documents that already expose an id field', () => {
        const db = createDatabase();
        const normalized = (db as any)._normalizeObject({
            id: 'custom-id',
            containerId: 'root',
            name: 'folder'
        });
        expect(normalized.id).toBe('custom-id');
    });

    it('throws when normalizing objects without identifiers', () => {
        const db = createDatabase();
        expect(() => (db as any)._normalizeObject({ name: 'broken' }))
            .toThrow('object missing identifier');
    });

    it('preserves null container identifiers when normalizing', () => {
        const db = createDatabase();
        const normalized = (db as any)._normalizeObject({
            id: 'abc',
            containerId: null,
            name: 'root'
        });
        expect(normalized.containerId).toBeNull();
    });

    it('omits container identifiers when they are undefined', () => {
        const db = createDatabase();
        const normalized = (db as any)._normalizeObject({
            id: 'xyz',
            name: 'file',
            containerId: undefined
        });
        expect(normalized).not.toHaveProperty('containerId');
    });

    it('derives timestamps from object ids', () => {
        const db = createDatabase();
        const createdAt = Date.now();
        const objectId = new ObjectId();

        const timestamp = db.getTimestampFromId(objectId);
        const delta = Math.abs(timestamp - createdAt);

        expect(delta).toBeLessThan(2000);
    });

    it('derives timestamps from string identifiers', () => {
        const db = createDatabase();
        const objectId = new ObjectId();
        const timestamp = db.getTimestampFromId(objectId.toHexString());
        expect(timestamp).toBeGreaterThan(0);
    });

    it('throws when collections are not initialized', async () => {
        const db = createDatabase();
        await expect(db.getVolumes()).rejects.toThrow('database not initialized');
        await expect(db.getObjectById(new ObjectId().toHexString())).rejects.toThrow('database not initialized');
    });

    it('connects to MongoDB and initializes collections', async () => {
        const db = createDatabase();
        const volumes = { volume: true };
        const content = {
            content: true,
            createIndexes: vi.fn().mockResolvedValue([]),
            indexes: vi.fn().mockResolvedValue([]),
            dropIndex: vi.fn().mockResolvedValue({})
        };
        const collection = vi.fn((name: string) => name === 'volumes' ? volumes : content);
        const mockDb = { collection };
        const mockClient = { db: vi.fn().mockReturnValue(mockDb) };
        const connectSpy = vi.spyOn(MongoClient, 'connect').mockResolvedValue(mockClient as any);

        await db.connect();

        expect(connectSpy).toHaveBeenCalledWith(
            'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin'
        );
        expect((db as any)._collections.volumes).toBe(volumes);
        expect((db as any)._collections.content).toBe(content);

        connectSpy.mockRestore();
    });

    it('drops invalid compound slice verification indexes during connect', async () => {
        const db = createDatabase();
        const volumes = { volume: true };
        const content = {
            createIndexes: vi.fn().mockResolvedValue([]),
            indexes: vi.fn().mockResolvedValue([
                { name: '_id_' },
                { name: 'dataVolume0Verification' },
                { name: 'parityVolume1Verification' },
                { name: 'dataVolumes' }
            ]),
            dropIndex: vi.fn().mockResolvedValue({})
        };
        const collection = vi.fn((name: string) => name === 'volumes' ? volumes : content);
        const mockDb = { collection };
        const mockClient = { db: vi.fn().mockReturnValue(mockDb) };
        const connectSpy = vi.spyOn(MongoClient, 'connect').mockResolvedValue(mockClient as any);

        await db.connect();

        expect(content.dropIndex).toHaveBeenCalledWith('dataVolume0Verification');
        expect(content.dropIndex).toHaveBeenCalledWith('parityVolume1Verification');
        expect(content.dropIndex).not.toHaveBeenCalledWith('dataVolumes');

        connectSpy.mockRestore();
    });

    it('wraps connection failures in a DBFAIL error', async () => {
        const db = createDatabase();
        const connectSpy = vi.spyOn(MongoClient, 'connect').mockRejectedValue(new Error('boom'));
        await expect(db.connect()).rejects.toMatchObject({ code: 'DBFAIL' });
        connectSpy.mockRestore();
    });

    it('retrieves volume configuration data', async () => {
        const { db, volumes } = createDbWithCollections();
        const toArray = vi.fn().mockResolvedValue([{ id: 1 }]);
        volumes.find.mockReturnValue({ toArray });

        const result = await db.getVolumes();

        expect(volumes.find).toHaveBeenCalledWith({});
        expect(result).toEqual([{ id: 1 }]);
    });

    it('creates object records with normalized identifiers', async () => {
        const { db, content } = createDbWithCollections();
        const id = new ObjectId().toHexString();
        const containerId = new ObjectId().toHexString();
        content.insertOne.mockResolvedValue({});

        await db.createObjectRecord({
            id,
            containerId,
            name: 'photo.jpg',
            isFile: true,
            size: 42,
            chunkSize: 8,
            dataVolumes: [1],
            parityVolumes: [2]
        });

        const insertDoc = content.insertOne.mock.calls[0][0];
        expect(insertDoc._id.toHexString()).toBe(id);
        expect(insertDoc.containerId?.toHexString()).toBe(containerId);
        expect(insertDoc.name).toBe('photo.jpg');
    });

    it('looks up objects by id and normalizes responses', async () => {
        const { db, content } = createDbWithCollections();
        const id = new ObjectId();
        content.findOne.mockResolvedValue({
            _id: id,
            name: 'doc',
            containerId: new ObjectId()
        });

        const result = await db.getObjectById(id.toHexString());

        expect(content.findOne).toHaveBeenCalledWith({ _id: expect.any(ObjectId) });
        expect(result.id).toBe(id.toHexString());
    });

    it('throws ENOENT when getObjectById cannot find a record', async () => {
        const { db, content } = createDbWithCollections();
        content.findOne.mockResolvedValue(null);
        await expect(db.getObjectById(new ObjectId().toHexString())).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('lists objects in a container', async () => {
        const { db, content } = createDbWithCollections();
        const containerId = new ObjectId();
        const toArray = vi.fn().mockResolvedValue([
            { _id: new ObjectId(), name: 'a', isContainer: true },
            { _id: new ObjectId(), name: 'b', isFile: true }
        ]);
        content.find.mockReturnValue({ toArray });

        const results = await db.getObjectsInContainer(containerId.toHexString());

        expect(content.find).toHaveBeenCalledWith(
            { containerId: expect.any(ObjectId) },
            { projection: { _id: 1, name: 1, isFile: 1, isContainer: 1, size: 1 } }
        );
        expect(results).toHaveLength(2);
        expect(results[0]).toHaveProperty('id');
    });

    it('lists objects within a container path', async () => {
        const { db, content } = createDbWithCollections();
        const containerId = new ObjectId();
        content.findOne.mockResolvedValue({
            _id: containerId,
            name: 'photos',
            isContainer: true,
            containerId: null
        });
        const toArray = vi.fn().mockResolvedValue([{ _id: new ObjectId(), name: 'x', isFile: true }]);
        content.find.mockReturnValue({ toArray });

        const results = await db.getObjectsInContainerPath('photos');

        expect(content.findOne).toHaveBeenCalledWith({ containerId: null, name: 'photos' });
        expect(results).toHaveLength(1);
    });

    it('lists root container objects when the path is empty', async () => {
        const { db, content } = createDbWithCollections();
        const toArray = vi.fn().mockResolvedValue([]);
        content.find.mockReturnValue({ toArray });
        await db.getObjectsInContainerPath('');
        expect(content.find).toHaveBeenCalledWith({ containerId: null }, expect.any(Object));
    });

    it('throws when container traversal hits a non-container object', async () => {
        const { db, content } = createDbWithCollections();
        content.findOne.mockResolvedValue({
            _id: new ObjectId(),
            name: 'file.txt',
            isContainer: false
        });

        await expect(db.getContainer('file.txt')).rejects.toMatchObject({ code: 'ENOTDIR' });
    });

    it('uses existing container nodes before creating the rest of the path', async () => {
        const { db, content } = createDbWithCollections();
        const existingContainerId = new ObjectId();
        content.findOne
            .mockResolvedValueOnce({
                _id: existingContainerId,
                name: 'photos',
                isContainer: true
            })
            .mockResolvedValue(null);

        const newId = new ObjectId();
        content.insertOne.mockResolvedValue({ insertedId: newId });

        const result = await db.getContainer('photos/2025', true);

        expect(result).toBe(newId.toHexString());
        expect(content.findOne).toHaveBeenCalledTimes(2);
    });

    it('retrieves objects by path', async () => {
        const { db, content } = createDbWithCollections();
        const containerId = new ObjectId();
        const objectId = new ObjectId();
        content.findOne
            .mockResolvedValueOnce({
                _id: containerId,
                name: 'docs',
                isContainer: true,
                containerId: null
            })
            .mockResolvedValueOnce({
                _id: objectId,
                name: 'file.txt',
                containerId
            });

        const result = await db.getObjectByPath('docs/file.txt');

        expect(content.findOne).toHaveBeenCalledWith({
            containerId: expect.any(ObjectId),
            name: 'file.txt'
        });
        expect(result.id).toBe(objectId.toHexString());
    });

    it('throws when object path lacks a terminal component', async () => {
        const db = createDatabase();
        await expect(db.getObjectByPath('')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('throws when an object path cannot be resolved', async () => {
        const { db, content } = createDbWithCollections();
        content.findOne.mockResolvedValue(null);
        await expect(db.getObjectByPath('ghost')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('caches container lookups returned by getObjectByPath', async () => {
        const { db, content } = createDbWithCollections();
        const objectId = new ObjectId();
        content.findOne.mockResolvedValue({
            _id: objectId,
            name: 'folder',
            isContainer: true,
            containerId: null
        });

        await db.getObjectByPath('folder');

        const cache = (db as any)._containerCache;
        expect(cache.get('folder', null)).toBe(objectId.toHexString());
    });

    it('deletes objects by identifier', async () => {
        const { db, content } = createDbWithCollections();
        content.deleteOne.mockResolvedValue({});

        const id = new ObjectId().toHexString();
        await db.deleteObjectById(id);

        expect(content.deleteOne).toHaveBeenCalledWith({ _id: expect.any(ObjectId) });
    });

    it('finds targeted objects by stale per-slice verification time', async () => {
        const { db, content } = createDbWithCollections();
        const startedAt = new Date('2026-06-14T00:00:00.000Z');
        const toArray = vi.fn().mockResolvedValue([]);
        content.find.mockReturnValue({ toArray });

        await db.findObjectsOnVolumesNeedingVerification(startedAt, 25, [2]);

        const [query, options] = content.find.mock.calls[0];
        expect(query).toEqual(expect.objectContaining({
            isFile: true,
            $or: expect.arrayContaining([
                expect.objectContaining({
                    'dataVolumes.0': { $in: [2] },
                    $and: expect.arrayContaining([
                        expect.objectContaining({
                            $or: expect.arrayContaining([
                                { 'sliceVerificationTimes.data.0': { $lt: startedAt } },
                                { 'sliceVerificationTimes.data.0': { $exists: false } },
                                { 'sliceVerificationTimes.data.0': null }
                            ])
                        }),
                        expect.objectContaining({
                            $or: expect.arrayContaining([
                                { lastVerifiedAt: { $lt: startedAt } },
                                { lastVerifiedAt: { $exists: false } },
                                { lastVerifiedAt: null }
                            ])
                        })
                    ])
                })
            ])
        }));
        expect(options).toEqual({ sort: { _id: 1 }, limit: 25 });
    });

    it('persists slice verification times with verification state updates', async () => {
        const { db, content } = createDbWithCollections();
        const id = new ObjectId().toHexString();
        const verifiedAt = new Date('2026-06-14T01:00:00.000Z');
        content.updateOne.mockResolvedValue({});

        await db.updateObjectVerificationState(id, {
            lastVerifiedAt: verifiedAt,
            sliceErrors: null,
            sliceVerificationTimes: {
                data: [verifiedAt],
                parity: []
            }
        });

        expect(content.updateOne).toHaveBeenCalledWith(
            { _id: expect.any(ObjectId) },
            {
                $set: {
                    lastVerifiedAt: verifiedAt,
                    sliceVerificationTimes: {
                        data: [verifiedAt],
                        parity: []
                    }
                },
                $unset: { sliceErrors: '' }
            }
        );
    });

    it('computes storage stats from content aggregation results', async () => {
        const { db, content } = createDbWithCollections();
        const aggregateResults = [
            [{ objectCount: 2, logicalBytes: 30, dataSliceCount: 4, paritySliceCount: 2, dataBytes: 400, parityBytes: 200 }],
            [{ volumeId: 1, sliceCount: 2, bytes: 200 }],
            [{ volumeId: 3, sliceCount: 2, bytes: 200 }],
            [{ volumeId: 1, objectCount: 2, logicalBytes: 30 }, { volumeId: 3, objectCount: 2, logicalBytes: 30 }],
            [{ objectCount: 1, logicalBytes: 10 }]
        ];
        content.aggregate.mockImplementation(() => ({
            toArray: vi.fn().mockResolvedValue(aggregateResults.shift() ?? [])
        }));

        const updatedAt = new Date('2026-06-14T00:00:00.000Z');
        const stats = await db.computeStorageStats([1], updatedAt);

        expect(content.aggregate).toHaveBeenCalledTimes(5);
        expect(stats.updatedAt).toBe(updatedAt);
        expect(stats.system).toMatchObject({
            objectCount: 2,
            logicalBytes: 30,
            dataSliceCount: 4,
            paritySliceCount: 2,
            dataBytes: 400,
            parityBytes: 200,
            physicalBytes: 600,
            unavailableObjectCount: 1,
            unavailableLogicalBytes: 10
        });
        expect(stats.volumes['1']).toMatchObject({
            objectCount: 2,
            logicalBytes: 30,
            dataSliceCount: 2,
            dataBytes: 200
        });
        expect(stats.volumes['3']).toMatchObject({
            objectCount: 2,
            logicalBytes: 30,
            paritySliceCount: 2,
            parityBytes: 200
        });
    });

    it('backfills missing slice sizes', async () => {
        const { db, content } = createDbWithCollections();
        content.updateMany.mockResolvedValue({ modifiedCount: 3 });

        const modified = await db.backfillContentSliceSizes();

        expect(modified).toBe(3);
        expect(content.updateMany).toHaveBeenCalledWith(
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
                        sliceSize: expect.any(Object)
                    }
                }
            ]
        );
    });

    it('applies storage stats deltas to the cached snapshot', async () => {
        const { db, storageStats } = createDbWithCollections();
        const updatedAt = new Date('2026-06-14T00:00:00.000Z');
        storageStats.updateOne.mockResolvedValue({});

        await db.applyStorageStatsDelta({
            system: {
                objectCount: 1,
                logicalBytes: 10,
                dataSliceCount: 2,
                paritySliceCount: 1,
                dataBytes: 100,
                parityBytes: 50,
                physicalBytes: 150,
                unavailableObjectCount: 0,
                unavailableLogicalBytes: 0
            },
            volumes: {
                '1': {
                    objectCount: 1,
                    logicalBytes: 10,
                    dataSliceCount: 1,
                    paritySliceCount: 0,
                    dataBytes: 50,
                    parityBytes: 0,
                    physicalBytes: 50
                }
            }
        }, updatedAt);

        expect(storageStats.updateOne).toHaveBeenCalledWith(
            { _id: 'current' },
            expect.objectContaining({
                $set: { updatedAt },
                $inc: expect.objectContaining({
                    'system.objectCount': 1,
                    'system.logicalBytes': 10,
                    'volumes.1.objectCount': 1,
                    'volumes.1.dataBytes': 50
                })
            }),
            { upsert: true }
        );
    });

    it('creates containers when requested and caches the results', async () => {
        const { db, content } = createDbWithCollections();
        const firstId = new ObjectId();
        const secondId = new ObjectId();

        content.findOne.mockResolvedValueOnce(null);
        content.insertOne
            .mockResolvedValueOnce({ insertedId: firstId })
            .mockResolvedValueOnce({ insertedId: secondId });

        const id = await db.getContainer('photos/2024', true);

        expect(id).toBe(secondId.toHexString());
        expect(content.insertOne).toHaveBeenCalledTimes(2);

        content.findOne.mockClear();
        content.insertOne.mockClear();

        const cached = await db.getContainer('photos/2024', false);

        expect(cached).toBe(id);
        expect(content.findOne).not.toHaveBeenCalled();
        expect(content.insertOne).not.toHaveBeenCalled();
    });

    it('skips empty path segments while resolving containers', async () => {
        const { db, content } = createDbWithCollections();
        content.findOne.mockResolvedValue(null);
        const firstId = new ObjectId();
        const secondId = new ObjectId();
        content.insertOne
            .mockResolvedValueOnce({ insertedId: firstId })
            .mockResolvedValueOnce({ insertedId: secondId });

        const id = await db.getContainer('foo//bar', true);
        expect(id).toBe(secondId.toHexString());
        expect(content.insertOne).toHaveBeenCalledTimes(2);
    });

    it('accepts container paths supplied as arrays', async () => {
        const { db, content } = createDbWithCollections();
        content.findOne.mockResolvedValue(null);
        const insertedId = new ObjectId();
        content.insertOne.mockResolvedValue({ insertedId });

        const id = await db.getContainer(['archive'], true);

        expect(id).toBe(insertedId.toHexString());
    });

    it('throws when asked for a container that cannot be created', async () => {
        const { db, content } = createDbWithCollections();
        content.findOne.mockResolvedValue(null);
        await expect(db.getContainer('missing')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('delegates getOrCreateContainer to getContainer', async () => {
        const db = createDatabase();
        const spy = vi.spyOn(db, 'getContainer').mockResolvedValue('abc');
        const result = await db.getOrCreateContainer('foo/bar');
        expect(spy).toHaveBeenCalledWith('foo/bar', true);
        expect(result).toBe('abc');
    });

    it('invokes cache sweeping during cleanup', () => {
        const db = createDatabase();
        const sweepSpy = vi.spyOn((db as any)._containerCache, 'sweep').mockImplementation(() => undefined);
        (db as any)._cleanObjectCache();
        expect(sweepSpy).toHaveBeenCalled();
        sweepSpy.mockRestore();
    });
});
