import { createLogger } from '../log';
import { config } from '../config';
import { database } from '../database';
import { ioManager } from '../io/manager';
import { runtimeConfig } from '../runtime-config';
import { isMaintenanceFrozen } from '../maintenance';
import type { Volume } from '../io/volume';
import type { ContentDocument } from '../database/types';

// Persisted evict progress (so a restart resumes the in-flight drain before routine maintenance).
const EVICT_VOLUME_ID_KEY = 'evictVolumeId';
const EVICT_CURSOR_ID_KEY = 'evictCursorId';
const BATCH_SIZE = 100;
const DEFAULT_CONCURRENCY = 4;

type LoadedObject = { dataSliceVolumeIds: number[]; paritySliceVolumeIds: number[]; dataSliceCount: number; sliceSize: number };
type EvictSummary = { objects: number; relocated: number; unrecoverable: number; skippedDead: number; noDest: number };

type EvictVolumeJobDeps = {
    database: Pick<typeof database, 'findObjectsOnVolume' | 'replaceObjectVolumeRef' | 'getObjectById'>;
    getWritableVolumes: () => Volume[];
    getVolume: (id: number) => Volume | undefined;
    loadObject: (record: unknown) => Promise<LoadedObject>;
    // Copy-first fast path: if the source drive is online, copy the slice file to the target and
    // validate it (chunk checksums) -- far cheaper than RS for a HEALTHY drain. Returns false (falls
    // back to reconstruct) if the source is offline/unreadable or the copy doesn't validate.
    tryCopyRelocate: (object: LoadedObject, sliceIndex: number, fileName: string, sourceVol: Volume, targetVol: Volume) => Promise<boolean>;
    repairSlice: (object: LoadedObject, sliceIndex: number) => Promise<void>;
    runtimeConfig: typeof runtimeConfig;
    isFrozen: () => Promise<boolean>;
    createLogger: typeof createLogger;
    concurrency: number;
    delayMs: number;
};

async function copyFile(sourceVol: Volume, targetVol: Volume, fileName: string): Promise<boolean> {
    let src; let dst;
    try { src = await sourceVol.openCommittedFh(fileName); }
    catch { return false; }                              // offline / missing -> reconstruct instead
    try {
        dst = await targetVol.createTemporaryFh(fileName);
        const buf = Buffer.allocUnsafe(1 << 20);
        let pos = 0;
        for (;;) {
            const { bytesRead } = await src.read(buf, 0, buf.length, pos);
            if (!bytesRead) break;
            let written = 0;
            while (written < bytesRead) { const r = await dst.write(buf, written, bytesRead - written); written += r.bytesWritten; }
            pos += bytesRead;
        }
        await dst.close(); dst = undefined;
        await targetVol.commitTemporaryFile(fileName);
        return true;
    }
    catch { if (dst) await dst.close().catch(() => undefined); return false; }
    finally { await src.close().catch(() => undefined); }
}

const defaultDeps: EvictVolumeJobDeps = {
    database,
    getWritableVolumes: () => ioManager.getWritableVolumes(),
    getVolume: (id: number) => ioManager.getVolume(id),
    tryCopyRelocate: async (object: LoadedObject, sliceIndex: number, fileName: string, sourceVol: Volume, targetVol: Volume) => {
        if (!sourceVol.isReadable || !targetVol.isWritable)
            return false;
        if (!await copyFile(sourceVol, targetVol, fileName))
            return false;
        // Validate the copied slice (the object's ref for this index now points at the target): open +
        // checksum every chunk. If the copy doesn't validate, drop it and fall back to reconstruct.
        try {
            const { FileObjectSliceVerifier } = require('../io/file-object/slice-verifier') as typeof import('../io/file-object/slice-verifier');
            await new FileObjectSliceVerifier(object as never).verifySlice(sliceIndex);
            return true;
        }
        catch {
            await targetVol.deleteCommittedFile(fileName).catch(() => undefined);
            return false;
        }
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
export class EvictVolumeJob {
    private readonly deps: EvictVolumeJobDeps;
    private readonly log: ReturnType<typeof createLogger>;
    private running = false;
    private cancelled = false; // paused (freeze) — persisted state kept so it resumes
    private aborted = false;   // operator cancel — persisted state cleared so it does NOT resume
    private activeVolumeId: number | null = null;

    constructor(deps?: Partial<EvictVolumeJobDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('evict-volume-job');
    }

    isRunning(): boolean { return this.running; }
    evictingVolumeId(): number | null { return this.activeVolumeId; }

    // Begin (or restart) evicting a volume. Idempotent while a drain for the same volume is running.
    async start(volumeId: number): Promise<void> {
        if (this.running) {
            if (this.activeVolumeId === volumeId)
                return;
            this.log('cannot evict volume %d: a drain of volume %d is already running', volumeId, this.activeVolumeId);
            return;
        }
        await this.deps.runtimeConfig.set(EVICT_VOLUME_ID_KEY, volumeId);
        await this.deps.runtimeConfig.delete(EVICT_CURSOR_ID_KEY);
        void this.run(volumeId, undefined);
    }

    // Resume a persisted, not-yet-finished eviction (called at startup BEFORE the scrub/repair start).
    async resumePendingJob(): Promise<void> {
        const volumeId = await this.deps.runtimeConfig.get(EVICT_VOLUME_ID_KEY);
        if (typeof volumeId !== 'number')
            return;
        if (await this.deps.isFrozen()) {
            this.log('maintenance freeze active: not resuming eviction of volume %d', volumeId);
            return;
        }
        const cursor = await this.deps.runtimeConfig.get(EVICT_CURSOR_ID_KEY);
        this.log('resuming eviction of volume %d', volumeId);
        void this.run(volumeId, typeof cursor === 'string' ? cursor : undefined);
    }

    // Pause (e.g. maintenance freeze): stop processing but KEEP the persisted evict state so the drain
    // resumes later (resumePendingJob).
    stop(): void { this.cancelled = true; }

    // Operator cancel: abort the drain AND clear the persisted state so it does NOT resume. The volume
    // stays isEvicting=false is the caller's job (mgmt). Already-relocated slices keep their new homes.
    async cancel(volumeId?: number): Promise<void> {
        if (volumeId !== undefined && this.activeVolumeId !== null && this.activeVolumeId !== volumeId) {
            // A different drain is running; only clear any persisted pending state for the named volume.
            const pending = await this.deps.runtimeConfig.get(EVICT_VOLUME_ID_KEY);
            if (pending !== volumeId)
                return;
        }
        this.cancelled = true;
        this.aborted = true;
        await this.clearState();
        this.log('eviction cancelled for volume %s', volumeId ?? this.activeVolumeId ?? '?');
    }

    private async clearState(): Promise<void> {
        await this.deps.runtimeConfig.delete(EVICT_VOLUME_ID_KEY);
        await this.deps.runtimeConfig.delete(EVICT_CURSOR_ID_KEY);
    }

    private async run(volumeId: number, afterId: string | undefined): Promise<void> {
        if (this.running)
            return;
        this.running = true;
        this.cancelled = false;
        this.aborted = false;
        this.activeVolumeId = volumeId;
        const s: EvictSummary = { objects: 0, relocated: 0, unrecoverable: 0, skippedDead: 0, noDest: 0 };
        this.log('evicting volume %d — reconstructing and relocating its slices', volumeId);
        try {
            let cursor = afterId;
            for (;;) {
                if (this.aborted) { this.log('eviction of volume %d cancelled', volumeId); return; }
                if (this.cancelled) { this.log('eviction of volume %d paused', volumeId); return; }
                if (await this.deps.isFrozen()) { this.log('maintenance freeze active: pausing eviction of volume %d', volumeId); return; }

                const batch = await this.deps.database.findObjectsOnVolume([volumeId], BATCH_SIZE, cursor);
                if (!batch.length)
                    break;

                await this.processBatch(batch, volumeId, s);
                if (this.aborted)
                    return;
                cursor = String(batch[batch.length - 1]._id);
                await this.deps.runtimeConfig.set(EVICT_CURSOR_ID_KEY, cursor);
                if (s.objects % 1000 === 0)
                    this.log('  ...%d objects, %d relocated, %d unrecoverable, %d dead-skipped', s.objects, s.relocated, s.unrecoverable, s.skippedDead);
                if (this.deps.delayMs > 0)
                    await new Promise(r => setTimeout(r, this.deps.delayMs));
            }
            if (!this.cancelled && !this.aborted)
                await this.finalize(volumeId, s);
        }
        catch (err) {
            this.log.error('eviction of volume %d failed: %s', volumeId, err instanceof Error ? err.message : String(err));
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

    private async processBatch(batch: ContentDocument[], volumeId: number, s: EvictSummary): Promise<void> {
        const inflight = new Set<Promise<void>>();
        for (const doc of batch) {
            if (this.cancelled || this.aborted)
                break;
            s.objects++;
            const p = this.drainObject(doc, volumeId, s).catch(err => {
                this.log.error('drain of object %s failed: %s', String((doc as { _id?: unknown })._id), err instanceof Error ? err.message : String(err));
            }).finally(() => inflight.delete(p));
            inflight.add(p);
            if (inflight.size >= this.deps.concurrency)
                await Promise.race(inflight);
        }
        await Promise.all(inflight);
    }

    private async drainObject(doc: ContentDocument, volumeId: number, s: EvictSummary): Promise<void> {
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
        const sliceBytes = (doc as { sliceSize?: number }).sliceSize || Math.ceil(((doc as { size?: number }).size ?? 0) / Math.max(1, dataVols.length)) || 5e6;
        const target = this.pickTarget(objectVols, sliceBytes);
        if (!target) { s.noDest++; this.log('no relocation target for object %s (all healthy volumes in use or full)', String((doc as { _id?: unknown })._id)); return; }

        const object = await this.deps.loadObject(doc);
        if (idx < object.dataSliceCount)
            object.dataSliceVolumeIds[idx] = target.id;
        else
            object.paritySliceVolumeIds[idx - object.dataSliceCount] = target.id;

        // Copy-first (fast, healthy/online source), else reconstruct (md5-gated, works even offline).
        const fileName = `${String(doc._id)}.${idx}`;
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
        const flipped = placed && await this.deps.database.replaceObjectVolumeRef(doc._id, volumeId, object.dataSliceVolumeIds, object.paritySliceVolumeIds);
        if (flipped)
            s.relocated++;
    }

    // Emptiest healthy WRITABLE volume the object doesn't already use (evicting volumes are already
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

    private async finalize(volumeId: number, s: EvictSummary): Promise<void> {
        this.log('eviction of volume %d complete: %d objects, %d relocated, %d unrecoverable, %d dead-skipped, %d no-dest',
            volumeId, s.objects, s.relocated, s.unrecoverable, s.skippedDead, s.noDest);
        if (s.unrecoverable || s.noDest)
            this.log.error('volume %d still has %d slices that could not be relocated (unrecoverable/no-dest) — removal blocked until resolved', volumeId, s.unrecoverable + s.noDest);
        await this.deps.runtimeConfig.delete(EVICT_VOLUME_ID_KEY);
        await this.deps.runtimeConfig.delete(EVICT_CURSOR_ID_KEY);
    }
}

export const evictVolumeJob = new EvictVolumeJob();
