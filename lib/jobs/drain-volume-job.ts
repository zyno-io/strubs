import { createLogger } from '../log';
import { config } from '../config';
import { database } from '../database';
import { ioManager } from '../io/manager';
import { runtimeConfig } from '../runtime-config';
import { isMaintenanceFrozen } from '../maintenance';
import type { Volume } from '../io/volume';
import { domainLoadForObject, domainLoadFor } from '../io/failure-domain';
import { isDocumentedDead } from '../database/types';
import type { ContentDocument } from '../database/types';

// Persisted drain progress (so a restart resumes the in-flight drain before routine maintenance).
const DRAIN_VOLUME_ID_KEY = 'drainVolumeId';
const DRAIN_CURSOR_ID_KEY = 'drainCursorId';
const BATCH_SIZE = 100;

type LoadedObject = { dataSliceVolumeIds: number[]; paritySliceVolumeIds: number[]; dataSliceCount: number; sliceSize: number };
// skippedDead/duplicateRefs are SETS of object ids, not counters: the pass loop re-scans leftovers,
// so the same object can be skipped repeatedly. We want 'objects affected', not 'attempts'.
type DrainSummary = { objects: number; relocated: number; unrecoverable: number; skippedDead: Set<string>; noDest: number; duplicateRefs: Set<string> };

type DrainVolumeJobDeps = {
    database: Pick<typeof database, 'findObjectsOnVolume' | 'replaceObjectVolumeRef' | 'getObjectById' | 'countObjectsOnVolume'>;
    getWritableVolumes: () => Volume[];
    getVolume: (id: number) => Volume | undefined;
    // Ids of volumes still flagged for draining (for auto-continuing to the next queued volume).
    getDrainingVolumeIds: () => number[];
    loadObject: (record: unknown) => Promise<LoadedObject>;
    // Copy-first fast path: if the source drive is online, copy the slice file to the target and
    // validate it (chunk checksums) -- far cheaper than RS for a HEALTHY drain. Returns false (falls
    // back to reconstruct) if the source is offline/unreadable or the copy doesn't validate.
    tryCopyRelocate: (object: LoadedObject, sliceIndex: number, fileName: string, sourceVol: Volume, targetVol: Volume) => Promise<boolean>;
    repairSlice: (object: LoadedObject, sliceIndex: number) => Promise<void>;
    deleteSlice: (vol: Volume, fileName: string) => Promise<void>;
    // Clear the draining flag once the drain job finishes (the drive stays read-only -- the operator
    // deletes or un-read-onlys it as a separate manual step).
    markDrainComplete: (volumeId: number) => Promise<void>;
    // Notify storage stats of a slice moving fromVolumeId -> toVolumeId (near-immediate per-volume update).
    recordRelocated: (fromVolumeId: number, toVolumeId: number, size: number, sliceSize: number, isParity: boolean) => void;
    runtimeConfig: typeof runtimeConfig;
    isFrozen: () => Promise<boolean>;
    // Move the namespace journal off the volume and PROVE it left. THROWS if it did not. The drain job
    // relocates the slices that `content` references and knows nothing about .journal/, so without this
    // a drain would happily run to completion -- and report the drive drained -- with the only copy of the
    // namespace history still on it. The HTTP drain endpoint calls this too, but a RESUMED or
    // AUTO-CONTINUED drain never goes through the endpoint, so the invariant lives here as well.
    relocateJournalOff: (volumeId: number) => Promise<void>;
    createLogger: typeof createLogger;
    concurrency: number;
    delayMs: number;
};

const defaultDeps: DrainVolumeJobDeps = {
    database,
    getWritableVolumes: () => ioManager.getWritableVolumes(),
    getVolume: (id: number) => ioManager.getVolume(id),
    getDrainingVolumeIds: () => ioManager.getVolumeEntries().filter(([, v]) => v.isDraining && !v.isDeleted).map(([id]) => id),
    tryCopyRelocate: async (object: LoadedObject, sliceIndex: number, fileName: string, sourceVol: Volume, targetVol: Volume) => {
        const { relocateByCopy } = require('../io/slice-relocator') as typeof import('../io/slice-relocator');
        return relocateByCopy(object as never, sliceIndex, fileName, sourceVol, targetVol);
    },
    // Lazily required so importing this module (and mgmt/core) never pulls the native reed-solomon
    // binding via the reader unless a real drain actually runs.
    loadObject: async (record: unknown) => {
        const { FileObject } = require('../io/file-object') as typeof import('../io/file-object');
        const o = new FileObject(); await o.loadFromRecord(record as never); return o as unknown as LoadedObject;
    },
    repairSlice: async (object: LoadedObject, sliceIndex: number) => {
        const { sliceRepairer } = require('../io/file-object/slice-repairer') as typeof import('../io/file-object/slice-repairer');
        await sliceRepairer.repair(object as never, sliceIndex);
    },
    deleteSlice: async (vol: Volume, fileName: string) => { await vol.deleteCommittedFile(fileName); },
    markDrainComplete: async (volumeId: number) => {
        await database.updateVolumeFlags(volumeId, { isDraining: false });
        await ioManager.updateVolumeFlags(volumeId, { isDraining: false });
    },
    recordRelocated: (fromVolumeId, toVolumeId, size, sliceSize, isParity) => {
        const { storageStatsTracker } = require('../storage/stats-tracker') as typeof import('../storage/stats-tracker');
        storageStatsTracker.recordRelocated(fromVolumeId, toVolumeId, size, sliceSize, isParity);
    },
    runtimeConfig,
    isFrozen: isMaintenanceFrozen,
    relocateJournalOff: async (volumeId: number) => {
        const { journal } = require('../io/journal') as typeof import('../io/journal');
        await journal.relocateOff(volumeId);
    },
    createLogger,
    concurrency: config.drainConcurrency,
    delayMs: config.verifyReadDelayMs
};

// Relocate every slice a volume holds onto healthy volumes, rewriting object refs, so the drive can be
// removed with no data loss. Per slice: COPY-FIRST (fast — copy the file off an online source and
// validate its chunk checksums), falling back to RECONSTRUCT (rebuild from peers, whole-object md5-gated
// by the SliceRepairer) — which needs no read of the source, so it works even when the drive is OFFLINE.
// move-then-flip: write+verify the new slice, then flip the ref (reads never see a gap). Slices that
// can't be rebuilt correctly (below quorum / foreign parity) are left in place and reported -- they block
// removal until the operator accepts the loss (recoveryComment). Documented-dead objects are skipped.
// Gated by the maintenance freeze; resumes on restart ahead of the routine scrub/repair.
export class DrainVolumeJob {
    private readonly deps: DrainVolumeJobDeps;
    private readonly log: ReturnType<typeof createLogger>;
    private running = false;
    // The volume a start() is mid-way through claiming: set before its persisted writes, cleared once
    // run() can take over. Closes the window where two starts could both think they were first.
    private claiming: number | null = null;
    private cancelled = false; // paused (freeze) — persisted state kept so it resumes
    private aborted = false;   // operator cancel — persisted state cleared so it does NOT resume
    private activeVolumeId: number | null = null;
    // Volumes drain-attempted this process run — so auto-continue never ping-pongs back into a volume
    // it just finished (or one left stuck with unrelocatable slices, which keeps isDraining=true).
    private readonly attemptedVolumeIds = new Set<number>();

    constructor(deps?: Partial<DrainVolumeJobDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('drain-volume-job');
    }

    isRunning(): boolean { return this.running; }
    drainingVolumeId(): number | null { return this.activeVolumeId; }

    // Begin (or restart) draining a volume. Idempotent while a drain for the same volume is running.
    async start(volumeId: number): Promise<void> {
        // `claiming` covers the AWAIT WINDOW below. run() claims `running` synchronously, but it is not
        // reached until after the two persisted writes -- so without this, two concurrent start()s both see
        // running=false, both write drainVolumeId, and the loser's id is what ends up persisted while the
        // winner's drain is the one actually running. A restart would then resume the wrong volume.
        if (this.running || this.claiming) {
            if (this.activeVolumeId === volumeId)
                return;
            this.log('cannot drain volume %d: a drain of volume %d is already starting or running',
                volumeId, this.activeVolumeId ?? this.claiming);
            return;
        }

        this.claiming = volumeId;
        try {
            await this.deps.runtimeConfig.set(DRAIN_VOLUME_ID_KEY, volumeId);
            await this.deps.runtimeConfig.delete(DRAIN_CURSOR_ID_KEY);
        }
        finally {
            this.claiming = null;
        }
        void this.run(volumeId, undefined);
    }

    // Resume a persisted, not-yet-finished drain (called at startup BEFORE the scrub/repair start).
    async resumePendingJob(): Promise<void> {
        const volumeId = await this.deps.runtimeConfig.get(DRAIN_VOLUME_ID_KEY);
        if (typeof volumeId !== 'number')
            return;
        if (await this.deps.isFrozen()) {
            this.log('maintenance freeze active: not resuming drain of volume %d', volumeId);
            return;
        }
        const cursor = await this.deps.runtimeConfig.get(DRAIN_CURSOR_ID_KEY);
        this.log('resuming drain of volume %d', volumeId);
        void this.run(volumeId, typeof cursor === 'string' ? cursor : undefined);
    }

    // Pause (e.g. maintenance freeze): stop processing but KEEP the persisted drain state so the drain
    // resumes later (resumePendingJob).
    stop(): void { this.cancelled = true; }

    // Operator cancel: abort the drain AND clear the persisted state so it does NOT resume. The volume
    // stays isDraining=false is the caller's job (mgmt). Already-relocated slices keep their new homes.
    async cancel(volumeId?: number): Promise<void> {
        if (volumeId !== undefined) {
            // Abort/clear ONLY if the named volume is the one actually being (or pending) drained --
            // otherwise cancelling volume B must not wipe volume A's running or paused drain state.
            const pending = await this.deps.runtimeConfig.get(DRAIN_VOLUME_ID_KEY);
            const activeOrPending = this.activeVolumeId ?? (typeof pending === 'number' ? pending : null);
            if (activeOrPending !== null && activeOrPending !== volumeId)
                return;
        }
        this.cancelled = true;
        this.aborted = true;
        await this.clearState();
        this.log('drain cancelled for volume %s', volumeId ?? this.activeVolumeId ?? '?');
    }

    private async clearState(): Promise<void> {
        await this.deps.runtimeConfig.delete(DRAIN_VOLUME_ID_KEY);
        await this.deps.runtimeConfig.delete(DRAIN_CURSOR_ID_KEY);
    }

    private async run(volumeId: number, afterId: string | undefined): Promise<void> {
        if (this.running)
            return;

        // CLAIM THE SINGLETON FIRST, before any await. The journal relocation below yields (it copies
        // segments between disks), and start() fires run() without awaiting it -- so leaving the claim until
        // after the relocation lets a second start/resume walk straight in behind the first and share
        // activeVolumeId, the cancel flags and the persisted cursor with it.
        this.running = true;
        this.cancelled = false;
        this.aborted = false;
        this.activeVolumeId = volumeId;
        // Recorded even if the relocation refuses below: auto-continue skips volumes already attempted this
        // run, and without this a volume the journal cannot leave would be picked again and again, starving
        // every other queued drain behind it.
        this.attemptedVolumeIds.add(volumeId);

        // BEFORE a single slice moves: get the namespace journal off this disk, and prove it left.
        //
        // The drain walks `content` and relocates what it references. It has never heard of .journal/, so
        // it will finish, report the volume drained, and leave the only copy of the namespace's recent
        // history sitting on a drive the operator is now holding in their hand. Refusing to start is the
        // right failure: nothing has moved yet, the volume stays flagged, and the persisted state is left
        // alone so a retry resumes cleanly once there is somewhere for the journal to go.
        //
        // This is enforced HERE rather than at the callers because run() is the one thing every path goes
        // through -- the HTTP endpoint, a resume after restart, and auto-continuing to the next queued
        // volume. The endpoint checks it too, so an operator gets the failure in their response instead of
        // only in the log.
        try {
            await this.deps.relocateJournalOff(volumeId);
        }
        catch (err) {
            this.log('REFUSING to drain volume %d: %s', volumeId, err instanceof Error ? err.message : String(err));
            this.running = false;
            this.activeVolumeId = null;
            // The volume keeps its isDraining flag, so it is not forgotten -- but it must not STARVE the
            // volumes queued behind it. A disk the journal cannot be moved off could sit at the head of the
            // queue indefinitely, and everything else the operator asked to drain would simply never happen.
            // Move on; this one keeps its flag and gets picked up again on a later run.
            await this.continueToNextFlagged(volumeId);
            return;
        }
        const s: DrainSummary = { objects: 0, relocated: 0, unrecoverable: 0, skippedDead: new Set(), noDest: 0, duplicateRefs: new Set() };
        this.log('draining volume %d — reconstructing and relocating its slices', volumeId);
        let completed = false;    // the drain loop ran to its natural end (not paused/aborted/frozen)
        let fullyDrained = false; // zero live (non-dead) slices remain — safe to signal the drive removable
        try {
            let cursor = afterId;
            let prevRemaining = Number.POSITIVE_INFINITY;
            // Pass loop: a forward scan ADVANCES ITS CURSOR PAST objects that fail to relocate (a transient
            // error, e.g. a momentary source-read failure), so a single pass can leave slices behind and
            // still reach the end. Re-scan from the start until the count of live (non-dead) refs stops
            // dropping: transient failures clear on retry; genuinely-unrelocatable slices (below quorum /
            // no target) make no progress and stop the loop with the drive still flagged draining.
            passLoop: for (;;) {
                for (;;) {
                    if (this.aborted) { this.log('drain of volume %d cancelled', volumeId); return; }
                    if (this.cancelled) { this.log('drain of volume %d paused', volumeId); return; }
                    if (await this.deps.isFrozen()) { this.log('maintenance freeze active: pausing drain of volume %d', volumeId); return; }

                    const batch = await this.deps.database.findObjectsOnVolume([volumeId], BATCH_SIZE, cursor);
                    if (!batch.length)
                        break;

                    await this.processBatch(batch, volumeId, s);
                    if (this.aborted)
                        return;
                    cursor = (batch[batch.length - 1] as { id: string }).id;
                    await this.deps.runtimeConfig.set(DRAIN_CURSOR_ID_KEY, cursor);
                    if (s.objects % 1000 === 0)
                        this.log('  ...%d objects, %d relocated, %d unrecoverable, %d dead-skipped', s.objects, s.relocated, s.unrecoverable, s.skippedDead.size);
                    if (this.deps.delayMs > 0)
                        await new Promise(r => setTimeout(r, this.deps.delayMs));
                }

                // Forward scan exhausted. Any live (non-dead) refs still on the volume are objects that
                // FAILED to relocate this pass — retry them, unless the count didn't drop (stuck).
                const remaining = await this.deps.database.countObjectsOnVolume(volumeId, { excludeDead: true });
                if (remaining === 0) { fullyDrained = true; break passLoop; }
                if (remaining >= prevRemaining) {
                    this.log.error('drain of volume %d stuck: %d live slice(s) could not be relocated (below quorum / no target / %d object(s) holding duplicate refs on this volume) — removal blocked',
                        volumeId, remaining, s.duplicateRefs.size);
                    break passLoop;
                }
                this.log('drain of volume %d: %d live ref(s) remain after pass (transient failures) — re-scanning', volumeId, remaining);
                prevRemaining = remaining;
                cursor = undefined;
                await this.deps.runtimeConfig.delete(DRAIN_CURSOR_ID_KEY);
            }
            completed = true;
            await this.finalize(volumeId, s, fullyDrained);
        }
        catch (err) {
            this.log.error('drain of volume %d failed: %s', volumeId, err instanceof Error ? err.message : String(err));
        }
        finally {
            this.running = false;
            this.activeVolumeId = null;
            // If an operator cancel raced a cursor write, make sure the persisted state is gone so a
            // cancelled drain never resumes.
            if (this.aborted)
                await this.clearState().catch(() => undefined);
        }

        // Auto-continue: if this drain finished cleanly and other volumes are still flagged for draining
        // (e.g. the operator queued several), pick up the next one so they don't have to babysit it.
        // The just-completed volume has had isDraining cleared, so it won't be re-selected.
        if (completed && !this.cancelled && !this.aborted)
            await this.continueToNextFlagged(volumeId);
    }

    // Move on to the next volume the operator has flagged for draining. Called both when a drain FINISHES
    // and when one is REFUSED, because a queue that stops dead at its first stuck volume is not a queue.
    private async continueToNextFlagged(afterVolumeId: number): Promise<void> {
        if (this.cancelled || this.aborted || await this.deps.isFrozen())
            return;

        // Skip any volume already attempted this run: one that cannot be drained keeps isDraining=true (so
        // it still blocks its own removal) and would otherwise be re-selected here forever.
        const next = this.deps.getDrainingVolumeIds()
            .find(id => id !== afterVolumeId && !this.attemptedVolumeIds.has(id));
        if (typeof next !== 'number')
            return;

        this.log('continuing to the next volume flagged for draining: volume %d', next);
        await this.deps.runtimeConfig.set(DRAIN_VOLUME_ID_KEY, next);
        await this.deps.runtimeConfig.delete(DRAIN_CURSOR_ID_KEY);
        await this.run(next, undefined);
    }

    private async processBatch(batch: ContentDocument[], volumeId: number, s: DrainSummary): Promise<void> {
        const inflight = new Set<Promise<void>>();
        for (const doc of batch) {
            if (this.cancelled || this.aborted)
                break;
            s.objects++;
            const p = this.drainObject(doc, volumeId, s).catch(err => {
                this.log.error('drain of object %s failed: %s', (doc as { id?: string }).id, err instanceof Error ? err.message : String(err));
            }).finally(() => inflight.delete(p));
            inflight.add(p);
            if (inflight.size >= this.deps.concurrency)
                await Promise.race(inflight);
        }
        await Promise.all(inflight);
    }

    private async drainObject(doc: ContentDocument, volumeId: number, s: DrainSummary): Promise<void> {
        // Documented-dead objects (recoveryComment) can't be relocated (their surviving slices are
        // foreign/insufficient); treat as accepted loss and leave their ref -- deletion is unblocked
        // separately once the operator accepts that loss.
        if (isDocumentedDead(doc)) { s.skippedDead.add((doc as { id: string }).id); return; }

        const dataVols = (doc as { dataVolumes?: number[] }).dataVolumes ?? [];
        const parityVols = (doc as { parityVolumes?: number[] }).parityVolumes ?? [];
        const all = [...dataVols, ...parityVols];
        const idx = all.indexOf(volumeId);
        if (idx < 0)
            return; // no longer here (already relocated / concurrent change)

        // replaceObjectVolumeRef rewrites EVERY array position holding volumeId, but we relocate exactly
        // ONE file (the first match). If an object has two slices on this volume, flipping would repoint
        // both refs at the single copy and orphan the other -- turning a recoverable slice into a lost
        // one, while making the volume look safely drained. Refuse; it needs a human.
        if (all.lastIndexOf(volumeId) !== idx) {
            this.log.error('object %s has multiple slices on volume %d: skipping (unsafe to relocate)', (doc as { id?: string }).id, volumeId);
            s.duplicateRefs.add((doc as { id: string }).id);
            return;
        }

        const objectVols = new Set(all);
        // Keep a legitimately-zero slice size as 0 (a zero-byte object needs ~no space) instead of
        // defaulting it to a bogus large requirement that would falsely block relocation.
        const declared = (doc as { sliceSize?: number }).sliceSize;
        const sliceBytes = typeof declared === 'number' ? declared : Math.ceil(((doc as { size?: number }).size ?? 0) / Math.max(1, dataVols.length));
        const target = this.pickTarget(objectVols, sliceBytes, volumeId);
        if (!target) { s.noDest++; this.log('no relocation target for object %s (all healthy volumes in use or full)', (doc as { id?: string }).id); return; }

        const object = await this.deps.loadObject(doc);
        const isParity = idx >= object.dataSliceCount;   // still needed for per-volume storage-stats accounting
        if (idx < object.dataSliceCount)
            object.dataSliceVolumeIds[idx] = target.id;
        else
            object.paritySliceVolumeIds[idx - object.dataSliceCount] = target.id;

        // Copy-first for BOTH data and parity: byte-copy the slice off an online source, then validate it
        // (per-chunk md5 + the advisory header md5); an invalid/failed copy falls back to md5-gated
        // reconstruct, which also covers an offline source. Parity was formerly ALWAYS recomputed to purge
        // FOREIGN parity (self-consistent but wrong); the full-fleet verify confirmed none remains, so the
        // faster validated copy is now safe -- and a bit-rotted parity chunk still fails validation -> recompute.
        const fileName = `${(doc as { id: string }).id}.${idx}`;
        const sourceVol = this.deps.getVolume(volumeId);
        let placed = false;
        if (sourceVol)
            placed = await this.deps.tryCopyRelocate(object, idx, fileName, sourceVol, target);
        if (!placed) {
            try {
                await this.deps.repairSlice(object, idx); // reconstruct from peers, md5-gated, write to target
                placed = true;
            }
            catch (err) {
                const code = (err as { code?: string } | undefined)?.code;
                if (code === 'EQUORUM' || code === 'ECORRUPT') { s.unrecoverable++; return; } // can't rebuild correctly; leave ref
                throw err;
            }
        }
        if (!placed) return;
        // Positional flip: rewrites only this slice's ref (source->target), so a concurrent relocation
        // of another slice of the same object can't be clobbered.
        const flipped = await this.deps.database.replaceObjectVolumeRef((doc as { id: string }).id, volumeId, target.id);
        if (!flipped) {
            await this.deps.deleteSlice(target, fileName).catch(() => undefined); // drop the orphan copy; drain keeps the source
            return;
        }
        s.relocated++;
        // Reflect the move in per-volume storage stats immediately (source -1, target +1) so the UI
        // tracks the drain instead of waiting for the next full reconcile.
        this.deps.recordRelocated(volumeId, target.id, (doc as { size?: number }).size ?? 0, sliceBytes, isParity);
        // Account the write so pickTarget spreads within the run (loadFromRecord objects don't
        // self-account on commit). Drain keeps the source, so only the target changes.
        if (typeof target.bytesFree === 'number') target.bytesFree -= sliceBytes;
    }

    // Emptiest healthy WRITABLE volume the object doesn't already use (draining volumes are already
    // excluded from getWritableVolumes()). Distinct-volume constraint keeps one slice per drive.
    // Ranked by FAILURE DOMAIN first, then free space. Draining a disk relocates every slice it holds;
    // picking purely by emptiness will happily stack a third slice of an object into an enclosure that
    // already holds two, so a box outage then takes it below quorum even though every disk is fine.
    // The write planner spreads across groups — a drain must not quietly undo that.
    private pickTarget(objectVols: Set<number>, sliceBytes: number, movingFrom: number): Volume | null {
        const load = domainLoadForObject(objectVols, movingFrom, id => this.deps.getVolume(id));
        let best: Volume | null = null;
        let bestFree = -1;
        let bestLoad = Infinity;
        for (const v of this.deps.getWritableVolumes()) {
            if (objectVols.has(v.id))
                continue;
            const free = (v.bytesFree ?? 0) - v.bytesPending;
            if (free < sliceBytes)
                continue;
            const l = domainLoadFor(v, load);
            if (l < bestLoad || (l === bestLoad && free > bestFree)) { bestLoad = l; bestFree = free; best = v; }
        }
        return best;
    }

    private async finalize(volumeId: number, s: DrainSummary, fullyDrained: boolean): Promise<void> {
        this.log('drain of volume %d finished: %d objects, %d relocated, %d unrecoverable, %d dead-skipped, %d no-dest, %d duplicate-refs',
            volumeId, s.objects, s.relocated, s.unrecoverable, s.skippedDead.size, s.noDest, s.duplicateRefs.size);
        // Clear the persisted progress cursor either way: a stuck drain must not tight-loop-resume on
        // every restart, and a done drain has nothing to resume.
        await this.deps.runtimeConfig.delete(DRAIN_VOLUME_ID_KEY);
        await this.deps.runtimeConfig.delete(DRAIN_CURSOR_ID_KEY);
        if (!fullyDrained) {
            // Live slices remain that couldn't be relocated (below quorum / no target). Do NOT clear the
            // draining flag — leaving it set keeps the drive read-only and blocks removal until the
            // operator resolves the loss (recoveryComment) or frees capacity.
            const remaining = await this.deps.database.countObjectsOnVolume(volumeId, { excludeDead: true }).catch(() => -1);
            this.log.error('volume %d NOT fully drained (%d live slice(s) remain) — draining flag left set; removal blocked until resolved', volumeId, remaining);
            return;
        }
        // Fully drained: clear the draining flag (the drive stays read-only + empty, awaiting a manual
        // delete). Only reached when zero live slices remain -- so a partial drain can never signal "safe
        // to pull". Freeze-pause / abort return before here.
        await this.deps.markDrainComplete(volumeId);
    }
}

export const drainVolumeJob = new DrainVolumeJob();
