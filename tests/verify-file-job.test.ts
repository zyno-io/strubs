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
        job = new VerifyFileJob({
            database: databaseMock as unknown as DatabaseType,
            fileObjectService: fileObjectServiceMock as unknown as FileObjectServiceType,
            createSliceVerifier: createSliceVerifierMock as unknown as SliceVerifierFactory,
            createLogger: createNoopLogger
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
