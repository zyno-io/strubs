import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileObject } from '../lib/io/file-object';
import { Plan } from '../lib/io/plan';

// Controllable slice: a slice index in failPlan throws on readChunk for the
// configured number of times (Infinity = always), then succeeds.
class MockSlice {
    static instances: MockSlice[] = [];
    static failPlan: Record<number, { times: number; code?: string }> = {};

    opened = false;
    closed = false;
    readCount = 0;
    private remainingFails: number;
    private readonly failCode?: string;

    constructor(public readonly fileObject: FileObject, public readonly ioClass: any, public readonly index: number) {
        const plan = MockSlice.failPlan[index];
        this.remainingFails = plan ? plan.times : 0;
        this.failCode = plan?.code;
        MockSlice.instances.push(this);
    }

    isAvailable(): boolean {
        return !this.fileObject.unavailableSliceIdxs?.includes(this.index);
    }

    async open(): Promise<void> { this.opened = true; }
    seekToChunkIndex(): void { /* no-op */ }

    async readChunk(): Promise<Buffer> {
        this.readCount++;
        if (this.remainingFails > 0) {
            this.remainingFails--;
            const err = new Error(`mock fault on slice ${this.index}`) as Error & { code?: string };
            if (this.failCode)
                err.code = this.failCode;
            throw err;
        }
        const size = this.ioClass._chunkDataSize || 8;
        return Buffer.alloc(size, (this.index + this.readCount) & 0xff);
    }

    async close(): Promise<void> { this.closed = true; }

    static reset(): void {
        this.instances = [];
        this.failPlan = {};
    }
}

const reedSolomonEncode = vi.fn(async () => {});
const reportSliceFault = vi.fn();

vi.mock('../lib/io/file-object/slice', () => ({ Slice: MockSlice }));
vi.mock('../lib/async-bridges/reed-solomon', () => ({ create: vi.fn(() => ({})), encode: reedSolomonEncode }));
vi.mock('../lib/remediation/service', () => ({ remediationService: { reportSliceFault } }));

const { FileObjectReader } = await import('../lib/io/file-object/reader');

const createStub = (overrides: Partial<FileObject> = {}): FileObject => {
    const base: FileObject = {
        id: 'feedfacecafebeef0badf00d',
        idBuf: Buffer.from('00112233445566778899aabb', 'hex'),
        containerId: null,
        name: 'stub.bin',
        size: 64,
        chunkSize: 64,
        dataSliceCount: 2,
        dataSliceVolumeIds: [1, 2],
        paritySliceCount: 1,
        paritySliceVolumeIds: [3],
        unavailableSliceIdxs: [],
        plan: null,
        getRequestId: () => null,
        setRequestId: () => undefined,
        getLoggerPrefix: () => 'file:stub',
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

const readAll = async (reader: any): Promise<void> => {
    reader.setReadRange(0, reader.fileObject.size);
    while ((await reader.readChunk()) !== null) { /* drain */ }
};

describe('FileObjectReader resilience', () => {
    beforeEach(() => {
        MockSlice.reset();
        reedSolomonEncode.mockClear();
        reportSliceFault.mockClear();
    });

    it('reconstructs from parity and reports a fault on a transient read error', async () => {
        MockSlice.failPlan = { 0: { times: 1, code: 'ECHECKSUM' } };
        const reader = new FileObjectReader(createStub({ size: 64 }));
        await reader.prepare();
        await readAll(reader);

        expect(reedSolomonEncode).toHaveBeenCalled();
        expect(reportSliceFault).toHaveBeenCalledWith(expect.objectContaining({
            sliceIndex: 0, source: 'read', code: 'ECHECKSUM', volumeId: 1
        }));
    });

    it('escalates to whole-slice reconstruction after repeated faults', async () => {
        // Large object => many chunk sets; slice 0 always fails.
        MockSlice.failPlan = { 0: { times: Infinity, code: 'ECHECKSUM' } };
        const reader = new FileObjectReader(createStub({ size: 4096, chunkSize: 64 }));
        await reader.prepare();
        await readAll(reader);

        // After ESCALATE_THRESHOLD (2) faults the slice is no longer probed, so
        // it is read at most twice and no further faults are raised.
        expect(MockSlice.instances[0].readCount).toBe(2);
        expect(reportSliceFault).toHaveBeenCalledTimes(2);
        expect(reedSolomonEncode.mock.calls.length).toBeGreaterThan(2);
    });

    it('serves a range read from a healthy slice even when another slice is unrecoverable', async () => {
        // Slice 1 and parity are dead, but the requested range lives entirely in
        // slice 0 — the read must not touch (or require) the other slices.
        MockSlice.failPlan = { 1: { times: Infinity, code: 'EIO' }, 2: { times: Infinity, code: 'EIO' } };
        const reader = new FileObjectReader(createStub({ size: 64 }));
        await reader.prepare();
        reader.setReadRange(0, 1);
        const chunk = await reader.readChunk();
        expect(chunk).not.toBeNull();
        expect(chunk?.length).toBe(1);
        expect(MockSlice.instances[1].readCount).toBe(0);
    });

    it('fails the read when redundancy is lost (below quorum)', async () => {
        MockSlice.failPlan = {
            0: { times: Infinity, code: 'EIO' },
            2: { times: Infinity, code: 'EIO' }
        };
        const reader = new FileObjectReader(createStub({ size: 64 }));
        await reader.prepare();
        reader.setReadRange(0, 64);
        const err = await reader.readChunk().then(
            () => null,
            error => error
        );

        expect(err).toMatchObject({
            code: 'EQUORUM',
            repairDetails: {
                requiredSlices: 2,
                availableSlices: 1,
                totalSlices: 3,
                availableSliceIndexes: [1],
                missingSliceIndexes: [0, 2],
                missingVolumeIds: [1, 3]
            }
        });
    });
});
