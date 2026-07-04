import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VerifyFileJob } from '../lib/jobs/verify-file-job';
import type { StoredObjectRecord } from '../lib/io/file-object';
import type { FileObject } from '../lib/io/file-object';
import type { Logger } from '../lib/log';

const { fileObjectService: fileObjectServiceMock } = vi.hoisted(() => ({
    fileObjectService: {
        load: vi.fn()
    }
})) as { fileObjectService: { load: ReturnType<typeof vi.fn> } };

const databaseMock = {
    getObjectById: vi.fn(),
    updateObjectVerificationState: vi.fn()
};

vi.mock('../lib/io/file-object/service', () => ({
    fileObjectService: fileObjectServiceMock
}));

vi.mock('../lib/io/file-object/slice-verifier', () => ({
    FileObjectSliceVerifier: class {}
}));

type DatabaseType = typeof import('../lib/database').database;
type FileObjectServiceType = typeof import('../lib/io/file-object/service').fileObjectService;
type CreateLogger = (subject: string) => Logger;
type SliceVerifierFactory = (object: FileObject) => { verifySlice: (sliceIndex: number) => Promise<void> };

const createSliceVerifierMock = vi.fn();
const verifySliceMock = vi.fn();
const verifyObjectParityMock = vi.fn();
const reportParityFaultMock = vi.fn();

// Full deps for a job that has parity checking ENABLED with a mocked recompute (the real one loads the
// native RS binding, which vitest can't). Callers override verifyObjectParity per test.
const parityDeps = () => ({
    createLogger: createNoopLogger,
    verifyParity: true,
    verifyObjectParity: verifyObjectParityMock,
    reportParityFault: reportParityFaultMock
});

const createNoopLogger: CreateLogger = (_subject: string) => {
    const logger = ((..._args: unknown[]) => undefined) as Logger;
    logger.error = () => undefined;
    return logger;
};

describe('VerifyFileJob', () => {
    let job: VerifyFileJob;

    beforeEach(() => {
        vi.clearAllMocks();
        databaseMock.getObjectById.mockReset();
        databaseMock.updateObjectVerificationState.mockReset();
        fileObjectServiceMock.load.mockReset();
        verifySliceMock.mockReset();
        createSliceVerifierMock.mockReset();
        createSliceVerifierMock.mockImplementation(() => ({ verifySlice: verifySliceMock }));
        verifyObjectParityMock.mockReset();
        verifyObjectParityMock.mockResolvedValue([]); // no foreign parity by default
        reportParityFaultMock.mockReset();
        job = new VerifyFileJob({
            database: databaseMock as unknown as DatabaseType,
            fileObjectService: fileObjectServiceMock as unknown as FileObjectServiceType,
            createSliceVerifier: createSliceVerifierMock as unknown as SliceVerifierFactory,
            isVolumeDraining: () => false,
            ...parityDeps()
        });
    });

    const createRecord = (): StoredObjectRecord => ({
        id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        containerId: null,
        name: 'file',
        isFile: true,
        size: 10,
        md5: null,
        mime: null,
        chunkSize: 1024,
        dataVolumes: [1, 2],
        parityVolumes: [3]
    });

    it('verifies all slices and clears previous errors', async () => {
        const record = createRecord();
        databaseMock.getObjectById.mockResolvedValue(record);
        fileObjectServiceMock.load.mockResolvedValue({} as FileObject);
        verifySliceMock.mockResolvedValue(undefined);

        const result = await job.verify(record.id);

        expect(result).toEqual({
            '0': { ok: true, type: 'data', volumeId: 1 },
            '1': { ok: true, type: 'data', volumeId: 2 },
            '2': { ok: true, type: 'parity', volumeId: 3 }
        });
        expect(databaseMock.updateObjectVerificationState).toHaveBeenCalledTimes(1);
        expect(databaseMock.updateObjectVerificationState).toHaveBeenCalledWith(record.id, expect.objectContaining({
            lastVerifiedAt: expect.any(Date),
            sliceErrors: null,
            sliceVerificationTimes: {
                data: [expect.any(Date), expect.any(Date)],
                parity: [expect.any(Date)]
            }
        }));
        expect(createSliceVerifierMock).toHaveBeenCalledTimes(3);
        expect(verifyObjectParityMock).toHaveBeenCalledTimes(1); // parity verified when data is clean
    });

    it('flags and faults a foreign parity slice detected by recompute-and-compare', async () => {
        const record = createRecord(); // data [1,2], parity [3] -> parity slice index 2 on vol 3
        databaseMock.getObjectById.mockResolvedValue(record);
        fileObjectServiceMock.load.mockResolvedValue({} as FileObject);
        verifySliceMock.mockResolvedValue(undefined);       // all slices pass per-chunk checks
        verifyObjectParityMock.mockResolvedValue([2]);      // ...but parity slice 2 is FOREIGN

        const result = await job.verify(record.id);

        expect(result['2']).toEqual({ ok: false, type: 'parity', volumeId: 3, error: 'parity-mismatch' });
        expect(reportParityFaultMock).toHaveBeenCalledWith({ objectId: record.id, sliceIndex: 2, volumeId: 3 });
        expect(databaseMock.updateObjectVerificationState).toHaveBeenCalledWith(record.id, expect.objectContaining({
            sliceErrors: expect.objectContaining({ '2': expect.objectContaining({ code: 'EPARITY', category: 'parity-mismatch', type: 'parity' }) })
        }));
    });

    it('does NOT run parity verification when a data slice already errored', async () => {
        const record = createRecord();
        databaseMock.getObjectById.mockResolvedValue(record);
        fileObjectServiceMock.load.mockResolvedValue({} as FileObject);
        verifySliceMock.mockRejectedValueOnce(Object.assign(new Error('bad'), { code: 'ECHECKSUM' })).mockResolvedValue(undefined);

        await job.verify(record.id);
        expect(verifyObjectParityMock).not.toHaveBeenCalled(); // recomputing parity needs good data
    });

    it('does NOT run parity verification when disabled', async () => {
        const noParity = new VerifyFileJob({
            database: databaseMock as unknown as DatabaseType,
            fileObjectService: fileObjectServiceMock as unknown as FileObjectServiceType,
            createSliceVerifier: createSliceVerifierMock as unknown as SliceVerifierFactory,
            isVolumeDraining: () => false,
            ...parityDeps(),
            verifyParity: false
        });
        databaseMock.getObjectById.mockResolvedValue(createRecord());
        fileObjectServiceMock.load.mockResolvedValue({} as FileObject);
        verifySliceMock.mockResolvedValue(undefined);

        await noParity.verify('aaaaaaaaaaaaaaaaaaaaaaaa');
        expect(verifyObjectParityMock).not.toHaveBeenCalled();
    });

    it('does NOT run parity verification in light mode', async () => {
        const record = createRecord();
        databaseMock.getObjectById.mockResolvedValue(record);
        fileObjectServiceMock.load.mockResolvedValue({} as FileObject);
        verifySliceMock.mockResolvedValue(undefined);

        await job.verify(record.id, { mode: 'light' });
        expect(verifyObjectParityMock).not.toHaveBeenCalled();
    });

    it('skips slices on an draining volume (the drain job is relocating them)', async () => {
        const record = createRecord(); // dataVolumes [1,2], parityVolumes [3]
        databaseMock.getObjectById.mockResolvedValue(record);
        fileObjectServiceMock.load.mockResolvedValue({} as FileObject);
        verifySliceMock.mockResolvedValue(undefined);
        const drainJob = new VerifyFileJob({
            database: databaseMock as unknown as DatabaseType,
            fileObjectService: fileObjectServiceMock as unknown as FileObjectServiceType,
            createSliceVerifier: createSliceVerifierMock as unknown as SliceVerifierFactory,
            isVolumeDraining: (volumeId) => volumeId === 2, // slice index 1 lives on volume 2
            ...parityDeps()
        });

        const result = await drainJob.verify(record.id);

        // The draining-volume slice is not read, but is marked verified-now (so the object doesn't churn
        // in the scrub queue) — it never goes through the slice verifier.
        expect(result['1']).toEqual({ ok: true, type: 'data', volumeId: 2 });
        expect(result['0']).toBeDefined();
        expect(result['2']).toBeDefined();
        expect(createSliceVerifierMock).toHaveBeenCalledTimes(2);
        // its verification time advanced (included in the state update's verified slices)
        expect(databaseMock.updateObjectVerificationState).toHaveBeenCalledWith(record.id, expect.objectContaining({
            sliceVerificationTimes: { data: [expect.any(Date), expect.any(Date)], parity: [expect.any(Date)] }
        }));
    });

    it('records slice errors when verification fails', async () => {
        const record = createRecord();
        databaseMock.getObjectById.mockResolvedValue(record);
        fileObjectServiceMock.load.mockResolvedValue({} as FileObject);
        verifySliceMock.mockImplementation(async (sliceIndex: number) => {
            if (sliceIndex === 1) {
                const err = Object.assign(new Error('checksum mismatch'), { code: 'ECHECKSUM', sliceIndex });
                throw err;
            }
        });

        const result = await job.verify(record.id);

        expect(result['1']).toEqual({
            ok: false,
            type: 'data',
            volumeId: 2,
            checksum: true,
            error: 'checksum mismatch'
        });
        expect(result['0']).toEqual({ ok: true, type: 'data', volumeId: 1 });
        expect(result['2']).toEqual({ ok: true, type: 'parity', volumeId: 3 });
        expect(databaseMock.updateObjectVerificationState).toHaveBeenCalledWith(record.id, expect.objectContaining({
            lastVerifiedAt: expect.any(Date),
            sliceErrors: {
                '1': { code: 'ECHECKSUM', category: 'checksum', checksum: true, type: 'data' }
            },
            sliceVerificationTimes: {
                data: [expect.any(Date), expect.any(Date)],
                parity: [expect.any(Date)]
            }
        }));
        expect(createSliceVerifierMock).toHaveBeenCalledTimes(3);
    });

    it('threads the requested mode to the slice verifier (light)', async () => {
        const record = createRecord();
        databaseMock.getObjectById.mockResolvedValue(record);
        const loadedObject = {} as FileObject;
        fileObjectServiceMock.load.mockResolvedValue(loadedObject);
        verifySliceMock.mockResolvedValue(undefined);

        await job.verify(record.id, { mode: 'light' });

        expect(createSliceVerifierMock).toHaveBeenCalledTimes(3);
        for (const call of createSliceVerifierMock.mock.calls)
            expect(call).toEqual([loadedObject, 'light']);
    });

    it('defaults to full mode when none is given', async () => {
        const record = createRecord();
        databaseMock.getObjectById.mockResolvedValue(record);
        fileObjectServiceMock.load.mockResolvedValue({} as FileObject);
        verifySliceMock.mockResolvedValue(undefined);

        await job.verify(record.id);

        for (const call of createSliceVerifierMock.mock.calls)
            expect(call[1]).toBe('full');
    });

    it('throws when the object is not a file', async () => {
        databaseMock.getObjectById.mockResolvedValue({ id: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: 'folder', isContainer: true });
        await expect(job.verify('bbbbbbbbbbbbbbbbbbbbbbbb')).rejects.toMatchObject({ code: 'ENOTFILE' });
        expect(databaseMock.updateObjectVerificationState).not.toHaveBeenCalled();
        expect(createSliceVerifierMock).not.toHaveBeenCalled();
    });
});
