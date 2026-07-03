import { describe, expect, it, vi } from 'vitest';

import { EvictVolumeJob } from '../lib/jobs/evict-volume-job';

const loggerFactory = () => vi.fn(() => Object.assign(vi.fn(), { error: vi.fn() })) as any;

// object with a slice on the evicting volume (index 0 = volume 5)
const objectDoc = (overrides?: Record<string, unknown>) => ({
    _id: 'obj1',
    dataVolumes: [5, 10, 11, 12],
    parityVolumes: [13, 14],
    size: 4000,
    sliceSize: 1000,
    ...overrides
});

const loadedObject = () => ({ dataSliceVolumeIds: [5, 10, 11, 12], paritySliceVolumeIds: [13, 14], dataSliceCount: 4, sliceSize: 1000 });

const makeJob = (overrides?: any) => {
    const deps = {
        database: {
            findObjectsOnVolume: vi.fn().mockResolvedValueOnce([objectDoc()]).mockResolvedValue([]),
            replaceObjectVolumeRef: vi.fn().mockResolvedValue(true),
            getObjectById: vi.fn()
        },
        getWritableVolumes: vi.fn(() => [
            { id: 20, bytesFree: 5e9, bytesPending: 0 },
            { id: 21, bytesFree: 9e9, bytesPending: 0 }
        ]),
        getVolume: vi.fn(() => ({ id: 5, isReadable: true })),
        tryCopyRelocate: vi.fn().mockResolvedValue(false), // default: copy declines -> reconstruct path
        loadObject: vi.fn().mockResolvedValue(loadedObject()),
        repairSlice: vi.fn().mockResolvedValue(undefined),
        runtimeConfig: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
        isFrozen: vi.fn().mockResolvedValue(false),
        createLogger: loggerFactory(),
        concurrency: 4,
        delayMs: 0,
        ...overrides
    };
    return { job: new EvictVolumeJob(deps), deps };
};

const runDrain = (job: EvictVolumeJob, volumeId: number) => (job as unknown as { run(v: number, a?: string): Promise<void> }).run(volumeId, undefined);

describe('EvictVolumeJob', () => {
    it('reconstructs + relocates a recoverable slice onto an unused healthy volume and flips the ref', async () => {
        const { job, deps } = makeJob();
        await runDrain(job, 5);

        // target is a writable volume the object does not already use, emptiest-first (21 has more free)
        expect(deps.repairSlice).toHaveBeenCalledTimes(1);
        const [relocatedObject, sliceIndex] = deps.repairSlice.mock.calls[0];
        expect(sliceIndex).toBe(0);
        expect(relocatedObject.dataSliceVolumeIds[0]).toBe(21); // repointed off volume 5 before rebuild
        expect(deps.database.replaceObjectVolumeRef).toHaveBeenCalledWith('obj1', 5, [21, 10, 11, 12], [13, 14], 21);
    });

    it('uses copy-first when the source is online and the copy validates (no reconstruction)', async () => {
        const { job, deps } = makeJob({ tryCopyRelocate: vi.fn().mockResolvedValue(true) });
        await runDrain(job, 5);

        expect(deps.tryCopyRelocate).toHaveBeenCalledTimes(1);
        expect(deps.repairSlice).not.toHaveBeenCalled(); // copy succeeded -> no RS
        expect(deps.database.replaceObjectVolumeRef).toHaveBeenCalledWith('obj1', 5, [21, 10, 11, 12], [13, 14], 21);
    });

    it('falls back to reconstruction when the copy declines or fails', async () => {
        const { job, deps } = makeJob({ tryCopyRelocate: vi.fn().mockResolvedValue(false) });
        await runDrain(job, 5);

        expect(deps.tryCopyRelocate).toHaveBeenCalledTimes(1);
        expect(deps.repairSlice).toHaveBeenCalledTimes(1);
        expect(deps.database.replaceObjectVolumeRef).toHaveBeenCalled();
    });

    it('cancel() clears persisted evict state so it does not resume', async () => {
        const { job, deps } = makeJob();
        await job.cancel(5);
        expect(deps.runtimeConfig.delete).toHaveBeenCalledWith('evictVolumeId');
        expect(deps.runtimeConfig.delete).toHaveBeenCalledWith('evictCursorId');
    });

    it('skips documented-dead (recoveryComment) objects without attempting reconstruction', async () => {
        const { job, deps } = makeJob({
            database: {
                findObjectsOnVolume: vi.fn().mockResolvedValueOnce([objectDoc({ recoveryComment: 'drive gone' })]).mockResolvedValue([]),
                replaceObjectVolumeRef: vi.fn().mockResolvedValue(true),
                getObjectById: vi.fn()
            }
        });
        await runDrain(job, 5);

        expect(deps.repairSlice).not.toHaveBeenCalled();
        expect(deps.database.replaceObjectVolumeRef).not.toHaveBeenCalled();
    });

    it('leaves the ref in place when reconstruction fails the md5 gate (ECORRUPT) or is below quorum (EQUORUM)', async () => {
        for (const code of ['ECORRUPT', 'EQUORUM']) {
            const { job, deps } = makeJob({
                repairSlice: vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { code }))
            });
            await runDrain(job, 5);
            expect(deps.database.replaceObjectVolumeRef).not.toHaveBeenCalled();
        }
    });

    it('does not relocate when the object already occupies every healthy volume (no target)', async () => {
        const { job, deps } = makeJob({
            getWritableVolumes: vi.fn(() => [{ id: 10, bytesFree: 9e9, bytesPending: 0 }]) // already used by the object
        });
        await runDrain(job, 5);

        expect(deps.repairSlice).not.toHaveBeenCalled();
        expect(deps.database.replaceObjectVolumeRef).not.toHaveBeenCalled();
    });

    it('excludes volumes without room and picks the emptiest that fits', async () => {
        const { job, deps } = makeJob({
            getWritableVolumes: vi.fn(() => [
                { id: 20, bytesFree: 500, bytesPending: 0 },   // too small for the 1000-byte slice
                { id: 22, bytesFree: 3000, bytesPending: 0 }
            ])
        });
        await runDrain(job, 5);
        expect(deps.repairSlice.mock.calls[0][0].dataSliceVolumeIds[0]).toBe(22);
    });

    it('does not process while the maintenance freeze is active', async () => {
        const { job, deps } = makeJob({ isFrozen: vi.fn().mockResolvedValue(true) });
        await runDrain(job, 5);
        expect(deps.database.findObjectsOnVolume).not.toHaveBeenCalled();
        expect(deps.repairSlice).not.toHaveBeenCalled();
    });

    it('persists a cursor as it advances and clears evict state on completion', async () => {
        const { job, deps } = makeJob();
        await runDrain(job, 5);
        expect(deps.runtimeConfig.set).toHaveBeenCalledWith('evictCursorId', 'obj1');
        expect(deps.runtimeConfig.delete).toHaveBeenCalledWith('evictVolumeId');
        expect(deps.runtimeConfig.delete).toHaveBeenCalledWith('evictCursorId');
    });
});
