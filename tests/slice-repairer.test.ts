import crypto from 'crypto';
import { describe, expect, it, vi } from 'vitest';

// The repairer imports the reader -> base -> the native reed-solomon binding. This suite injects fake
// reader/slice factories and never reconstructs for real, so stub the native module so the import loads.
vi.mock('@ronomon/reed-solomon', () => ({ default: { create: () => ({}), encode: () => {}, search: () => {}, XOR: () => {} } }));

import { SliceRepairer } from '../lib/io/file-object/slice-repairer';

const loggerFactory = () => vi.fn(() => Object.assign(vi.fn(), { error: vi.fn() })) as any;

// A fake object with just the fields the repairer reads.
const makeObject = (opts: { size: number; md5: Buffer | null; dataSliceCount?: number }) => ({
    id: 'obj1',
    size: opts.size,
    md5: opts.md5,
    dataSliceCount: opts.dataSliceCount ?? 4,
    dataSliceVolumeIds: [10, 11, 12, 13],
    paritySliceVolumeIds: [14, 15]
});

const makeReader = (chunkSets: Array<{ buffer: Buffer; chunkDataSize: number }>) => {
    let i = 0;
    return {
        prepare: vi.fn().mockResolvedValue(undefined),
        setReadRange: vi.fn(),
        reconstructFullChunkSet: vi.fn().mockImplementation(async () => (i < chunkSets.length ? chunkSets[i++] : null)),
        close: vi.fn().mockResolvedValue(undefined)
    };
};

const makeSlice = () => ({
    writes: [] as Buffer[],
    create: vi.fn().mockResolvedValue(undefined),
    writeChunk: vi.fn(function (this: any, c: Buffer) { this.writes.push(Buffer.from(c)); return Promise.resolve(); }),
    close: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined)
});

const makeRepairer = (chunkSets: Array<{ buffer: Buffer; chunkDataSize: number }>, slice = makeSlice()) => {
    const reader = makeReader(chunkSets);
    const repairer = new SliceRepairer({
        createLogger: loggerFactory(),
        ioManager: { getVolume: () => ({ isWritable: true }) as any },
        createReader: () => reader as any,
        createSlice: () => slice as any
    });
    return { repairer, reader, slice };
};

// dataSliceCount=4; two chunk sets of chunkDataSize=10 (data region = 40 bytes each). size=65 so the
// final chunk set contributes only 25 of its 40 data bytes -> exercises the object.size cap.
const buf0 = Buffer.alloc(60, 0xaa); // 4 data + 2 parity slices * 10 bytes
const buf1 = Buffer.alloc(60, 0xbb);
const CHUNK_SETS = [{ buffer: buf0, chunkDataSize: 10 }, { buffer: buf1, chunkDataSize: 10 }];
const SIZE = 65;
const correctMd5 = crypto.createHash('md5').update(Buffer.concat([buf0.subarray(0, 40), buf1.subarray(0, 25)])).digest();

describe('SliceRepairer whole-object md5 gate', () => {
    it('commits when the reconstruction matches the stored whole-object md5 (with partial last chunk)', async () => {
        const { repairer, slice } = makeRepairer(CHUNK_SETS);
        await repairer.repair(makeObject({ size: SIZE, md5: correctMd5 }) as any, 0);

        expect(slice.commit).toHaveBeenCalledTimes(1);
        expect(slice.delete).not.toHaveBeenCalled();
        // target slice 0 gets each chunk set's slice-0 region (first 10 bytes)
        expect(slice.writes).toEqual([buf0.subarray(0, 10), buf1.subarray(0, 10)]);
    });

    it('refuses to commit (throws ECORRUPT) and deletes the temp slice when reconstruction does not match', async () => {
        const { repairer, slice } = makeRepairer(CHUNK_SETS);
        const wrongMd5 = Buffer.alloc(16, 0xff);
        await expect(repairer.repair(makeObject({ size: SIZE, md5: wrongMd5 }) as any, 0))
            .rejects.toMatchObject({ code: 'ECORRUPT' });

        expect(slice.commit).not.toHaveBeenCalled();
        expect(slice.delete).toHaveBeenCalledTimes(1);
    });

    it('commits without a gate when the object has no stored md5 (nothing to verify against)', async () => {
        const { repairer, slice } = makeRepairer(CHUNK_SETS);
        await repairer.repair(makeObject({ size: SIZE, md5: null }) as any, 0);

        expect(slice.commit).toHaveBeenCalledTimes(1);
        expect(slice.delete).not.toHaveBeenCalled();
    });
});
