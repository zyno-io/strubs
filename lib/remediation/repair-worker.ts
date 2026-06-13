import { createLogger } from '../log';
import { database } from '../database';
import type { Severity } from '../notify/notifier';
import { notificationService, NotificationService } from '../notify/service';
import { remediationService, RemediationService } from './service';
import type { SliceFault } from './fault';

type VerifySliceResult = { ok: boolean; volumeId: number | null };
type VerifyResult = Record<string, VerifySliceResult>;
type LoadedObject = { id?: string | null; size: number };
type VerifyFileJobModule = typeof import('../jobs/verify-file-job');
type FileObjectModule = typeof import('../io/file-object');
type SliceRepairerModule = typeof import('../io/file-object/slice-repairer');

type RepairWorkerDeps = {
    database: Pick<typeof database, 'getObjectById'>;
    remediationService: RemediationService;
    notificationService: NotificationService;
    // Lazily imported so this module (and core) never pulls the native
    // reed-solomon binding unless a repair actually runs.
    verifyObject: (objectId: string) => Promise<VerifyResult>;
    loadObject: (record: unknown) => Promise<LoadedObject>;
    repairSlice: (object: LoadedObject, sliceIndex: number) => Promise<void>;
    createLogger: typeof createLogger;
};

const defaultDeps: RepairWorkerDeps = {
    database,
    remediationService,
    notificationService,
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
    private running = false;

    constructor(deps?: Partial<RepairWorkerDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('repair-worker');
    }

    start(intervalMs: number): void {
        if (this.timer)
            return;
        if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
            this.log('repair worker disabled (no interval configured)');
            return;
        }
        this.log('repair worker polling every %dms', intervalMs);
        this.timer = setInterval(() => void this.processFaults(), intervalMs);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    isScheduled(): boolean {
        return this.timer !== null;
    }

    async processFaults(): Promise<void> {
        if (this.running)
            return;
        this.running = true;
        try {
            for (const fault of this.deps.remediationService.listFaults())
                await this.repairFault(fault);
        }
        finally {
            this.running = false;
        }
    }

    async repairFault(fault: SliceFault): Promise<void> {
        if (this.leases.has(fault.key))
            return;
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
                    return;
                }
                this.log.error('failed to load object %s for repair: %s', fault.objectId, err instanceof Error ? err.message : String(err));
                return;
            }

            // Classify: re-verify the slice. A clean result => transient.
            const before = await this.deps.verifyObject(fault.objectId);
            if (before[String(fault.sliceIndex)]?.ok) {
                await this.clear(fault, 'verified clean (transient)');
                await this.notify('info', `Transient fault on object ${fault.objectId} slice ${fault.sliceIndex} cleared`, fault);
                return;
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
                await this.notify('warning', `Repair of object ${fault.objectId} slice ${fault.sliceIndex} did not verify clean`, fault);
            }
        }
        catch (err) {
            const code = (err as { code?: string } | undefined)?.code;
            const message = err instanceof Error ? err.message : String(err);
            if (code === 'EQUORUM') {
                this.log.error('cannot repair %s slice %d: insufficient redundancy', fault.objectId, fault.sliceIndex);
                await this.notify('critical', `Cannot repair object ${fault.objectId} slice ${fault.sliceIndex}: insufficient redundancy (data at risk)`, fault);
            }
            else {
                this.log.error('repair failed for %s slice %d: %s', fault.objectId, fault.sliceIndex, message);
                await this.notify('warning', `Repair failed for object ${fault.objectId} slice ${fault.sliceIndex}: ${message}`, fault);
            }
        }
        finally {
            this.leases.delete(fault.key);
        }
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
}

export const repairWorker = new RepairWorker();
