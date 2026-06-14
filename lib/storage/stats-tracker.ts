import { database, type StorageStatsDelta, type StorageStatsSnapshot } from '../database';
import { ioManager } from '../io/manager';
import type { StoredObjectRecord } from '../io/file-object';
import { createLogger } from '../log';
import {
    buildStorageStatsDeltaForObject,
    createEmptyStorageStatsDelta,
    mergeStorageStatsDelta,
    storageStatsDeltaIsEmpty
} from './stats';

type StorageStatsTrackerDeps = {
    database: typeof database;
    ioManager: Pick<typeof ioManager, 'getVolumeEntries'>;
    createLogger: typeof createLogger;
};

const defaultDeps: StorageStatsTrackerDeps = {
    database,
    ioManager,
    createLogger
};

export class StorageStatsTracker {
    private readonly deps: StorageStatsTrackerDeps;
    private readonly log: ReturnType<typeof createLogger>;
    private pending = createEmptyStorageStatsDelta();
    private flushTimer: NodeJS.Timeout | null = null;
    private reconcileTimer: NodeJS.Timeout | null = null;
    private flushIntervalMs = 5000;
    private started = false;
    private flushInFlight: Promise<void> | null = null;
    private reconcileInFlight: Promise<void> | null = null;
    private unavailableRefreshInFlight: Promise<StorageStatsSnapshot | null> | null = null;
    private mutationSerial = 0;

    constructor(deps?: Partial<StorageStatsTrackerDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('storage-stats');
    }

    start(options: { reconcileIntervalMs: number; flushIntervalMs: number }): void {
        if (this.started)
            return;
        this.started = true;
        this.flushIntervalMs = Math.max(1000, options.flushIntervalMs);

        if (options.reconcileIntervalMs > 0) {
            void this.ensureSnapshot().catch(err => {
                this.log.error('initial storage stats refresh failed', err);
            });
            this.reconcileTimer = setInterval(() => {
                void this.reconcile().catch(err => {
                    this.log.error('storage stats reconciliation failed', err);
                });
            }, options.reconcileIntervalMs);
            this.reconcileTimer.unref?.();
        }
        else {
            this.log('storage stats reconciliation disabled');
        }
    }

    async stop(): Promise<void> {
        this.started = false;
        if (this.reconcileTimer) {
            clearInterval(this.reconcileTimer);
            this.reconcileTimer = null;
        }
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.reconcileInFlight)
            await this.reconcileInFlight;
        if (this.unavailableRefreshInFlight)
            await this.unavailableRefreshInFlight;
        await this.flushPendingDeltas(true);
    }

    recordCreated(record: StoredObjectRecord): void {
        this.recordDelta(record, 1);
    }

    recordDeleted(record: StoredObjectRecord): void {
        this.recordDelta(record, -1);
    }

    async getSnapshot(): Promise<StorageStatsSnapshot | null> {
        const snapshot = await this.deps.database.getStorageStats();
        if (!snapshot)
            return null;
        return this.refreshUnavailableIfNeeded(snapshot);
    }

    private async ensureSnapshot(): Promise<void> {
        const snapshot = await this.deps.database.getStorageStats();
        if (!snapshot) {
            await this.reconcile();
            return;
        }
        await this.refreshUnavailableIfNeeded(snapshot);
    }

    async reconcile(): Promise<void> {
        if (this.reconcileInFlight)
            return this.reconcileInFlight;
        this.reconcileInFlight = (async () => {
            const maxAttempts = 3;
            for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
                await this.flushPendingDeltas(true);
                const backfilled = await this.deps.database.backfillContentSliceSizes();
                if (backfilled > 0)
                    this.log('backfilled slice sizes for %d object(s)', backfilled);
                const startedAtSerial = this.mutationSerial;
                const readableVolumeIds = this.getReadableVolumeIds();
                const snapshot = await this.deps.database.computeStorageStats(readableVolumeIds, new Date());
                await this.deps.database.replaceStorageStats(snapshot);
                const changedDuringReconcile = this.mutationSerial !== startedAtSerial;
                this.log('reconciled storage stats: objects=%d logicalBytes=%d physicalBytes=%d unavailable=%d',
                    snapshot.system.objectCount,
                    snapshot.system.logicalBytes,
                    snapshot.system.physicalBytes,
                    snapshot.system.unavailableObjectCount
                );
                if (!changedDuringReconcile)
                    break;
                if (attempt < maxAttempts - 1)
                    this.log('storage stats changed during reconciliation; running another pass');
            }
        })();
        try {
            await this.reconcileInFlight;
        }
        finally {
            this.reconcileInFlight = null;
        }
    }

    async flush(): Promise<void> {
        return this.flushPendingDeltas(false);
    }

    private async flushPendingDeltas(allowDuringReconcile: boolean): Promise<void> {
        if (!allowDuringReconcile && this.reconcileInFlight) {
            this.scheduleFlush();
            return;
        }
        if (this.flushInFlight)
            return this.flushInFlight;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        const delta = this.pending;
        if (storageStatsDeltaIsEmpty(delta))
            return;
        this.pending = createEmptyStorageStatsDelta();
        this.flushInFlight = this.deps.database.applyStorageStatsDelta(delta, new Date()).catch(err => {
            mergeStorageStatsDelta(this.pending, delta);
            throw err;
        });
        try {
            await this.flushInFlight;
        }
        finally {
            this.flushInFlight = null;
        }
    }

    private recordDelta(record: StoredObjectRecord, direction: 1 | -1): void {
        if (!this.started)
            return;
        this.mutationSerial += 1;
        mergeStorageStatsDelta(this.pending, buildStorageStatsDeltaForObject(record, direction, this.getReadableVolumeIds()));
        this.scheduleFlush();
    }

    private scheduleFlush(): void {
        if (this.flushTimer)
            return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.flush().catch(err => {
                this.log.error('storage stats delta flush failed', err);
                this.scheduleFlush();
            });
        }, this.flushIntervalMs);
        this.flushTimer.unref?.();
    }

    private getReadableVolumeIds(): number[] {
        return this.deps.ioManager.getVolumeEntries()
            .filter(([, volume]) => volume.isReadable !== false)
            .map(([id]) => id)
            .sort((a, b) => a - b);
    }

    private async refreshUnavailableIfNeeded(snapshot: StorageStatsSnapshot): Promise<StorageStatsSnapshot> {
        const readableVolumeIds = this.getReadableVolumeIds();
        if (this.sameVolumeIds(snapshot.readableVolumeIds, readableVolumeIds))
            return snapshot;
        if (!this.unavailableRefreshInFlight) {
            this.unavailableRefreshInFlight = this.deps.database.refreshStorageStatsUnavailable(readableVolumeIds, new Date()).finally(() => {
                this.unavailableRefreshInFlight = null;
            });
        }
        return (await this.unavailableRefreshInFlight) ?? snapshot;
    }

    private sameVolumeIds(left: number[] | undefined, right: number[]): boolean {
        if (!left || left.length !== right.length)
            return false;
        for (let index = 0; index < left.length; index++) {
            if (left[index] !== right[index])
                return false;
        }
        return true;
    }
}

export const storageStatsTracker = new StorageStatsTracker();
