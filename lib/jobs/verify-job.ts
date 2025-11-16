import os from 'os';
import { database, type SliceErrorInfo } from '../database';
import { runtimeConfig } from '../runtime-config';
import { fileObjectService, type FileObjectService } from '../io/file-object/service';
import type { StoredObjectRecord, FileObject } from '../io/file-object';
import { ioManager } from '../io/manager';
import { createLogger } from '../log';
import type { Volume } from '../io/volume';
import { FileObjectSliceVerifier } from '../io/file-object/slice-verifier';

type VolumeErrorCounters = {
    checksum: number;
    total: number;
};

type VerifyJobDeps = {
    database: typeof database;
    runtimeConfig: typeof runtimeConfig;
    fileObjectService: FileObjectService;
    ioManager: typeof ioManager;
    createLogger: typeof createLogger;
    createSliceVerifier: (object: FileObject) => { verifySlice: (sliceIndex: number) => Promise<void> };
};

type VerifyErrorSnapshot = {
    total: number;
    volumes: Record<string, number>;
};

type VerifyObjectResult = {
    checksumErrors: number;
    totalErrors: number;
    volumeImpacts: Map<number, VolumeErrorCounters>;
};

const defaultDeps: VerifyJobDeps = {
    database,
    runtimeConfig,
    fileObjectService,
    ioManager,
    createLogger,
    createSliceVerifier: (object: FileObject) => new FileObjectSliceVerifier(object)
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

export class VerifyJob {
    private readonly deps: VerifyJobDeps;
    private readonly log: ReturnType<typeof createLogger>;
    private readonly volumeCoordinator = new VolumeReadCoordinator();
    private running: Promise<void> | null = null;
    private cancelRequested = false;
    private startedAt: string | null = null;
    private volumeFilter: Set<number> | null = null;
    private progress = {
        objectsVerified: 0,
        errors: {
            total: 0,
            volumes: {} as Record<string, number>
        }
    };
    private progressLogger: NodeJS.Timeout | null = null;

    constructor(deps?: Partial<VerifyJobDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('verify-job');
    }

    async start(options?: { volumeIds?: number[] }): Promise<{ startedAt: string }> {
        if (this.running)
            return { startedAt: this.startedAt as string };

        const existing = await this.deps.runtimeConfig.get('verifyStartedAt');
        if (typeof existing === 'string' && existing.length) {
            const persistedFilter = await this.loadPersistedVolumeFilter();
            this.launch(existing, true, persistedFilter);
            return { startedAt: existing };
        }

        const normalizedFilter = this.normalizeVolumeIds(options?.volumeIds);
        await this.persistVolumeFilter(normalizedFilter);

        const startedAt = new Date().toISOString();
        await this.deps.runtimeConfig.set('verifyStartedAt', startedAt);
        this.launch(startedAt, false, normalizedFilter);
        return { startedAt };
    }

    async resumePendingJob(): Promise<void> {
        if (this.running)
            return;
        const existing = await this.deps.runtimeConfig.get('verifyStartedAt');
        if (typeof existing !== 'string' || !existing.length)
            return;
        this.log('resuming verify job started at %s', existing);
        const persistedFilter = await this.loadPersistedVolumeFilter();
        this.launch(existing, true, persistedFilter);
    }

    async stop(): Promise<void> {
        const running = this.running;
        if (!running)
            return;
        this.log('stop requested');
        this.cancelRequested = true;
        await running;
        await this.deps.runtimeConfig.delete('verifyStartedAt');
        await this.deps.runtimeConfig.delete(VERIFY_VOLUME_IDS_KEY);
    }

    isRunning(): boolean {
        return Boolean(this.running);
    }

    getStatus(): { running: boolean; startedAt: string | null; objectsVerified: number; errors: VerifyErrorSnapshot } {
        return {
            running: this.isRunning(),
            startedAt: this.startedAt,
            objectsVerified: this.progress.objectsVerified,
            errors: this.progress.errors
        };
    }

    private launch(startedAt: string, isResume: boolean, volumeIds: number[] | null): void {
        if (this.running)
            return;

        this.startedAt = startedAt;
        this.applyVolumeFilter(volumeIds);
        if (isResume)
            this.log('starting verification (resume) at %s', startedAt);
        else
            this.log('starting verification at %s', startedAt);
        this.cancelRequested = false;
        this.progress.objectsVerified = 0;
        this.progress.errors = { total: 0, volumes: {} };
        this.startProgressLogger();
        this.running = this.execute(startedAt, isResume)
            .catch(err => {
                this.log.error('verify job failed', err);
            })
            .finally(() => {
                this.stopProgressLogger();
                this.startedAt = null;
                this.running = null;
                this.cancelRequested = false;
                this.volumeFilter = null;
            });
    }

    private async execute(startedAt: string, isResume: boolean): Promise<void> {
        const startedAtDate = new Date(startedAt);
        if (!Number.isFinite(startedAtDate.getTime()))
            throw new Error('invalid verify start time');

        const volumeCounts = this.initializeVolumeCounters();
        if (!isResume)
            await this.resetVolumeCounters(volumeCounts);
        let checksumErrors = 0;
        let totalErrors = 0;

        const concurrency = this.resolveConcurrency();

        try {
            while (!this.cancelRequested) {
                const batch = await this.fetchBatch(startedAtDate);
                if (!batch.length)
                    break;

                let interrupted = false;
                let nextIndex = 0;
                const active: Array<{ record: StoredObjectRecord; promise: Promise<VerifyObjectResult | null> }> = [];

                const startNext = (): void => {
                    while (nextIndex < batch.length && active.length < concurrency && !this.cancelRequested) {
                        const record = batch[nextIndex++];
                        active.push({
                            record,
                            promise: this.verifyObject(record, startedAtDate)
                        });
                    }
                };

                startNext();

                while (active.length && !this.cancelRequested) {
                    const settled = await Promise.race(active.map(entry => entry.promise.then(result => ({ entry, result }))));
                    const { entry, result } = settled;
                    const index = active.indexOf(entry);
                    if (index !== -1)
                        active.splice(index, 1);

                    if (!result) {
                        interrupted = true;
                        break;
                    }

                    this.progress.objectsVerified++;
                    checksumErrors += result.checksumErrors;
                    totalErrors += result.totalErrors;
                    await this.mergeVolumeResults(volumeCounts, result.volumeImpacts);
                    this.logProgress(totalErrors, volumeCounts);

                    startNext();
                }

                if (active.length)
                    await Promise.allSettled(active.map(entry => entry.promise));

                if (this.cancelRequested || interrupted)
                    break;
            }
        }
        finally {
            if (!this.cancelRequested) {
                await this.deps.runtimeConfig.delete('verifyStartedAt');
                await this.deps.runtimeConfig.delete(VERIFY_VOLUME_IDS_KEY);
            }
            if (!this.cancelRequested) {
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
        const filter = this.volumeFilter ? Array.from(this.volumeFilter.values()) : undefined;
        const objects = await this.deps.database.findObjectsNeedingVerification(startedAt, VERIFY_BATCH_SIZE, filter);
        return objects as StoredObjectRecord[];
    }

    private async verifyObject(record: StoredObjectRecord, startedAt: Date): Promise<VerifyObjectResult | null> {
        const volumeLocks = await this.acquireVolumeLocks(record);
        if (volumeLocks === null)
            return null;
        try {
            if (this.cancelRequested)
                return null;

            const object = await this.deps.fileObjectService.load(record, { requestId: 'verify', priority: 'low' });
            const verifier = this.deps.createSliceVerifier(object);

            const totalSlices = record.dataVolumes.length + record.parityVolumes.length;
            const sliceErrors: Record<string, SliceErrorInfo> = {};
            const volumeImpacts = new Map<number, VolumeErrorCounters>();
            let checksumErrors = 0;
            let totalErrors = 0;
            let processedSlices = 0;

            for (let sliceIndex = 0; sliceIndex < totalSlices; sliceIndex++) {
                if (this.cancelRequested)
                    return null;
                const descriptor = this.describeSlice(record, sliceIndex);
                if (!this.shouldVerifyVolume(descriptor.volumeId))
                    continue;
                try {
                    processedSlices++;
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
            }

            if (this.cancelRequested)
                return null;
            if (!processedSlices)
                return {
                    checksumErrors: 0,
                    totalErrors: 0,
                    volumeImpacts
                };

            await this.deps.database.updateObjectVerificationState(record.id, {
                lastVerifiedAt: startedAt,
                sliceErrors: Object.keys(sliceErrors).length ? sliceErrors : null
            });

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
            const sliceErrors = normalized ? { [normalized.sliceKey]: normalized.info } : null;
            await this.deps.database.updateObjectVerificationState(record.id, {
                lastVerifiedAt: startedAt,
                sliceErrors
            });

            const volumeImpacts = new Map<number, VolumeErrorCounters>();
            if (normalized?.volumeId !== null && normalized?.volumeId !== undefined) {
                volumeImpacts.set(normalized.volumeId, {
                    checksum: normalized.isChecksum ? 1 : 0,
                    total: 1
                });
            }

            const message = err instanceof Error ? err.message : String(err);
            if (normalized) {
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
        finally {
            this.releaseVolumeLocks(volumeLocks);
        }
    }

    private async acquireVolumeLocks(record: StoredObjectRecord): Promise<(() => void)[] | null> {
        const volumes = this.collectRecordVolumeIds(record);
        const releases: (() => void)[] = [];
        for (const volumeId of volumes) {
            if (this.cancelRequested) {
                this.releaseVolumeLocks(releases);
                return null;
            }
            const release = await this.volumeCoordinator.acquire(volumeId);
            releases.push(release);
        }
        return releases;
    }

    private releaseVolumeLocks(releases: (() => void)[]): void {
        for (const release of releases.reverse())
            release();
    }

    private collectRecordVolumeIds(record: StoredObjectRecord): number[] {
        const unique = new Set<number>();
        for (const id of record.dataVolumes ?? []) {
            if (typeof id === 'number' && this.shouldVerifyVolume(id))
                unique.add(id);
        }
        for (const id of record.parityVolumes ?? []) {
            if (typeof id === 'number' && this.shouldVerifyVolume(id))
                unique.add(id);
        }
        return Array.from(unique).sort((a, b) => a - b);
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
    ): { sliceKey: string; sliceType: 'data' | 'parity' | 'unknown'; info: SliceErrorInfo; volumeId: number | null; isChecksum: boolean } | null {
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
            isChecksum
        };
    }

    private shouldVerifyVolume(volumeId: number | null | undefined): boolean {
        if (!this.volumeFilter)
            return true;
        if (volumeId === null || volumeId === undefined)
            return false;
        return this.volumeFilter.has(volumeId);
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

export const verifyJob = new VerifyJob();
