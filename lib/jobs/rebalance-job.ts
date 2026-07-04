import { createLogger } from '../log';
import { config } from '../config';
import { database } from '../database';
import { ioManager } from '../io/manager';
import { runtimeConfig } from '../runtime-config';
import { isMaintenanceFrozen } from '../maintenance';
import type { Volume } from '../io/volume';
import type { ContentDocument } from '../database/types';

// Persisted progress so a restart resumes an in-flight rebalance.
const REBALANCE_ACTIVE_KEY = 'rebalanceActive';
const REBALANCE_CURSOR_KEY = 'rebalanceCursor';   // `${sourceVolumeId}:${afterId}`
const BATCH_SIZE = 100;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_DEADBAND = 0.05;                     // ±5% fill hysteresis
const DEFAULT_MAX_MOVES = Number.POSITIVE_INFINITY;

type LoadedObject = { dataSliceVolumeIds: number[]; paritySliceVolumeIds: number[]; dataSliceCount: number; sliceSize: number };
type RebalanceSummary = { moves: number; reconstructed: number; copied: number; unrecoverable: number; noDest: number; sourceDeleteFailed: number };
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
    runtimeConfig: typeof runtimeConfig;
    isFrozen: () => Promise<boolean>;
    createLogger: typeof createLogger;
    concurrency: number;
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
    runtimeConfig,
    isFrozen: isMaintenanceFrozen,
    createLogger,
    concurrency: DEFAULT_CONCURRENCY,
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

    constructor(deps?: Partial<RebalanceJobDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('rebalance-job');
    }

    isRunning(): boolean { return this.running; }

    async start(options?: RebalanceOptions): Promise<void> {
        if (this.running)
            return;
        this.deadband = options?.deadband ?? DEFAULT_DEADBAND;
        this.maxMoves = options?.maxMoves ?? DEFAULT_MAX_MOVES;
        await this.deps.runtimeConfig.set(REBALANCE_ACTIVE_KEY, true);
        void this.run();
    }

    async resumePendingJob(): Promise<void> {
        if (await this.deps.runtimeConfig.get(REBALANCE_ACTIVE_KEY) !== true)
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
        const s: RebalanceSummary = { moves: 0, reconstructed: 0, copied: 0, unrecoverable: 0, noDest: 0, sourceDeleteFailed: 0 };
        try {
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
                await this.drainSourceToTarget(source, target, s);
                if (s.moves >= this.maxMoves) { this.log('rebalance: move budget reached (%d)', s.moves); break; }
            }
            await this.finalize(s);
        }
        catch (err) { this.log.error('rebalance failed: %s', err instanceof Error ? err.message : String(err)); }
        finally { this.running = false; }
    }

    // Shed a source's over-target excess onto healthy under-target targets.
    private async drainSourceToTarget(source: Volume, target: number, s: RebalanceSummary): Promise<void> {
        let cursor: string | undefined;
        while (this.fill(source) > target + this.deadband) {
            if (this.cancelled || await this.deps.isFrozen()) return;
            if (s.moves >= this.maxMoves) return;

            const batch = await this.deps.database.findObjectsOnVolume([source.id], BATCH_SIZE, cursor);
            if (!batch.length) return; // no more objects on this source

            for (const doc of batch) {
                if (this.cancelled || s.moves >= this.maxMoves) break;
                if (this.fill(source) <= target + this.deadband) break; // source now balanced
                await this.moveOneSlice(doc, source, target, s).catch(err =>
                    this.log.error('rebalance move of %s failed: %s', (doc as { id?: string }).id, err instanceof Error ? err.message : String(err)));
                if (this.deps.delayMs > 0)
                    await new Promise(r => setTimeout(r, this.deps.delayMs));
            }
            cursor = (batch[batch.length - 1] as { id: string }).id; // in-source pagination only
        }
    }

    private async moveOneSlice(doc: ContentDocument, source: Volume, target: number, s: RebalanceSummary): Promise<void> {
        const dataVols = (doc as { dataVolumes?: number[] }).dataVolumes ?? [];
        const parityVols = (doc as { parityVolumes?: number[] }).parityVolumes ?? [];
        const all = [...dataVols, ...parityVols];
        const idx = all.indexOf(source.id);
        if (idx < 0) return;

        const objectVols = new Set(all);
        const declared = (doc as { sliceSize?: number }).sliceSize;
        const sliceBytes = typeof declared === 'number' ? declared : Math.ceil(((doc as { size?: number }).size ?? 0) / Math.max(1, dataVols.length));
        const dest = this.pickTarget(objectVols, sliceBytes, target);
        if (!dest) { s.noDest++; return; } // no under-target healthy volume this object can use

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
        // Free the space (the point of rebalance). A crash before this leaves a harmless duplicate.
        if (!await this.deps.deleteSourceSlice(source, fileName)) s.sourceDeleteFailed++;
        else this.accountMove(source, dest, sliceBytes);
    }

    // Emptiest healthy WRITABLE target that is UNDER the fill target and the object doesn't already use.
    private pickTarget(objectVols: Set<number>, sliceBytes: number, targetFill: number): Volume | null {
        let best: Volume | null = null; let bestFill = Infinity;
        for (const v of this.deps.getVolumes()) {
            if (!this.eligible(v) || v.isHealthy === false) continue; // failing disks are never targets
            if ((v.verifyErrors?.total ?? 0) > 0) continue;           // suspect (had verify errors) -> not a target
            if (objectVols.has(v.id)) continue;
            if (this.fill(v) >= targetFill - this.deadband) continue;  // only under-target volumes receive
            if (((v.bytesFree ?? 0) - v.bytesPending) < sliceBytes) continue;
            const f = this.fill(v);
            if (f < bestFill) { bestFill = f; best = v; }
        }
        return best;
    }

    // Reflect the move in the in-memory free-byte estimate so fill() converges within a run before the
    // storage-stats tracker catches up.
    private accountMove(source: Volume, dest: Volume, bytes: number): void {
        if (typeof source.bytesFree === 'number') source.bytesFree += bytes;
        if (typeof dest.bytesFree === 'number') dest.bytesFree -= bytes;
    }

    private async finalize(s: RebalanceSummary): Promise<void> {
        this.log('rebalance complete: %d moves (%d copied, %d reconstructed), %d no-dest, %d unrecoverable, %d source-delete-failed',
            s.moves, s.copied, s.reconstructed, s.noDest, s.unrecoverable, s.sourceDeleteFailed);
        await this.deps.runtimeConfig.delete(REBALANCE_ACTIVE_KEY);
        await this.deps.runtimeConfig.delete(REBALANCE_CURSOR_KEY);
    }
}

export const rebalanceJob = new RebalanceJob();
