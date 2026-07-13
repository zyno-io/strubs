import { describe, expect, it, vi } from 'vitest';

// rebalance-job statically imports verifyVolumesJob (it parks the scrub while it owns the disks), which
// drags in the native RS binding that vitest can't load. The deps are injected, so a stub is enough.
vi.mock('@ronomon/reed-solomon', () => ({ default: { create: () => ({}), encode: () => {}, search: () => {}, XOR: () => {} } }));

import { RebalanceJob } from '../lib/jobs/rebalance-job';

const loggerFactory = () => vi.fn(() => Object.assign(vi.fn(), { error: vi.fn() })) as any;

// A volume for the fake pool. bytesFree drives fill(); accountMove mutates these in place.
const vol = (id: number, bytesFree: number, extra?: Record<string, unknown>) => ({
    id, bytesTotal: 100, bytesFree, bytesPending: 0, isWritable: true, isHealthy: true,
    reserveSpace(bytes: number) { this.bytesPending += bytes; },
    releaseReservation(bytes: number) { this.bytesPending = Math.max(0, this.bytesPending - bytes); },
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
        // get() returns undefined -> the job falls back to its default concurrency (3).
        runtimeConfig: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
        isFrozen: vi.fn().mockResolvedValue(false),
        createLogger: loggerFactory(),
        pauseVerify: vi.fn().mockResolvedValue(undefined),
        resumeVerify: vi.fn().mockResolvedValue(undefined),
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

    it('relocates up to `concurrency` slices in parallel (the knob must actually parallelize)', async () => {
        // Big source so the per-move accounting doesn't balance it mid-batch and end the run early.
        const vols = [
            vol(1, 1_000, { bytesTotal: 100_000 }),   // fill 0.99 -> source
            vol(2, 90_000, { bytesTotal: 100_000 })   // fill 0.10 -> target
        ];
        const batch = Array.from({ length: 10 }, (_, i) => ({
            id: `obj${i}`, dataVolumes: [1, 10, 11, 12], parityVolumes: [13, 14], size: 160, sliceSize: 40
        }));

        let inflight = 0;
        let peak = 0;
        const { job, deps } = makeJob(vols, null, {
            database: {
                findObjectsOnVolume: vi.fn().mockResolvedValueOnce(batch).mockResolvedValue([]),
                replaceObjectVolumeRef: vi.fn().mockResolvedValue(true)
            },
            loadObject: vi.fn().mockImplementation(async (d: any) => loadedFor(d)),
            tryCopyRelocate: vi.fn().mockImplementation(async () => {
                inflight++;
                peak = Math.max(peak, inflight);
                await new Promise(r => setTimeout(r, 5));
                inflight--;
                return true;
            })
        });

        await run(job);

        expect(deps.tryCopyRelocate).toHaveBeenCalledTimes(10); // all 10 moved
        expect(peak).toBe(3);                                   // ...3 at a time, not serially
    });

    it('sheds the biggest objects first, and stops before the small tiers once the source is balanced', async () => {
        const doc = objectDoc(1, 'data');
        const { job, deps } = makeJob(pool(), doc);
        await run(job);

        // Tier scans are descending, and the very first scan is the 256MB tier -- not an unordered scan.
        const minSizes = deps.database.findObjectsOnVolume.mock.calls.map((c: any[]) => c[3]?.minSize);
        expect(minSizes[0]).toBe(256 * 1024 * 1024);
        // This one move balances the source, so we must never fall through to the small-object tiers.
        expect(minSizes).not.toContain(0);
        expect(deps.tryCopyRelocate).toHaveBeenCalledTimes(1);
    });

    it('falls through to smaller tiers when the big objects do not balance the source', async () => {
        // Every tier scan comes back empty -> the job must try all four tiers, largest to smallest.
        const { job, deps } = makeJob(pool(), null, {
            database: {
                findObjectsOnVolume: vi.fn().mockResolvedValue([]),
                replaceObjectVolumeRef: vi.fn().mockResolvedValue(true)
            }
        });
        await run(job);

        const minSizes = deps.database.findObjectsOnVolume.mock.calls.map((c: any[]) => c[3]?.minSize);
        expect(minSizes).toEqual([256 * 1024 * 1024, 16 * 1024 * 1024, 1024 * 1024, 0]);
    });

    it('parks the verify while it owns the disks and releases it afterwards', async () => {
        const doc = objectDoc(1, 'data');
        const { job, deps } = makeJob(pool(), doc);

        await run(job);

        expect(deps.pauseVerify).toHaveBeenCalledTimes(1);
        expect(deps.resumeVerify).toHaveBeenCalledTimes(1);
    });

    it('still releases the verify when the rebalance fails', async () => {
        // Otherwise a crashed rebalance would strand the scrub as "waiting" forever.
        const doc = objectDoc(1, 'data');
        const { job, deps } = makeJob(pool(), doc, {
            loadObject: vi.fn().mockRejectedValue(new Error('boom')),
            getVolumes: () => { throw new Error('pool exploded'); }
        });

        await run(job);

        expect(deps.resumeVerify).toHaveBeenCalledTimes(1);
    });

    it('reads concurrency from runtime config, so it can be retuned without a restart', async () => {
        const { job, deps } = makeJob(pool(), null, {
            runtimeConfig: { get: vi.fn().mockResolvedValue(9), set: vi.fn(), delete: vi.fn() }
        });

        expect(await job.getConcurrency()).toBe(9);
        expect((await job.getStatus()).concurrency).toBe(9);

        await job.setConcurrency(12);
        expect(deps.runtimeConfig.set).toHaveBeenCalledWith('rebalanceConcurrency', 12);
    });

    it('clamps a nonsense concurrency instead of stalling or melting the disks', () => {
        expect(RebalanceJob.normalizeConcurrency(0)).toBe(3);        // < 1 -> default
        expect(RebalanceJob.normalizeConcurrency(-5)).toBe(3);
        expect(RebalanceJob.normalizeConcurrency('nope')).toBe(3);
        expect(RebalanceJob.normalizeConcurrency(undefined)).toBe(3);
        expect(RebalanceJob.normalizeConcurrency(1000)).toBe(64);    // clamped to the ceiling
        expect(RebalanceJob.normalizeConcurrency(8)).toBe(8);
    });

    it('debits the destination even when the source delete fails', async () => {
        // The bytes are on dest the moment the ref flips, regardless of the unlink. If a failed delete
        // also skipped the dest debit, dest would look emptier than it is, keep winning pickTarget, and
        // get written past its real free space -- while the source's fill never fell, so the tier loop
        // would relocate the whole volume and free nothing.
        const vols = pool();
        const [source, dest] = vols;
        const { job } = makeJob(vols, objectDoc(1, 'data'), {
            deleteSourceSlice: vi.fn().mockResolvedValue(false)  // e.g. source went read-only mid-run
        });

        await run(job);

        expect(dest.bytesFree).toBe(40);      // 80 - 40: debited despite the failed delete
        expect(source.bytesFree).toBe(5);     // ...and NOT credited, because the file is still there
        expect((await (job as any).getStatus()).sourceDeleteFailed).toBe(1);
    });

    it('reserves space on the destination so CONCURRENT moves do not all pile onto one volume', async () => {
        // pickTarget is deterministic (emptiest under-target volume) and the free-space debit only lands
        // AFTER a move commits -- so concurrent moves all see identical inputs and, without a
        // reservation, every one of them picks the same dest: serialising on one spindle and
        // over-committing it past pickTarget's own free-space guard.
        // vol2 and vol3 are within one sliceSize of each other, so a single reservation is exactly what
        // tips the choice to the other volume. All 3 moves are in flight before any of them commits.
        const vols = [
            vol(1, 1_000, { bytesTotal: 100_000 }),   // source, 99% full
            vol(2, 60_000, { bytesTotal: 100_000 }),  // dest A — emptiest
            vol(3, 59_500, { bytesTotal: 100_000 })   // dest B — only 500B behind, < one 1000B slice
        ];
        const batch = Array.from({ length: 3 }, (_, i) => ({
            id: `obj${i}`, dataVolumes: [1, 10, 11, 12], parityVolumes: [13, 14], size: 4_000, sliceSize: 1_000
        }));

        const dispatchedTo: number[] = [];
        let inflight = 0;
        let peak = 0;
        const { job } = makeJob(vols, null, {
            database: {
                findObjectsOnVolume: vi.fn().mockResolvedValueOnce(batch).mockResolvedValue([]),
                replaceObjectVolumeRef: vi.fn().mockResolvedValue(true)
            },
            loadObject: vi.fn().mockImplementation(async (d: any) => loadedFor(d)),
            // Records the destination at DISPATCH time — before any move has committed its debit.
            tryCopyRelocate: vi.fn().mockImplementation(async (_o: any, _i: number, _f: string, _src: any, target: any) => {
                dispatchedTo.push(target.id);
                inflight++;
                peak = Math.max(peak, inflight);
                await new Promise(r => setTimeout(r, 10));
                inflight--;
                return true;
            })
        });

        await run(job);

        expect(peak).toBe(3);                            // all three genuinely overlapped...
        expect(new Set(dispatchedTo).size).toBe(2);      // ...and were spread, not all aimed at vol 2
        expect(vols[1].bytesPending).toBe(0);            // every reservation released
        expect(vols[2].bytesPending).toBe(0);
    });

    it('refuses to relocate a documented-dead (recoveryComment) object', async () => {
        // Its surviving slices are foreign or below quorum, so reconstructing from them yields
        // self-consistent-but-wrong bytes -- and rebalance would write that onto a healthy volume.
        // The repair worker and the drain both refuse these; rebalance must too.
        const doc = { ...objectDoc(1, 'data'), recoveryComment: 'drive gone, insufficient slices' };
        const { job, deps } = makeJob(pool(), doc);

        await run(job);

        expect(deps.tryCopyRelocate).not.toHaveBeenCalled();
        expect(deps.repairSlice).not.toHaveBeenCalled();
        expect(deps.database.replaceObjectVolumeRef).not.toHaveBeenCalled();
        expect(deps.deleteSourceSlice).not.toHaveBeenCalled();
        expect((await (job as any).getStatus()).skippedDead).toBe(1);
    });

    it('refuses to move an object that has two slices on the same source volume', async () => {
        // The positional flip rewrites EVERY ref equal to the source, but only one file is copied --
        // so flipping would orphan the second slice, turning a recoverable slice into a lost one.
        const doc = { id: 'obj1', dataVolumes: [1, 1, 11, 12], parityVolumes: [13, 14], size: 160, sliceSize: 40 };
        const { job, deps } = makeJob(pool(), doc);

        await run(job);

        expect(deps.tryCopyRelocate).not.toHaveBeenCalled();
        expect(deps.database.replaceObjectVolumeRef).not.toHaveBeenCalled();
        expect(deps.deleteSourceSlice).not.toHaveBeenCalled();
        expect((await (job as any).getStatus()).duplicateRefs).toBe(1);
    });

    it('does not report a rate or ETA once the run is over', async () => {
        const doc = objectDoc(1, 'data');
        const { job } = makeJob(pool(), doc);
        await run(job);

        // startedAt/bytesMoved survive the run; dividing by an ever-growing elapsed would show an idle
        // system a fake ETA that quietly got worse forever.
        const status = await (job as any).getStatus();
        expect(status.running).toBe(false);
        expect(status.bytesPerSec).toBe(0);
        expect(status.etaSeconds).toBeNull();
    });

    it('does nothing when the pool is already balanced (no source over the deadband)', async () => {
        const { job, deps } = makeJob([vol(1, 50), vol(2, 50), vol(3, 50)], objectDoc(1, 'data'));
        await run(job);
        expect(deps.database.findObjectsOnVolume).not.toHaveBeenCalled();
        expect(deps.tryCopyRelocate).not.toHaveBeenCalled();
    });

    it('reports live progress: target fill, bytes still to move, and bytes moved', async () => {
        const doc = objectDoc(1, 'data');
        const { job } = makeJob(pool(), doc);

        // pool: vol1 95/100, vol2 20/100, vol3 50/100 -> 165/300 = 55% capacity-weighted balance point.
        const before = await (job as any).getStatus();
        expect(before.running).toBe(false);
        expect(before.targetFill).toBeCloseTo(0.55, 3);
        expect(before.bytesToMove).toBe(40);        // vol1 is 40 bytes over the 55% line
        expect(before.bytesMoved).toBe(0);

        await run(job);

        const after = await (job as any).getStatus();
        expect(after.moves).toBe(1);
        expect(after.bytesMoved).toBe(40);          // the relocated slice
        expect(after.bytesToMove).toBe(0);          // ...and the source is now at the balance point
        expect(after.startedAt).toEqual(expect.any(String));
    });

    it('spreads across failure domains: prefers the enclosure holding fewest of the object slices', async () => {
        // 4+2 survives losing 2 slices, so 3 slices in ONE enclosure means a box outage takes the object
        // below quorum with every disk still healthy. The write planner spreads across groups; a
        // relocation that only asks "which volume is emptiest?" quietly undoes that.
        // Object's other slices: vols 10,11 (group 1) and 12,13,14 — so group 1 already holds 2.
        // Candidate 2 is EMPTIER but sits in group 1 (would make it 3). Candidate 3 is in group 2.
        const vols = [
            vol(1, 5),                                       // source (group 9, irrelevant)
            vol(2, 90, { deviceGroup: 1 }),                  // emptiest — but its box already has 2 slices
            vol(3, 80, { deviceGroup: 2 })                   // fuller, but a box with none of this object
        ];
        vols.push(
            vol(10, 50, { deviceGroup: 1 }), vol(11, 50, { deviceGroup: 1 }),
            vol(12, 50, { deviceGroup: 3 }), vol(13, 50, { deviceGroup: 4 }), vol(14, 50, { deviceGroup: 5 })
        );
        const doc = { id: 'obj1', dataVolumes: [1, 10, 11, 12], parityVolumes: [13, 14], size: 160, sliceSize: 40 };

        const { job, deps } = makeJob(vols, doc);
        await run(job);

        // vol 3, NOT the emptier vol 2 — spreading beats packing.
        expect(deps.database.replaceObjectVolumeRef).toHaveBeenCalledWith('obj1', 1, 3);
    });

    it('still uses the emptiest volume when the failure domains are equally loaded', async () => {
        // The domain rule must not override fill balancing when it buys nothing.
        const vols = [
            vol(1, 5),
            vol(2, 90, { deviceGroup: 7 }),   // emptiest, and its box holds none of the object
            vol(3, 80, { deviceGroup: 8 })    // also holds none
        ];
        const doc = { id: 'obj1', dataVolumes: [1, 10, 11, 12], parityVolumes: [13, 14], size: 160, sliceSize: 40 };

        const { job, deps } = makeJob(vols, doc);
        await run(job);

        expect(deps.database.replaceObjectVolumeRef).toHaveBeenCalledWith('obj1', 1, 2);
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

    // STOPPING IS NOT STOPPED, AND THE OPERATOR IS WATCHING.
    //
    // cancel() stops the job taking NEW work at once, but up to `concurrency` slice relocations are already in
    // the air, and each is drained to a safe boundary: a slice is only unlinked from its source after the copy
    // is fsynced and the database reference flipped. Interrupt that and you leave a duplicate, or a record
    // pointing at a slice that is not fully on the platter yet.
    //
    // So for a while after the click the job IS still running and the logs DO keep scrolling. Reporting
    // `running: true` with nothing else made the array look like it had flatly ignored the operator. It had
    // not -- it was finishing what it had already started, which is the only safe thing it could do.
    describe('cancelling', () => {
        it('reports STOPPING while the moves already in flight are still landing', async () => {
            const { job } = makeJob(pool(), objectDoc(1, 'data'));

            (job as any).running = true;
            expect(job.isStopping).toBe(false);         // running, not cancelled

            await job.cancel();
            expect(job.isStopping).toBe(true);          // cancelled, but still draining -- SAY SO

            (job as any).running = false;
            expect(job.isStopping).toBe(false);         // actually stopped now
        });

        it('is not "stopping" when it was never running', async () => {
            const { job } = makeJob(pool(), objectDoc(1, 'data'));
            await job.cancel();
            expect(job.isStopping).toBe(false);
        });
    });
});