import { createLogger } from '../log';
import { config } from '../config';
import { database } from '../database';
import { ioManager } from '../io/manager';
import { runtimeConfig } from '../runtime-config';
import { isMaintenanceFrozen } from '../maintenance';
// One-directional: the rebalance drives the verify job (parks it, then releases it). The verify job
// knows nothing about rebalance, so there is no import cycle.
import { verifyVolumesJob } from './verify-volumes-job';
import { domainLoadForObject, domainLoadFor } from '../io/failure-domain';
import type { Volume } from '../io/volume';
import { isDocumentedDead } from '../database/types';
import type { ContentDocument } from '../database/types';

// Persisted progress so a restart resumes an in-flight rebalance.
const REBALANCE_ACTIVE_KEY = 'rebalanceActive';
const REBALANCE_CURSOR_KEY = 'rebalanceCursor';   // `${sourceVolumeId}:${afterId}`
const REBALANCE_CONCURRENCY_KEY = 'rebalanceConcurrency';
// How many slices relocate at once. Persisted (not an env var) so it can be retuned from the API/UI
// mid-run: the right value depends on what the disks can absorb, which you only learn by watching a
// real rebalance. Re-read once per batch, so a change takes effect within ~a batch rather than
// needing a restart.
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 64;
const BATCH_SIZE = 100;
const DEFAULT_DEADBAND = 0.05;                     // ±5% fill hysteresis
// Shed the BIG objects first. Object stores tend to hold most of their bytes in a small minority of
// large objects, while a move costs roughly the same fixed latency -- open, read, write, commit, DB ref
// flip, delete -- whatever the slice weighs. Descending size tiers therefore reach the fill target in far
// fewer moves. Each tier is a plain `size >= n` filter over the normal _id scan, so a source that holds
// enough large objects balances in the first tier or two; the smaller tiers are the fallback for volumes
// whose bytes really are spread across small objects.
const SIZE_TIERS = [256 * 1024 * 1024, 16 * 1024 * 1024, 1024 * 1024, 0];
const DEFAULT_MAX_MOVES = Number.POSITIVE_INFINITY;

type LoadedObject = { dataSliceVolumeIds: number[]; paritySliceVolumeIds: number[]; dataSliceCount: number; sliceSize: number };
type RebalanceSummary = { moves: number; reconstructed: number; copied: number; unrecoverable: number; noDest: number; sourceDeleteFailed: number; duplicateRefs: number; skippedDead: number };
const emptySummary = (): RebalanceSummary => ({ moves: 0, reconstructed: 0, copied: 0, unrecoverable: 0, noDest: 0, sourceDeleteFailed: 0, duplicateRefs: 0, skippedDead: 0 });

export type RebalanceStatus = RebalanceSummary & {
    running: boolean;

    // STOPPING IS NOT STOPPED, AND THE DIFFERENCE IS WHAT AN OPERATOR IS STARING AT.
    //
    // cancel() sets the flag and returns at once, but the run does not die on the spot: up to `concurrency`
    // slice relocations are already in the air, and each one has to reach a safe boundary. A slice is copied,
    // fsynced, the database reference is flipped, and only THEN is the source unlinked -- kill it in the middle
    // and you leave either a duplicate or a record pointing at a slice that is not fully on the platter yet. So
    // the in-flight moves are drained, deliberately, and on cold USB spindles that can take a while.
    //
    // Meanwhile `running` stays true, the UI keeps saying "Rebalancing", the button still says "Cancel", and
    // the logs keep scrolling -- so the array looks like it flatly ignored the operator. It did not. It is
    // finishing what it had already started, which is the only safe thing it could do. Say so.
    stopping: boolean;
    concurrency: number;             // live, retunable via PUT /$/rebalance
    targetFill: number;              // 0..1, capacity-weighted balance point
    deadband: number;
    bytesToMove: number;             // still above target across all sources (live)
    bytesMoved: number;              // this run
    bytesPerSec: number;
    etaSeconds: number | null;
    sourceVolumeIds: number[];
    currentSourceVolumeId: number | null;
    currentMinObjectSize: number | null;  // which size tier is being shed
    startedAt: string | null;
};
type RebalanceOptions = { deadband?: number; maxMoves?: number };

type RebalanceJobDeps = {
    database: Pick<typeof database, 'findObjectsOnVolume' | 'replaceObjectVolumeRef'>;
    getVolumes: () => Volume[];
    getVolume: (id: number) => Volume | undefined;
    loadObject: (record: unknown) => Promise<LoadedObject>;
    // data slice: fast copy of a checksum-clean original. parity: never copied (would preserve
    // known-bad parity) -> the caller forces reconstruct for parity.
    tryCopyRelocate: (object: LoadedObject, sliceIndex: number, fileName: string, sourceVol: Volume, targetVol: Volume) => Promise<boolean>;
    repairSlice: (object: LoadedObject, sliceIndex: number) => Promise<void>;   // recompute/reconstruct, md5-gated
    deleteSourceSlice: (sourceVol: Volume, fileName: string) => Promise<boolean>;
    recordRelocated: (fromVolumeId: number, toVolumeId: number, size: number, sliceSize: number, isParity: boolean) => void;
    runtimeConfig: typeof runtimeConfig;
    isFrozen: () => Promise<boolean>;
    createLogger: typeof createLogger;
    // A scrub and a rebalance fight over the same spindles, and a scrub of a volume whose slices are
    // being relocated is verifying a moving target. So the rebalance owns the disks while it runs: it
    // pauses any verify (state preserved) and resumes it on completion/cancel.
    pauseVerify: () => Promise<void>;
    resumeVerify: () => Promise<void>;
    delayMs: number;
};

const defaultDeps: RebalanceJobDeps = {
    database,
    getVolumes: () => ioManager.getWritableVolumes(),
    getVolume: (id: number) => ioManager.getVolume(id),
    loadObject: async (record: unknown) => { const { FileObject } = require('../io/file-object') as typeof import('../io/file-object'); const o = new FileObject(); await o.loadFromRecord(record as never); return o as unknown as LoadedObject; },
    tryCopyRelocate: async (object, sliceIndex, fileName, sourceVol, targetVol) => {
        const { relocateByCopy } = require('../io/slice-relocator') as typeof import('../io/slice-relocator');
        return relocateByCopy(object as never, sliceIndex, fileName, sourceVol, targetVol);
    },
    repairSlice: async (object, sliceIndex) => { const { sliceRepairer } = require('../io/file-object/slice-repairer') as typeof import('../io/file-object/slice-repairer'); await sliceRepairer.repair(object as never, sliceIndex); },
    deleteSourceSlice: async (sourceVol, fileName) => { try { await sourceVol.deleteCommittedFile(fileName); return true; } catch { return false; } },
    recordRelocated: (fromVolumeId, toVolumeId, size, sliceSize, isParity) => {
        const { storageStatsTracker } = require('../storage/stats-tracker') as typeof import('../storage/stats-tracker');
        storageStatsTracker.recordRelocated(fromVolumeId, toVolumeId, size, sliceSize, isParity);
    },
    runtimeConfig,
    isFrozen: isMaintenanceFrozen,
    createLogger,
    pauseVerify: () => verifyVolumesJob.pauseForRebalance(),
    resumeVerify: () => verifyVolumesJob.releaseForRebalance(),
    delayMs: config.verifyReadDelayMs
};

// Even out fill across the pool: move slices off over-full disks onto under-full ones. Balances by
// FILL RATIO (used/capacity, heterogeneous drives) with a deadband. ASYMMETRIC health policy: failing
// disks are never TARGETS (data only lands on healthy disks) but are ordinary SOURCES only for their
// over-target excess. Relocation reuses the drain engine (copy-first for data, recompute for parity,
// whole-object md5-gated) then DELETES the source slice (that's the point — free space). Gated by the
// maintenance freeze (optional housekeeping); paced, cancellable, cursor-resumable.
export class RebalanceJob {
    private readonly deps: RebalanceJobDeps;
    private readonly log: ReturnType<typeof createLogger>;
    private running = false;
    private cancelled = false;
    private deadband = DEFAULT_DEADBAND;
    private maxMoves = DEFAULT_MAX_MOVES;
    // Live progress (the job used to keep all of this in a local and only log it on completion, so the
    // API could say nothing but "running: true").
    private summary: RebalanceSummary = emptySummary();
    private startedAt: number | null = null;
    private bytesMoved = 0;
    private currentSourceId: number | null = null;
    private currentMinSize: number | null = null;
    private concurrency = DEFAULT_CONCURRENCY;
    // The tier loop rescans a source up to four times, so the same object can be skipped repeatedly.
    // Dedupe by id so the reported counts are 'objects affected', not 'attempts'.
    private skippedDeadIds = new Set<string>();
    private duplicateRefIds = new Set<string>();

    constructor(deps?: Partial<RebalanceJobDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('rebalance-job');
    }

    isRunning(): boolean { return this.running; }

    // Clamped to [1, MAX_CONCURRENCY]; a bad value falls back to the default rather than stalling the
    // job at 0 or melting the disks.
    static normalizeConcurrency(value: unknown): number {
        const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
        if (!Number.isFinite(n) || n < 1)
            return DEFAULT_CONCURRENCY;
        return Math.min(Math.floor(n), MAX_CONCURRENCY);
    }

    async getConcurrency(): Promise<number> {
        const stored = await this.deps.runtimeConfig.get(REBALANCE_CONCURRENCY_KEY);
        return stored == null ? DEFAULT_CONCURRENCY : RebalanceJob.normalizeConcurrency(stored);
    }

    // Takes effect on a RUNNING rebalance at the next batch — no restart needed.
    async setConcurrency(value: unknown): Promise<number> {
        const next = RebalanceJob.normalizeConcurrency(value);
        await this.deps.runtimeConfig.set(REBALANCE_CONCURRENCY_KEY, next);
        this.concurrency = next;
        this.log('rebalance concurrency set to %d', next);
        return next;
    }

    // Everything the UI needs: where the balance point is, how far off the pool still is, and how fast
    // we're closing the gap. bytesToMove is recomputed from LIVE volume fills, so it falls as the job
    // works and is correct even after a restart mid-rebalance.
    // Cancelled, but the moves already in the air are still landing.
    get isStopping(): boolean { return this.running && this.cancelled; }

    async getStatus(): Promise<RebalanceStatus> {
        // Read the persisted knob rather than the in-memory copy: when the job is idle the field still
        // holds whatever the last run used, and the UI has to show what the NEXT run will use.
        const concurrency = await this.getConcurrency();
        const pool = this.deps.getVolumes().filter(v => this.eligible(v));
        let poolCap = 0, poolUsed = 0;
        for (const v of pool) { const cap = v.bytesTotal || 0; poolCap += cap; poolUsed += cap - ((v.bytesFree ?? 0) - v.bytesPending); }
        const targetFill = poolCap > 0 ? poolUsed / poolCap : 0;

        let bytesToMove = 0;
        const sources: number[] = [];
        for (const v of pool) {
            const f = this.fill(v);
            if (f > targetFill + this.deadband) { bytesToMove += (f - targetFill) * (v.bytesTotal || 0); sources.push(v.id); }
        }
        // Rate and ETA are only meaningful WHILE running. Once the job stops, `startedAt`/`bytesMoved`
        // keep their last-run values, so an elapsed-time divide would show an idle system a fake ETA
        // that quietly worsened forever.
        const elapsedSec = this.running && this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0;
        const bytesPerSec = elapsedSec > 0 ? this.bytesMoved / elapsedSec : 0;
        return {
            running: this.running,
            stopping: this.isStopping,
            concurrency,
            targetFill,
            deadband: this.deadband,
            bytesToMove: Math.round(bytesToMove),
            bytesMoved: this.bytesMoved,
            bytesPerSec: Math.round(bytesPerSec),
            etaSeconds: bytesPerSec > 0 && bytesToMove > 0 ? Math.round(bytesToMove / bytesPerSec) : null,
            sourceVolumeIds: sources,
            currentSourceVolumeId: this.currentSourceId,
            currentMinObjectSize: this.currentMinSize,
            startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
            ...this.summary
        };
    }

    async start(options?: RebalanceOptions): Promise<void> {
        if (this.running)
            return;
        this.deadband = options?.deadband ?? DEFAULT_DEADBAND;
        this.maxMoves = options?.maxMoves ?? DEFAULT_MAX_MOVES;
        await this.deps.runtimeConfig.set(REBALANCE_ACTIVE_KEY, true);
        void this.run();
    }

    // True when a rebalance is persisted as active — i.e. it is running, or will resume. Startup uses
    // this to park the scrub BEFORE resuming it, so a queued verify never briefly starts and get killed.
    async hasPendingRun(): Promise<boolean> {
        return await this.deps.runtimeConfig.get(REBALANCE_ACTIVE_KEY) === true;
    }

    async resumePendingJob(): Promise<void> {
        if (!await this.hasPendingRun())
            return;
        if (await this.deps.isFrozen())
            return;
        this.log('resuming rebalance');
        void this.run();
    }

    async cancel(): Promise<void> {
        this.cancelled = true;
        await this.deps.runtimeConfig.delete(REBALANCE_ACTIVE_KEY);
        await this.deps.runtimeConfig.delete(REBALANCE_CURSOR_KEY);
        // If a run is in flight its finally-block releases the verify. If one was merely QUEUED (e.g.
        // cancelled while frozen), nothing else would ever unblock the scrub — so do it here.
        if (!this.running)
            await this.deps.resumeVerify();
    }

    stop(): void { this.cancelled = true; } // freeze pause: keep state

    // fill ratio of a volume (0..1), using live free bytes.
    private fill(v: Volume): number {
        const total = v.bytesTotal || 0;
        if (total <= 0) return 0;
        const free = (v.bytesFree ?? 0) - v.bytesPending;
        return (total - free) / total;
    }

    private eligible(v: Volume): boolean {
        return v.isWritable; // started+enabled+healthy+!readonly+!draining
    }

    private async run(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.cancelled = false;
        this.summary = emptySummary();
        this.skippedDeadIds.clear();
        this.duplicateRefIds.clear();
        this.startedAt = Date.now();
        this.bytesMoved = 0;
        const s = this.summary;
        try {
            this.concurrency = await this.getConcurrency();
            // We own the disks for the duration: park any scrub (cursor preserved) so it isn't
            // re-verifying slices we're about to move, and hand the disks back in finalize().
            await this.deps.pauseVerify();
            const pool = this.deps.getVolumes().filter(v => this.eligible(v));
            if (pool.length < 2) { this.log('rebalance: fewer than 2 eligible volumes, nothing to do'); return; }
            // Balance point = pool-wide used/capacity (capacity-weighted), not the average of per-volume
            // fills -- heterogeneous drive sizes make the latter wrong.
            let poolCap = 0, poolUsed = 0;
            for (const v of pool) { const cap = v.bytesTotal || 0; poolCap += cap; poolUsed += cap - ((v.bytesFree ?? 0) - v.bytesPending); }
            const target = poolCap > 0 ? poolUsed / poolCap : 0;
            this.log('rebalance: target fill %s%% (deadband ±%s%%) over %d eligible volumes', (target * 100).toFixed(1), (this.deadband * 100).toFixed(1), pool.length);

            // Sources: over target+band (any eligible/writable disk, health-blind). Most-over-full first.
            const sources = pool.filter(v => this.fill(v) > target + this.deadband).sort((a, b) => this.fill(b) - this.fill(a));
            if (!sources.length) { this.log('rebalance: pool already balanced, nothing to do'); await this.finalize(s); return; }

            for (const source of sources) {
                if (this.cancelled) return;
                if (await this.deps.isFrozen()) { this.log('maintenance freeze active: pausing rebalance'); return; }
                this.currentSourceId = source.id;
                await this.drainSourceToTarget(source, target, s);
                if (s.moves >= this.maxMoves) { this.log('rebalance: move budget reached (%d)', s.moves); break; }
            }
            await this.finalize(s);
        }
        catch (err) { this.log.error('rebalance failed: %s', err instanceof Error ? err.message : String(err)); }
        finally {
            // Clear `running` BEFORE waking the verify: it checks isRebalanceRunning() and would simply
            // defer itself again. Covers every exit — completion, cancel, freeze pause, and error.
            this.running = false;
            this.currentSourceId = null;
            this.currentMinSize = null;
            await this.deps.resumeVerify().catch(err =>
                this.log.error('failed to resume the deferred verify: %s', err instanceof Error ? err.message : String(err)));
        }
    }

    // Shed a source's over-target excess onto healthy under-target targets, biggest objects first.
    private async drainSourceToTarget(source: Volume, target: number, s: RebalanceSummary): Promise<void> {
        for (const minSize of SIZE_TIERS) {
            if (this.fill(source) <= target + this.deadband) return; // balanced -> never touch the small tiers
            if (this.cancelled || s.moves >= this.maxMoves) return;
            this.currentMinSize = minSize;
            await this.shedTier(source, target, s, minSize);
        }
        this.currentMinSize = null;
    }

    // One size tier of one source. Objects already moved by a bigger tier no longer reference the source,
    // so a later tier's scan never revisits them.
    private async shedTier(source: Volume, target: number, s: RebalanceSummary, minSize: number): Promise<void> {
        let cursor: string | undefined;
        while (this.fill(source) > target + this.deadband) {
            if (this.cancelled || await this.deps.isFrozen()) return;
            if (s.moves >= this.maxMoves) return;

            const batch = await this.deps.database.findObjectsOnVolume([source.id], BATCH_SIZE, cursor, { minSize });
            if (!batch.length) return; // tier exhausted on this source

            // Re-read the knob each batch so retuning it from the UI takes effect on the running job.
            this.concurrency = await this.getConcurrency();

            // Bounded concurrency, same shape as the drain's processBatch. A move is latency-bound
            // (open/read/write/commit + the DB ref flip) and the objects are often small, so awaiting
            // them one at a time leaves every spindle idle -- concurrency, not bandwidth, is the lever.
            const inflight = new Set<Promise<void>>();
            for (const doc of batch) {
                if (this.cancelled || s.moves >= this.maxMoves) break;
                if (this.fill(source) <= target + this.deadband) break; // source now balanced
                const p = this.moveOneSlice(doc, source, target, s).catch(err =>
                    this.log.error('rebalance move of %s failed: %s', (doc as { id?: string }).id, err instanceof Error ? err.message : String(err))
                ).finally(() => inflight.delete(p));
                inflight.add(p);
                if (inflight.size >= this.concurrency)
                    await Promise.race(inflight);
                if (this.deps.delayMs > 0)
                    await new Promise(r => setTimeout(r, this.deps.delayMs));
            }
            await Promise.all(inflight);
            cursor = (batch[batch.length - 1] as { id: string }).id; // in-source pagination only
        }
    }

    private async moveOneSlice(doc: ContentDocument, source: Volume, target: number, s: RebalanceSummary): Promise<void> {
        // Documented-dead objects (recoveryComment) are accepted loss: their surviving slices are
        // foreign or below quorum, so a relocation would reconstruct from sources we already know are
        // bad and write the result over a healthy volume. The repair worker and the drain both refuse
        // these (repair-worker blocks 'unrecoverable'; drain counts skippedDead) -- rebalance must too.
        if (isDocumentedDead(doc)) {
            const id = (doc as { id: string }).id;
            if (!this.skippedDeadIds.has(id)) { this.skippedDeadIds.add(id); s.skippedDead++; }
            return;
        }

        const dataVols = (doc as { dataVolumes?: number[] }).dataVolumes ?? [];
        const parityVols = (doc as { parityVolumes?: number[] }).parityVolumes ?? [];
        const all = [...dataVols, ...parityVols];
        const idx = all.indexOf(source.id);
        if (idx < 0) return;

        // replaceObjectVolumeRef rewrites EVERY array position holding source.id, but we copy exactly
        // ONE file (the first match). If an object somehow has two slices on this volume, flipping
        // would repoint both refs at the single copy we made and orphan the other -- turning a
        // recoverable slice into a lost one. Refuse to touch it; it needs a human.
        if (all.lastIndexOf(source.id) !== idx) {
            const id = (doc as { id: string }).id;
            this.log.error('object %s has multiple slices on volume %d: skipping (unsafe to relocate)', id, source.id);
            if (!this.duplicateRefIds.has(id)) { this.duplicateRefIds.add(id); s.duplicateRefs++; }
            return;
        }

        const objectVols = new Set(all);
        const declared = (doc as { sliceSize?: number }).sliceSize;
        const sliceBytes = typeof declared === 'number' ? declared : Math.ceil(((doc as { size?: number }).size ?? 0) / Math.max(1, dataVols.length));
        const dest = this.pickTarget(objectVols, sliceBytes, target, source.id);
        if (!dest) { s.noDest++; return; } // no under-target healthy volume this object can use

        // Hold the space for the whole move. Nothing else does: relocateByCopy writes straight to a
        // temp handle, and reconstructing onto a loaded-from-record object carries no reservation. So
        // without this, every concurrent move sees identical free space, pickTarget is deterministic,
        // and they ALL pile onto the same emptiest volume -- serialising on one spindle and
        // collectively over-committing it past pickTarget's own free-space guard. fill() already
        // subtracts bytesPending, so reserving fixes the guard and the spreading in one go.
        dest.reserveSpace(sliceBytes);
        let reserved = true;
        const release = () => { if (reserved) { dest.releaseReservation(sliceBytes); reserved = false; } };
        try {
            const object = await this.deps.loadObject(doc);
            const isParity = idx >= object.dataSliceCount;
            if (idx < object.dataSliceCount) object.dataSliceVolumeIds[idx] = dest.id;
            else object.paritySliceVolumeIds[idx - object.dataSliceCount] = dest.id;

            const fileName = `${(doc as { id: string }).id}.${idx}`;
            let placed = false;
            // Parity is always recomputed from verified data (copying preserves known-bad parity); data
            // slices try the fast copy first, then reconstruct.
            if (!isParity)
                placed = await this.deps.tryCopyRelocate(object, idx, fileName, source, dest);
            if (placed) s.copied++;
            if (!placed) {
                try { await this.deps.repairSlice(object, idx); placed = true; s.reconstructed++; }
                catch (err) { const code = (err as { code?: string } | undefined)?.code; if (code === 'EQUORUM' || code === 'ECORRUPT') { s.unrecoverable++; return; } throw err; }
            }

            // Positional atomic flip (only this slice's ref, source->dest; target must be absent ->
            // distinct-volume at commit; other slice positions untouched so a concurrent move can't clobber).
            const flipped = await this.deps.database.replaceObjectVolumeRef((doc as { id: string }).id, source.id, dest.id);
            if (!flipped) {
                // Someone else changed the object; drop the copy we placed and leave the source alone.
                await this.deps.deleteSourceSlice(dest, fileName).catch(() => undefined);
                return;
            }
            s.moves++;
            this.bytesMoved += sliceBytes;
            // Reflect the move in per-volume storage stats immediately (source -1, target +1).
            this.deps.recordRelocated(source.id, dest.id, (doc as { size?: number }).size ?? 0, sliceBytes, isParity);

            // The bytes are ON dest the moment the ref flips — whether or not the source unlink then
            // works. Account the two sides SEPARATELY: bundling them behind a successful delete would,
            // if the source went read-only mid-run (deleteCommittedFile throws when !isWritable), leave
            // dest permanently under-counted (so it keeps being picked as emptiest, past ENOSPC) and
            // source's fill never falling (so the tier loop would relocate the entire volume for nothing).
            this.accountPlaced(dest, sliceBytes);
            // Free the source (the point of a rebalance). A crash before this leaves a harmless duplicate.
            if (!await this.deps.deleteSourceSlice(source, fileName)) s.sourceDeleteFailed++;
            else this.accountFreed(source, sliceBytes);
        }
        finally {
            release();
        }
    }

    // Healthy WRITABLE target that is UNDER the fill target and the object doesn't already use, ranked
    // by FAILURE DOMAIN FIRST and only then by emptiness. Every candidate has already cleared the
    // capacity/health/fill filters, so preferring the enclosure that holds fewest of this object's
    // slices costs nothing — and applied across a whole rebalance it actively pulls the fleet back
    // toward surviving a box outage, instead of quietly stacking a third slice into a full group.
    private pickTarget(objectVols: Set<number>, sliceBytes: number, targetFill: number, movingFrom: number): Volume | null {
        const load = domainLoadForObject(objectVols, movingFrom, id => this.deps.getVolume(id));
        let best: Volume | null = null; let bestFill = Infinity; let bestLoad = Infinity;
        for (const v of this.deps.getVolumes()) {
            if (!this.eligible(v) || v.isHealthy === false) continue; // failing disks are never targets
            if ((v.verifyErrors?.total ?? 0) > 0) continue;           // suspect (had verify errors) -> not a target
            if (objectVols.has(v.id)) continue;
            if (this.fill(v) >= targetFill - this.deadband) continue;  // only under-target volumes receive
            if (((v.bytesFree ?? 0) - v.bytesPending) < sliceBytes) continue;
            const l = domainLoadFor(v, load);
            const f = this.fill(v);
            // Lexicographic: least-crowded failure domain wins; emptiest breaks the tie.
            if (l < bestLoad || (l === bestLoad && f < bestFill)) { bestLoad = l; bestFill = f; best = v; }
        }
        return best;
    }

    // Reflect the move in the in-memory free-byte estimate so fill() converges within a run before the
    // storage-stats tracker catches up.
    // The slice now occupies space on dest (ref flipped).
    private accountPlaced(dest: Volume, bytes: number): void {
        if (typeof dest.bytesFree === 'number') dest.bytesFree -= bytes;
    }

    // The source copy is gone, so its space is genuinely back. Only ever call this after a successful
    // unlink — otherwise the source's fill would never drop and the tier loop would never converge.
    private accountFreed(source: Volume, bytes: number): void {
        if (typeof source.bytesFree === 'number') source.bytesFree += bytes;
    }

    private async finalize(s: RebalanceSummary): Promise<void> {
        this.log('rebalance complete: %d moves (%d copied, %d reconstructed), %d no-dest, %d unrecoverable, %d source-delete-failed, %d dead-skipped, %d duplicate-refs',
            s.moves, s.copied, s.reconstructed, s.noDest, s.unrecoverable, s.sourceDeleteFailed, s.skippedDead, s.duplicateRefs);
        await this.deps.runtimeConfig.delete(REBALANCE_ACTIVE_KEY);
        await this.deps.runtimeConfig.delete(REBALANCE_CURSOR_KEY);
    }
}

export const rebalanceJob = new RebalanceJob();
