import os from 'os';
import PQueue from 'p-queue';
import { database, type SliceErrorInfo } from '../database';
import { runtimeConfig } from '../runtime-config';
import { fileObjectService, type FileObjectService } from '../io/file-object/service';
import type { StoredObjectRecord, FileObject } from '../io/file-object';
import { ioManager } from '../io/manager';
import { createLogger } from '../log';
import type { Volume } from '../io/volume';
import { FileObjectSliceVerifier } from '../io/file-object/slice-verifier';
import { remediationService } from '../remediation/service';

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
    createSliceVerifier: (object: FileObject) => { verifySlice: (sliceIndex: number) => Promise<void> };
    remediationService: typeof remediationService;
};

type VerifyVolumesErrorSnapshot = {
    total: number;
    volumes: Record<string, number>;
};

type VerifyVolumesObjectResult = {
    checksumErrors: number;
    totalErrors: number;
    volumeImpacts: Map<number, VolumeErrorCounters>;
};

type VerifyStartResult = { startedAt: string; accepted: boolean };

const defaultDeps: VerifyVolumesJobDeps = {
    database,
    runtimeConfig,
    fileObjectService,
    ioManager,
    createLogger,
    createSliceVerifier: (object: FileObject) => new FileObjectSliceVerifier(object),
    remediationService
};

const VERIFY_BATCH_SIZE = 25;
const VERIFY_VOLUME_IDS_KEY = 'verifyVolumeIds';
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
    private readonly volumeCoordinator = new VolumeReadCoordinator();
    private running: Promise<void> | null = null;
    private cancelRequested = false;
    private startedAt: string | null = null;
    private volumeFilter: Set<number> | null = null;
    private targetedCursor: string | null = null;
    private startGuard = false;
    private progress = {
        objectsVerified: 0,
        errors: {
            total: 0,
            volumes: {} as Record<string, number>
        }
    };
    private progressLogger: NodeJS.Timeout | null = null;
    private currentConcurrency = 0;

    constructor(deps?: Partial<VerifyVolumesJobDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('verify-job');
    }

    async start(options?: { volumeIds?: number[] }): Promise<VerifyStartResult> {
        const requestedFilter = this.normalizeVolumeIds(options?.volumeIds);
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
                const restoredCount = await this.getResumedObjectsVerified(existing, persistedFilter);
                this.launch(existing, true, persistedFilter, restoredCount);
                return { startedAt: existing, accepted: this.filterCoversRequest(persistedFilter, requestedFilter) };
            }

            await this.persistVolumeFilter(requestedFilter);

            const startedAt = new Date().toISOString();
            await this.deps.runtimeConfig.set('verifyStartedAt', startedAt);
            this.launch(startedAt, false, requestedFilter, 0);
            return { startedAt, accepted: true };
        }
        finally {
            this.startGuard = false;
        }
    }

    async resumePendingJob(): Promise<void> {
        if (this.running || this.startGuard)
            return;
        this.startGuard = true;
        try {
            const existing = await this.deps.runtimeConfig.get('verifyStartedAt');
            if (typeof existing !== 'string' || !existing.length)
                return;
            this.log('resuming verify job started at %s', existing);
            const persistedFilter = await this.loadPersistedVolumeFilter();
            const restoredCount = await this.getResumedObjectsVerified(existing, persistedFilter);
            this.launch(existing, true, persistedFilter, restoredCount);
        }
        finally {
            this.startGuard = false;
        }
    }

    async stop(options?: { preserveState?: boolean }): Promise<void> {
        const running = this.running;
        if (!running)
            return;
        this.log('stop requested');
        this.cancelRequested = true;
        await running;
        if (!options?.preserveState) {
            await this.deps.runtimeConfig.delete('verifyStartedAt');
            await this.deps.runtimeConfig.delete(VERIFY_VOLUME_IDS_KEY);
        }
    }

    isRunning(): boolean {
        return Boolean(this.running);
    }

    getStatus(): { running: boolean; startedAt: string | null; objectsVerified: number; errors: VerifyVolumesErrorSnapshot; concurrency: number } {
        return {
            running: this.isRunning(),
            startedAt: this.startedAt,
            objectsVerified: this.progress.objectsVerified,
            errors: this.progress.errors,
            concurrency: this.currentConcurrency
        };
    }

    private launch(startedAt: string, isResume: boolean, volumeIds: number[] | null, initialObjectsVerified: number): void {
        if (this.running)
            return;

        this.startedAt = startedAt;
        this.applyVolumeFilter(volumeIds);
        this.targetedCursor = null;
        const concurrency = this.resolveConcurrency();
        this.currentConcurrency = concurrency;
        if (isResume)
            this.log('starting verification (resume) at %s', startedAt);
        else
            this.log('starting verification at %s', startedAt);
        this.cancelRequested = false;
        this.progress.objectsVerified = initialObjectsVerified;
        this.progress.errors = { total: 0, volumes: {} };
        this.startProgressLogger();
        this.running = this.execute(startedAt, isResume, concurrency)
            .catch(err => {
                this.log.error('verify job failed', err);
            })
            .finally(() => {
                this.stopProgressLogger();
                this.startedAt = null;
                this.running = null;
                this.cancelRequested = false;
                this.currentConcurrency = 0;
                this.volumeFilter = null;
                this.targetedCursor = null;
            });
    }

    // A run is "targeted" when scoped to specific volumes (fault-driven). A
    // targeted run is a single _id-paginated pass that records slice errors only;
    // it must not advance the rolling scrub watermark (`lastVerifiedAt`).
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

    private async execute(startedAt: string, isResume: boolean, concurrency: number): Promise<void> {
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
            while (!this.cancelRequested) {
                const batch = await this.fetchBatch(startedAtDate);
                if (!batch.length) {
                    completed = true;
                    break;
                }

                let interrupted = false;
                const queue = new PQueue({ concurrency });
                const laneAllocator = new LaneAllocator(concurrency);

                const taskPromises = batch.map(record => queue.add(async () => {
                    if (this.cancelRequested || interrupted)
                        return;
                    const lane = await laneAllocator.acquire();
                    try {
                        const result = await this.verifyObject(record, startedAtDate, lane);
                        if (!result) {
                            interrupted = true;
                            queue.clear();
                            return;
                        }
                        this.progress.objectsVerified++;
                        checksumErrors += result.checksumErrors;
                        totalErrors += result.totalErrors;
                        await this.mergeVolumeResults(volumeCounts, result.volumeImpacts);
                        this.logProgress(totalErrors, volumeCounts);
                    }
                    finally {
                        laneAllocator.release(lane);
                    }
                }));

                const taskResults = await Promise.allSettled(taskPromises);
                const rejectedTask = taskResults.find(result => result.status === 'rejected');
                if (rejectedTask?.status === 'rejected')
                    throw rejectedTask.reason;

                if (this.cancelRequested || interrupted)
                    break;
            }
        }
        finally {
            this.currentConcurrency = 0;
            const shouldFinalize = completed && !this.cancelRequested;
            if (shouldFinalize) {
                await this.deps.runtimeConfig.delete('verifyStartedAt');
                await this.deps.runtimeConfig.delete(VERIFY_VOLUME_IDS_KEY);
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

    private async fetchBatch(startedAt: Date): Promise<StoredObjectRecord[]> {
        if (this.isTargetedRun) {
            const volumeIds = Array.from((this.volumeFilter as Set<number>).values());
            const objects = await this.deps.database.findObjectsOnVolumes(this.targetedCursor, VERIFY_BATCH_SIZE, volumeIds);
            if (objects.length) {
                const lastId = (objects[objects.length - 1] as StoredObjectRecord).id;
                if (lastId)
                    this.targetedCursor = lastId;
            }
            return objects as StoredObjectRecord[];
        }
        const objects = await this.deps.database.findObjectsNeedingVerification(startedAt, VERIFY_BATCH_SIZE);
        return objects as StoredObjectRecord[];
    }

    private async verifyObject(record: StoredObjectRecord, startedAt: Date, lane?: number): Promise<VerifyVolumesObjectResult | null> {
        try {
            if (this.cancelRequested)
                return null;

            const requestId = typeof lane === 'number' ? `verify:${lane}` : 'verify';
            const object = await this.deps.fileObjectService.load(record, { requestId, priority: 'low' });
            const verifier = this.deps.createSliceVerifier(object);

            const totalSlices = record.dataVolumes.length + record.parityVolumes.length;
            const sliceErrors: Record<string, SliceErrorInfo> = {};
            const volumeImpacts = new Map<number, VolumeErrorCounters>();
            let checksumErrors = 0;
            let totalErrors = 0;
            let processedSlices = 0;
            const processedSliceKeys = new Set<string>();

            for (let sliceIndex = 0; sliceIndex < totalSlices; sliceIndex++) {
                if (this.cancelRequested)
                    return null;
                const descriptor = this.describeSlice(record, sliceIndex);
                if (!this.shouldVerifyVolume(descriptor.volumeId))
                    continue;
                const releaseLock = await this.acquireVolumeLock(descriptor.volumeId);
                if (this.cancelRequested) {
                    releaseLock?.();
                    return null;
                }
                try {
                    processedSlices++;
                    processedSliceKeys.add(descriptor.key);
                    await verifier.verifySlice(sliceIndex);
                }
                catch (err) {
                    if (this.isIOAbortError(err)) {
                        this.cancelRequested = true;
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

            if (this.cancelRequested)
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
            if (this.isIOAbortError(err)) {
                this.cancelRequested = true;
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
        const info: SliceErrorInfo = isChecksum
            ? { checksum: true }
            : { err: errorObj.message ?? String(err) };
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

    private async acquireVolumeLock(volumeId: number | null | undefined): Promise<(() => void) | null> {
        if (volumeId === null || volumeId === undefined)
            return null;
        if (this.cancelRequested)
            return null;
        return this.volumeCoordinator.acquire(volumeId);
    }

    private shouldVerifyVolume(volumeId: number | null | undefined): boolean {
        if (!this.volumeFilter)
            return true;
        if (volumeId === null || volumeId === undefined)
            return false;
        return this.volumeFilter.has(volumeId);
    }

    private buildVerificationUpdate(
        record: StoredObjectRecord,
        startedAt: Date,
        sliceErrors: Record<string, SliceErrorInfo>,
        processedSliceKeys: Set<string>
    ): { lastVerifiedAt?: Date; sliceErrors?: Record<string, SliceErrorInfo> | null } {
        if (!this.isTargetedRun) {
            return {
                lastVerifiedAt: startedAt,
                sliceErrors: Object.keys(sliceErrors).length ? sliceErrors : null
            };
        }

        const mergedErrors: Record<string, SliceErrorInfo> = { ...(record.sliceErrors ?? {}) };
        for (const key of processedSliceKeys)
            delete mergedErrors[key];
        Object.assign(mergedErrors, sliceErrors);

        return {
            sliceErrors: Object.keys(mergedErrors).length ? mergedErrors : null
        };
    }

    private async loadPersistedVolumeFilter(): Promise<number[] | null> {
        const stored = await this.deps.runtimeConfig.get(VERIFY_VOLUME_IDS_KEY);
        return this.normalizeVolumeIds(stored);
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

    private isIOAbortError(err: unknown): boolean {
        const errorObj = err as Error & { code?: string };
        return errorObj?.code === 'IOABORT';
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
