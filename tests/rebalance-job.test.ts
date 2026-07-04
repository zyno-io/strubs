import { describe, expect, it, vi } from 'vitest';

import { RebalanceJob } from '../lib/jobs/rebalance-job';

const loggerFactory = () => vi.fn(() => Object.assign(vi.fn(), { error: vi.fn() })) as any;

// A volume for the fake pool. bytesFree drives fill(); accountMove mutates these in place.
const vol = (id: number, bytesFree: number, extra?: Record<string, unknown>) => ({
    id, bytesTotal: 100, bytesFree, bytesPending: 0, isWritable: true, isHealthy: true,
    deleteCommittedFile: vi.fn().mockResolvedValue(undefined), ...extra
});

// object with its slice on the source volume; `slot` decides data (0) vs parity index
const objectDoc = (sourceId: number, slot: 'data' | 'parity') => slot === 'data'
    ? { id: 'obj1', dataVolumes: [sourceId, 10, 11, 12], parityVolumes: [13, 14], size: 160, sliceSize: 40 }
    : { id: 'obj1', dataVolumes: [10, 11, 12, 15], parityVolumes: [sourceId, 14], size: 160, sliceSize: 40 };

const loadedFor = (doc: any) => ({ dataSliceVolumeIds: [...doc.dataVolumes], paritySliceVolumeIds: [...doc.parityVolumes], dataSliceCount: 4, sliceSize: 40 });

const makeJob = (vols: any[], doc: any, overrides?: any) => {
    const deps = {
        database: {
            findObjectsOnVolume: vi.fn().mockResolvedValueOnce(doc ? [doc] : []).mockResolvedValue([]),
            replaceObjectVolumeRef: vi.fn().mockResolvedValue(true)
        },
        getVolumes: () => vols,
        getVolume: (id: number) => vols.find(v => v.id === id),
        loadObject: vi.fn().mockResolvedValue(doc ? loadedFor(doc) : undefined),
        tryCopyRelocate: vi.fn().mockResolvedValue(true),
        repairSlice: vi.fn().mockResolvedValue(undefined),
        deleteSourceSlice: vi.fn().mockResolvedValue(true),
        recordRelocated: vi.fn(),
        runtimeConfig: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
        isFrozen: vi.fn().mockResolvedValue(false),
        createLogger: loggerFactory(),
        concurrency: 3,
        delayMs: 0,
        ...overrides
    };
    return { job: new RebalanceJob(deps), deps };
};

const run = (job: RebalanceJob) => (job as unknown as { run(): Promise<void> }).run();

describe('RebalanceJob', () => {
    // pool: source 95% full, target 20%, mid 50% -> avg 55%, deadband 5% -> source>60, target<50
    const pool = () => [vol(1, 5), vol(2, 80), vol(3, 50)];

    it('moves a data slice off the over-full source onto an under-full target, flips ref, deletes source', async () => {
        const doc = objectDoc(1, 'data');
        const { job, deps } = makeJob(pool(), doc);
        await run(job);

        expect(deps.tryCopyRelocate).toHaveBeenCalledTimes(1);          // data slice -> copy-first
        expect(deps.repairSlice).not.toHaveBeenCalled();
        // flip: source 1 -> target 2, with the distinct-volume (toVolumeId) guard
        expect(deps.database.replaceObjectVolumeRef).toHaveBeenCalledWith('obj1', 1, 2);
        expect(deps.deleteSourceSlice).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'obj1.0');
        expect(deps.recordRelocated).toHaveBeenCalledWith(1, 2, 160, 40, false); // stats: source 1 -> dest 2
    });

    it('recomputes (reconstructs) parity slices instead of copying them', async () => {
        const doc = objectDoc(1, 'parity'); // slice on volume 1 is a parity slice (index 4)
        const { job, deps } = makeJob(pool(), doc);
        await run(job);

        expect(deps.tryCopyRelocate).not.toHaveBeenCalled();            // parity is never byte-copied
        expect(deps.repairSlice).toHaveBeenCalledTimes(1);
        expect(deps.database.replaceObjectVolumeRef).toHaveBeenCalledWith('obj1', 1, 2);
    });

    it('does nothing when the pool is already balanced (no source over the deadband)', async () => {
        const { job, deps } = makeJob([vol(1, 50), vol(2, 50), vol(3, 50)], objectDoc(1, 'data'));
        await run(job);
        expect(deps.database.findObjectsOnVolume).not.toHaveBeenCalled();
        expect(deps.tryCopyRelocate).not.toHaveBeenCalled();
    });

    it('never targets a failing (unhealthy) volume', async () => {
        // only under-target volume is failing -> no eligible target
        const vols = [vol(1, 5), vol(2, 80, { isHealthy: false }), vol(3, 50)];
        const { job, deps } = makeJob(vols, objectDoc(1, 'data'));
        await run(job);
        expect(deps.tryCopyRelocate).not.toHaveBeenCalled();
        expect(deps.database.replaceObjectVolumeRef).not.toHaveBeenCalled();
    });

    it('does not move when the object already uses every under-target volume (no dest)', async () => {
        // object already on vol 2 (the only under-target) -> distinct-volume blocks it
        const doc = { id: 'obj1', dataVolumes: [1, 2, 11, 12], parityVolumes: [13, 14], size: 160, sliceSize: 40 };
        const { job, deps } = makeJob(pool(), doc);
        await run(job);
        expect(deps.database.replaceObjectVolumeRef).not.toHaveBeenCalled();
    });

    it('drops the placed copy and does not delete the source when the ref flip loses a race', async () => {
        const doc = objectDoc(1, 'data');
        const { job, deps } = makeJob(pool(), doc, {
            database: { findObjectsOnVolume: vi.fn().mockResolvedValueOnce([doc]).mockResolvedValue([]), replaceObjectVolumeRef: vi.fn().mockResolvedValue(false) }
        });
        await run(job);
        expect(deps.deleteSourceSlice).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), 'obj1.0'); // clean up the target copy
        expect(deps.deleteSourceSlice).not.toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'obj1.0'); // source kept
    });

    it('does not run while the maintenance freeze is active', async () => {
        const { job, deps } = makeJob(pool(), objectDoc(1, 'data'), { isFrozen: vi.fn().mockResolvedValue(true) });
        await run(job);
        expect(deps.database.findObjectsOnVolume).not.toHaveBeenCalled();
    });

    it('cancel() clears persisted rebalance state', async () => {
        const { job, deps } = makeJob(pool(), null);
        await job.cancel();
        expect(deps.runtimeConfig.delete).toHaveBeenCalledWith('rebalanceActive');
        expect(deps.runtimeConfig.delete).toHaveBeenCalledWith('rebalanceCursor');
    });
});
