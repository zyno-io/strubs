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
        createLogger: loggerFactory(),
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
        const equorum = Object.assign(new Error('insufficient slices'), { code: 'EQUORUM' });
        const { worker, deps } = makeWorker({
            verifyObject: vi.fn().mockResolvedValue({ '0': { ok: false, volumeId: 1 } }),
            repairSlice: vi.fn().mockRejectedValue(equorum)
        });
        await worker.processFaults();

        expect(deps.remediationService.clearFault).not.toHaveBeenCalled();
        expect(deps.notificationService.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical' }));
    });

    it('clears the fault when the object no longer exists', async () => {
        const { worker, deps } = makeWorker({
            database: { getObjectById: vi.fn().mockRejectedValue(Object.assign(new Error('object not found'), { code: 'ENOENT' })) }
        });
        await worker.processFaults();

        expect(deps.repairSlice).not.toHaveBeenCalled();
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
