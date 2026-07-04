import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageStatsTracker } from '../lib/storage/stats-tracker';

const createLogger = () => {
    const logger = Object.assign(vi.fn(), { error: vi.fn() });
    return vi.fn(() => logger);
};

const createRecord = () => ({
    id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    containerId: null,
    isFile: true,
    name: 'file.bin',
    size: 10,
    md5: null,
    chunkSize: 64,
    sliceSize: 50,
    dataVolumes: [1, 2],
    parityVolumes: [3]
});

describe('StorageStatsTracker', () => {
    beforeEach(() => {
        vi.useRealTimers();
    });

    it('flushes batched object create and delete deltas', async () => {
        const database = {
            applyStorageStatsDelta: vi.fn().mockResolvedValue(undefined),
            getStorageStats: vi.fn(),
            backfillContentSliceSizes: vi.fn().mockResolvedValue(0),
            computeStorageStats: vi.fn(),
            replaceStorageStats: vi.fn(),
            refreshStorageStatsUnavailable: vi.fn()
        };
        const tracker = new StorageStatsTracker({
            database: database as any,
            ioManager: {
                getVolumeEntries: vi.fn(() => [
                    [1, { isReadable: true }],
                    [2, { isReadable: true }],
                    [3, { isReadable: true }]
                ])
            },
            createLogger: createLogger()
        });
        tracker.start({ reconcileIntervalMs: 0, flushIntervalMs: 1000 });

        const record = createRecord();
        tracker.recordCreated(record as any);
        tracker.recordDeleted({ ...record, id: 'bbbbbbbbbbbbbbbbbbbbbbbb' } as any);
        tracker.recordCreated(record as any);
        await tracker.flush();

        expect(database.applyStorageStatsDelta).toHaveBeenCalledTimes(1);
        const delta = database.applyStorageStatsDelta.mock.calls[0][0];
        expect(delta.system).toMatchObject({
            objectCount: 1,
            logicalBytes: 10,
            dataSliceCount: 2,
            paritySliceCount: 1,
            dataBytes: 100,
            parityBytes: 50,
            physicalBytes: 150,
            unavailableObjectCount: 0,
            unavailableLogicalBytes: 0
        });
        expect(delta.volumes['1']).toMatchObject({
            objectCount: 1,
            logicalBytes: 10,
            dataSliceCount: 1,
            dataBytes: 50
        });

        await tracker.stop();
    });

    it('records a slice relocation as a per-volume-only delta (system unchanged)', async () => {
        const database = {
            applyStorageStatsDelta: vi.fn().mockResolvedValue(undefined),
            getStorageStats: vi.fn(),
            backfillContentSliceSizes: vi.fn().mockResolvedValue(0),
            computeStorageStats: vi.fn(),
            replaceStorageStats: vi.fn(),
            refreshStorageStatsUnavailable: vi.fn()
        };
        const tracker = new StorageStatsTracker({
            database: database as any,
            ioManager: { getVolumeEntries: vi.fn(() => [[1, { isReadable: true }], [2, { isReadable: true }]]) },
            createLogger: createLogger()
        });
        tracker.start({ reconcileIntervalMs: 0, flushIntervalMs: 1000 });

        // a 40-byte DATA slice of a 160-byte object moves from vol 1 -> vol 2
        tracker.recordRelocated(1, 2, 160, 40, false);
        await tracker.flush();

        const delta = database.applyStorageStatsDelta.mock.calls[0][0];
        // object still exists -> system totals unchanged
        expect(delta.system).toMatchObject({ objectCount: 0, logicalBytes: 0, dataSliceCount: 0, paritySliceCount: 0, physicalBytes: 0 });
        // source loses the slice, target gains it
        expect(delta.volumes['1']).toMatchObject({ objectCount: -1, logicalBytes: -160, dataSliceCount: -1, dataBytes: -40, physicalBytes: -40 });
        expect(delta.volumes['2']).toMatchObject({ objectCount: 1, logicalBytes: 160, dataSliceCount: 1, dataBytes: 40, physicalBytes: 40 });

        await tracker.stop();
    });

    it('tracks unavailable object deltas against readable volume ids', async () => {
        const database = {
            applyStorageStatsDelta: vi.fn().mockResolvedValue(undefined),
            getStorageStats: vi.fn(),
            backfillContentSliceSizes: vi.fn().mockResolvedValue(0),
            computeStorageStats: vi.fn(),
            replaceStorageStats: vi.fn(),
            refreshStorageStatsUnavailable: vi.fn()
        };
        const tracker = new StorageStatsTracker({
            database: database as any,
            ioManager: {
                getVolumeEntries: vi.fn(() => [
                    [1, { isReadable: true }],
                    [2, { isReadable: false }],
                    [3, { isReadable: false }]
                ])
            },
            createLogger: createLogger()
        });
        tracker.start({ reconcileIntervalMs: 0, flushIntervalMs: 1000 });

        tracker.recordCreated(createRecord() as any);
        await tracker.flush();

        const delta = database.applyStorageStatsDelta.mock.calls[0][0];
        expect(delta.system.unavailableObjectCount).toBe(1);
        expect(delta.system.unavailableLogicalBytes).toBe(10);

        await tracker.stop();
    });

    it('reconciles from readable volume ids', async () => {
        const snapshot = {
            updatedAt: new Date('2026-06-14T00:00:00.000Z'),
            system: {
                objectCount: 0,
                logicalBytes: 0,
                dataSliceCount: 0,
                paritySliceCount: 0,
                dataBytes: 0,
                parityBytes: 0,
                physicalBytes: 0,
                unavailableObjectCount: 0,
                unavailableLogicalBytes: 0
            },
            volumes: {}
        };
        const database = {
            applyStorageStatsDelta: vi.fn().mockResolvedValue(undefined),
            getStorageStats: vi.fn(),
            backfillContentSliceSizes: vi.fn().mockResolvedValue(2),
            computeStorageStats: vi.fn().mockResolvedValue(snapshot),
            replaceStorageStats: vi.fn().mockResolvedValue(undefined),
            refreshStorageStatsUnavailable: vi.fn()
        };
        const tracker = new StorageStatsTracker({
            database: database as any,
            ioManager: {
                getVolumeEntries: vi.fn(() => [
                    [1, { isReadable: true }],
                    [2, { isReadable: false }],
                    [3, {}]
                ])
            },
            createLogger: createLogger()
        });

        await tracker.reconcile();

        expect(database.computeStorageStats.mock.calls[0][0]).toEqual([1, 3]);
        expect(database.backfillContentSliceSizes).toHaveBeenCalledTimes(1);
        expect(database.backfillContentSliceSizes.mock.invocationCallOrder[0])
            .toBeLessThan(database.computeStorageStats.mock.invocationCallOrder[0]);
        expect(database.replaceStorageStats).toHaveBeenCalledWith(snapshot);
    });

    it('refreshes only unavailable counters when cached readable volumes are stale', async () => {
        const cached = {
            updatedAt: new Date('2026-06-14T00:00:00.000Z'),
            readableVolumeIds: [1, 2, 3],
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
            volumes: {}
        };
        const refreshed = {
            ...cached,
            readableVolumeIds: [1, 3],
            system: { ...cached.system, unavailableObjectCount: 1, unavailableLogicalBytes: 10 }
        };
        const database = {
            applyStorageStatsDelta: vi.fn().mockResolvedValue(undefined),
            getStorageStats: vi.fn().mockResolvedValue(cached),
            backfillContentSliceSizes: vi.fn().mockResolvedValue(0),
            computeStorageStats: vi.fn(),
            replaceStorageStats: vi.fn(),
            refreshStorageStatsUnavailable: vi.fn().mockResolvedValue(refreshed)
        };
        const tracker = new StorageStatsTracker({
            database: database as any,
            ioManager: {
                getVolumeEntries: vi.fn(() => [
                    [1, { isReadable: true }],
                    [2, { isReadable: false }],
                    [3, {}]
                ])
            },
            createLogger: createLogger()
        });

        const snapshot = await tracker.getSnapshot();

        expect(snapshot).toBe(refreshed);
        expect(database.computeStorageStats).not.toHaveBeenCalled();
        expect(database.replaceStorageStats).not.toHaveBeenCalled();
        expect(database.refreshStorageStatsUnavailable).toHaveBeenCalledWith([1, 3], expect.any(Date));
    });
});
