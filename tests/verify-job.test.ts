import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/io/file-object/service', () => ({
    fileObjectService: {}
}));

vi.mock('../lib/io/file-object/slice-verifier', () => ({
    FileObjectSliceVerifier: vi.fn()
}));

import { VerifyVolumesJob } from '../lib/jobs/verify-volumes-job';

const createLoggerFactory = () => {
    const loggerInstance = Object.assign(vi.fn(), { error: vi.fn() });
    return vi.fn(() => loggerInstance);
};

const createDeps = () => {
    const database = {
        findObjectsNeedingVerification: vi.fn(),
        findObjectsOnVolumesNeedingVerification: vi.fn().mockResolvedValue([]),
        updateObjectVerificationState: vi.fn().mockResolvedValue(undefined),
        setVolumeVerifyErrors: vi.fn().mockResolvedValue(undefined),
        countObjectsVerifiedSince: vi.fn().mockResolvedValue(0)
    };
    const runtimeConfig = {
        get: vi.fn(),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined)
    };
    const fileObjectService = {
        load: vi.fn()
    };
    const volumeStub1 = { setVerifyErrors: vi.fn(), verifyErrors: { checksum: 2, total: 3 }, isEnabled: true, isDeleted: false };
    const volumeStub2 = { setVerifyErrors: vi.fn(), verifyErrors: { checksum: 0, total: 0 }, isEnabled: true, isDeleted: false };
    const ioManager = {
        getVolumeEntries: vi.fn().mockReturnValue([[1, volumeStub1], [2, volumeStub2]]),
        getVolume: vi.fn((id: number) => (id === 1 ? volumeStub1 : volumeStub2))
    };

    const remediationService = {
        reportSliceFault: vi.fn()
    };

    return {
        database,
        runtimeConfig,
        fileObjectService,
        ioManager,
        createLogger: createLoggerFactory(),
        createSliceVerifier: vi.fn(),
        remediationService
    };
};

const times = (startedAt: string, data: boolean[], parity: boolean[] = []) => ({
    data: data.map(verified => verified ? new Date(startedAt) : null),
    parity: parity.map(verified => verified ? new Date(startedAt) : null)
});

describe('VerifyVolumesJob', () => {
    it('reports full verification scope by default', () => {
        const job = new VerifyVolumesJob(createDeps());
        expect(job.getStatus()).toMatchObject({
            running: false,
            scope: 'full',
            volumeIds: []
        });
    });

    describe('deferral behind a rebalance', () => {
        it('queues a requested verify instead of running it, and persists the request', async () => {
            const deps = createDeps();
            deps.runtimeConfig.get.mockResolvedValue(null);
            const job = new VerifyVolumesJob(deps);

            await job.pauseForRebalance();
            const result = await job.start({ volumeIds: [13] });

            expect(result.accepted).toBe(true);
            expect(result.deferred).toBe(true);
            expect(job.isRunning()).toBe(false);
            // Persisted, so it is queued rather than dropped -- the rebalance restarts it later.
            expect(deps.runtimeConfig.set).toHaveBeenCalledWith('verifyStartedAt', result.startedAt);
            expect(job.getStatus()).toMatchObject({ running: false, waiting: true, waitingFor: 'rebalance' });
        });

        it('starts the queued verify once the rebalance releases the disks', async () => {
            const deps = createDeps();
            deps.runtimeConfig.get.mockResolvedValue(null);
            deps.database.findObjectsNeedingVerification.mockResolvedValue([]);
            const job = new VerifyVolumesJob(deps);

            await job.pauseForRebalance();
            await job.start();
            expect(job.getStatus().waiting).toBe(true);

            // The rebalance finished: the persisted run must now actually launch.
            deps.runtimeConfig.get.mockResolvedValue('2026-01-01T00:00:00.000Z');
            await job.releaseForRebalance();

            const running = (job as unknown as { running: Promise<void> | null }).running;
            if (running) await running;
            expect(deps.database.findObjectsNeedingVerification).toHaveBeenCalled();
            expect(job.getStatus().waiting).toBe(false);
        });

        it('lets Stop discard a verify that is queued behind a rebalance', async () => {
            // Without this, Stop would appear to do nothing and the run would spring to life later.
            const deps = createDeps();
            deps.runtimeConfig.get.mockResolvedValue(null);
            const job = new VerifyVolumesJob(deps);

            await job.pauseForRebalance();
            await job.start();
            expect(job.getStatus().waiting).toBe(true);

            await job.stop();

            expect(job.getStatus()).toMatchObject({ waiting: false, waitingFor: null });
            expect(deps.runtimeConfig.delete.mock.calls.map(c => c[0])).toContain('verifyStartedAt');
        });
    });

    it('reports targeted verification scope while a filtered run is active', () => {
        const job = new VerifyVolumesJob(createDeps());
        Object.assign(job as unknown as {
            running: Promise<void>;
            startedAt: string;
            volumeFilter: Set<number>;
            currentConcurrency: number;
        }, {
            running: Promise.resolve(),
            startedAt: '2024-02-01T00:00:00.000Z',
            volumeFilter: new Set([2, 1]),
            currentConcurrency: 2
        });

        expect(job.getStatus()).toMatchObject({
            running: true,
            scope: 'targeted',
            volumeIds: [1, 2]
        });
    });

    it('verifies objects and records lastVerify metadata', async () => {
        const deps = createDeps();
        const record = {
            id: 'abc',
            size: 1,
            dataVolumes: [1],
            parityVolumes: [],
            chunkSize: 1,
            dataSliceVolumeIds: [1],
            paritySliceVolumeIds: [],
            unavailableSlices: [],
            damagedSlices: [],
            isFile: true,
            name: 'file',
            md5: null
        };

        deps.runtimeConfig.get.mockResolvedValueOnce(null);
        deps.database.findObjectsNeedingVerification
            .mockResolvedValueOnce([record])
            .mockResolvedValueOnce([]);
        const sliceVerifier = { verifySlice: vi.fn().mockResolvedValue(undefined) };
        deps.fileObjectService.load.mockResolvedValue({} as any);
        deps.createSliceVerifier.mockReturnValue(sliceVerifier);

        const job = new VerifyVolumesJob(deps);
        const startPromise = job.start();
        const { startedAt } = await startPromise;
        const running = (job as unknown as { running: Promise<void> | null }).running;
        if (running)
            await running;

        expect(sliceVerifier.verifySlice).toHaveBeenCalledTimes(1);
        expect(sliceVerifier.verifySlice).toHaveBeenCalledWith(0);
        expect(deps.database.updateObjectVerificationState).toHaveBeenCalledWith(record.id, {
            lastVerifiedAt: new Date(startedAt),
            sliceErrors: null,
            sliceVerificationTimes: times(startedAt, [true])
        });
        expect(deps.database.setVolumeVerifyErrors).toHaveBeenCalledTimes(2);
        expect(deps.database.setVolumeVerifyErrors).toHaveBeenNthCalledWith(1, 1, { checksum: 0, total: 0 });
        expect(deps.database.setVolumeVerifyErrors).toHaveBeenNthCalledWith(2, 2, { checksum: 0, total: 0 });
        expect(deps.runtimeConfig.set).toHaveBeenNthCalledWith(1, 'verifyStartedAt', startedAt);
        expect(deps.runtimeConfig.set).toHaveBeenCalledWith('verifyCursorId', record.id);
        expect(deps.runtimeConfig.set).toHaveBeenCalledWith('lastVerify', expect.objectContaining({
            startedAt,
            checksumErrors: 0,
            totalErrors: 0
        }));
        expect(deps.runtimeConfig.delete.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(['verifyStartedAt', 'verifyVolumeIds', 'verifyCursorId']));
    });

    it('verifies multiple objects in parallel batches', async () => {
        const deps = createDeps();
        const recordA = {
            id: 'obj-a',
            size: 1,
            dataVolumes: [1],
            parityVolumes: [],
            chunkSize: 1,
            dataSliceVolumeIds: [1],
            paritySliceVolumeIds: [],
            unavailableSlices: [],
            damagedSlices: [],
            isFile: true,
            name: 'fileA',
            md5: null
        };
        const recordB = {
            id: 'obj-b',
            size: 1,
            dataVolumes: [2],
            parityVolumes: [],
            chunkSize: 1,
            dataSliceVolumeIds: [2],
            paritySliceVolumeIds: [],
            unavailableSlices: [],
            damagedSlices: [],
            isFile: true,
            name: 'fileB',
            md5: null
        };

        deps.runtimeConfig.get.mockResolvedValueOnce(null);
        deps.database.findObjectsNeedingVerification
            .mockResolvedValueOnce([recordA, recordB])
            .mockResolvedValueOnce([]);

        const verifierSpies: Array<ReturnType<typeof vi.fn>> = [];
        deps.fileObjectService.load.mockResolvedValue({} as any);
        deps.createSliceVerifier.mockImplementation(() => {
            const fn = vi.fn().mockResolvedValue(undefined);
            verifierSpies.push(fn);
            return { verifySlice: fn };
        });

        const job = new VerifyVolumesJob(deps);
        const { startedAt } = await job.start();
        const running = (job as unknown as { running: Promise<void> | null }).running;
        if (running)
            await running;

        expect(deps.fileObjectService.load).toHaveBeenCalledTimes(2);
        expect(deps.fileObjectService.load).toHaveBeenNthCalledWith(1, recordA, {
            requestId: 'verify:1',
            priority: 'low'
        });
        const secondCallOptions = deps.fileObjectService.load.mock.calls[1]?.[1];
        expect(secondCallOptions).toEqual(expect.objectContaining({
            requestId: expect.stringMatching(/^verify:\d+$/),
            priority: 'low'
        }));
        expect(verifierSpies).toHaveLength(2);
        expect(verifierSpies[0]).toHaveBeenCalledWith(0);
        expect(verifierSpies[1]).toHaveBeenCalledWith(0);
        expect(deps.database.updateObjectVerificationState).toHaveBeenCalledWith(recordA.id, {
            lastVerifiedAt: new Date(startedAt),
            sliceErrors: null,
            sliceVerificationTimes: times(startedAt, [true])
        });
        expect(deps.database.updateObjectVerificationState).toHaveBeenCalledWith(recordB.id, {
            lastVerifiedAt: new Date(startedAt),
            sliceErrors: null,
            sliceVerificationTimes: times(startedAt, [true])
        });
    });

    it('records checksum failures and per-volume counts', async () => {
        const deps = createDeps();
        const record = {
            id: 'def',
            size: 1,
            dataVolumes: [1],
            parityVolumes: [],
            chunkSize: 1,
            dataSliceVolumeIds: [1],
            paritySliceVolumeIds: [],
            unavailableSlices: [],
            damagedSlices: [],
            isFile: true,
            name: 'file2',
            md5: null
        };

        deps.runtimeConfig.get.mockResolvedValueOnce(null);
        deps.database.findObjectsNeedingVerification
            .mockResolvedValueOnce([record])
            .mockResolvedValueOnce([]);

        const checksumError = Object.assign(new Error('checksum mismatch'), {
            code: 'ECHECKSUM',
            sliceIndex: 0,
            volumeId: 1
        });
        const sliceVerifier = {
            verifySlice: vi.fn().mockRejectedValue(checksumError)
        };
        deps.fileObjectService.load.mockResolvedValue({} as any);
        deps.createSliceVerifier.mockReturnValue(sliceVerifier);

        const job = new VerifyVolumesJob(deps);
        const startPromise = job.start();
        const { startedAt } = await startPromise;
        const running = (job as unknown as { running: Promise<void> | null }).running;
        if (running)
            await running;

        expect(sliceVerifier.verifySlice).toHaveBeenCalledTimes(1);
        expect(deps.database.updateObjectVerificationState).toHaveBeenCalledWith(record.id, {
            lastVerifiedAt: new Date(startedAt),
            sliceErrors: { '0': { code: 'ECHECKSUM', category: 'checksum', checksum: true, type: 'data' } },
            sliceVerificationTimes: times(startedAt, [true])
        });
        expect(deps.database.setVolumeVerifyErrors).toHaveBeenCalledTimes(3);
        expect(deps.database.setVolumeVerifyErrors).toHaveBeenNthCalledWith(1, 1, { checksum: 0, total: 0 });
        expect(deps.database.setVolumeVerifyErrors).toHaveBeenNthCalledWith(2, 2, { checksum: 0, total: 0 });
        expect(deps.database.setVolumeVerifyErrors).toHaveBeenNthCalledWith(3, 1, { checksum: 1, total: 1 });
        expect(deps.runtimeConfig.set).toHaveBeenCalledWith('lastVerify', expect.objectContaining({
            checksumErrors: 1,
            totalErrors: 1
        }));
    });

    it('reports detected slice faults to the remediation pipeline', async () => {
        const deps = createDeps();
        const record = {
            id: 'fault-obj',
            size: 1,
            dataVolumes: [1],
            parityVolumes: [],
            chunkSize: 1,
            dataSliceVolumeIds: [1],
            paritySliceVolumeIds: [],
            unavailableSlices: [],
            damagedSlices: [],
            isFile: true,
            name: 'file',
            md5: null
        };

        deps.runtimeConfig.get.mockResolvedValueOnce(null);
        deps.database.findObjectsNeedingVerification
            .mockResolvedValueOnce([record])
            .mockResolvedValueOnce([]);

        const checksumError = Object.assign(new Error('checksum mismatch'), {
            code: 'ECHECKSUM',
            sliceIndex: 0,
            volumeId: 1
        });
        deps.fileObjectService.load.mockResolvedValue({} as any);
        deps.createSliceVerifier.mockReturnValue({ verifySlice: vi.fn().mockRejectedValue(checksumError) });

        const job = new VerifyVolumesJob(deps);
        await job.start();
        const running = (job as unknown as { running: Promise<void> | null }).running;
        if (running)
            await running;

        expect(deps.remediationService.reportSliceFault).toHaveBeenCalledTimes(1);
        expect(deps.remediationService.reportSliceFault).toHaveBeenCalledWith(expect.objectContaining({
            objectId: 'fault-obj',
            sliceIndex: 0,
            volumeId: 1,
            source: 'verify',
            code: 'ECHECKSUM',
            isChecksum: true
        }));
    });

    it('continues verifying remaining slices and parity volumes', async () => {
        const deps = createDeps();
        const record = {
            id: 'ghi',
            size: 1,
            dataVolumes: [1],
            parityVolumes: [2],
            chunkSize: 1,
            dataSliceVolumeIds: [1],
            paritySliceVolumeIds: [2],
            unavailableSlices: [],
            damagedSlices: [],
            isFile: true,
            name: 'file3',
            md5: null
        };

        deps.runtimeConfig.get.mockResolvedValueOnce(null);
        deps.database.findObjectsNeedingVerification
            .mockResolvedValueOnce([record])
            .mockResolvedValueOnce([]);

        const verifySlice = vi.fn(async (sliceIndex: number) => {
            if (sliceIndex === 0)
                throw Object.assign(new Error('data failed'), { sliceIndex });
            if (sliceIndex === 1)
                throw Object.assign(new Error('parity failed'), { sliceIndex });
        });
        deps.fileObjectService.load.mockResolvedValue({} as any);
        deps.createSliceVerifier.mockReturnValue({ verifySlice });

        const job = new VerifyVolumesJob(deps);
        const startPromise = job.start();
        const { startedAt } = await startPromise;
        const running = (job as unknown as { running: Promise<void> | null }).running;
        if (running)
            await running;

        expect(verifySlice).toHaveBeenCalledTimes(2);
        expect(verifySlice).toHaveBeenNthCalledWith(1, 0);
        expect(verifySlice).toHaveBeenNthCalledWith(2, 1);

        expect(deps.database.updateObjectVerificationState).toHaveBeenCalledWith(record.id, {
            lastVerifiedAt: new Date(startedAt),
            sliceErrors: {
                '0': { category: 'unknown', err: 'data failed', type: 'data' },
                '1': { category: 'unknown', err: 'parity failed', type: 'parity' }
            },
            sliceVerificationTimes: times(startedAt, [true], [true])
        });

        expect(deps.database.setVolumeVerifyErrors).toHaveBeenCalledTimes(4);
        expect(deps.database.setVolumeVerifyErrors).toHaveBeenNthCalledWith(1, 1, { checksum: 0, total: 0 });
        expect(deps.database.setVolumeVerifyErrors).toHaveBeenNthCalledWith(2, 2, { checksum: 0, total: 0 });
        expect(deps.database.setVolumeVerifyErrors).toHaveBeenNthCalledWith(3, 1, { checksum: 0, total: 1 });
        expect(deps.database.setVolumeVerifyErrors).toHaveBeenNthCalledWith(4, 2, { checksum: 0, total: 1 });

        expect(deps.runtimeConfig.set).toHaveBeenCalledWith('lastVerify', expect.objectContaining({
            checksumErrors: 0,
            totalErrors: 2
        }));
    });

    it('defers verification state when IO shutdown aborts verification', async () => {
        const deps = createDeps();
        const record = {
            id: 'jkl',
            size: 1,
            dataVolumes: [1],
            parityVolumes: [],
            chunkSize: 1,
            dataSliceVolumeIds: [1],
            paritySliceVolumeIds: [],
            unavailableSlices: [],
            damagedSlices: [],
            isFile: true,
            name: 'file4',
            md5: null
        };

        deps.runtimeConfig.get.mockResolvedValueOnce(null);
        deps.database.findObjectsNeedingVerification
            .mockResolvedValueOnce([record])
            .mockResolvedValueOnce([]);

        const ioAbortError = Object.assign(new Error('IO abort'), { code: 'IOABORT' });
        const sliceVerifier = { verifySlice: vi.fn().mockRejectedValue(ioAbortError) };
        deps.fileObjectService.load.mockResolvedValue({} as any);
        deps.createSliceVerifier.mockReturnValue(sliceVerifier);

        const job = new VerifyVolumesJob(deps);
        const { startedAt } = await job.start();
        const running = (job as unknown as { running: Promise<void> | null }).running;
        if (running)
            await running;

        expect(sliceVerifier.verifySlice).toHaveBeenCalledTimes(1);
        expect(deps.database.updateObjectVerificationState).not.toHaveBeenCalled();
        expect(deps.runtimeConfig.set).toHaveBeenCalledTimes(1);
        expect(deps.runtimeConfig.set).toHaveBeenCalledWith('verifyStartedAt', startedAt);
        const deleteKeys = deps.runtimeConfig.delete.mock.calls.map(call => call[0]);
        expect(deleteKeys).not.toContain('verifyStartedAt');
        expect(deleteKeys).toContain('verifyVolumeIds');
    });

    it('preserves pending resume state when fetching a batch fails', async () => {
        const deps = createDeps();
        const fetchFailure = new Error('database unavailable');

        deps.runtimeConfig.get.mockResolvedValueOnce(null);
        deps.database.findObjectsNeedingVerification.mockRejectedValueOnce(fetchFailure);

        const job = new VerifyVolumesJob(deps);
        const { startedAt } = await job.start();
        const running = (job as unknown as { running: Promise<void> | null }).running;
        if (running)
            await running;

        expect(deps.runtimeConfig.set).toHaveBeenCalledWith('verifyStartedAt', startedAt);
        expect(deps.runtimeConfig.set).not.toHaveBeenCalledWith('lastVerify', expect.anything());
        const deleteKeys = deps.runtimeConfig.delete.mock.calls.map(call => call[0]);
        expect(deleteKeys).not.toContain('verifyStartedAt');
    });

    it('preserves pending resume state when a verification task fails outside object verification', async () => {
        const deps = createDeps();
        const record = {
            id: 'counter-fail',
            size: 1,
            dataVolumes: [1],
            parityVolumes: [],
            chunkSize: 1,
            dataSliceVolumeIds: [1],
            paritySliceVolumeIds: [],
            unavailableSlices: [],
            damagedSlices: [],
            isFile: true,
            name: 'file',
            md5: null
        };

        deps.runtimeConfig.get.mockResolvedValueOnce(null);
        deps.database.findObjectsNeedingVerification
            .mockResolvedValueOnce([record])
            .mockResolvedValueOnce([]);
        deps.database.setVolumeVerifyErrors
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('counter write failed'));

        const checksumError = Object.assign(new Error('checksum mismatch'), {
            code: 'ECHECKSUM',
            sliceIndex: 0,
            volumeId: 1
        });
        deps.fileObjectService.load.mockResolvedValue({} as any);
        deps.createSliceVerifier.mockReturnValue({ verifySlice: vi.fn().mockRejectedValue(checksumError) });

        const job = new VerifyVolumesJob(deps);
        const { startedAt } = await job.start();
        const running = (job as unknown as { running: Promise<void> | null }).running;
        if (running)
            await running;

        expect(deps.database.updateObjectVerificationState).toHaveBeenCalledWith(record.id, {
            lastVerifiedAt: new Date(startedAt),
            sliceErrors: { '0': { code: 'ECHECKSUM', category: 'checksum', checksum: true, type: 'data' } },
            sliceVerificationTimes: times(startedAt, [true])
        });
        expect(deps.runtimeConfig.set).toHaveBeenCalledWith('verifyStartedAt', startedAt);
        expect(deps.runtimeConfig.set).not.toHaveBeenCalledWith('lastVerify', expect.anything());
        const deleteKeys = deps.runtimeConfig.delete.mock.calls.map(call => call[0]);
        expect(deleteKeys).not.toContain('verifyStartedAt');
    });

    it('cleans up pending resume state when the job is stopped', async () => {
        const deps = createDeps();
        deps.runtimeConfig.get.mockResolvedValueOnce(null);

        let releaseBatch: (() => void) | null = null;
        let batchReadyResolve: (() => void) | null = null;
        const batchReady = new Promise<void>(resolve => {
            batchReadyResolve = resolve;
        });
        deps.database.findObjectsNeedingVerification.mockImplementationOnce(() => new Promise(resolve => {
            releaseBatch = () => resolve([]);
            batchReadyResolve?.();
        }));
        deps.database.findObjectsNeedingVerification.mockResolvedValue([]);

        const job = new VerifyVolumesJob(deps);
        await job.start();
        await batchReady;

        const stopPromise = job.stop();
        releaseBatch?.();
        await stopPromise;

        expect(deps.runtimeConfig.delete.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(['verifyStartedAt', 'verifyVolumeIds', 'verifyCursorId']));
    });

    it('restores progress when resuming a pending job', async () => {
        const deps = createDeps();
        const startedAt = '2024-02-01T00:00:00.000Z';
        deps.runtimeConfig.get
            .mockResolvedValueOnce(startedAt)
            .mockResolvedValueOnce([2])
            .mockResolvedValueOnce('cursor-1');
        deps.database.countObjectsVerifiedSince.mockResolvedValueOnce(42);
        deps.database.findObjectsNeedingVerification.mockResolvedValue([]);

        const job = new VerifyVolumesJob(deps);
        await job.start();
        const running = (job as unknown as { running: Promise<void> | null }).running;
        if (running)
            await running;

        expect(deps.database.countObjectsVerifiedSince).toHaveBeenCalledWith(new Date(startedAt), [2]);
        expect(job.getStatus().objectsVerified).toBe(42);
    });

    it('limits verification to the specified volume ids', async () => {
        const deps = createDeps();
        const record = {
            id: 'vol-filter',
            size: 1,
            dataVolumes: [1, 2],
            parityVolumes: [2],
            chunkSize: 1,
            dataSliceVolumeIds: [1, 2],
            paritySliceVolumeIds: [3],
            unavailableSlices: [],
            damagedSlices: [],
            isFile: true,
            name: 'file',
            md5: null
        };

        deps.runtimeConfig.get.mockResolvedValueOnce(null);
        deps.database.findObjectsOnVolumesNeedingVerification
            .mockResolvedValueOnce([record])
            .mockResolvedValueOnce([]);

        deps.fileObjectService.load.mockResolvedValue({} as any);
        const verifySlice = vi.fn().mockResolvedValue(undefined);
        deps.createSliceVerifier.mockReturnValue({ verifySlice });

        const job = new VerifyVolumesJob(deps);
        const { startedAt } = await job.start({ volumeIds: [2, 2] });
        const running = (job as unknown as { running: Promise<void> | null }).running;
        if (running)
            await running;

        expect(verifySlice).toHaveBeenCalledTimes(2);
        expect(verifySlice).toHaveBeenNthCalledWith(1, 1);
        expect(verifySlice).toHaveBeenNthCalledWith(2, 2);
        // Targeted runs stamp only the matching slices, so the whole-object
        // watermark cannot advance until every slice has a verification time.
        expect(deps.database.updateObjectVerificationState).toHaveBeenCalledWith(record.id, {
            sliceErrors: null,
            sliceVerificationTimes: times(startedAt, [false, true], [true])
        });
        expect(deps.database.updateObjectVerificationState).not.toHaveBeenCalledWith(record.id, expect.objectContaining({
            lastVerifiedAt: expect.anything()
        }));
        expect(deps.database.findObjectsOnVolumesNeedingVerification).toHaveBeenNthCalledWith(1, new Date(startedAt), 25, [2], null);
        expect(deps.database.findObjectsOnVolumesNeedingVerification).toHaveBeenNthCalledWith(2, new Date(startedAt), 25, [2], record.id);
        expect(deps.database.findObjectsNeedingVerification).not.toHaveBeenCalled();
        expect(deps.database.setVolumeVerifyErrors).toHaveBeenCalledTimes(1);
        expect(deps.database.setVolumeVerifyErrors).toHaveBeenNthCalledWith(1, 2, { checksum: 0, total: 0 });
        expect(deps.runtimeConfig.set).toHaveBeenNthCalledWith(1, 'verifyVolumeIds', [2]);
        expect(deps.runtimeConfig.set).toHaveBeenNthCalledWith(2, 'verifyStartedAt', startedAt);
        expect(deps.runtimeConfig.set).toHaveBeenCalledWith('verifyCursorId', record.id);
        expect(deps.runtimeConfig.set).not.toHaveBeenCalledWith('lastVerify', expect.anything());
        expect(deps.runtimeConfig.delete.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(['verifyStartedAt', 'verifyVolumeIds', 'verifyCursorId']));
    });

    it('preserves unrelated slice errors during targeted verification', async () => {
        const deps = createDeps();
        const existingError = { err: 'existing failure on another volume', type: 'data' as const };
        const record = {
            id: 'target-preserve',
            size: 1,
            dataVolumes: [1, 2],
            parityVolumes: [3],
            chunkSize: 1,
            dataSliceVolumeIds: [1, 2],
            paritySliceVolumeIds: [3],
            unavailableSlices: [],
            damagedSlices: [],
            sliceErrors: {
                '0': existingError,
                '1': { err: 'old error on target volume', type: 'data' as const }
            },
            isFile: true,
            name: 'file',
            md5: null
        };

        deps.runtimeConfig.get.mockResolvedValueOnce(null);
        deps.database.findObjectsOnVolumesNeedingVerification
            .mockResolvedValueOnce([record])
            .mockResolvedValueOnce([]);

        deps.fileObjectService.load.mockResolvedValue({} as any);
        deps.createSliceVerifier.mockReturnValue({ verifySlice: vi.fn().mockResolvedValue(undefined) });

        const job = new VerifyVolumesJob(deps);
        const { startedAt } = await job.start({ volumeIds: [2] });
        const running = (job as unknown as { running: Promise<void> | null }).running;
        if (running)
            await running;

        expect(deps.database.updateObjectVerificationState).toHaveBeenCalledWith(record.id, {
            sliceErrors: { '0': existingError },
            sliceVerificationTimes: times(startedAt, [false, true], [false])
        });
    });

    it('reports full mode by default', () => {
        const job = new VerifyVolumesJob(createDeps());
        expect(job.getStatus().mode).toBe('full');
    });

    it('threads light mode to the slice verifier and persists/reports it', async () => {
        const deps = createDeps();
        const record = {
            id: 'light-obj',
            size: 1,
            dataVolumes: [1],
            parityVolumes: [],
            chunkSize: 1,
            dataSliceVolumeIds: [1],
            paritySliceVolumeIds: [],
            unavailableSlices: [],
            damagedSlices: [],
            isFile: true,
            name: 'file',
            md5: null
        };

        deps.runtimeConfig.get.mockResolvedValueOnce(null);
        deps.database.findObjectsNeedingVerification
            .mockResolvedValueOnce([record])
            .mockResolvedValueOnce([]);
        deps.fileObjectService.load.mockResolvedValue({} as any);
        const sliceVerifier = { verifySlice: vi.fn().mockResolvedValue(undefined) };
        deps.createSliceVerifier.mockReturnValue(sliceVerifier);

        const job = new VerifyVolumesJob(deps);
        await job.start({ mode: 'light' });
        expect(job.getStatus().mode).toBe('light');
        const running = (job as unknown as { running: Promise<void> | null }).running;
        if (running)
            await running;

        const loadedObject = await deps.fileObjectService.load.mock.results[0]?.value;
        expect(deps.createSliceVerifier).toHaveBeenCalledWith(loadedObject, 'light');
        expect(deps.runtimeConfig.set).toHaveBeenCalledWith('verifyMode', 'light');
    });

    it('restores the persisted mode when resuming a pending job', async () => {
        const deps = createDeps();
        const startedAt = '2024-02-01T00:00:00.000Z';
        deps.runtimeConfig.get
            .mockResolvedValueOnce(startedAt)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce('light');
        deps.database.countObjectsVerifiedSince.mockResolvedValueOnce(0);
        deps.database.findObjectsNeedingVerification.mockResolvedValue([]);

        const job = new VerifyVolumesJob(deps);
        await job.start();
        expect(job.getStatus().mode).toBe('light');
        const running = (job as unknown as { running: Promise<void> | null }).running;
        if (running)
            await running;
    });

    it('reports current concurrency via status', async () => {
        const deps = createDeps();
        deps.runtimeConfig.get.mockResolvedValueOnce(null);

        const volumeStub1 = { setVerifyErrors: vi.fn(), verifyErrors: { checksum: 0, total: 0 }, isEnabled: true, isDeleted: false };
        const volumeStub2 = { setVerifyErrors: vi.fn(), verifyErrors: { checksum: 0, total: 0 }, isEnabled: true, isDeleted: false };
        deps.ioManager.getVolumeEntries.mockReturnValue([[1, volumeStub1], [2, volumeStub2]]);
        deps.ioManager.getVolume.mockImplementation((id: number) => (id === 1 ? volumeStub1 : volumeStub2));

        let releaseBatch: (() => void) | null = null;
        let batchReadyResolve: (() => void) | null = null;
        const batchReady = new Promise<void>(resolve => {
            batchReadyResolve = resolve;
        });
        deps.database.findObjectsNeedingVerification.mockImplementationOnce(() => new Promise(resolve => {
            releaseBatch = () => resolve([]);
            batchReadyResolve?.();
        }));
        deps.database.findObjectsNeedingVerification.mockResolvedValue([]);

        const job = new VerifyVolumesJob(deps);
        await job.start();
        await batchReady;

        expect(job.getStatus().concurrency).toBe(2);

        releaseBatch?.();
        const running = (job as unknown as { running: Promise<void> | null }).running;
        if (running)
            await running;

        expect(job.getStatus().concurrency).toBe(0);
    });
});
