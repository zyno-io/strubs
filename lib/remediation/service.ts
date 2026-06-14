import { createLogger } from '../log';
import { database, type FaultDocument, type FaultUpsert } from '../database';
import type { Severity } from '../notify/notifier';
import { notificationService, NotificationService } from '../notify/service';
import { faultKey, type SliceFault, type SliceFaultInput } from './fault';

// Minimal durable store contract; the database singleton satisfies it.
export interface FaultStore {
    upsertFault(fault: FaultUpsert): Promise<void>;
    listFaults(): Promise<FaultDocument[]>;
    deleteFault(key: string): Promise<void>;
}

type RemediationServiceDeps = {
    notificationService: NotificationService;
    faultStore: FaultStore;
    createLogger: typeof createLogger;
    now: () => number;
};

export type SliceFaultListener = (fault: SliceFault) => void;

const defaultDeps: RemediationServiceDeps = {
    notificationService,
    faultStore: database,
    createLogger,
    now: () => Date.now()
};

// Ingest slice faults from any detector, coalesce repeats, persist them,
// notify operators, and wake any remediation subscribers. The ingest surface
// (reportSliceFault) is intentionally fire-and-forget so detectors on the hot
// read path never block or throw.
export class RemediationService {
    private readonly deps: RemediationServiceDeps;
    private readonly log: ReturnType<typeof createLogger>;
    private readonly faults = new Map<string, SliceFault>();
    private readonly faultListeners = new Set<SliceFaultListener>();
    // Per-key promise chain so persistence writes for a given fault are ordered
    // (an out-of-order upsert can't overwrite a newer count, and a clear can't
    // be overtaken by a still-pending upsert that resurrects the row).
    private readonly persistChains = new Map<string, Promise<void>>();

    constructor(deps?: Partial<RemediationServiceDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('remediation');
    }

    reportSliceFault(input: SliceFaultInput): void {
        try {
            const fault = this.record(input);
            this.persist(fault);
            this.emitFault(fault);
            void this.announce(fault).catch(err => {
                this.log.error('failed to announce fault %s: %s', fault.key, err instanceof Error ? err.message : String(err));
            });
        }
        catch (err) {
            // Never let fault reporting break the caller (read path / verify job).
            this.log.error('failed to record slice fault: %s', err instanceof Error ? err.message : String(err));
        }
    }

    onSliceFault(listener: SliceFaultListener): () => void {
        this.faultListeners.add(listener);
        return () => {
            this.faultListeners.delete(listener);
        };
    }

    // Load previously-persisted faults into memory at startup so counts and
    // dedupe state survive a restart. The store is read before the in-memory map
    // is replaced, so a read failure leaves the existing map intact.
    async hydrate(): Promise<void> {
        try {
            const stored = await this.deps.faultStore.listFaults();
            this.faults.clear();
            for (const doc of stored) {
                const fault: SliceFault = {
                    key: doc._id,
                    objectId: doc.objectId,
                    sliceIndex: doc.sliceIndex,
                    volumeId: doc.volumeId,
                    source: doc.source as SliceFault['source'],
                    code: doc.code,
                    message: doc.message,
                    isChecksum: doc.isChecksum,
                    firstSeen: doc.firstSeen.getTime(),
                    lastSeen: doc.lastSeen.getTime(),
                    count: doc.count
                };
                this.faults.set(fault.key, fault);
            }
            this.log('hydrated %d persisted fault(s)', this.faults.size);
        }
        catch (err) {
            this.log.error('failed to hydrate faults: %s', err instanceof Error ? err.message : String(err));
        }
    }

    listFaults(): SliceFault[] {
        return Array.from(this.faults.values());
    }

    async clearFault(key: string): Promise<boolean> {
        const removed = this.faults.delete(key);
        // Chain the delete after any pending upserts for this key so it can't be
        // resurrected by an in-flight write.
        await this.enqueuePersist(key, async () => {
            try {
                await this.deps.faultStore.deleteFault(key);
            }
            catch (err) {
                this.log.error('failed to delete persisted fault %s: %s', key, err instanceof Error ? err.message : String(err));
            }
        });
        return removed;
    }

    private persist(fault: SliceFault): void {
        // Snapshot the mutable in-memory fault so the queued write reflects the
        // values at this occurrence, not whatever they become later.
        const payload: FaultUpsert = {
            key: fault.key,
            objectId: fault.objectId,
            sliceIndex: fault.sliceIndex,
            volumeId: fault.volumeId,
            source: fault.source,
            code: fault.code,
            message: fault.message,
            isChecksum: fault.isChecksum,
            firstSeen: new Date(fault.firstSeen),
            lastSeen: new Date(fault.lastSeen),
            count: fault.count
        };
        void this.enqueuePersist(fault.key, async () => {
            try {
                await this.deps.faultStore.upsertFault(payload);
            }
            catch (err) {
                this.log.error('failed to persist fault %s: %s', payload.key, err instanceof Error ? err.message : String(err));
            }
        });
    }

    // Serialize persistence operations per fault key.
    private enqueuePersist(key: string, op: () => Promise<void>): Promise<void> {
        const prev = this.persistChains.get(key) ?? Promise.resolve();
        const next = prev.then(op, op);
        this.persistChains.set(key, next);
        void next.finally(() => {
            if (this.persistChains.get(key) === next)
                this.persistChains.delete(key);
        });
        return next;
    }

    private record(input: SliceFaultInput): SliceFault {
        const key = faultKey(input);
        const now = this.deps.now();
        const existing = this.faults.get(key);
        if (existing) {
            existing.lastSeen = now;
            existing.count += 1;
            existing.code = input.code ?? existing.code;
            existing.message = input.message ?? existing.message;
            return existing;
        }
        const fault: SliceFault = { ...input, key, firstSeen: now, lastSeen: now, count: 1 };
        this.faults.set(key, fault);
        this.log('new slice fault %s source=%s code=%s', key, fault.source, fault.code ?? 'n/a');
        return fault;
    }

    private emitFault(fault: SliceFault): void {
        const snapshot = { ...fault };
        for (const listener of this.faultListeners) {
            try {
                listener(snapshot);
            }
            catch (err) {
                this.log.error('fault listener failed for %s: %s', fault.key, err instanceof Error ? err.message : String(err));
            }
        }
    }

    private async announce(fault: SliceFault): Promise<void> {
        const severity = this.classify(fault);
        const detail = fault.code ?? (fault.isChecksum ? 'ECHECKSUM' : 'error');
        const suffix = fault.message ? ` — ${fault.message}` : '';
        await this.deps.notificationService.notify({
            severity,
            title: `Slice fault on volume ${fault.volumeId ?? 'unknown'}`,
            body: `object ${fault.objectId} slice ${fault.sliceIndex} (${fault.source}) failed: ${detail}${suffix}`,
            dedupeKey: `fault:${fault.key}`,
            context: {
                volumeId: fault.volumeId,
                objectId: fault.objectId,
                sliceIndex: fault.sliceIndex,
                source: fault.source,
                code: fault.code,
                occurrences: fault.count
            }
        });
    }

    private classify(_fault: SliceFault): Severity {
        // Phase 1: a single slice fault is recoverable from parity, so it is a
        // warning, not critical. Volume-level escalation (many faults on one
        // device, SMART pre-fail) arrives with the Tier 2 work.
        return 'warning';
    }
}

export const remediationService = new RemediationService();
