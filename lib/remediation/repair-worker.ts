import { createLogger } from '../log';
import { database } from '../database';
import type { Severity } from '../notify/notifier';
import { notificationService, NotificationService } from '../notify/service';
import { remediationService, RemediationService } from './service';
import type { RepairBlockDetails, SliceFault } from './fault';

type VerifySliceResult = { ok: boolean; volumeId: number | null };
type VerifyResult = Record<string, VerifySliceResult>;
type LoadedObject = { id?: string | null; size: number };
type VerifyFileJobModule = typeof import('../jobs/verify-file-job');
type FileObjectModule = typeof import('../io/file-object');
type SliceRepairerModule = typeof import('../io/file-object/slice-repairer');
type RepairFaultResult = 'processed' | 'skipped' | 'cancelled';
type RepairWorkerStartOptions = {
    batchSize?: number;
    backlogDelayMs?: number;
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
    createLogger: typeof createLogger;
};

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_BACKLOG_DELAY_MS = 10 * 1000;

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
    createLogger
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
    private batchSize: number;
    private backlogDelayMs: number;

    constructor(deps?: Partial<RepairWorkerDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('repair-worker');
        this.batchSize = this.normalizeBatchSize(this.deps.batchSize);
        this.backlogDelayMs = this.normalizeBacklogDelayMs(this.deps.backlogDelayMs);
    }

    start(intervalMs: number, options?: RepairWorkerStartOptions): void {
        if (this.started)
            return;
        this.started = true;
        this.stopping = false;
        this.batchSize = this.normalizeBatchSize(options?.batchSize ?? this.deps.batchSize);
        this.backlogDelayMs = this.normalizeBacklogDelayMs(options?.backlogDelayMs ?? this.deps.backlogDelayMs);

        this.unsubscribeFaults = this.deps.remediationService.onSliceFault(fault => {
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
    }

    isScheduled(): boolean {
        return this.started;
    }

    wake(reason: string): void {
        this.scheduleProcess(reason);
    }

    async processFaults(): Promise<void> {
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
                const faults = this.deps.remediationService.listFaults();
                let visited = 0;
                let hitBatchLimit = false;

                for (const fault of faults) {
                    if (this.stopping)
                        return;

                    const result = await this.repairFault(fault);
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

    async repairFault(fault: SliceFault): Promise<RepairFaultResult> {
        if (this.stopping)
            return 'cancelled';
        if (this.leases.has(fault.key))
            return 'skipped';
        this.leases.add(fault.key);
        try {
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

            await this.deps.remediationService.markRepairAttempted(fault.key);

            // Classify: re-verify the slice. A clean result => transient.
            const before = await this.deps.verifyObject(fault.objectId);
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
                await this.deps.remediationService.markRepairBlocked(
                    fault.key,
                    'insufficient-slices',
                    this.repairBlockDetails(err, message)
                );
                await this.notify('critical', `Cannot repair object ${fault.objectId} slice ${fault.sliceIndex}: insufficient redundancy (data at risk)`, fault);
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

    private repairBlockDetails(err: unknown, message: string): RepairBlockDetails {
        const details = { ...((err as { repairDetails?: RepairBlockDetails } | undefined)?.repairDetails ?? {}) };
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
}

export const repairWorker = new RepairWorker();
