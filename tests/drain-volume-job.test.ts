import { describe, expect, it, vi } from 'vitest';

import { DrainVolumeJob } from '../lib/jobs/drain-volume-job';

const loggerFactory = () => vi.fn(() => Object.assign(vi.fn(), { error: vi.fn() })) as any;

// object with a slice on the draining volume (index 0 = volume 5)
const objectDoc = (overrides?: Record<string, unknown>) => ({
    id: 'obj1',
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
            getObjectById: vi.fn(),
            countObjectsOnVolume: vi.fn().mockResolvedValue(0) // volume fully drained after the pass
        },
        getWritableVolumes: vi.fn(() => [
            { id: 20, bytesFree: 5e9, bytesPending: 0 },
            { id: 21, bytesFree: 9e9, bytesPending: 0 }
        ]),
        getVolume: vi.fn(() => ({ id: 5, isReadable: true })),
        getDrainingVolumeIds: vi.fn(() => []),
        tryCopyRelocate: vi.fn().mockResolvedValue(false), // default: copy declines -> reconstruct path
        loadObject: vi.fn().mockResolvedValue(loadedObject()),
        repairSlice: vi.fn().mockResolvedValue(undefined),
        deleteSlice: vi.fn().mockResolvedValue(undefined),
        markDrainComplete: vi.fn().mockResolvedValue(undefined),
        recordRelocated: vi.fn(),
        runtimeConfig: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
        isFrozen: vi.fn().mockResolvedValue(false),
        relocateJournalOff: vi.fn().mockResolvedValue(undefined),
        createLogger: loggerFactory(),
        concurrency: 4,
        delayMs: 0,
        ...overrides
    };
    return { job: new DrainVolumeJob(deps), deps };
};

const runDrain = (job: DrainVolumeJob, volumeId: number) => (job as unknown as { run(v: number, a?: string): Promise<void> }).run(volumeId, undefined);

describe('DrainVolumeJob', () => {
    it('reconstructs + relocates a recoverable slice onto an unused healthy volume and flips the ref', async () => {
        const { job, deps } = makeJob();
        await runDrain(job, 5);

        // target is a writable volume the object does not already use, emptiest-first (21 has more free)
        expect(deps.repairSlice).toHaveBeenCalledTimes(1);
        const [relocatedObject, sliceIndex] = deps.repairSlice.mock.calls[0];
        expect(sliceIndex).toBe(0);
        expect(relocatedObject.dataSliceVolumeIds[0]).toBe(21); // repointed off volume 5 before rebuild
        expect(deps.database.replaceObjectVolumeRef).toHaveBeenCalledWith('obj1', 5, 21);
        // storage stats notified of the move: source 5 -> target 21, data slice, size 4000, sliceSize 1000
        expect(deps.recordRelocated).toHaveBeenCalledWith(5, 21, 4000, 1000, false);
    });

    it('an EMPTY recoveryComment does not mean dead — the object is still relocated', async () => {
        // The three call sites had drifted to three different tests for "dead". An empty comment was
        // skipped here (slice left on the volume) yet excluded from countObjectsOnVolume(excludeDead)
        // (volume reported fully drained) -- so the disk could be pulled and the slice silently lost.
        // Dead now means exactly: a NON-EMPTY recoveryComment.
        const doc = objectDoc({ recoveryComment: '' });
        const { job, deps } = makeJob({
            database: {
                findObjectsOnVolume: vi.fn().mockResolvedValueOnce([doc]).mockResolvedValue([]),
                replaceObjectVolumeRef: vi.fn().mockResolvedValue(true),
                getObjectById: vi.fn(),
                countObjectsOnVolume: vi.fn().mockResolvedValue(0)
            }
        });

        await runDrain(job, 5);

        expect(deps.repairSlice).toHaveBeenCalledTimes(1);          // relocated, not skipped
        expect(deps.database.replaceObjectVolumeRef).toHaveBeenCalled();
    });

    it('skips a documented-dead object (non-empty recoveryComment)', async () => {
        const doc = objectDoc({ recoveryComment: 'drive gone, insufficient slices' });
        const { job, deps } = makeJob({
            database: {
                findObjectsOnVolume: vi.fn().mockResolvedValueOnce([doc]).mockResolvedValue([]),
                replaceObjectVolumeRef: vi.fn().mockResolvedValue(true),
                getObjectById: vi.fn(),
                countObjectsOnVolume: vi.fn().mockResolvedValue(0)
            }
        });

        await runDrain(job, 5);

        expect(deps.repairSlice).not.toHaveBeenCalled();
        expect(deps.database.replaceObjectVolumeRef).not.toHaveBeenCalled();
    });

    it('refuses to relocate an object holding two slices on the draining volume', async () => {
        // replaceObjectVolumeRef rewrites EVERY position matching the volume, but a drain relocates one
        // file. Flipping both refs at the single copy would orphan the other slice -- turning a
        // recoverable slice into a lost one, while making the volume look safely drained.
        const doc = objectDoc({ dataVolumes: [5, 5, 11, 12] });
        const { job, deps } = makeJob({
            database: {
                findObjectsOnVolume: vi.fn().mockResolvedValueOnce([doc]).mockResolvedValue([]),
                replaceObjectVolumeRef: vi.fn().mockResolvedValue(true),
                getObjectById: vi.fn(),
                countObjectsOnVolume: vi.fn().mockResolvedValue(1) // still referenced -> not fully drained
            }
        });

        await runDrain(job, 5);

        expect(deps.repairSlice).not.toHaveBeenCalled();
        expect(deps.tryCopyRelocate).not.toHaveBeenCalled();
        expect(deps.database.replaceObjectVolumeRef).not.toHaveBeenCalled();
        expect(deps.deleteSlice).not.toHaveBeenCalled();
        // and the volume must NOT be declared drained while it still holds that slice
        expect(deps.markDrainComplete).not.toHaveBeenCalled();
    });

    it('uses copy-first when the source is online and the copy validates (no reconstruction)', async () => {
        const { job, deps } = makeJob({ tryCopyRelocate: vi.fn().mockResolvedValue(true) });
        await runDrain(job, 5);

        expect(deps.tryCopyRelocate).toHaveBeenCalledTimes(1);
        expect(deps.repairSlice).not.toHaveBeenCalled(); // copy succeeded -> no RS
        expect(deps.database.replaceObjectVolumeRef).toHaveBeenCalledWith('obj1', 5, 21);
    });

    it('falls back to reconstruction when the copy declines or fails', async () => {
        const { job, deps } = makeJob({ tryCopyRelocate: vi.fn().mockResolvedValue(false) });
        await runDrain(job, 5);

        expect(deps.tryCopyRelocate).toHaveBeenCalledTimes(1);
        expect(deps.repairSlice).toHaveBeenCalledTimes(1);
        expect(deps.database.replaceObjectVolumeRef).toHaveBeenCalled();
    });

    it('copy-first for a parity slice too, when the copy validates (foreign parity is verified gone)', async () => {
        const parityDoc = objectDoc({ dataVolumes: [10, 11, 12, 15], parityVolumes: [5, 14] });
        const { job, deps } = makeJob({
            database: { findObjectsOnVolume: vi.fn().mockResolvedValueOnce([parityDoc]).mockResolvedValue([]), replaceObjectVolumeRef: vi.fn().mockResolvedValue(true), getObjectById: vi.fn(), countObjectsOnVolume: vi.fn().mockResolvedValue(0) },
            loadObject: vi.fn().mockResolvedValue({ dataSliceVolumeIds: [10, 11, 12, 15], paritySliceVolumeIds: [5, 14], dataSliceCount: 4, sliceSize: 1000 }),
            tryCopyRelocate: vi.fn().mockResolvedValue(true)
        });
        await runDrain(job, 5);
        expect(deps.tryCopyRelocate).toHaveBeenCalledTimes(1);   // parity is now byte-copied first, like data
        expect(deps.repairSlice).not.toHaveBeenCalled();          // valid copy -> no recompute
        expect(deps.database.replaceObjectVolumeRef).toHaveBeenCalledWith('obj1', 5, 21);
    });

    it('falls back to reconstruct when a parity copy is unavailable/invalid', async () => {
        const parityDoc = objectDoc({ dataVolumes: [10, 11, 12, 15], parityVolumes: [5, 14] });
        const { job, deps } = makeJob({
            database: { findObjectsOnVolume: vi.fn().mockResolvedValueOnce([parityDoc]).mockResolvedValue([]), replaceObjectVolumeRef: vi.fn().mockResolvedValue(true), getObjectById: vi.fn(), countObjectsOnVolume: vi.fn().mockResolvedValue(0) },
            loadObject: vi.fn().mockResolvedValue({ dataSliceVolumeIds: [10, 11, 12, 15], paritySliceVolumeIds: [5, 14], dataSliceCount: 4, sliceSize: 1000 }),
            tryCopyRelocate: vi.fn().mockResolvedValue(false)     // copy declines (offline/invalid)
        });
        await runDrain(job, 5);
        expect(deps.tryCopyRelocate).toHaveBeenCalledTimes(1);
        expect(deps.repairSlice).toHaveBeenCalledTimes(1);        // -> md5-gated reconstruct
        expect(deps.database.replaceObjectVolumeRef).toHaveBeenCalledWith('obj1', 5, 21);
    });

    it('drops the orphaned target copy when the flip loses a race', async () => {
        const { job, deps } = makeJob({
            tryCopyRelocate: vi.fn().mockResolvedValue(true),
            database: { findObjectsOnVolume: vi.fn().mockResolvedValueOnce([objectDoc()]).mockResolvedValue([]), replaceObjectVolumeRef: vi.fn().mockResolvedValue(false), getObjectById: vi.fn(), countObjectsOnVolume: vi.fn().mockResolvedValue(0) }
        });
        await runDrain(job, 5);
        expect(deps.deleteSlice).toHaveBeenCalledWith(expect.objectContaining({ id: 21 }), 'obj1.0'); // clean up target orphan
    });

    it('auto-continues to the next flagged volume when a drain completes', async () => {
        const draining = new Set([5, 8]); // operator queued vol 5 and vol 8
        const { job, deps } = makeJob({
            getDrainingVolumeIds: vi.fn(() => [...draining]),
            markDrainComplete: vi.fn(async (id: number) => { draining.delete(id); }) // clearing isDraining, as the real one does
        });
        await runDrain(job, 5);
        expect(deps.markDrainComplete).toHaveBeenCalledWith(5);
        expect(deps.markDrainComplete).toHaveBeenCalledWith(8); // picked up vol 8 without operator action
    });

    it('does not auto-continue when no other volume is flagged', async () => {
        const { job, deps } = makeJob({ getDrainingVolumeIds: vi.fn(() => [5]) }); // only the one being drained
        await runDrain(job, 5);
        expect(deps.markDrainComplete).toHaveBeenCalledTimes(1);
        expect(deps.markDrainComplete).toHaveBeenCalledWith(5);
    });

    // The drain relocates the slices `content` references. It has never heard of .journal/, so left to
    // itself it will finish, report the volume drained, and leave the only copy of the namespace history
    // on a drive the operator is now holding. The invariant lives in run() rather than at the HTTP
    // endpoint precisely because a RESUMED or AUTO-CONTINUED drain never goes through the endpoint.
    describe('will not move a single slice until the journal is off the volume', () => {
        it('refuses to start when the journal could not be relocated', async () => {
            const { job, deps } = makeJob({
                relocateJournalOff: vi.fn().mockRejectedValue(
                    new Error('volume 5 holds the only complete copy of 2 journal segment(s)'))
            });

            await runDrain(job, 5);

            expect(deps.relocateJournalOff).toHaveBeenCalledWith(5);
            expect(deps.deleteSlice).not.toHaveBeenCalled();          // nothing moved...
            expect(deps.markDrainComplete).not.toHaveBeenCalled();    // ...and it never reports "drained"
            expect(deps.runtimeConfig.delete).not.toHaveBeenCalled(); // state kept, so a retry resumes
        });

        it('enforces it on a RESUMED drain, which never passes through the HTTP endpoint', async () => {
            const relocateJournalOff = vi.fn().mockRejectedValue(new Error('nowhere to put the journal'));
            const { job, deps } = makeJob({ relocateJournalOff });
            deps.runtimeConfig.get = vi.fn(async (key: string) => (key === 'drainVolumeId' ? 5 : undefined)) as never;

            await job.resumePendingJob();
            await new Promise(r => setImmediate(r));   // run() is kicked off with void

            expect(relocateJournalOff).toHaveBeenCalledWith(5);
            expect(deps.deleteSlice).not.toHaveBeenCalled();
            expect(deps.markDrainComplete).not.toHaveBeenCalled();
        });

        // The relocation copies segments between disks, so it YIELDS -- and start() fires run() without
        // awaiting it. If the singleton claim waited for the relocation to finish, a second start could
        // walk in behind the first and the two drains would share activeVolumeId, the cancel flags and the
        // persisted cursor.
        it('claims the singleton BEFORE the relocation, so a second start cannot slip in behind it', async () => {
            let release!: () => void;
            const relocateJournalOff = vi.fn(() => new Promise<void>(r => { release = r; }));
            const { job, deps } = makeJob({ relocateJournalOff });

            void job.start(5);
            await new Promise(r => setImmediate(r));      // parked inside the relocation
            void job.start(9);                            // a second drain tries to start
            await new Promise(r => setImmediate(r));

            expect(relocateJournalOff).toHaveBeenCalledTimes(1);       // the second never got in
            expect(relocateJournalOff).toHaveBeenCalledWith(5);
            release();
            await new Promise(r => setImmediate(r));
            expect(deps.markDrainComplete).not.toHaveBeenCalledWith(9);
        });

        it('does not let an unrelocatable volume starve the drains queued behind it', async () => {
            const draining = new Set([5, 8]);
            // Volume 5 can NEVER release the journal. Without recording it as attempted, auto-continue
            // would pick it again every time volume 8 finishes, and nothing else would ever drain.
            const relocateJournalOff = vi.fn(async (id: number) => {
                if (id === 5) throw new Error('volume 5 holds the only complete copy of 1 journal segment(s)');
            });
            const { job, deps } = makeJob({
                getDrainingVolumeIds: vi.fn(() => [...draining]),
                markDrainComplete: vi.fn(async (id: number) => { draining.delete(id); }),
                relocateJournalOff
            });

            await runDrain(job, 8);                       // 8 drains fine; auto-continue then reaches for 5

            expect(relocateJournalOff).toHaveBeenCalledWith(5);
            expect(deps.markDrainComplete).toHaveBeenCalledWith(8);
            expect(deps.markDrainComplete).not.toHaveBeenCalledWith(5);
            // Attempted exactly once -- it is not retried in a loop within this run.
            expect(relocateJournalOff.mock.calls.filter(([id]) => id === 5)).toHaveLength(1);
        });

        // ...and the same starvation the other way round: the STUCK volume at the HEAD of the queue. A
        // refusal used to return before the auto-continue, so a disk the journal could not leave sat at the
        // front of the line indefinitely and everything the operator had queued behind it simply never ran.
        it('moves on to the queued volumes when the FIRST one cannot release the journal', async () => {
            const draining = new Set([5, 8]);
            const relocateJournalOff = vi.fn(async (id: number) => {
                if (id === 5) throw new Error('volume 5 holds the only complete copy of 1 journal segment(s)');
            });
            const { job, deps } = makeJob({
                getDrainingVolumeIds: vi.fn(() => [...draining]),
                markDrainComplete: vi.fn(async (id: number) => { draining.delete(id); }),
                relocateJournalOff
            });

            await runDrain(job, 5);                       // the stuck one goes FIRST

            expect(relocateJournalOff).toHaveBeenCalledWith(5);
            expect(deps.markDrainComplete).not.toHaveBeenCalledWith(5);   // refused, as it must be
            // ...but volume 8, queued behind it, still gets drained rather than waiting forever.
            expect(relocateJournalOff).toHaveBeenCalledWith(8);
            expect(deps.markDrainComplete).toHaveBeenCalledWith(8);
        });

        it('enforces it on the AUTO-CONTINUED volume, not just the first one', async () => {
            const draining = new Set([5, 8]);
            // Volume 5 is fine; volume 8 still carries the journal.
            const relocateJournalOff = vi.fn(async (id: number) => {
                if (id === 8) throw new Error('volume 8 holds the only complete copy of 1 journal segment(s)');
            });
            const { job, deps } = makeJob({
                getDrainingVolumeIds: vi.fn(() => [...draining]),
                markDrainComplete: vi.fn(async (id: number) => { draining.delete(id); }),
                relocateJournalOff
            });

            await runDrain(job, 5);

            expect(relocateJournalOff).toHaveBeenCalledWith(8);
            expect(deps.markDrainComplete).toHaveBeenCalledWith(5);
            expect(deps.markDrainComplete).not.toHaveBeenCalledWith(8);   // refused, not silently drained
        });
    });

    it('cancel() clears persisted drain state so it does not resume', async () => {
        const { job, deps } = makeJob();
        await job.cancel(5);
        expect(deps.runtimeConfig.delete).toHaveBeenCalledWith('drainVolumeId');
        expect(deps.runtimeConfig.delete).toHaveBeenCalledWith('drainCursorId');
    });

    it('cancel(otherVolume) does NOT clear a different volume paused/pending drain state', async () => {
        const { job, deps } = makeJob({ runtimeConfig: { get: vi.fn().mockResolvedValue(7), set: vi.fn(), delete: vi.fn() } });
        await job.cancel(9);   // cancel an unrelated volume; volume 7 is persisted-pending
        expect(deps.runtimeConfig.delete).not.toHaveBeenCalled();
    });

    it('skips documented-dead (recoveryComment) objects without attempting reconstruction', async () => {
        const { job, deps } = makeJob({
            database: {
                findObjectsOnVolume: vi.fn().mockResolvedValueOnce([objectDoc({ recoveryComment: 'drive gone' })]).mockResolvedValue([]),
                replaceObjectVolumeRef: vi.fn().mockResolvedValue(true),
                getObjectById: vi.fn(),
                countObjectsOnVolume: vi.fn().mockResolvedValue(0)
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

    it('persists a cursor as it advances and clears drain state on completion', async () => {
        const { job, deps } = makeJob();
        await runDrain(job, 5);
        expect(deps.runtimeConfig.set).toHaveBeenCalledWith('drainCursorId', 'obj1');
        expect(deps.runtimeConfig.delete).toHaveBeenCalledWith('drainVolumeId');
        expect(deps.runtimeConfig.delete).toHaveBeenCalledWith('drainCursorId');
    });

    it('clears the draining flag when the drain completes (drive stays read-only)', async () => {
        const { job, deps } = makeJob();
        await runDrain(job, 5);
        expect(deps.markDrainComplete).toHaveBeenCalledWith(5);
    });

    it('re-scans and completes when refs a transient failure left behind clear on retry', async () => {
        // A forward scan advances its cursor past objects that fail to relocate, so one pass can leave
        // slices behind (the md5-Binary bug did exactly this). Completion must gate on a real ref count,
        // not on reaching the end of the scan — so it re-scans and only completes once none remain.
        const { job, deps } = makeJob({
            database: {
                findObjectsOnVolume: vi.fn()
                    .mockResolvedValueOnce([objectDoc()]).mockResolvedValueOnce([])   // pass 1
                    .mockResolvedValueOnce([objectDoc()]).mockResolvedValueOnce([]),  // pass 2 (retry)
                replaceObjectVolumeRef: vi.fn().mockResolvedValue(true),
                getObjectById: vi.fn(),
                countObjectsOnVolume: vi.fn().mockResolvedValueOnce(1).mockResolvedValue(0) // 1 left, then 0
            }
        });
        await runDrain(job, 5);
        expect(deps.database.findObjectsOnVolume).toHaveBeenCalledTimes(4); // scanned twice
        expect(deps.repairSlice).toHaveBeenCalledTimes(2);                  // retried the leftover slice
        expect(deps.markDrainComplete).toHaveBeenCalledWith(5);            // completed only after 0 remain
    });

    it('does NOT mark complete or clear the draining flag when live slices cannot be relocated', async () => {
        // Count never drops between passes -> stuck (below quorum / no target). The flag must stay set so
        // the drive keeps blocking its own removal; a partial drain must never signal "safe to pull".
        const { job, deps } = makeJob({
            database: {
                findObjectsOnVolume: vi.fn()
                    .mockResolvedValueOnce([objectDoc()]).mockResolvedValueOnce([])
                    .mockResolvedValueOnce([objectDoc()]).mockResolvedValueOnce([]),
                replaceObjectVolumeRef: vi.fn().mockResolvedValue(true),
                getObjectById: vi.fn(),
                countObjectsOnVolume: vi.fn().mockResolvedValue(3) // no progress
            }
        });
        await runDrain(job, 5);
        expect(deps.markDrainComplete).not.toHaveBeenCalled();                       // removal blocked
        expect(deps.runtimeConfig.delete).toHaveBeenCalledWith('drainVolumeId');     // but progress state cleared
    });
});
