import { describe, expect, it, vi } from 'vitest';

import { RepairWorker } from '../lib/remediation/repair-worker';
import type { SliceFault } from '../lib/remediation/fault';

const loggerFactory = () => vi.fn(() => Object.assign(vi.fn(), { error: vi.fn() })) as any;
const flushImmediate = () => new Promise(resolve => setImmediate(resolve));

const fault = (overrides?: Partial<SliceFault>): SliceFault => ({
    key: '1:obj1:0',
    objectId: 'obj1',
    sliceIndex: 0,
    volumeId: 1,
    source: 'verify',
    firstSeen: 0,
    lastSeen: 0,
    count: 1,
    ...overrides
});

const makeWorker = (overrides?: any) => {
    const faultListeners = new Set<(fault: SliceFault) => void>();
    const unsubscribe = vi.fn();
    const deps = {
        database: { getObjectById: vi.fn().mockResolvedValue({ id: 'obj1', size: 10 }) },
        remediationService: {
            listFaults: vi.fn(() => [fault()]),
            clearFault: vi.fn().mockResolvedValue(true),
            markRepairAttempted: vi.fn().mockResolvedValue(true),
            markRepairBlocked: vi.fn().mockResolvedValue(true),
            markRepairFailed: vi.fn().mockResolvedValue(true),
            onSliceFault: vi.fn((listener: (fault: SliceFault) => void) => {
                faultListeners.add(listener);
                return () => {
                    faultListeners.delete(listener);
                    unsubscribe();
                };
            })
        },
        notificationService: { notify: vi.fn().mockResolvedValue({ delivered: [], failed: [], suppressed: false }) },
        verifyObject: vi.fn(),
        loadObject: vi.fn().mockResolvedValue({ id: 'obj1', size: 10 }),
        repairSlice: vi.fn().mockResolvedValue(undefined),
        isVolumeWritable: vi.fn().mockReturnValue(true),
        createLogger: loggerFactory(),
        now: vi.fn(() => 1000),
        blockedRetryMs: 60 * 60 * 1000,
        ...overrides
    };
    return { worker: new RepairWorker(deps), deps, faultListeners, unsubscribe };
};

describe('RepairWorker', () => {
    it('clears a transient fault without repairing when the slice re-verifies clean', async () => {
        const { worker, deps } = makeWorker({
            verifyObject: vi.fn().mockResolvedValue({ '0': { ok: true, volumeId: 1 } })
        });
        await worker.processFaults();

        expect(deps.repairSlice).not.toHaveBeenCalled();
        expect(deps.remediationService.clearFault).toHaveBeenCalledWith('1:obj1:0');
        expect(deps.remediationService.markRepairAttempted).toHaveBeenCalledWith('1:obj1:0');
    });

    it('rebuilds a confirmed-bad slice and clears the fault after it re-verifies', async () => {
        const verifyObject = vi.fn()
            .mockResolvedValueOnce({ '0': { ok: false, volumeId: 1 } }) // classify: still bad
            .mockResolvedValueOnce({ '0': { ok: true, volumeId: 1 } });  // after repair: clean
        const { worker, deps } = makeWorker({ verifyObject });
        await worker.processFaults();

        expect(deps.repairSlice).toHaveBeenCalledWith(expect.anything(), 0);
        expect(deps.remediationService.clearFault).toHaveBeenCalledWith('1:obj1:0');
        expect(deps.notificationService.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: 'info' }));
    });

    it('does not clear the fault when the repaired slice fails to re-verify', async () => {
        const verifyObject = vi.fn()
            .mockResolvedValueOnce({ '0': { ok: false, volumeId: 1 } }) // classify: bad
            .mockResolvedValueOnce({ '0': { ok: false, volumeId: 1 } }); // after repair: still bad
        const { worker, deps } = makeWorker({ verifyObject });
        await worker.processFaults();

        expect(deps.repairSlice).toHaveBeenCalled();
        expect(deps.remediationService.clearFault).not.toHaveBeenCalled();
        expect(deps.remediationService.markRepairFailed).toHaveBeenCalledWith('1:obj1:0', 'repaired slice did not verify clean');
        expect(deps.notificationService.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warning' }));
    });

    it('skips a fault that is already being repaired (lease)', async () => {
        const { worker, deps } = makeWorker({
            verifyObject: vi.fn().mockResolvedValue({ '0': { ok: false, volumeId: 1 } })
        });
        (worker as unknown as { leases: Set<string> }).leases.add('1:obj1:0');
        await worker.repairFault(fault());
        expect(deps.repairSlice).not.toHaveBeenCalled();
    });

    it('raises a critical alert and leaves the fault when redundancy is insufficient', async () => {
        const equorum = Object.assign(new Error('insufficient slices'), {
            code: 'EQUORUM',
            repairDetails: { requiredSlices: 4, availableSlices: 3, missingSliceIndexes: [5] }
        });
        const { worker, deps } = makeWorker({
            verifyObject: vi.fn().mockResolvedValue({ '0': { ok: false, volumeId: 1 } }),
            repairSlice: vi.fn().mockRejectedValue(equorum)
        });
        await worker.processFaults();

        expect(deps.remediationService.clearFault).not.toHaveBeenCalled();
        expect(deps.remediationService.markRepairBlocked).toHaveBeenCalledWith(
            '1:obj1:0',
            'insufficient-slices',
            expect.objectContaining({
                requiredSlices: 4,
                availableSlices: 3,
                missingSliceIndexes: [5],
                message: 'insufficient slices'
            })
        );
        expect(deps.notificationService.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical' }));
    });

    it('blocks repair without verifying when the target volume is not writable', async () => {
        const { worker, deps } = makeWorker({
            isVolumeWritable: vi.fn().mockReturnValue(false)
        });
        await worker.processFaults();

        expect(deps.verifyObject).not.toHaveBeenCalled();
        expect(deps.repairSlice).not.toHaveBeenCalled();
        expect(deps.remediationService.markRepairAttempted).not.toHaveBeenCalled();
        expect(deps.remediationService.markRepairBlocked).toHaveBeenCalledWith(
            '1:obj1:0',
            'target-unwritable',
            { targetVolumeId: 1, message: 'target volume is not writable' }
        );
        expect(deps.notificationService.notify).not.toHaveBeenCalled();
    });

    it('marks target-unwritable repair errors as blocked instead of failed', async () => {
        const error = Object.assign(new Error('volume is not writable'), {
            code: 'EVOLUMEUNWRITABLE',
            repairDetails: { targetVolumeId: 1 }
        });
        const { worker, deps } = makeWorker({
            verifyObject: vi.fn().mockResolvedValue({ '0': { ok: false, volumeId: 1 } }),
            repairSlice: vi.fn().mockRejectedValue(error)
        });
        await worker.processFaults();

        expect(deps.remediationService.markRepairBlocked).toHaveBeenCalledWith(
            '1:obj1:0',
            'target-unwritable',
            { targetVolumeId: 1, message: 'volume is not writable' }
        );
        expect(deps.remediationService.markRepairFailed).not.toHaveBeenCalled();
    });

    it('blocks (reconstruction-mismatch) and alerts when the rebuilt object fails the md5 gate', async () => {
        const corrupt = Object.assign(new Error('reconstruction does not match stored object md5'), { code: 'ECORRUPT' });
        const { worker, deps } = makeWorker({
            verifyObject: vi.fn().mockResolvedValue({ '0': { ok: false, volumeId: 1 } }),
            repairSlice: vi.fn().mockRejectedValue(corrupt)
        });
        await worker.processFaults();

        expect(deps.remediationService.clearFault).not.toHaveBeenCalled();
        expect(deps.remediationService.markRepairFailed).not.toHaveBeenCalled();
        expect(deps.remediationService.markRepairBlocked).toHaveBeenCalledWith(
            '1:obj1:0',
            'reconstruction-mismatch',
            expect.objectContaining({ message: expect.stringContaining('does not match stored object md5') })
        );
        expect(deps.notificationService.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical' }));
    });

    it('records non-quorum repair failures without marking the fault blocked', async () => {
        const failure = new Error('write failed');
        const { worker, deps } = makeWorker({
            verifyObject: vi.fn().mockResolvedValue({ '0': { ok: false, volumeId: 1 } }),
            repairSlice: vi.fn().mockRejectedValue(failure)
        });
        await worker.processFaults();

        expect(deps.remediationService.markRepairFailed).toHaveBeenCalledWith('1:obj1:0', 'write failed');
        expect(deps.remediationService.markRepairBlocked).not.toHaveBeenCalled();
    });

    it('treats shutdown I/O aborts as cancellation without failure notifications', async () => {
        const ioAbort = Object.assign(new Error('I/O aborted due to shutdown'), { code: 'IOABORT' });
        const { worker, deps } = makeWorker({
            verifyObject: vi.fn().mockRejectedValue(ioAbort)
        });
        deps.remediationService.listFaults.mockReturnValue([
            fault(),
            fault({ key: '1:obj2:1', objectId: 'obj2', sliceIndex: 1 })
        ]);

        await worker.processFaults();

        expect(deps.database.getObjectById).toHaveBeenCalledTimes(1);
        expect(deps.remediationService.markRepairFailed).not.toHaveBeenCalled();
        expect(deps.remediationService.markRepairBlocked).not.toHaveBeenCalled();
        expect(deps.notificationService.notify).not.toHaveBeenCalled();
    });

    it('clears the fault when the object no longer exists', async () => {
        const { worker, deps } = makeWorker({
            database: { getObjectById: vi.fn().mockRejectedValue(Object.assign(new Error('object not found'), { code: 'ENOENT' })) }
        });
        await worker.processFaults();

        expect(deps.repairSlice).not.toHaveBeenCalled();
        expect(deps.remediationService.clearFault).toHaveBeenCalledWith('1:obj1:0');
    });

    it('skips blocked faults until their retry window expires', async () => {
        const blocked = fault({
            key: '1:blocked:0',
            objectId: 'blocked',
            repairStatus: 'blocked',
            repairBlockedReason: 'insufficient-slices',
            lastRepairAttemptAt: 900
        });
        const pending = fault({ key: '1:pending:1', objectId: 'pending', sliceIndex: 1 });
        const { worker, deps } = makeWorker({
            blockedRetryMs: 500,
            verifyObject: vi.fn().mockResolvedValue({ '1': { ok: true, volumeId: 1 } })
        });
        deps.remediationService.listFaults.mockReturnValue([blocked, pending]);

        await worker.processFaults();

        expect(deps.database.getObjectById).toHaveBeenCalledTimes(1);
        expect(deps.database.getObjectById).toHaveBeenCalledWith('pending');
        expect(deps.remediationService.markRepairAttempted).toHaveBeenCalledWith('1:pending:1');
        expect(deps.remediationService.markRepairAttempted).not.toHaveBeenCalledWith('1:blocked:0');
    });

    it('retries a target-unwritable blocked fault as soon as the target volume is writable', async () => {
        const blocked = fault({
            repairStatus: 'blocked',
            repairBlockedReason: 'target-unwritable',
            lastRepairAttemptAt: 999
        });
        const { worker, deps } = makeWorker({
            blockedRetryMs: 500,
            isVolumeWritable: vi.fn().mockReturnValue(true),
            verifyObject: vi.fn().mockResolvedValue({ '0': { ok: true, volumeId: 1 } })
        });
        deps.remediationService.listFaults.mockReturnValue([blocked]);

        await worker.processFaults();

        expect(deps.verifyObject).toHaveBeenCalledTimes(1);
        expect(deps.remediationService.clearFault).toHaveBeenCalledWith('1:obj1:0');
    });

    it('does not retry target-unwritable blocked faults just because the retry window elapsed', async () => {
        const blocked = fault({
            repairStatus: 'blocked',
            repairBlockedReason: 'target-unwritable',
            lastRepairAttemptAt: 0
        });
        const { worker, deps } = makeWorker({
            blockedRetryMs: 500,
            isVolumeWritable: vi.fn().mockReturnValue(false)
        });
        deps.remediationService.listFaults.mockReturnValue([blocked]);

        await worker.processFaults();

        expect(deps.database.getObjectById).not.toHaveBeenCalled();
        expect(deps.verifyObject).not.toHaveBeenCalled();
        expect(deps.remediationService.markRepairBlocked).not.toHaveBeenCalled();
    });

    it('skips repair of objects marked unrecoverable (recoveryComment) without reconstructing', async () => {
        const { worker, deps } = makeWorker({
            database: { getObjectById: vi.fn().mockResolvedValue({ id: 'obj1', size: 10, recoveryComment: 'drive gone, insufficient slices, 7/1/26 -sf' }) }
        });
        await worker.processFaults();

        expect(deps.verifyObject).not.toHaveBeenCalled();
        expect(deps.repairSlice).not.toHaveBeenCalled();
        expect(deps.remediationService.markRepairAttempted).not.toHaveBeenCalled();
        expect(deps.remediationService.markRepairBlocked).toHaveBeenCalledWith(
            '1:obj1:0',
            'unrecoverable',
            expect.objectContaining({ message: expect.stringContaining('object marked unrecoverable') })
        );
    });

    it('never retries an unrecoverable blocked fault even after the retry window elapses', async () => {
        const blocked = fault({ repairStatus: 'blocked', repairBlockedReason: 'unrecoverable', lastRepairAttemptAt: 0 });
        const { worker, deps } = makeWorker({ blockedRetryMs: 500 });
        deps.remediationService.listFaults.mockReturnValue([blocked]);

        await worker.processFaults();

        expect(deps.database.getObjectById).not.toHaveBeenCalled();
        expect(deps.repairSlice).not.toHaveBeenCalled();
        expect(deps.remediationService.markRepairBlocked).not.toHaveBeenCalled();
    });

    it('never retries a reconstruction-mismatch blocked fault (no re-reconstruct / alert spam)', async () => {
        const blocked = fault({ repairStatus: 'blocked', repairBlockedReason: 'reconstruction-mismatch', lastRepairAttemptAt: 0 });
        const { worker, deps } = makeWorker({ blockedRetryMs: 500 });
        deps.remediationService.listFaults.mockReturnValue([blocked]);

        await worker.processFaults();

        expect(deps.database.getObjectById).not.toHaveBeenCalled();
        expect(deps.repairSlice).not.toHaveBeenCalled();
        expect(deps.notificationService.notify).not.toHaveBeenCalled();
    });

    it('skips repair of below-quorum objects (more bad slices than parity) without reconstructing', async () => {
        const { worker, deps } = makeWorker({
            database: { getObjectById: vi.fn().mockResolvedValue({
                id: 'obj1', size: 10,
                dataVolumes: [1, 2, 3, 4], parityVolumes: [5, 6],
                sliceErrors: { '1': {}, '2': {}, '4': {} } // 3 bad slices > 2 parity => below quorum
            }) }
        });
        await worker.processFaults();

        expect(deps.verifyObject).not.toHaveBeenCalled();
        expect(deps.repairSlice).not.toHaveBeenCalled();
        expect(deps.remediationService.markRepairBlocked).toHaveBeenCalledWith(
            '1:obj1:0',
            'insufficient-slices',
            expect.objectContaining({ requiredSlices: 4, availableSlices: 3, totalSlices: 6 })
        );
    });

    it('still repairs a within-quorum object with a repairable slice error map', async () => {
        const verifyObject = vi.fn()
            .mockResolvedValueOnce({ '0': { ok: false, volumeId: 1 } })
            .mockResolvedValueOnce({ '0': { ok: true, volumeId: 1 } });
        const { worker, deps } = makeWorker({
            verifyObject,
            database: { getObjectById: vi.fn().mockResolvedValue({
                id: 'obj1', size: 10,
                dataVolumes: [1, 2, 3, 4], parityVolumes: [5, 6],
                sliceErrors: { '0': {} } // 1 bad <= 2 parity => recoverable, must NOT be skipped
            }) }
        });
        await worker.processFaults();

        expect(deps.repairSlice).toHaveBeenCalledWith(expect.anything(), 0);
        expect(deps.remediationService.clearFault).toHaveBeenCalledWith('1:obj1:0');
    });

    it('leaves the fault on a transient DB error (no ENOENT)', async () => {
        const { worker, deps } = makeWorker({
            database: { getObjectById: vi.fn().mockRejectedValue(new Error('connection reset')) }
        });
        await worker.processFaults();

        expect(deps.repairSlice).not.toHaveBeenCalled();
        expect(deps.remediationService.clearFault).not.toHaveBeenCalled();
    });

    it('stops the active repair pass before starting another fault', async () => {
        const { worker, deps } = makeWorker();
        deps.remediationService.listFaults.mockReturnValue([
            fault(),
            fault({ key: '1:obj2:1', objectId: 'obj2', sliceIndex: 1 })
        ]);
        const repairFault = vi.spyOn(worker, 'repairFault')
            .mockImplementationOnce(async () => {
                worker.stop();
                return 'processed' as never;
            })
            .mockResolvedValue('processed' as never);

        await worker.processFaults();

        expect(repairFault).toHaveBeenCalledTimes(1);
    });

    it('wakes a repair pass when a fault is reported even with periodic polling disabled', async () => {
        const { worker, deps, faultListeners } = makeWorker();
        const processFaults = vi.spyOn(worker, 'processFaults').mockResolvedValue(undefined);

        worker.start(0);
        expect(deps.remediationService.onSliceFault).toHaveBeenCalledTimes(1);

        for (const listener of faultListeners)
            listener(fault());
        await flushImmediate();

        expect(processFaults).toHaveBeenCalledTimes(1);
        worker.stop();
    });

    it('processes a bounded backlog batch and delays remaining faults', async () => {
        const initialFaults = [
            fault(),
            fault({ key: '1:obj2:1', objectId: 'obj2', sliceIndex: 1 }),
            fault({ key: '1:obj3:2', objectId: 'obj3', sliceIndex: 2 })
        ];
        let faults = initialFaults.slice();
        const { worker, deps } = makeWorker({ batchSize: 2, backlogDelayMs: 5 });
        deps.remediationService.listFaults.mockImplementation(() => faults.slice());
        const repairFault = vi.spyOn(worker, 'repairFault').mockImplementation(async current => {
            faults = faults.filter(existing => existing.key !== current.key);
            return 'processed' as never;
        });

        worker.start(0);
        await flushImmediate();

        expect(repairFault).toHaveBeenCalledTimes(2);

        await new Promise(resolve => setTimeout(resolve, 20));
        await Promise.resolve();

        expect(repairFault).toHaveBeenCalledTimes(3);
        worker.stop();
    });

    it('ignores self-wake events for faults already in the active pass', async () => {
        const { worker, faultListeners } = makeWorker();
        const repairFault = vi.spyOn(worker, 'repairFault').mockImplementation(async current => {
            for (const listener of faultListeners)
                listener(current);
            return 'processed' as never;
        });

        worker.start(0);
        await flushImmediate();
        await Promise.resolve();

        expect(repairFault).toHaveBeenCalledTimes(1);
        worker.stop();
    });

    it('blocks sibling faults after one insufficient-redundancy repair attempt for an object', async () => {
        const equorum = Object.assign(new Error('insufficient slices'), {
            code: 'EQUORUM',
            repairDetails: { requiredSlices: 4, availableSlices: 3 }
        });
        const { worker, deps } = makeWorker({
            verifyObject: vi.fn().mockResolvedValue({
                '0': { ok: false, volumeId: 1 },
                '1': { ok: false, volumeId: 1 }
            }),
            repairSlice: vi.fn().mockRejectedValue(equorum)
        });
        deps.remediationService.listFaults.mockReturnValue([
            fault(),
            fault({ key: '1:obj1:1', sliceIndex: 1 })
        ]);

        await worker.processFaults();

        expect(deps.verifyObject).toHaveBeenCalledTimes(1);
        expect(deps.repairSlice).toHaveBeenCalledTimes(1);
        expect(deps.remediationService.markRepairBlocked).toHaveBeenCalledWith(
            '1:obj1:0',
            'insufficient-slices',
            expect.objectContaining({ requiredSlices: 4, availableSlices: 3 })
        );
        expect(deps.remediationService.markRepairBlocked).toHaveBeenCalledWith(
            '1:obj1:1',
            'insufficient-slices',
            expect.objectContaining({ requiredSlices: 4, availableSlices: 3 })
        );
        expect(deps.notificationService.notify).toHaveBeenCalledTimes(1);
    });

    it('blocks pending siblings of a not-yet-retryable insufficient-slices fault without repair', async () => {
        const blocked = fault({
            key: '1:obj1:0',
            sliceIndex: 0,
            repairStatus: 'blocked',
            repairBlockedReason: 'insufficient-slices',
            repairBlockedAt: 900,
            lastRepairAttemptAt: 900,
            repairDetails: { requiredSlices: 4, availableSlices: 3 }
        });
        const pending = fault({ key: '1:obj1:1', sliceIndex: 1 });
        const { worker, deps } = makeWorker();
        deps.remediationService.listFaults.mockReturnValue([blocked, pending]);

        await worker.processFaults();

        expect(deps.database.getObjectById).not.toHaveBeenCalled();
        expect(deps.verifyObject).not.toHaveBeenCalled();
        expect(deps.repairSlice).not.toHaveBeenCalled();
        expect(deps.remediationService.markRepairAttempted).not.toHaveBeenCalled();
        expect(deps.remediationService.markRepairBlocked).toHaveBeenCalledWith(
            '1:obj1:1',
            'insufficient-slices',
            expect.objectContaining({ requiredSlices: 4, availableSlices: 3 })
        );
    });

    it('coalesces overlapping repair passes instead of running them in parallel', async () => {
        const { worker } = makeWorker();
        let releaseFirst: () => void = () => {};
        let enteredFirst: () => void = () => {};
        let active = 0;
        let maxActive = 0;
        const firstEntered = new Promise<void>(resolve => {
            enteredFirst = resolve;
        });
        const firstRelease = new Promise<void>(resolve => {
            releaseFirst = resolve;
        });

        const repairFault = vi.spyOn(worker, 'repairFault')
            .mockImplementationOnce(async () => {
                active++;
                maxActive = Math.max(maxActive, active);
                enteredFirst();
                await firstRelease;
                active--;
            })
            .mockImplementationOnce(async () => {
                active++;
                maxActive = Math.max(maxActive, active);
                active--;
            });

        const firstRun = worker.processFaults();
        await firstEntered;
        const secondRun = worker.processFaults();

        expect(repairFault).toHaveBeenCalledTimes(1);
        releaseFirst();
        await firstRun;
        await secondRun;

        expect(repairFault).toHaveBeenCalledTimes(2);
        expect(maxActive).toBe(1);
    });
});
