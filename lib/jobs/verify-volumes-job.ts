import os from 'os';
import PQueue from 'p-queue';
import { database, type SliceErrorInfo } from '../database';
import { categorizeSliceError, isIOAbort } from '../slice-error';
import { runtimeConfig } from '../runtime-config';
import { fileObjectService, type FileObjectService } from '../io/file-object/service';
import type { StoredObjectRecord, FileObject } from '../io/file-object';
import { ioManager } from '../io/manager';
import { createLogger } from '../log';
import type { Volume } from '../io/volume';
import { FileObjectSliceVerifier, type VerifyMode } from '../io/file-object/slice-verifier';
import { remediationService } from '../remediation/service';
import { buildObjectVerificationStateUpdate } from '../verification-state';
import { isMaintenanceFrozen } from '../maintenance';

type VolumeErrorCounters = {
    checksum: number;
    total: number;
};

type VerifyVolumesJobDeps = {
    database: typeof database;
    runtimeConfig: typeof runtimeConfig;
    fileObjectService: FileObjectService;
    ioManager: typeof ioManager;
    createLogger: typeof createLogger;
    createSliceVerifier: (object: FileObject, mode: VerifyMode) => { verifySlice: (sliceIndex: number) => Promise<void> };
    remediationService: typeof remediationService;
};

type VerifyVolumesErrorSnapshot = {
    total: number;
    volumes: Record<string, number>;
};

export type VerifyVolumesStatus = {
    running: boolean;
    startedAt: string | null;
    objectsVerified: number;
    errors: VerifyVolumesErrorSnapshot;
    concurrency: number;
    scope: 'full' | 'targeted';
    mode: VerifyMode;
    volumeIds: number[];
    // Requested (and persisted), but held back until a rebalance finishes. Not running, not lost.
    waiting: boolean;
    waitingFor: 'rebalance' | null;
};

type VerifyVolumesObjectResult = {
    checksumErrors: number;
    totalErrors: number;
    volumeImpacts: Map<number, VolumeErrorCounters>;
};

type VerifyStartResult = { startedAt: string; accepted: boolean; deferred?: boolean };

const defaultDeps: VerifyVolumesJobDeps = {
    database,
    runtimeConfig,
    fileObjectService,
    ioManager,
    createLogger,
    createSliceVerifier: (object: FileObject, mode: VerifyMode) => new FileObjectSliceVerifier(object, { mode }),
    remediationService
};

const VERIFY_BATCH_SIZE = 25;
const VERIFY_VOLUME_IDS_KEY = 'verifyVolumeIds';
const VERIFY_CURSOR_ID_KEY = 'verifyCursorId';
const VERIFY_MODE_KEY = 'verifyMode';
// How long stop() waits for the run to drain in-flight work before giving up.
// A read against a failing drive can wedge in the kernel (its libuv threadpool
// thread never returns), so a cooperative cancel may never complete. After this
// we abandon the run so the API responds and a fresh run can start.
const STOP_DRAIN_TIMEOUT_MS = 10000;

// Per-run mutable state. Holding cancellation, the volume read coordinator and
// run identity on a handle (rather than on the job) means an abandoned/"zombie"
// run that is still blocked on stuck disk I/O cannot interfere with a later run
// that reuses the same job instance.
interface ActiveRun {
    token: number;
    cancelled: boolean;
    coordinator: VolumeReadCoordinator;
    cursorId: string | null;
    mode: VerifyMode;
}
const envConcurrency = process.env.STRUBS_VERIFY_PARALLEL ? Number.parseInt(process.env.STRUBS_VERIFY_PARALLEL, 10) : NaN;
const cpuCount = os.cpus?.().length ?? 1;

class VolumeReadCoordinator {
    private readonly locked = new Set<number>();
    private readonly queues = new Map<number, Array<() => void>>();

    async acquire(volumeId: number | null | undefined): Promise<() => void> {
        if (volumeId === null || volumeId === undefined)
            return () => undefined;
        if (!this.locked.has(volumeId)) {
            this.locked.add(volumeId);
            return this.createRelease(volumeId);
        }
        return new Promise<() => void>(resolve => {
            const queue = this.queues.get(volumeId) ?? [];
            queue.push(() => {
                this.locked.add(volumeId);
                resolve(this.createRelease(volumeId));
            });
            this.queues.set(volumeId, queue);
        });
    }

    private createRelease(volumeId: number): () => void {
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            const queue = this.queues.get(volumeId);
            if (queue && queue.length) {
                const next = queue.shift();
                if (next)
                    next();
                if (!queue.length)
                    this.queues.delete(volumeId);
                return;
            }
            this.locked.delete(volumeId);
        };
    }
}

class LaneAllocator {
    private readonly available: number[] = [];
    private readonly waiters: Array<(lane: number) => void> = [];

    constructor(total: number) {
        for (let lane = 1; lane <= total; lane++)
            this.available.push(lane);
    }

    acquire(): Promise<number> {
        const lane = this.available.shift();
        if (lane !== undefined)
            return Promise.resolve(lane);
        return new Promise(resolve => this.waiters.push(resolve));
    }

    release(lane: number): void {
        const waiter = this.waiters.shift();
        if (waiter) {
            waiter(lane);
            return;
        }
        this.available.push(lane);
    }
}

export class VerifyVolumesJob {
    private readonly deps: VerifyVolumesJobDeps;
    private readonly log: ReturnType<typeof createLogger>;
    private running: Promise<void> | null = null;
    private activeRun: ActiveRun | null = null;
    private runToken = 0;
    private startedAt: string | null = null;
    private volumeFilter: Set<number> | null = null;
    private startGuard = false;
    private waitingForRebalance = false;
    private blockedByRebalance = false;
    private progress = {
        objectsVerified: 0,
        errors: {
            total: 0,
            volumes: {} as Record<string, number>
        }
    };
    private progressLogger: NodeJS.Timeout | null = null;
    private currentConcurrency = 0;
    private currentMode: VerifyMode = 'full';

    constructor(deps?: Partial<VerifyVolumesJobDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('verify-job');
    }

    async start(options?: { volumeIds?: number[]; mode?: VerifyMode }): Promise<VerifyStartResult> {
        if (await isMaintenanceFrozen()) {
            this.log('maintenance freeze active: not starting verify run');
            return { startedAt: this.startedAt ?? '', accepted: false };
        }
        const requestedFilter = this.normalizeVolumeIds(options?.volumeIds);
        const requestedMode = this.normalizeMode(options?.mode);
        if (this.running)
            return { startedAt: this.startedAt as string, accepted: this.activeRunCoversRequest(requestedFilter) };
        // Synchronous guard: start() awaits runtime-config/persistence before
        // launch() sets `running`, so without this two overlapping callers
        // (scheduler tick, HTTP, resume) could both proceed and corrupt state.
        if (this.startGuard)
            return { startedAt: this.startedAt ?? '', accepted: false };
        this.startGuard = true;
        try {
            const existing = await this.deps.runtimeConfig.get('verifyStartedAt');
            if (typeof existing === 'string' && existing.length) {
                const persistedFilter = await this.loadPersistedVolumeFilter();
                const persistedCursorId = await this.loadPersistedCursorId();
                const persistedMode = await this.loadPersistedMode();
                const restoredCount = await this.getResumedObjectsVerified(existing, persistedFilter);
                const accepted = this.filterCoversRequest(persistedFilter, requestedFilter);
                if (this.deferForRebalance())
                    return { startedAt: existing, accepted, deferred: true };
                this.launch(existing, true, persistedFilter, restoredCount, persistedCursorId, persistedMode);
                return { startedAt: existing, accepted };
            }

            await this.persistVolumeFilter(requestedFilter);
            await this.persistMode(requestedMode);
            await this.deps.runtimeConfig.delete(VERIFY_CURSOR_ID_KEY);

            const startedAt = new Date().toISOString();
            await this.deps.runtimeConfig.set('verifyStartedAt', startedAt);
            // Persisted above, so the request is not lost — the rebalance resumes it when it finishes.
            if (this.deferForRebalance())
                return { startedAt, accepted: true, deferred: true };
            this.launch(startedAt, false, requestedFilter, 0, null, requestedMode);
            return { startedAt, accepted: true };
        }
        finally {
            this.startGuard = false;
        }
    }

    async resumePendingJob(): Promise<void> {
        if (this.running || this.startGuard)
            return;
        if (await isMaintenanceFrozen()) {
            this.log('maintenance freeze active: not resuming pending verify run');
            return;
        }
        this.startGuard = true;
        try {
            const existing = await this.deps.runtimeConfig.get('verifyStartedAt');
            if (typeof existing !== 'string' || !existing.length)
                return;
            if (this.deferForRebalance())
                return; // state stays persisted; the rebalance calls back here when it finishes
            this.log('resuming verify job started at %s', existing);
            const persistedFilter = await this.loadPersistedVolumeFilter();
            const persistedCursorId = await this.loadPersistedCursorId();
            const persistedMode = await this.loadPersistedMode();
            const restoredCount = await this.getResumedObjectsVerified(existing, persistedFilter);
            this.launch(existing, true, persistedFilter, restoredCount, persistedCursorId, persistedMode);
        }
        finally {
            this.startGuard = false;
        }
    }

    // A rebalance relocates slices out from under a scrub: the two fight over the same spindles, and
    // verifying a volume whose slices are moving re-verifies a moving target. So a rebalance takes the
    // disks for its duration -- it parks any running scrub (cursor preserved) and blocks new ones. A
    // verify requested meanwhile is PERSISTED and queued, never dropped.
    async pauseForRebalance(): Promise<void> {
        this.blockedByRebalance = true;
        if (this.isRunning()) {
            this.log('rebalance starting: pausing verify (its cursor is preserved)');
            await this.stop({ preserveState: true });
            this.waitingForRebalance = true; // paused mid-run -> it is queued, not finished
        }
    }

    // Rebalance finished (or was cancelled): hand the disks back and start whatever was queued.
    async releaseForRebalance(): Promise<void> {
        this.blockedByRebalance = false;
        await this.resumePendingJob();
    }

    // Hold the run back while a rebalance is in flight. The caller has already persisted the request,
    // so this only decides whether to launch NOW. Returns true when the run was deferred.
    private deferForRebalance(): boolean {
        if (!this.blockedByRebalance)
            return false;
        this.waitingForRebalance = true;
        this.log('rebalance in progress: verify queued, will start when the rebalance finishes');
        return true;
    }

    async stop(options?: { preserveState?: boolean }): Promise<void> {
        const running = this.running;
        const run = this.activeRun;
        if (!running || !run) {
            // A run queued behind a rebalance isn't "running", but Stop must still be able to drop it —
            // otherwise it would silently start the moment the rebalance ends.
            if (this.waitingForRebalance && !options?.preserveState) {
                this.log('stop requested: discarding the verify queued behind the rebalance');
                this.waitingForRebalance = false;
                await this.clearPersistedRun();
            }
            return;
        }
        this.log('stop requested');
        run.cancelled = true;

        const drained = await this.awaitWithTimeout(running, STOP_DRAIN_TIMEOUT_MS);
        if (!drained && this.activeRun === run) {
            // The run is wedged — almost certainly an in-flight read against a
            // failing drive that won't return (its libuv threadpool thread is
            // stuck in the kernel; the slice-level read timeout rejects the JS
            // promise but cannot cancel the syscall). Abandon it so the API
            // returns and a new run can start. The zombie keeps its own
            // ActiveRun handle, so when its stuck I/O eventually returns it
            // exits quietly without touching this job's state.
            this.log.error(
                'verify job did not drain within %dms after stop; abandoning wedged run (in-flight disk I/O may still be pending)',
                STOP_DRAIN_TIMEOUT_MS
            );
            this.stopProgressLogger();
            this.activeRun = null;
            this.running = null;
            this.startedAt = null;
            this.currentConcurrency = 0;
            this.currentMode = 'full';
            this.volumeFilter = null;
        }

        if (!options?.preserveState)
            await this.clearPersistedRun();
    }

    private async clearPersistedRun(): Promise<void> {
        await this.deps.runtimeConfig.delete('verifyStartedAt');
        await this.deps.runtimeConfig.delete(VERIFY_VOLUME_IDS_KEY);
        await this.deps.runtimeConfig.delete(VERIFY_CURSOR_ID_KEY);
        await this.deps.runtimeConfig.delete(VERIFY_MODE_KEY);
    }

    // Resolve true if the promise settles within the window, false on timeout.
    private awaitWithTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
        return new Promise<boolean>(resolve => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                resolve(false);
            }, ms);
            timer.unref?.();
            promise.then(() => undefined, () => undefined).then(() => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                resolve(true);
            });
        });
    }

    isRunning(): boolean {
        return Boolean(this.running);
    }

    getStatus(): VerifyVolumesStatus {
        const volumeIds = this.volumeFilter
            ? Array.from(this.volumeFilter).sort((a, b) => a - b)
            : [];
        const waiting = !this.isRunning() && this.waitingForRebalance;
        return {
            running: this.isRunning(),
            startedAt: this.startedAt,
            objectsVerified: this.progress.objectsVerified,
            errors: this.progress.errors,
            concurrency: this.currentConcurrency,
            scope: volumeIds.length ? 'targeted' : 'full',
            mode: this.currentMode,
            volumeIds,
            waiting,
            waitingFor: waiting ? 'rebalance' : null
        };
    }

    private launch(startedAt: string, isResume: boolean, volumeIds: number[] | null, initialObjectsVerified: number, cursorId: string | null, mode: VerifyMode): void {
        if (this.running)
            return;

        this.waitingForRebalance = false;
        this.startedAt = startedAt;
        this.currentMode = mode;
        this.applyVolumeFilter(volumeIds);
        const concurrency = this.resolveConcurrency();
        this.currentConcurrency = concurrency;
        if (isResume)
            this.log('starting verification (resume) at %s', startedAt);
        else
            this.log('starting verification at %s', startedAt);
        const run: ActiveRun = { token: ++this.runToken, cancelled: false, coordinator: new VolumeReadCoordinator(), cursorId, mode };
        this.activeRun = run;
        this.progress.objectsVerified = initialObjectsVerified;
        this.progress.errors = { total: 0, volumes: {} };
        this.startProgressLogger();
        this.running = this.execute(run, startedAt, isResume, concurrency)
            .catch(err => {
                this.log.error('verify job failed', err);
            })
            .finally(() => {
                // If this run was abandoned (stop() timed out) or superseded,
                // another run now owns the job state — don't clobber it.
                if (this.activeRun !== run)
                    return;
                this.stopProgressLogger();
                this.startedAt = null;
                this.running = null;
                this.activeRun = null;
                this.currentConcurrency = 0;
                this.currentMode = 'full';
                this.volumeFilter = null;
            });
    }

    // A run is "targeted" when scoped to specific volumes (fault-driven).
    // Targeted runs stamp only the matching slices; `lastVerifiedAt` advances
    // only if all slices have verification times.
    private get isTargetedRun(): boolean {
        return this.volumeFilter !== null;
    }

    private async getResumedObjectsVerified(startedAt: string, volumeIds: number[] | null): Promise<number> {
        try {
            const startedAtDate = new Date(startedAt);
            if (!Number.isFinite(startedAtDate.getTime()))
                return 0;
            const filter = volumeIds && volumeIds.length ? volumeIds : undefined;
            const count = await this.deps.database.countObjectsVerifiedSince(startedAtDate, filter);
            return count;
        }
        catch (err) {
            this.log.error('failed to restore verify progress for %s', startedAt, err);
            return 0;
        }
    }

    private async execute(run: ActiveRun, startedAt: string, isResume: boolean, concurrency: number): Promise<void> {
        const startedAtDate = new Date(startedAt);
        if (!Number.isFinite(startedAtDate.getTime()))
            throw new Error('invalid verify start time');

        const volumeCounts = this.initializeVolumeCounters();
        if (!isResume)
            await this.resetVolumeCounters(volumeCounts);
        let checksumErrors = 0;
        let totalErrors = 0;
        let completed = false;

        try {
            while (!run.cancelled) {
                // Per-batch freeze checkpoint: if maintenance freeze is turned on
                // mid-run, stop gracefully WITHOUT finalizing (completed stays
                // false), leaving persisted progress intact so the run can resume
                // once the freeze is lifted.
                if (await isMaintenanceFrozen()) {
                    this.log('maintenance freeze activated mid-run: stopping verify run');
                    break;
                }
                const batch = await this.fetchBatch(run, startedAtDate);
                if (!batch.length) {
                    completed = true;
                    break;
                }

                let interrupted = false;
                const queue = new PQueue({ concurrency });
                const laneAllocator = new LaneAllocator(concurrency);

                const taskPromises = batch.map(record => queue.add(async () => {
                    if (run.cancelled || interrupted)
                        return;
                    const lane = await laneAllocator.acquire();
                    try {
                        const result = await this.verifyObject(run, record, startedAtDate, lane);
                        if (!result) {
                            interrupted = true;
                            queue.clear();
                            return;
                        }
                        checksumErrors += result.checksumErrors;
                        totalErrors += result.totalErrors;
                        await this.mergeVolumeResults(volumeCounts, result.volumeImpacts);
                        // Only publish to the shared status if we still own the
                        // job — a zombie task must not bump a later run's counter.
                        if (this.activeRun === run) {
                            this.progress.objectsVerified++;
                            this.logProgress(totalErrors, volumeCounts);
                        }
                    }
                    finally {
                        laneAllocator.release(lane);
                    }
                }));

                const taskResults = await Promise.allSettled(taskPromises);
                const rejectedTask = taskResults.find(result => result.status === 'rejected');
                if (rejectedTask?.status === 'rejected')
                    throw rejectedTask.reason;

                if (run.cancelled || interrupted)
                    break;
                await this.advanceCursor(run, batch);
            }
        }
        finally {
            // A superseded/abandoned run must not touch shared state or persisted config.
            if (this.activeRun === run)
                this.currentConcurrency = 0;
            const shouldFinalize = completed && !run.cancelled && this.activeRun === run;
            if (shouldFinalize) {
                await this.deps.runtimeConfig.delete('verifyStartedAt');
                await this.deps.runtimeConfig.delete(VERIFY_VOLUME_IDS_KEY);
                await this.deps.runtimeConfig.delete(VERIFY_CURSOR_ID_KEY);
                await this.deps.runtimeConfig.delete(VERIFY_MODE_KEY);
            }
            if (shouldFinalize && !this.isTargetedRun) {
                const finishedAt = new Date().toISOString();
                await this.deps.runtimeConfig.set('lastVerify', {
                    startedAt,
                    finishedAt,
                    checksumErrors,
                    totalErrors
                });
                this.log(
                    'verification complete: startedAt=%s finishedAt=%s objects=%d checksumErrors=%d totalErrors=%d',
                    startedAt,
                    finishedAt,
                    this.progress.objectsVerified,
                    checksumErrors,
                    totalErrors
                );
            }
        }
    }

    private initializeVolumeCounters(): Map<number, VolumeErrorCounters> {
        const counts = new Map<number, VolumeErrorCounters>();
        for (const [id, volume] of this.deps.ioManager.getVolumeEntries()) {
            if (this.volumeFilter && !this.volumeFilter.has(id))
                continue;
            const existing = volume.verifyErrors ?? { checksum: 0, total: 0 };
            counts.set(id, { checksum: existing.checksum, total: existing.total });
        }
        return counts;
    }

    private async fetchBatch(run: ActiveRun, startedAt: Date): Promise<StoredObjectRecord[]> {
        const volumeIds = this.getVerifiableVolumeIds();
        if (!volumeIds.length)
            return [];
        if (this.isTargetedRun) {
            const objects = await this.deps.database.findObjectsOnVolumesNeedingVerification(startedAt, VERIFY_BATCH_SIZE, volumeIds, run.cursorId);
            return objects as StoredObjectRecord[];
        }
        const objects = await this.deps.database.findObjectsNeedingVerification(startedAt, VERIFY_BATCH_SIZE, volumeIds, run.cursorId);
        return objects as StoredObjectRecord[];
    }

    private async advanceCursor(run: ActiveRun, batch: StoredObjectRecord[]): Promise<void> {
        const cursorId = this.getBatchCursor(batch);
        if (!cursorId)
            return;
        run.cursorId = cursorId;
        if (this.activeRun !== run)
            return;
        await this.deps.runtimeConfig.set(VERIFY_CURSOR_ID_KEY, cursorId);
    }

    private getBatchCursor(batch: StoredObjectRecord[]): string | null {
        const last = batch[batch.length - 1];
        return typeof last?.id === 'string' && last.id.length ? last.id : null;
    }

    private async verifyObject(run: ActiveRun, record: StoredObjectRecord, startedAt: Date, lane?: number): Promise<VerifyVolumesObjectResult | null> {
        try {
            if (run.cancelled)
                return null;

            const requestId = typeof lane === 'number' ? `verify:${lane}` : 'verify';
            const object = await this.deps.fileObjectService.load(record, { requestId, priority: 'low' });
            const verifier = this.deps.createSliceVerifier(object, run.mode);

            const totalSlices = record.dataVolumes.length + record.parityVolumes.length;
            const sliceErrors: Record<string, SliceErrorInfo> = {};
            const volumeImpacts = new Map<number, VolumeErrorCounters>();
            let checksumErrors = 0;
            let totalErrors = 0;
            let processedSlices = 0;
            const processedSliceKeys = new Set<string>();

            for (let sliceIndex = 0; sliceIndex < totalSlices; sliceIndex++) {
                if (run.cancelled)
                    return null;
                const descriptor = this.describeSlice(record, sliceIndex);
                if (!this.shouldVerifyVolume(descriptor.volumeId))
                    continue;
                const releaseLock = await this.acquireVolumeLock(run, descriptor.volumeId);
                if (run.cancelled) {
                    releaseLock?.();
                    return null;
                }
                try {
                    processedSlices++;
                    processedSliceKeys.add(descriptor.key);
                    await verifier.verifySlice(sliceIndex);
                }
                catch (err) {
                    if (isIOAbort(err)) {
                        run.cancelled = true;
                        this.log('object %s verification aborted due to I/O shutdown', record.id);
                        return null;
                    }
                    const normalized = this.normalizeSliceError(record, err);
                    const message = err instanceof Error ? err.message : String(err);
                    if (!normalized) {
                        this.log.error('object %s slice %d verification failed: %s', record.id, sliceIndex, message);
                        continue;
                    }

                    sliceErrors[normalized.sliceKey] = normalized.info;
                    totalErrors++;
                    if (normalized.isChecksum)
                        checksumErrors++;
                    this.reportFault(record, normalized);

                    if (normalized.volumeId !== null && normalized.volumeId !== undefined) {
                        const entry = volumeImpacts.get(normalized.volumeId) ?? { checksum: 0, total: 0 };
                        entry.total += 1;
                        if (normalized.isChecksum)
                            entry.checksum += 1;
                        volumeImpacts.set(normalized.volumeId, entry);
                    }

                    this.log.error(
                        'object %s %s slice %s verification failed: %s',
                        record.id,
                        normalized.sliceType,
                        normalized.sliceKey,
                        message
                    );
                }
                finally {
                    releaseLock?.();
                }
            }

            if (run.cancelled)
                return null;
            if (!processedSlices)
                return {
                    checksumErrors: 0,
                    totalErrors: 0,
                    volumeImpacts
                };

            await this.deps.database.updateObjectVerificationState(
                record.id,
                this.buildVerificationUpdate(record, startedAt, sliceErrors, processedSliceKeys)
            );

            return {
                checksumErrors,
                totalErrors,
                volumeImpacts
            };
        }
        catch (err) {
            if (isIOAbort(err)) {
                run.cancelled = true;
                this.log('object %s verification aborted due to I/O shutdown', record.id);
                return null;
            }
            const normalized = this.normalizeSliceError(record, err);
            const sliceErrors = normalized ? { [normalized.sliceKey]: normalized.info } : {};
            const processedSliceKeys = normalized ? new Set([normalized.sliceKey]) : new Set<string>();
            await this.deps.database.updateObjectVerificationState(
                record.id,
                this.buildVerificationUpdate(record, startedAt, sliceErrors, processedSliceKeys)
            );

            const volumeImpacts = new Map<number, VolumeErrorCounters>();
            if (normalized?.volumeId !== null && normalized?.volumeId !== undefined) {
                volumeImpacts.set(normalized.volumeId, {
                    checksum: normalized.isChecksum ? 1 : 0,
                    total: 1
                });
            }

            const message = err instanceof Error ? err.message : String(err);
            if (normalized) {
                this.reportFault(record, normalized);
                this.log.error(
                    'object %s %s slice %s verification failed: %s',
                    record.id,
                    normalized.sliceType,
                    normalized.sliceKey,
                    message
                );
            }
            else {
                this.log.error('object %s verification failed: %s', record.id, message);
            }

            return {
                checksumErrors: normalized?.isChecksum ? 1 : 0,
                totalErrors: normalized ? 1 : 0,
                volumeImpacts
            };
        }
    }

    private describeSlice(
        record: StoredObjectRecord,
        sliceIndex: number | null
    ): { key: string; type: 'data' | 'parity' | 'unknown'; volumeId: number | null } {
        if (sliceIndex === null)
            return { key: 'unknown', type: 'unknown', volumeId: null };
        if (sliceIndex < record.dataVolumes.length) {
            return {
                key: String(sliceIndex),
                type: 'data',
                volumeId: record.dataVolumes[sliceIndex] ?? null
            };
        }
        const parityIndex = sliceIndex - record.dataVolumes.length;
        return {
            key: String(sliceIndex),
            type: 'parity',
            volumeId: record.parityVolumes[parityIndex] ?? null
        };
    }

    private normalizeSliceError(
        record: StoredObjectRecord,
        err: unknown
    ): { sliceKey: string; sliceType: 'data' | 'parity' | 'unknown'; info: SliceErrorInfo; volumeId: number | null; sliceIndex: number | null; code: string | undefined; isChecksum: boolean } | null {
        const errorObj = err as Error & { code?: string; sliceIndex?: number; volumeId?: number };
        const sliceIndex = typeof errorObj.sliceIndex === 'number' ? errorObj.sliceIndex : null;
        const descriptor = this.describeSlice(record, sliceIndex);
        const isChecksum = errorObj.code === 'ECHECKSUM';
        const message = errorObj.message ?? String(err);
        const info: SliceErrorInfo = {
            code: errorObj.code,
            category: categorizeSliceError(errorObj.code, message)
        };
        if (isChecksum)
            info.checksum = true;
        else
            info.err = message;
        if (descriptor.type === 'data' || descriptor.type === 'parity')
            info.type = descriptor.type;
        const volumeId = errorObj.volumeId ?? descriptor.volumeId;
        return {
            sliceKey: descriptor.key,
            sliceType: descriptor.type,
            info,
            volumeId,
            sliceIndex,
            code: errorObj.code,
            isChecksum
        };
    }

    // Surface a verify-detected slice fault into the remediation pipeline.
    // Fire-and-forget; reportSliceFault never throws.
    private reportFault(
        record: StoredObjectRecord,
        normalized: { sliceKey: string; volumeId: number | null; sliceIndex: number | null; code: string | undefined; isChecksum: boolean; info: SliceErrorInfo }
    ): void {
        const sliceIndex = normalized.sliceIndex ?? Number.parseInt(normalized.sliceKey, 10);
        this.deps.remediationService.reportSliceFault({
            objectId: record.id,
            sliceIndex: Number.isFinite(sliceIndex) ? sliceIndex : -1,
            volumeId: normalized.volumeId ?? null,
            source: 'verify',
            code: normalized.code,
            isChecksum: normalized.isChecksum,
            message: normalized.info.err
        });
    }

    private async acquireVolumeLock(run: ActiveRun, volumeId: number | null | undefined): Promise<(() => void) | null> {
        if (volumeId === null || volumeId === undefined)
            return null;
        if (run.cancelled)
            return null;
        return run.coordinator.acquire(volumeId);
    }

    private shouldVerifyVolume(volumeId: number | null | undefined): boolean {
        // Never issue reads to a drive the system has taken out of service or
        // flagged unhealthy. Reads against a failing drive can wedge in the
        // kernel and exhaust the libuv threadpool, freezing the whole job (and
        // its stop()). The health monitor degrades bad drives to
        // isHealthy=false (and read-only); skip those here.
        if (typeof volumeId === 'number') {
            const volume = this.deps.ioManager.getVolume(volumeId) as Volume | undefined;
            if (volume && (volume.isReadable === false || volume.isHealthy === false))
                return false;
        }
        if (!this.volumeFilter)
            return true;
        if (volumeId === null || volumeId === undefined)
            return false;
        return this.volumeFilter.has(volumeId);
    }

    private getVerifiableVolumeIds(): number[] {
        const sourceIds = this.volumeFilter
            ? Array.from(this.volumeFilter.values())
            : this.deps.ioManager.getVolumeEntries().map(([id]) => id);
        const verifiable = new Set<number>();
        for (const id of sourceIds) {
            const volume = this.deps.ioManager.getVolume(id) as Volume | undefined;
            if (!volume)
                continue;
            if (volume.isReadable === false || volume.isHealthy === false)
                continue;
            verifiable.add(id);
        }
        return Array.from(verifiable).sort((a, b) => a - b);
    }

    private buildVerificationUpdate(
        record: StoredObjectRecord,
        startedAt: Date,
        sliceErrors: Record<string, SliceErrorInfo>,
        processedSliceKeys: Set<string>
    ) {
        return buildObjectVerificationStateUpdate(record, startedAt, sliceErrors, processedSliceKeys);
    }

    private async loadPersistedVolumeFilter(): Promise<number[] | null> {
        const stored = await this.deps.runtimeConfig.get(VERIFY_VOLUME_IDS_KEY);
        return this.normalizeVolumeIds(stored);
    }

    private async loadPersistedCursorId(): Promise<string | null> {
        const stored = await this.deps.runtimeConfig.get(VERIFY_CURSOR_ID_KEY);
        return typeof stored === 'string' && stored.length ? stored : null;
    }

    private async loadPersistedMode(): Promise<VerifyMode> {
        const stored = await this.deps.runtimeConfig.get(VERIFY_MODE_KEY);
        return this.normalizeMode(stored);
    }

    private async persistMode(mode: VerifyMode): Promise<void> {
        if (mode === 'light')
            await this.deps.runtimeConfig.set(VERIFY_MODE_KEY, mode);
        else
            await this.deps.runtimeConfig.delete(VERIFY_MODE_KEY);
    }

    private normalizeMode(value: unknown): VerifyMode {
        return value === 'light' ? 'light' : 'full';
    }

    private async persistVolumeFilter(volumeIds: number[] | null): Promise<void> {
        if (volumeIds && volumeIds.length)
            await this.deps.runtimeConfig.set(VERIFY_VOLUME_IDS_KEY, volumeIds);
        else
            await this.deps.runtimeConfig.delete(VERIFY_VOLUME_IDS_KEY);
    }

    private applyVolumeFilter(volumeIds: number[] | null): void {
        if (volumeIds && volumeIds.length)
            this.volumeFilter = new Set(volumeIds);
        else
            this.volumeFilter = null;
    }

    private activeRunCoversRequest(requestedFilter: number[] | null): boolean {
        const activeFilter = this.volumeFilter ? Array.from(this.volumeFilter.values()) : null;
        return this.filterCoversRequest(activeFilter, requestedFilter);
    }

    private filterCoversRequest(activeFilter: number[] | null, requestedFilter: number[] | null): boolean {
        if (requestedFilter === null)
            return activeFilter === null;
        if (activeFilter === null)
            return false;
        const active = new Set(activeFilter);
        return requestedFilter.every(id => active.has(id));
    }

    private normalizeVolumeIds(value: unknown): number[] | null {
        if (!Array.isArray(value))
            return null;
        const unique = new Set<number>();
        for (const entry of value) {
            if (typeof entry !== 'number' || !Number.isFinite(entry))
                continue;
            unique.add(entry);
        }
        return unique.size ? Array.from(unique.values()) : null;
    }

    private resolveConcurrency(): number {
        if (Number.isFinite(envConcurrency) && envConcurrency > 0)
            return envConcurrency;
        const entries = this.deps.ioManager.getVolumeEntries();
        const enabledCount = entries.filter(([, volume]) => volume.isEnabled && !volume.isDeleted).length;
        const effective = enabledCount || entries.length || cpuCount;
        return Math.max(1, Math.min(cpuCount, effective));
    }


    private async mergeVolumeResults(
        aggregate: Map<number, VolumeErrorCounters>,
        impacts: Map<number, VolumeErrorCounters>
    ): Promise<void> {
        const operations: Promise<void>[] = [];
        impacts.forEach((impact, volumeId) => {
            if (!impact.total)
                return;
            if (this.volumeFilter && !this.volumeFilter.has(volumeId))
                return;
            const entry = aggregate.get(volumeId) ?? { checksum: 0, total: 0 };
            entry.checksum += impact.checksum;
            entry.total += impact.total;
            aggregate.set(volumeId, entry);
            operations.push(this.persistVolumeError(volumeId, entry));
        });
        await Promise.all(operations);
    }

    private async resetVolumeCounters(counts: Map<number, VolumeErrorCounters>): Promise<void> {
        const operations: Promise<void>[] = [];
        counts.forEach((entry, volumeId) => {
            if (this.volumeFilter && !this.volumeFilter.has(volumeId))
                return;
            entry.checksum = 0;
            entry.total = 0;
            operations.push(this.persistVolumeError(volumeId, entry));
        });
        await Promise.all(operations);
    }

    private async persistVolumeError(volumeId: number, counters: VolumeErrorCounters): Promise<void> {
        const payload = { checksum: counters.checksum, total: counters.total };
        await this.deps.database.setVolumeVerifyErrors(volumeId, payload);
        const volume = this.deps.ioManager.getVolume(volumeId) as Volume | undefined;
        volume?.setVerifyErrors({ ...payload });
    }

    private logProgress(totalErrors: number, volumeCounts: Map<number, VolumeErrorCounters>): void {
        const volumes: Record<string, number> = {};
        for (const [volumeId, counters] of volumeCounts.entries()) {
            if (counters.total > 0)
                volumes[String(volumeId)] = counters.total;
        }
        this.progress.errors = { total: totalErrors, volumes };
    }

    private startProgressLogger(): void {
        if (this.progressLogger)
            return;
        this.progressLogger = setInterval(() => {
            const { objectsVerified, errors } = this.progress;
            let message = `verified:${objectsVerified} errors:${errors.total}`;
            const entries = Object.entries(errors.volumes).sort((a, b) => Number(a[0]) - Number(b[0]));
            for (const [volumeId, count] of entries)
                message += ` [vol-${volumeId}]:${count}`;
            this.log(message);
        }, 5000);
        this.progressLogger.unref?.();
    }

    private stopProgressLogger(): void {
        if (!this.progressLogger)
            return;
        clearInterval(this.progressLogger);
        this.progressLogger = null;
    }
}

export const verifyVolumesJob = new VerifyVolumesJob();
