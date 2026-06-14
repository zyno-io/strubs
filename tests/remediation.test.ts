import { describe, expect, it, vi } from 'vitest';

import { RemediationService } from '../lib/remediation/service';

const loggerFactory = () => vi.fn(() => Object.assign(vi.fn(), { error: vi.fn() })) as any;
const flush = () => new Promise(resolve => setImmediate(resolve));

const makeStore = () => ({
    upsertFault: vi.fn().mockResolvedValue(undefined),
    listFaults: vi.fn().mockResolvedValue([]),
    deleteFault: vi.fn().mockResolvedValue(undefined)
});

const makeService = (
    notify = vi.fn().mockResolvedValue({ delivered: [], failed: [], suppressed: false }),
    faultStore = makeStore()
) => {
    const service = new RemediationService({
        notificationService: { notify } as any,
        faultStore: faultStore as any,
        createLogger: loggerFactory(),
        now: () => 1000
    });
    return { service, notify, faultStore };
};

describe('RemediationService', () => {
    it('records a fault and emits a warning notification', async () => {
        const { service, notify } = makeService();
        service.reportSliceFault({ objectId: 'obj1', sliceIndex: 0, volumeId: 7, source: 'verify', code: 'EIO' });
        await flush();

        const faults = service.listFaults();
        expect(faults).toHaveLength(1);
        expect(faults[0]).toMatchObject({ objectId: 'obj1', sliceIndex: 0, volumeId: 7, count: 1, code: 'EIO' });

        expect(notify).toHaveBeenCalledTimes(1);
        const msg = notify.mock.calls[0][0];
        expect(msg.severity).toBe('warning');
        expect(msg.dedupeKey).toBe('fault:7:obj1:0');
        expect(msg.context).toMatchObject({ volumeId: 7, objectId: 'obj1', sliceIndex: 0, source: 'verify', occurrences: 1 });
    });

    it('coalesces repeats of the same slice into one rising-count fault', async () => {
        const { service } = makeService();
        service.reportSliceFault({ objectId: 'obj1', sliceIndex: 2, volumeId: 3, source: 'verify' });
        service.reportSliceFault({ objectId: 'obj1', sliceIndex: 2, volumeId: 3, source: 'read', code: 'EIO' });
        await flush();

        const faults = service.listFaults();
        expect(faults).toHaveLength(1);
        expect(faults[0].count).toBe(2);
        expect(faults[0].code).toBe('EIO');
    });

    it('notifies subscribers when a slice fault is reported', () => {
        const { service } = makeService();
        const listener = vi.fn();
        const unsubscribe = service.onSliceFault(listener);

        service.reportSliceFault({ objectId: 'obj1', sliceIndex: 0, volumeId: 7, source: 'read', code: 'EIO' });

        expect(listener).toHaveBeenCalledWith(expect.objectContaining({
            key: '7:obj1:0',
            objectId: 'obj1',
            sliceIndex: 0,
            volumeId: 7,
            source: 'read',
            code: 'EIO'
        }));

        unsubscribe();
        service.reportSliceFault({ objectId: 'obj1', sliceIndex: 0, volumeId: 7, source: 'read', code: 'EIO' });
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('never throws into the caller when notification fails', async () => {
        const notify = vi.fn().mockRejectedValue(new Error('transport down'));
        const { service } = makeService(notify);
        expect(() => service.reportSliceFault({ objectId: 'o', sliceIndex: 0, volumeId: 1, source: 'read' })).not.toThrow();
        await flush();
        expect(service.listFaults()).toHaveLength(1);
    });

    it('supports clearing a fault by key', async () => {
        const { service, faultStore } = makeService();
        service.reportSliceFault({ objectId: 'o', sliceIndex: 1, volumeId: 5, source: 'smart' });
        await flush();
        const [fault] = service.listFaults();
        await expect(service.clearFault(fault.key)).resolves.toBe(true);
        expect(service.listFaults()).toHaveLength(0);
        expect(faultStore.deleteFault).toHaveBeenCalledWith(fault.key);
    });

    it('marks a fault as repair-blocked and persists the reason', async () => {
        const { service, faultStore } = makeService();
        service.reportSliceFault({ objectId: 'obj1', sliceIndex: 0, volumeId: 7, source: 'read', code: 'EIO' });
        await expect(service.markRepairBlocked('7:obj1:0', 'insufficient-slices', {
            requiredSlices: 4,
            availableSlices: 3,
            missingSliceIndexes: [5],
            missingVolumeIds: [9],
            message: 'insufficient slices'
        })).resolves.toBe(true);

        const [fault] = service.listFaults();
        expect(fault).toMatchObject({
            repairStatus: 'blocked',
            repairBlockedReason: 'insufficient-slices',
            repairBlockedAt: 1000,
            lastRepairAttemptAt: 1000,
            lastRepairError: 'insufficient slices',
            repairDetails: {
                requiredSlices: 4,
                availableSlices: 3,
                missingSliceIndexes: [5],
                missingVolumeIds: [9]
            }
        });
        const upserted = faultStore.upsertFault.mock.calls.at(-1)?.[0];
        expect(upserted).toMatchObject({
            repairStatus: 'blocked',
            repairBlockedReason: 'insufficient-slices',
            repairDetails: expect.objectContaining({ requiredSlices: 4 })
        });
        expect(upserted.repairBlockedAt).toBeInstanceOf(Date);
    });

    it('returns a blocked fault to pending when repair is attempted again', async () => {
        const { service, faultStore } = makeService();
        service.reportSliceFault({ objectId: 'obj1', sliceIndex: 0, volumeId: 7, source: 'read', code: 'EIO' });
        await service.markRepairBlocked('7:obj1:0', 'insufficient-slices', { message: 'insufficient slices' });

        await expect(service.markRepairAttempted('7:obj1:0')).resolves.toBe(true);

        const [fault] = service.listFaults();
        expect(fault).toMatchObject({
            repairStatus: 'pending',
            lastRepairAttemptAt: 1000
        });
        expect(fault.repairBlockedReason).toBeUndefined();
        expect(fault.repairBlockedAt).toBeUndefined();
        expect(fault.lastRepairError).toBeUndefined();
        expect(fault.repairDetails).toBeUndefined();

        const upserted = faultStore.upsertFault.mock.calls.at(-1)?.[0];
        expect(upserted).toMatchObject({ repairStatus: 'pending' });
        expect(upserted.repairBlockedReason).toBeUndefined();
    });

    it('persists faults to the durable store', async () => {
        const { service, faultStore } = makeService();
        service.reportSliceFault({ objectId: 'obj1', sliceIndex: 0, volumeId: 7, source: 'verify', code: 'EIO' });
        await flush();
        expect(faultStore.upsertFault).toHaveBeenCalledTimes(1);
        const upserted = faultStore.upsertFault.mock.calls[0][0];
        expect(upserted).toMatchObject({ key: '7:obj1:0', objectId: 'obj1', volumeId: 7, count: 1, code: 'EIO' });
        expect(upserted.firstSeen).toBeInstanceOf(Date);
        expect(upserted.lastSeen).toBeInstanceOf(Date);
    });

    it('hydrates in-memory faults from the store on startup', async () => {
        const faultStore = makeStore();
        faultStore.listFaults.mockResolvedValue([
            {
                _id: '3:objX:1',
                objectId: 'objX',
                sliceIndex: 1,
                volumeId: 3,
                source: 'verify',
                code: 'EIO',
                firstSeen: new Date(1000),
                lastSeen: new Date(2000),
                count: 4,
                repairStatus: 'blocked',
                repairBlockedReason: 'insufficient-slices',
                repairBlockedAt: new Date(3000),
                lastRepairAttemptAt: new Date(2500),
                lastRepairError: 'insufficient slices',
                repairDetails: { requiredSlices: 4, availableSlices: 3 }
            }
        ]);
        const { service } = makeService(undefined, faultStore);
        await service.hydrate();
        const faults = service.listFaults();
        expect(faults).toHaveLength(1);
        expect(faults[0]).toMatchObject({
            key: '3:objX:1',
            objectId: 'objX',
            count: 4,
            firstSeen: 1000,
            lastSeen: 2000,
            repairStatus: 'blocked',
            repairBlockedReason: 'insufficient-slices',
            repairBlockedAt: 3000,
            lastRepairAttemptAt: 2500,
            lastRepairError: 'insufficient slices',
            repairDetails: { requiredSlices: 4, availableSlices: 3 }
        });
    });
});
