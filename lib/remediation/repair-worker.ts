import { createLogger } from '../log';
import { database } from '../database';
import { ioManager } from '../io/manager';
import type { Severity } from '../notify/notifier';
import { notificationService, NotificationService } from '../notify/service';
import { remediationService, RemediationService } from './service';
import type { RepairBlockDetails, SliceFault } from './fault';
import { isMaintenanceFrozen } from '../maintenance';

type VerifySliceResult = { ok: boolean; volumeId: number | null };
type VerifyResult = Record<string, VerifySliceResult>;
type LoadedObject = { id?: string | null; size: number };
type VerifyFileJobModule = typeof import('../jobs/verify-file-job');
type FileObjectModule = typeof import('../io/file-object');
type SliceRepairerModule = typeof import('../io/file-object/slice-repairer');
type RepairPassContext = {
    verifications: Map<string, VerifyResult>;
    insufficientObjects: Map<string, RepairBlockDetails | undefined>;
    notifiedInsufficientObjects: Set<string>;
};
type RepairFaultResult = 'processed' | 'skipped' | 'cancelled';
type RepairWorkerStartOptions = {
    batchSize?: number;
    backlogDelayMs?: number;
    blockedRetryMs?: number;
};

type RepairWorkerDeps = {
    database: Pick<typeof database, 'getObjectById'>;
    remediationService: Pick<RemediationService, 'listFaults' | 'clearFault' | 'onSliceFault' | 'markRepairAttempted' | 'markRepairBlocked' | 'markRepairFailed'>;
    notificationService: NotificationService;
    batchSize: number;
    backlogDelayMs: number;
    // Lazily imported so this module (and core) never pulls the native
    // reed-solomon binding unless a repair actually runs.
    verifyObject: (objectId: string) => Promise<VerifyResult>;
    loadObject: (record: unknown) => Promise<LoadedObject>;
    repairSlice: (object: LoadedObject, sliceIndex: number) => Promise<void>;
    isVolumeWritable: (volumeId: number) => boolean;
    createLogger: typeof createLogger;
    now: () => number;
    blockedRetryMs: number;
};

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_BACKLOG_DELAY_MS = 10 * 1000;
const DEFAULT_BLOCKED_RETRY_MS = 60 * 60 * 1000;

const defaultDeps: RepairWorkerDeps = {
    database,
    remediationService,
    notificationService,
    batchSize: DEFAULT_BATCH_SIZE,
    backlogDelayMs: DEFAULT_BACKLOG_DELAY_MS,
    verifyObject: async (objectId: string) => {
        const { verifyFileJob } = require('../jobs/verify-file-job') as VerifyFileJobModule;
        return verifyFileJob.verify(objectId) as Promise<VerifyResult>;
    },
    loadObject: async (record: unknown) => {
        const { FileObject } = require('../io/file-object') as FileObjectModule;
        const object = new FileObject();
        await object.loadFromRecord(record as never);
        return object as unknown as LoadedObject;
    },
    repairSlice: async (object: LoadedObject, sliceIndex: number) => {
        const { sliceRepairer } = require('../io/file-object/slice-repairer') as SliceRepairerModule;
        await sliceRepairer.repair(object as never, sliceIndex);
    },
    isVolumeWritable: (volumeId: number) => {
        try {
            return Boolean(ioManager.getVolume(volumeId)?.isWritable);
        }
        catch {
            return false;
        }
    },
    createLogger,
    now: () => Date.now(),
    blockedRetryMs: DEFAULT_BLOCKED_RETRY_MS
};

// Closed-loop repair: for each open fault, re-verify the slice. A clean result
// means the fault was transient and is cleared; a confirmed bad slice is rebuilt
// in place from parity (refused if redundancy is insufficient). Runs one repair
// at a time, with a per-fault lease so overlapping ticks can't double-repair.
export class RepairWorker {
    private readonly deps: RepairWorkerDeps;
    private readonly log: ReturnType<typeof createLogger>;
    private readonly leases = new Set<string>();
    private timer: NodeJS.Timeout | null = null;
    private backlogTimer: NodeJS.Timeout | null = null;
    private wakeHandle: NodeJS.Immediate | null = null;
    private unsubscribeFaults: (() => void) | null = null;
    private running = false;
    private started = false;
    private stopping = false;
    private rerunRequested = false;
    private activePassKeys = new Set<string>();
    private loggedUnwritableTargetVolumes = new Set<number>();
    private batchSize: number;
    private backlogDelayMs: number;
    private blockedRetryMs: number;

    constructor(deps?: Partial<RepairWorkerDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('repair-worker');
        this.batchSize = this.normalizeBatchSize(this.deps.batchSize);
        this.backlogDelayMs = this.normalizeBacklogDelayMs(this.deps.backlogDelayMs);
        this.blockedRetryMs = this.normalizeBlockedRetryMs(this.deps.blockedRetryMs);
    }

    start(intervalMs: number, options?: RepairWorkerStartOptions): void {
        if (this.started)
            return;
        this.started = true;
        this.stopping = false;
        this.batchSize = this.normalizeBatchSize(options?.batchSize ?? this.deps.batchSize);
        this.backlogDelayMs = this.normalizeBacklogDelayMs(options?.backlogDelayMs ?? this.deps.backlogDelayMs);
        this.blockedRetryMs = this.normalizeBlockedRetryMs(options?.blockedRetryMs ?? this.deps.blockedRetryMs);

        this.unsubscribeFaults = this.deps.remediationService.onSliceFault(fault => {
            if (!this.shouldWakeForFault(fault))
                return;
            this.scheduleProcess(`fault ${fault.key}`);
        });

        if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
            this.log('repair worker waiting for reported faults (periodic polling disabled)');
        }
        else {
            this.log('repair worker polling every %dms', intervalMs);
            this.timer = setInterval(() => this.scheduleProcess('periodic poll'), intervalMs);
            this.timer.unref?.();
        }
        this.log('repair worker processing up to %d fault(s) per pass with %dms backlog delay', this.batchSize, this.backlogDelayMs);

        if (this.deps.remediationService.listFaults().length > 0)
            this.scheduleProcess('startup faults');
    }

    stop(): void {
        this.stopping = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.backlogTimer) {
            clearTimeout(this.backlogTimer);
            this.backlogTimer = null;
        }
        if (this.wakeHandle) {
            clearImmediate(this.wakeHandle);
            this.wakeHandle = null;
        }
        this.unsubscribeFaults?.();
        this.unsubscribeFaults = null;
        this.started = false;
        this.rerunRequested = false;
        this.activePassKeys.clear();
    }

    isScheduled(): boolean {
        return this.started;
    }

    wake(reason: string): void {
        this.scheduleProcess(reason);
    }

    async processFaults(): Promise<void> {
        // Single convergence point for ALL repair work — covers the periodic
        // poll, fault subscriptions, and wake()/scheduleProcess() callers (e.g.
        // io/manager on volume register/availability changes). Gating here keeps
        // every repair path off while frozen, even when start() was never called.
        if (await isMaintenanceFrozen())
            return;
        if (this.stopping)
            return;
        if (this.running) {
            this.rerunRequested = true;
            return;
        }
        this.running = true;
        try {
            do {
                this.rerunRequested = false;
                const allFaults = this.deps.remediationService.listFaults();
                const faults = allFaults.filter(fault => this.shouldAttemptFault(fault));
                const context: RepairPassContext = {
                    verifications: new Map(),
                    insufficientObjects: this.currentInsufficientBlocks(allFaults),
                    notifiedInsufficientObjects: new Set()
                };
                let visited = 0;
                let hitBatchLimit = false;

                this.activePassKeys = new Set(faults.map(fault => fault.key));
                for (const fault of faults) {
                    if (this.stopping)
                        return;

                    const result = await this.repairFault(fault, context);
                    visited++;

                    if (result === 'cancelled' || this.stopping)
                        return;

                    if (visited >= this.batchSize && visited < faults.length) {
                        hitBatchLimit = true;
                        break;
                    }
                }

                if (hitBatchLimit && !this.rerunRequested) {
                    this.scheduleProcess('repair backlog', this.backlogDelayMs);
                    return;
                }
            } while (this.rerunRequested);
        }
        finally {
            this.activePassKeys.clear();
            this.running = false;
        }
    }

    private scheduleProcess(reason: string, delayMs = 0): void {
        if (!this.started || this.stopping)
            return;

        if (delayMs > 0) {
            if (this.wakeHandle || this.backlogTimer)
                return;

            this.log('scheduling repair pass for %s in %dms', reason, delayMs);
            this.backlogTimer = setTimeout(() => {
                this.backlogTimer = null;
                void this.processFaults().catch(err => {
                    this.log.error('scheduled repair pass failed: %s', err instanceof Error ? err.message : String(err));
                });
            }, delayMs);
            this.backlogTimer.unref?.();
            return;
        }

        if (this.running) {
            this.rerunRequested = true;
            return;
        }

        if (this.backlogTimer) {
            clearTimeout(this.backlogTimer);
            this.backlogTimer = null;
        }
        if (this.wakeHandle)
            return;

        this.log('scheduling repair pass for %s', reason);
        this.wakeHandle = setImmediate(() => {
            this.wakeHandle = null;
            void this.processFaults().catch(err => {
                this.log.error('scheduled repair pass failed: %s', err instanceof Error ? err.message : String(err));
            });
        });
        this.wakeHandle.unref?.();
    }

    private shouldWakeForFault(fault: SliceFault): boolean {
        if (this.running && (this.leases.has(fault.key) || this.activePassKeys.has(fault.key)))
            return false;
        return this.shouldAttemptFault(fault);
    }

    private shouldAttemptFault(fault: SliceFault): boolean {
        if (fault.repairStatus !== 'blocked')
            return true;

        if (fault.repairBlockedReason === 'target-unwritable') {
            return typeof fault.volumeId === 'number'
                && this.deps.isVolumeWritable(fault.volumeId);
        }

        if (this.blockedRetryMs <= 0)
            return true;

        const lastAttempt = fault.lastRepairAttemptAt ?? fault.repairBlockedAt ?? fault.lastSeen;
        return this.deps.now() - lastAttempt >= this.blockedRetryMs;
    }

    private createPassContext(): RepairPassContext {
        return {
            verifications: new Map(),
            insufficientObjects: new Map(),
            notifiedInsufficientObjects: new Set()
        };
    }

    private currentInsufficientBlocks(faults: SliceFault[]): Map<string, RepairBlockDetails | undefined> {
        const blockedObjects = new Map<string, RepairBlockDetails | undefined>();
        for (const fault of faults) {
            if (fault.repairStatus !== 'blocked' || fault.repairBlockedReason !== 'insufficient-slices')
                continue;
            if (this.shouldAttemptFault(fault))
                continue;
            blockedObjects.set(fault.objectId, fault.repairDetails);
        }
        return blockedObjects;
    }

    async repairFault(fault: SliceFault, context: RepairPassContext = this.createPassContext()): Promise<RepairFaultResult> {
        if (this.stopping)
            return 'cancelled';
        if (this.leases.has(fault.key))
            return 'skipped';
        this.leases.add(fault.key);
        try {
            const blockedDetails = context.insufficientObjects.get(fault.objectId);
            if (blockedDetails !== undefined || context.insufficientObjects.has(fault.objectId)) {
                await this.deps.remediationService.markRepairBlocked(fault.key, 'insufficient-slices', blockedDetails);
                return 'processed';
            }

            let record: unknown;
            try {
                record = await this.deps.database.getObjectById(fault.objectId);
            }
            catch (err) {
                // Only a confirmed "not found" means the object is gone; a
                // transient DB error must not delete a durable fault.
                if ((err as { code?: string } | undefined)?.code === 'ENOENT') {
                    await this.clear(fault, 'object no longer exists');
                    return 'processed';
                }
                this.log.error('failed to load object %s for repair: %s', fault.objectId, err instanceof Error ? err.message : String(err));
                return 'processed';
            }

            if (this.stopping)
                return 'cancelled';

            if (await this.blockIfTargetUnwritable(fault))
                return 'processed';

            await this.deps.remediationService.markRepairAttempted(fault.key);

            // Classify: re-verify the slice. A clean result => transient.
            const before = await this.verifyObject(fault.objectId, context);
            if (before[String(fault.sliceIndex)]?.ok) {
                await this.clear(fault, 'verified clean (transient)');
                await this.notify('info', `Transient fault on object ${fault.objectId} slice ${fault.sliceIndex} cleared`, fault);
                return 'processed';
            }

            // Permanent: rebuild the slice in place from parity.
            this.log('repairing object %s slice %d', fault.objectId, fault.sliceIndex);
            const object = await this.deps.loadObject(record);
            await this.deps.repairSlice(object, fault.sliceIndex);

            const after = await this.deps.verifyObject(fault.objectId);
            context.verifications.set(fault.objectId, after);
            if (after[String(fault.sliceIndex)]?.ok) {
                await this.clear(fault, 'repaired');
                await this.notify('info', `Repaired slice ${fault.sliceIndex} of object ${fault.objectId} on volume ${fault.volumeId ?? 'unknown'}`, fault);
            }
            else {
                await this.deps.remediationService.markRepairFailed(fault.key, 'repaired slice did not verify clean');
                await this.notify('warning', `Repair of object ${fault.objectId} slice ${fault.sliceIndex} did not verify clean`, fault);
            }
            return 'processed';
        }
        catch (err) {
            const code = (err as { code?: string } | undefined)?.code;
            const message = err instanceof Error ? err.message : String(err);
            if (code === 'IOABORT') {
                this.log('repair pass cancelled while repairing %s slice %d: %s', fault.objectId, fault.sliceIndex, message);
                return 'cancelled';
            }
            else if (code === 'EQUORUM') {
                this.log.error('cannot repair %s slice %d: insufficient redundancy', fault.objectId, fault.sliceIndex);
                const details = this.repairBlockDetails(err, message);
                context.insufficientObjects.set(fault.objectId, details);
                await this.deps.remediationService.markRepairBlocked(fault.key, 'insufficient-slices', details);
                if (!context.notifiedInsufficientObjects.has(fault.objectId)) {
                    context.notifiedInsufficientObjects.add(fault.objectId);
                    await this.notify('critical', `Cannot repair object ${fault.objectId}: insufficient redundancy (data at risk)`, fault);
                }
            }
            else if (code === 'EVOLUMEUNWRITABLE') {
                await this.markTargetUnwritable(fault, this.repairBlockDetails(err, message, { targetVolumeId: fault.volumeId ?? undefined }));
            }
            else {
                this.log.error('repair failed for %s slice %d: %s', fault.objectId, fault.sliceIndex, message);
                await this.deps.remediationService.markRepairFailed(fault.key, message);
                await this.notify('warning', `Repair failed for object ${fault.objectId} slice ${fault.sliceIndex}: ${message}`, fault);
            }
            return 'processed';
        }
        finally {
            this.leases.delete(fault.key);
        }
    }

    private async verifyObject(objectId: string, context: RepairPassContext): Promise<VerifyResult> {
        const cached = context.verifications.get(objectId);
        if (cached)
            return cached;

        const result = await this.deps.verifyObject(objectId);
        context.verifications.set(objectId, result);
        return result;
    }

    private async blockIfTargetUnwritable(fault: SliceFault): Promise<boolean> {
        if (typeof fault.volumeId !== 'number')
            return false;
        if (this.deps.isVolumeWritable(fault.volumeId))
            return false;

        await this.markTargetUnwritable(fault, {
            targetVolumeId: fault.volumeId,
            message: 'target volume is not writable'
        });
        return true;
    }

    private async markTargetUnwritable(fault: SliceFault, details: RepairBlockDetails): Promise<void> {
        if (typeof fault.volumeId === 'number' && !this.loggedUnwritableTargetVolumes.has(fault.volumeId)) {
            this.loggedUnwritableTargetVolumes.add(fault.volumeId);
            this.log('deferring slice repairs targeting volume %d while it is not writable', fault.volumeId);
        }
        await this.deps.remediationService.markRepairBlocked(fault.key, 'target-unwritable', details);
    }

    private repairBlockDetails(err: unknown, message: string, defaults?: RepairBlockDetails): RepairBlockDetails {
        const details = { ...((err as { repairDetails?: RepairBlockDetails } | undefined)?.repairDetails ?? {}) };
        details.targetVolumeId ??= defaults?.targetVolumeId;
        details.message ??= message;
        return details;
    }

    private async clear(fault: SliceFault, reason: string): Promise<void> {
        this.log('clearing fault %s: %s', fault.key, reason);
        await this.deps.remediationService.clearFault(fault.key);
    }

    private async notify(severity: Severity, body: string, fault: SliceFault): Promise<void> {
        await this.deps.notificationService.notify({
            severity,
            title: 'Slice repair',
            body,
            dedupeKey: `repair:${fault.key}:${severity}`,
            context: { objectId: fault.objectId, sliceIndex: fault.sliceIndex, volumeId: fault.volumeId }
        }).catch(err => {
            this.log.error('failed to send repair notification: %s', err instanceof Error ? err.message : String(err));
        });
    }

    private normalizeBatchSize(value: number): number {
        const normalized = Math.floor(value);
        return Number.isFinite(normalized) && normalized > 0 ? normalized : DEFAULT_BATCH_SIZE;
    }

    private normalizeBacklogDelayMs(value: number): number {
        const normalized = Math.floor(value);
        return Number.isFinite(normalized) && normalized >= 0 ? normalized : DEFAULT_BACKLOG_DELAY_MS;
    }

    private normalizeBlockedRetryMs(value: number): number {
        const normalized = Math.floor(value);
        return Number.isFinite(normalized) && normalized >= 0 ? normalized : DEFAULT_BLOCKED_RETRY_MS;
    }
}

export const repairWorker = new RepairWorker();
