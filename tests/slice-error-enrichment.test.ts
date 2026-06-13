import { describe, expect, it, vi } from 'vitest';

import { constants } from '../lib/constants';

// Slice pulls in the io manager / priority manager / shutdown singletons at
// import time; stub them so we can exercise the real read path in isolation.
const fakeRead = vi.fn();
const fakeClose = vi.fn().mockResolvedValue(undefined);
const fakeFh = { read: fakeRead, close: fakeClose };
const fakeVolume = {
    isReadable: true,
    openCommittedFh: vi.fn().mockResolvedValue(fakeFh)
};

vi.mock('../lib/io/manager', () => ({
    ioManager: {
        getVolume: vi.fn(() => fakeVolume)
    }
}));

vi.mock('../lib/io/volume-priority-manager', () => ({
    volumePriorityManager: {
        registerHandle: vi.fn(() => () => undefined),
        waitForAccess: vi.fn(() => undefined)
    }
}));

vi.mock('../lib/io/io-shutdown', () => ({
    ioShutdown: {
        throwIfAborted: vi.fn(),
        isAborted: vi.fn(() => false)
    }
}));

import { Slice } from '../lib/io/file-object/slice';

const OBJECT_ID = '6a2d8fec3b1e7a006700ab60';

const buildFileObject = () => ({
    id: OBJECT_ID,
    idBuf: Buffer.alloc(12),
    dataSliceCount: 4,
    paritySliceCount: 2,
    dataSliceVolumeIds: [10, 11, 12, 13],
    paritySliceVolumeIds: [14, 15],
    chunkSize: 4096,
    plan: { sliceSize: 1024 },
    unavailableSliceIdxs: [] as number[],
    hasVolumeReservations: () => false,
    getPriority: () => 'low',
    getLoggerPrefix: () => 'obj'
}) as any;

const ioClass = { _chunkDataSize: 16, _startChunkDataSize: 16, _standardChunkDataSize: 16 } as any;

// Writes a header into the buffer that satisfies Slice._validateHeader for the
// given object/slice, so open() succeeds and we can exercise the chunk-read path.
const headerReadFor = (fileObject: any, sliceIndex: number) =>
    async (buffer: Buffer) => {
        fileObject.idBuf.copy(buffer, 23, 0, 12);
        buffer.writeUInt8(fileObject.dataSliceCount, 40);
        buffer.writeUInt8(fileObject.paritySliceCount, 41);
        buffer.writeUInt8(sliceIndex, 42);
        buffer.writeIntLE(fileObject.chunkSize, 43, 3);
        return { bytesRead: constants.FILE_HEADER_SIZE };
    };

describe('Slice error enrichment', () => {
    it('decorates a raw chunk read error with object/slice/volume context', async () => {
        fakeRead.mockReset();
        const fileObject = buildFileObject();
        // First read (slice header during open) succeeds; second read (chunk) fails
        // with a bare error, simulating an unreadable sector with no code.
        fakeRead
            .mockImplementationOnce(headerReadFor(fileObject, 0))
            .mockRejectedValueOnce(new Error('Remote I/O error'));

        const slice = new Slice(fileObject, ioClass, 0);
        await slice.open();

        const err = await slice.readChunk().then(
            () => { throw new Error('expected readChunk to reject'); },
            (e: any) => e
        );

        expect(err.objectId).toBe(OBJECT_ID);
        expect(err.sliceIndex).toBe(0);
        expect(err.volumeId).toBe(10);
        expect(err.fileName).toBe(`${OBJECT_ID}.0`);
        expect(err.code).toBe('EIO');
    });

    it('preserves an existing error code while still attaching attribution', async () => {
        fakeRead.mockReset();
        const fileObject = buildFileObject();
        const coded = Object.assign(new Error('input/output error'), { code: 'EIO_NATIVE' });
        fakeRead
            .mockImplementationOnce(headerReadFor(fileObject, 2))
            .mockRejectedValueOnce(coded);

        const slice = new Slice(fileObject, ioClass, 2);
        await slice.open();

        const err = await slice.readChunk().then(
            () => { throw new Error('expected readChunk to reject'); },
            (e: any) => e
        );

        expect(err.code).toBe('EIO_NATIVE');
        expect(err.objectId).toBe(OBJECT_ID);
        expect(err.sliceIndex).toBe(2);
        expect(err.volumeId).toBe(12);
    });

    it('rejects opening a slice whose header is for a different slice index', async () => {
        fakeRead.mockReset();
        const fileObject = buildFileObject();
        // Header claims slice index 5 but this Slice is index 0 -> reject.
        fakeRead.mockImplementationOnce(headerReadFor(fileObject, 5));

        const slice = new Slice(fileObject, ioClass, 0);
        const err = await slice.open().then(
            () => { throw new Error('expected open to reject'); },
            (e: any) => e
        );
        expect(err.code).toBe('EOPEN');
        expect(String(err.cause ?? err)).toContain('slice index mismatch');
    });

    it('treats a short chunk read as an I/O error rather than returning stale bytes', async () => {
        fakeRead.mockReset();
        const fileObject = buildFileObject();
        fakeRead
            .mockImplementationOnce(headerReadFor(fileObject, 0))
            .mockResolvedValueOnce({ bytesRead: 1 }); // fewer bytes than requested

        const slice = new Slice(fileObject, ioClass, 0);
        await slice.open();
        const err = await slice.readChunk().then(
            () => { throw new Error('expected readChunk to reject'); },
            (e: any) => e
        );
        expect(err.code).toBe('EIO');
        expect(err.objectId).toBe(OBJECT_ID);
        expect(String(err.message)).toContain('short read');
    });
});
