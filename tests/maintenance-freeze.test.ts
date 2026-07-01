import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../lib/io/file-object/service', () => ({
    fileObjectService: {}
}));

vi.mock('../lib/io/file-object/slice-verifier', () => ({
    FileObjectSliceVerifier: vi.fn()
}));

const { isMaintenanceFrozenMock } = vi.hoisted(() => ({
    isMaintenanceFrozenMock: vi.fn()
}));

vi.mock('../lib/maintenance', () => ({
    isMaintenanceFrozen: isMaintenanceFrozenMock,
    setMaintenanceFrozen: vi.fn()
}));

import { VerifyVolumesJob } from '../lib/jobs/verify-volumes-job';
import { RepairWorker } from '../lib/remediation/repair-worker';
import type { SliceFault } from '../lib/remediation/fault';

const createLoggerFactory = () => {
    const loggerInstance = Object.assign(vi.fn(), { error: vi.fn() });
    return vi.fn(() => loggerInstance);
};

const createVerifyDeps = () => {
    const database = {
        findObjectsNeedingVerification: vi.fn().mockResolvedValue([]),
        findObjectsOnVolumesNeedingVerification: vi.fn().mockResolvedValue([]),
        updateObjectVerificationState: vi.fn().mockResolvedValue(undefined),
        setVolumeVerifyErrors: vi.fn().mockResolvedValue(undefined),
        countObjectsVerifiedSince: vi.fn().mockResolvedValue(0)
    };
    const runtimeConfig = {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined)
    };
    const volumeStub = { setVerifyErrors: vi.fn(), verifyErrors: { checksum: 0, total: 0 }, isEnabled: true, isDeleted: false };
    const ioManager = {
        getVolumeEntries: vi.fn().mockReturnValue([[1, volumeStub]]),
        getVolume: vi.fn(() => volumeStub)
    };
    return {
        database,
        runtimeConfig,
        fileObjectService: { load: vi.fn() },
        ioManager,
        createLogger: createLoggerFactory(),
        createSliceVerifier: vi.fn(),
        remediationService: { reportSliceFault: vi.fn() }
    };
};

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

const createRepairDeps = (overrides?: any) => ({
    database: { getObjectById: vi.fn().mockResolvedValue({ id: 'obj1', size: 10 }) },
    remediationService: {
        listFaults: vi.fn(() => [fault()]),
        clearFault: vi.fn().mockResolvedValue(true),
        markRepairAttempted: vi.fn().mockResolvedValue(true),
        markRepairBlocked: vi.fn().mockResolvedValue(true),
        markRepairFailed: vi.fn().mockResolvedValue(true),
        onSliceFault: vi.fn(() => () => undefined)
    },
    notificationService: { notify: vi.fn().mockResolvedValue({ delivered: [], failed: [], suppressed: false }) },
    verifyObject: vi.fn().mockResolvedValue({ '0': { ok: true, volumeId: 1 } }),
    loadObject: vi.fn().mockResolvedValue({ id: 'obj1', size: 10 }),
    repairSlice: vi.fn().mockResolvedValue(undefined),
    isVolumeWritable: vi.fn().mockReturnValue(true),
    createLogger: createLoggerFactory(),
    now: vi.fn(() => 1000),
    blockedRetryMs: 60 * 60 * 1000,
    ...overrides
});

describe('maintenance freeze gates', () => {
    beforeEach(() => {
        isMaintenanceFrozenMock.mockReset();
    });

    describe('VerifyVolumesJob.start', () => {
        it('does not start a run while frozen', async () => {
            isMaintenanceFrozenMock.mockResolvedValue(true);
            const deps = createVerifyDeps();
            const job = new VerifyVolumesJob(deps);

            const result = await job.start();

            expect(result.accepted).toBe(false);
            expect(job.isRunning()).toBe(false);
            // It must not even touch persisted verify state.
            expect(deps.runtimeConfig.get).not.toHaveBeenCalled();
            expect(deps.runtimeConfig.set).not.toHaveBeenCalled();
        });

        it('starts a run when not frozen', async () => {
            isMaintenanceFrozenMock.mockResolvedValue(false);
            const deps = createVerifyDeps();
            const job = new VerifyVolumesJob(deps);

            const result = await job.start();
            if (job.isRunning())
                await new Promise(resolve => setImmediate(resolve));

            expect(result.accepted).toBe(true);
            expect(deps.runtimeConfig.set).toHaveBeenCalledWith('verifyStartedAt', expect.any(String));
        });
    });

    describe('RepairWorker.processFaults', () => {
        it('does no repair work while frozen', async () => {
            isMaintenanceFrozenMock.mockResolvedValue(true);
            const deps = createRepairDeps();
            const worker = new RepairWorker(deps);

            await worker.processFaults();

            expect(deps.remediationService.listFaults).not.toHaveBeenCalled();
            expect(deps.verifyObject).not.toHaveBeenCalled();
            expect(deps.repairSlice).not.toHaveBeenCalled();
        });

        it('processes faults when not frozen', async () => {
            isMaintenanceFrozenMock.mockResolvedValue(false);
            const deps = createRepairDeps();
            const worker = new RepairWorker(deps);

            await worker.processFaults();

            expect(deps.verifyObject).toHaveBeenCalled();
            expect(deps.remediationService.clearFault).toHaveBeenCalledWith('1:obj1:0');
        });
    });
});
