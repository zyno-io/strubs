import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileObject } from '../lib/io/file-object';
import { Plan } from '../lib/io/plan';

class MockSlice {
    static instances: MockSlice[] = [];
    static deleteErrorIndex: number | null = null;
    static closeErrorIndex: number | null = null;

    created = false;
    writes: Buffer[] = [];
    opened = false;
    closed = false;
    committed = false;
    deleted = false;
    markedCommitted = false;
    readCount = 0;
    available: boolean;
    seekPositions: number[] = [];

    constructor(
        public readonly fileObject: FileObject,
        public readonly ioClass: any,
        public readonly index: number
    ) {
        this.available = !fileObject.unavailableSliceIdxs?.includes(index);
        MockSlice.instances.push(this);
    }

    async create(): Promise<void> {
        this.created = true;
    }

    async writeChunk(data: Buffer): Promise<void> {
        this.writes.push(Buffer.from(data));
    }

    async open(): Promise<void> {
        this.opened = true;
    }

    isAvailable(): boolean {
        return this.available;
    }

    seekToChunkIndex(index: number): void {
        this.seekPositions.push(index);
    }

    async readChunk(): Promise<Buffer> {
        this.readCount++;
        const size = this.ioClass._chunkDataSize || 8;
        return Buffer.alloc(size, (this.index + this.readCount) & 0xff);
    }

    async close(): Promise<void> {
        if (MockSlice.closeErrorIndex === this.index)
            throw new Error('close fail');
        this.closed = true;
    }

    async commit(): Promise<void> {
        this.committed = true;
    }

    async delete(): Promise<void> {
        if (MockSlice.deleteErrorIndex === this.index)
            throw new Error('delete fail');
        this.deleted = true;
    }

    markAsCommitted(): void {
        this.markedCommitted = true;
    }

    static reset(): void {
        this.instances = [];
        this.deleteErrorIndex = null;
        this.closeErrorIndex = null;
    }
}

const reedSolomonEncode = vi.fn(async () => {});

vi.mock('../lib/io/file-object/slice', () => ({
    Slice: MockSlice
}));

vi.mock('../lib/async-bridges/reed-solomon', () => ({
    create: vi.fn(() => ({})),
    encode: reedSolomonEncode
}));

const { FileObjectWriter } = await import('../lib/io/file-object/writer');
const { FileObjectReader } = await import('../lib/io/file-object/reader');
const { FileObjectDestroyer } = await import('../lib/io/file-object/destroyer');

const createFileObjectStub = (overrides: Partial<FileObject> = {}): FileObject => {
    let currentRequestId: string | null = null;
    const base: FileObject = {
        id: 'feedfacecafebeef',
        idBuf: Buffer.from('00112233445566778899aabb', 'hex'),
        containerId: null,
        name: 'stub.bin',
        size: 64,
        chunkSize: 64,
        dataSliceCount: 2,
        dataSliceVolumeIds: [ 1, 2 ],
        paritySliceCount: 1,
        paritySliceVolumeIds: [ 3 ],
        unavailableSliceIdxs: [],
        plan: null,
        getRequestId: overrides.getRequestId ?? (() => currentRequestId),
        setRequestId: overrides.setRequestId ?? ((reqId: string | null) => { currentRequestId = reqId; }),
        getLoggerPrefix: overrides.getLoggerPrefix ?? (() => {
            const idPart = base.id ?? 'uninitialized';
            return currentRequestId ? `${currentRequestId}:file:${idPart}` : `file:${idPart}`;
        }),
        ...overrides
    } as FileObject;

    const plan = new Plan();
    plan.fileSize = base.size;
    plan.chunkSize = base.chunkSize;
    plan.dataSliceCount = base.dataSliceCount;
    plan.paritySliceCount = base.paritySliceCount;
    plan.dataVolumes = base.dataSliceVolumeIds;
    plan.parityVolumes = base.paritySliceVolumeIds;
    plan.computeSliceSize();
    base.plan = plan;

    return base;
};

const createDeferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(res => {
        resolve = res;
    });
    return { promise, resolve };
};

describe('FileObjectWriter/Reader/Destroyer internals', () => {
    beforeEach(() => {
        MockSlice.reset();
        reedSolomonEncode.mockClear();
    });

    describe('FileObjectWriter', () => {
        it('throws when write operations execute before initialization', async () => {
            const writer = new FileObjectWriter(createFileObjectStub({ size: 8 }));
            await expect(writer.write(Buffer.alloc(1))).rejects.toThrow('writer not initialized');
            await expect(writer.finish()).rejects.toThrow('writer not initialized');
        });

        it('streams data into data and parity slices before finishing', async () => {
            const fileObject = createFileObjectStub({ size: 64, chunkSize: 64 });
            const writer = new FileObjectWriter(fileObject);
            await writer.prepare();
            await writer.write(Buffer.alloc(64, 0xaa));
            await writer.finish();
            expect(MockSlice.instances).toHaveLength(3);
            expect(MockSlice.instances[0]?.writes.length).toBeGreaterThan(0);
            expect(MockSlice.instances[2]?.writes.length).toBeGreaterThan(0);
            expect(writer.md5?.length).toBeGreaterThan(0);
        });

        it('pads the final chunk set before flushing the remainder of the buffer', async () => {
            const writer = new FileObjectWriter(createFileObjectStub({ size: 5 }));
            await writer.prepare();
            await writer.write(Buffer.alloc(5, 0xbb));
            await writer.finish();
            expect(writer.md5).not.toBeNull();
        });

        it('throws if finish sees an unexpected byte count', async () => {
            const writer = new FileObjectWriter(createFileObjectStub({ size: 32 }));
            await writer.prepare();
            await expect(writer.finish()).rejects.toThrow('writer expected 32 bytes');
        });

        it('waits for outstanding slice writes before finalizing', async () => {
            const writer = new FileObjectWriter(createFileObjectStub({ size: 4 }));
            await writer.prepare();
            await writer.write(Buffer.alloc(4, 0xee));
            const deferred = createDeferred();
            (writer as any)._sliceWritePromises[0] = deferred.promise;
            const finishPromise = writer.finish();
            await Promise.resolve();
            expect(writer.md5).toBeNull();
            deferred.resolve();
            await finishPromise;
            expect(writer.md5).not.toBeNull();
        });

        it('closes and commits slices during commit', async () => {
            const writer = new FileObjectWriter(createFileObjectStub({ size: 32 }));
            await writer.prepare();
            await writer.write(Buffer.alloc(32, 0xbb));
            await writer.finish();
            await writer.commit();
            expect(MockSlice.instances.every(slice => slice.closed && slice.committed)).toBe(true);
        });

        it('fails commit when an abort is in progress', async () => {
            const writer = new FileObjectWriter(createFileObjectStub({ size: 32 }));
            await writer.prepare();
            (writer as any)._isAborting = true;
            await expect(writer.commit()).rejects.toThrow('object write was aborted');
        });

        it('waits for pending slice writes before deleting during abort', async () => {
            const writer = new FileObjectWriter(createFileObjectStub({ size: 32 }));
            await writer.prepare();
            const deferred = createDeferred();
            (writer as any)._sliceWritePromises[0] = deferred.promise;
            const firstSlice = MockSlice.instances[0];
            const deleteSpy = vi.spyOn(firstSlice!, 'delete');
            const abortPromise = writer.abort();
            await Promise.resolve();
            expect(deleteSpy).not.toHaveBeenCalled();
            deferred.resolve();
            await abortPromise;
            expect(deleteSpy).toHaveBeenCalled();
            deleteSpy.mockRestore();
        });

        it('honors existing slice promises and abort flags inside queue operations', async () => {
            const writer = new FileObjectWriter(createFileObjectStub({ size: 4 }));
            await writer.prepare();
            const deferred = createDeferred();
            (writer as any)._sliceWritePromises[0] = deferred.promise;
            const queuePromise = (writer as any)._queueSliceWrite(0, Buffer.alloc(1));
            deferred.resolve();
            await queuePromise;
            (writer as any)._isAborting = true;
            await (writer as any)._queueSliceWrite(0, Buffer.alloc(1));
            expect(MockSlice.instances[0]?.writes.length).toBeGreaterThan(0);
        });

        it('guards low-level helpers when buffers are unavailable', async () => {
            const writer = new FileObjectWriter(createFileObjectStub({ size: 4 }));
            await writer.prepare();
            (writer as any)._chunkSetBuffer = null;
            await expect((writer as any)._writeBuffer()).rejects.toThrow('writer buffer not initialized');
        });

        it('refuses to compute parity when buffer state is invalid', async () => {
            const writer = new FileObjectWriter(createFileObjectStub({ size: 4 }));
            await writer.prepare();
            (writer as any)._chunkSetBuffer = null;
            await expect((writer as any)._computeAndWriteParity()).rejects.toThrow('writer buffer not initialized');
        });

        it('stops writing when the hash state has already been consumed', async () => {
            const writer = new FileObjectWriter(createFileObjectStub({ size: 4 }));
            await writer.prepare();
            (writer as any)._md5Hasher = null;
            await expect(writer.write(Buffer.alloc(1))).rejects.toThrow('hash not initialized');
        });

        it('waits for outstanding commit promises during abort', async () => {
            const writer = new FileObjectWriter(createFileObjectStub({ size: 4 }));
            await writer.prepare();
            const deferred = createDeferred();
            (writer as any)._commitPromises = [ deferred.promise ];
            const abortPromise = writer.abort();
            await Promise.resolve();
            deferred.resolve();
            await abortPromise;
        });
    });

    describe('FileObjectReader', () => {
        it('reads sequential data without reconstruction', async () => {
            const fileObject = createFileObjectStub({ size: 32 });
            const reader = new FileObjectReader(fileObject);
            await reader.prepare();
            reader.setReadRange(0, 16);
            const chunk = await reader.readChunk();
            expect(chunk).toBeInstanceOf(Buffer);
            expect(chunk.length).toBeGreaterThan(0);
            await reader.readChunk();
        });

        it('reconstructs data when slices are unavailable', async () => {
            const fileObject = createFileObjectStub({ size: 32, unavailableSliceIdxs: [ 0 ] });
            const reader = new FileObjectReader(fileObject);
            await reader.prepare();
            reader.setReadRange(0, 16);
            await reader.readChunk();
            expect(reedSolomonEncode).toHaveBeenCalled();
        });

        it('throws when there are not enough parity slices to rebuild the file', async () => {
            const fileObject = createFileObjectStub({ size: 32, unavailableSliceIdxs: [ 0, 1 ] });
            const reader = new FileObjectReader(fileObject);
            await expect(reader.prepare()).rejects.toThrow('insufficient slices available to reconstruct file');
        });

        it('seeks to mid-chunk offsets and trims over-read bytes', async () => {
            const fileObject = createFileObjectStub({ size: 128 });
            const reader = new FileObjectReader(fileObject);
            await reader.prepare();
            const offset = (reader as any)._standardChunkSetOffset + 8;
            const end = offset + 12;
            reader.setReadRange(offset, end);
            const chunk = await reader.readChunk();
            expect(chunk.length).toBe(end - offset);
        });

        it('closes active slices when requested', async () => {
            const fileObject = createFileObjectStub({ size: 16 });
            const reader = new FileObjectReader(fileObject);
            await reader.prepare();
            await reader.close();
            expect(MockSlice.instances.filter(slice => slice.opened).every(slice => slice.closed)).toBe(true);
        });

        it('logs and ignores close failures from individual slices', async () => {
            const fileObject = createFileObjectStub({ size: 8 });
            const reader = new FileObjectReader(fileObject);
            await reader.prepare();
            MockSlice.closeErrorIndex = 0;
            await reader.close();
            MockSlice.closeErrorIndex = null;
        });
    });

    describe('FileObjectDestroyer', () => {
        it('marks slices as committed and deletes them', async () => {
            const destroyer = new FileObjectDestroyer(createFileObjectStub());
            await destroyer.destroy();
            expect(MockSlice.instances.length).toBe(3);
            expect(MockSlice.instances.every(slice => slice.markedCommitted && slice.deleted)).toBe(true);
        });

        it('logs slice deletion failures but keeps destroying the object', async () => {
            MockSlice.deleteErrorIndex = 1;
            const destroyer = new FileObjectDestroyer(createFileObjectStub());
            await destroyer.destroy();
            MockSlice.deleteErrorIndex = null;
        });
    });
});
