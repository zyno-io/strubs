import { createLogger } from '../log';
import { config } from '../config';
import { database } from '../database';
import { ioManager } from '../io/manager';
import { runtimeConfig } from '../runtime-config';
import { isMaintenanceFrozen } from '../maintenance';
import type { Volume } from '../io/volume';
import type { ContentDocument } from '../database/types';

// Persisted drain progress (so a restart resumes the in-flight drain before routine maintenance).
const DRAIN_VOLUME_ID_KEY = 'drainVolumeId';
const DRAIN_CURSOR_ID_KEY = 'drainCursorId';
const BATCH_SIZE = 100;
const DEFAULT_CONCURRENCY = 4;

type LoadedObject = { dataSliceVolumeIds: number[]; paritySliceVolumeIds: number[]; dataSliceCount: number; sliceSize: number };
type DrainSummary = { objects: number; relocated: number; unrecoverable: number; skippedDead: number; noDest: number };

type DrainVolumeJobDeps = {
    database: Pick<typeof database, 'findObjectsOnVolume' | 'replaceObjectVolumeRef' | 'getObjectById'>;
    getWritableVolumes: () => Volume[];
    getVolume: (id: number) => Volume | undefined;
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
    runtimeConfig: typeof runtimeConfig;
    isFrozen: () => Promise<boolean>;
    createLogger: typeof createLogger;
    concurrency: number;
    delayMs: number;
};

const defaultDeps: DrainVolumeJobDeps = {
    database,
    getWritableVolumes: () => ioManager.getWritableVolumes(),
    getVolume: (id: number) => ioManager.getVolume(id),
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
    runtimeConfig,
    isFrozen: isMaintenanceFrozen,
    createLogger,
    concurrency: DEFAULT_CONCURRENCY,
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
    private cancelled = false; // paused (freeze) — persisted state kept so it resumes
    private aborted = false;   // operator cancel — persisted state cleared so it does NOT resume
    private activeVolumeId: number | null = null;

    constructor(deps?: Partial<DrainVolumeJobDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('drain-volume-job');
    }

    isRunning(): boolean { return this.running; }
    drainingVolumeId(): number | null { return this.activeVolumeId; }

    // Begin (or restart) draining a volume. Idempotent while a drain for the same volume is running.
    async start(volumeId: number): Promise<void> {
        if (this.running) {
            if (this.activeVolumeId === volumeId)
                return;
            this.log('cannot drain volume %d: a drain of volume %d is already running', volumeId, this.activeVolumeId);
            return;
        }
        await this.deps.runtimeConfig.set(DRAIN_VOLUME_ID_KEY, volumeId);
        await this.deps.runtimeConfig.delete(DRAIN_CURSOR_ID_KEY);
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
        this.running = true;
        this.cancelled = false;
        this.aborted = false;
        this.activeVolumeId = volumeId;
        const s: DrainSummary = { objects: 0, relocated: 0, unrecoverable: 0, skippedDead: 0, noDest: 0 };
        this.log('draining volume %d — reconstructing and relocating its slices', volumeId);
        try {
            let cursor = afterId;
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
                    this.log('  ...%d objects, %d relocated, %d unrecoverable, %d dead-skipped', s.objects, s.relocated, s.unrecoverable, s.skippedDead);
                if (this.deps.delayMs > 0)
                    await new Promise(r => setTimeout(r, this.deps.delayMs));
            }
            if (!this.cancelled && !this.aborted)
                await this.finalize(volumeId, s);
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
        if ((doc as { recoveryComment?: unknown }).recoveryComment != null) { s.skippedDead++; return; }

        const dataVols = (doc as { dataVolumes?: number[] }).dataVolumes ?? [];
        const parityVols = (doc as { parityVolumes?: number[] }).parityVolumes ?? [];
        const all = [...dataVols, ...parityVols];
        const idx = all.indexOf(volumeId);
        if (idx < 0)
            return; // no longer here (already relocated / concurrent change)

        const objectVols = new Set(all);
        // Keep a legitimately-zero slice size as 0 (a zero-byte object needs ~no space) instead of
        // defaulting it to a bogus large requirement that would falsely block relocation.
        const declared = (doc as { sliceSize?: number }).sliceSize;
        const sliceBytes = typeof declared === 'number' ? declared : Math.ceil(((doc as { size?: number }).size ?? 0) / Math.max(1, dataVols.length));
        const target = this.pickTarget(objectVols, sliceBytes);
        if (!target) { s.noDest++; this.log('no relocation target for object %s (all healthy volumes in use or full)', (doc as { id?: string }).id); return; }

        const object = await this.deps.loadObject(doc);
        const isParity = idx >= object.dataSliceCount;
        if (idx < object.dataSliceCount)
            object.dataSliceVolumeIds[idx] = target.id;
        else
            object.paritySliceVolumeIds[idx - object.dataSliceCount] = target.id;

        // Copy-first for DATA (fast); PARITY is always RECOMPUTED (a byte-copy would preserve known-bad
        // /foreign parity). Reconstruct is whole-object md5-gated and works even when the source is offline.
        const fileName = `${(doc as { id: string }).id}.${idx}`;
        const sourceVol = this.deps.getVolume(volumeId);
        let placed = false;
        if (sourceVol && !isParity)
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
        // Account the write so pickTarget spreads within the run (loadFromRecord objects don't
        // self-account on commit). Drain keeps the source, so only the target changes.
        if (typeof target.bytesFree === 'number') target.bytesFree -= sliceBytes;
    }

    // Emptiest healthy WRITABLE volume the object doesn't already use (draining volumes are already
    // excluded from getWritableVolumes()). Distinct-volume constraint keeps one slice per drive.
    private pickTarget(objectVols: Set<number>, sliceBytes: number): Volume | null {
        let best: Volume | null = null;
        let bestFree = -1;
        for (const v of this.deps.getWritableVolumes()) {
            if (objectVols.has(v.id))
                continue;
            const free = (v.bytesFree ?? 0) - v.bytesPending;
            if (free < sliceBytes)
                continue;
            if (free > bestFree) { bestFree = free; best = v; }
        }
        return best;
    }

    private async finalize(volumeId: number, s: DrainSummary): Promise<void> {
        this.log('drain of volume %d complete: %d objects, %d relocated, %d unrecoverable, %d dead-skipped, %d no-dest',
            volumeId, s.objects, s.relocated, s.unrecoverable, s.skippedDead, s.noDest);
        if (s.unrecoverable || s.noDest)
            this.log.error('volume %d still has %d slices that could not be relocated (unrecoverable/no-dest) — removal blocked until resolved', volumeId, s.unrecoverable + s.noDest);
        await this.deps.runtimeConfig.delete(DRAIN_VOLUME_ID_KEY);
        await this.deps.runtimeConfig.delete(DRAIN_CURSOR_ID_KEY);
        // Drain job finished: clear the draining flag (the drive stays read-only + empty, awaiting a
        // manual delete). Only reached on natural completion -- a freeze-pause returns before here.
        await this.deps.markDrainComplete(volumeId);
    }
}

export const drainVolumeJob = new DrainVolumeJob();
