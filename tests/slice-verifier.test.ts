import { describe, expect, it, vi } from 'vitest';
import { FileObjectSliceVerifier } from '../lib/io/file-object/slice-verifier';
import type { FileObject } from '../lib/io/file-object';

vi.mock('../lib/async-bridges/reed-solomon', () => ({
    create: vi.fn(() => ({})),
    encode: vi.fn()
}));

describe('FileObjectSliceVerifier', () => {
    it('paces chunk reads inside a slice verification loop', async () => {
        const events: string[] = [];
        const sleep = vi.fn(async () => {
            events.push('sleep');
        });
        const readChunk = vi.fn(async () => {
            events.push('read');
            return Buffer.alloc(4);
        });
        const slice = {
            seekToHead: vi.fn(),
            readChunk
        };
        const fileObject = {
            size: 15,
            chunkSize: 64,
            dataSliceCount: 1,
            dataSliceVolumeIds: [1],
            paritySliceCount: 0,
            paritySliceVolumeIds: [],
            plan: {
                startChunkDataSize: 4,
                standardChunkDataSize: 4,
                standardChunkCountPerSlice: 2,
                standardChunkSetOffset: 4,
                endChunkSetDataOffset: 12,
                endChunkDataSize: 3
            },
            getLoggerPrefix: () => 'file:test',
            getPriority: () => 'low'
        } as unknown as FileObject;

        const verifier = new FileObjectSliceVerifier(fileObject, {
            readDelayMs: 7,
            sleep
        });
        (verifier as any)._configureInternals();

        await (verifier as any).verifyOpenSlice(0, slice);

        expect(readChunk).toHaveBeenCalledTimes(4);
        expect(sleep).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenCalledWith(7);
        expect(events).toEqual([
            'read',
            'sleep',
            'read',
            'sleep',
            'read',
            'sleep',
            'read'
        ]);
    });

    const createFileObject = (): FileObject => ({
        size: 15,
        chunkSize: 64,
        dataSliceCount: 1,
        dataSliceVolumeIds: [1],
        paritySliceCount: 0,
        paritySliceVolumeIds: [],
        plan: {
            startChunkDataSize: 4,
            standardChunkDataSize: 4,
            standardChunkCountPerSlice: 2,
            standardChunkSetOffset: 4,
            endChunkSetDataOffset: 12,
            endChunkDataSize: 3
        },
        getLoggerPrefix: () => 'file:test',
        getPriority: () => 'low'
    } as unknown as FileObject);

    it('light mode opens the slice (header check) but skips chunk reads', async () => {
        const slice = {
            open: vi.fn().mockResolvedValue(undefined),
            close: vi.fn().mockResolvedValue(undefined),
            seekToHead: vi.fn(),
            readChunk: vi.fn()
        };
        const verifier = new FileObjectSliceVerifier(createFileObject(), { mode: 'light' });
        (verifier as any).prepared = true;
        (verifier as any)._slices = [slice];
        const verifyOpenSlice = vi.spyOn(verifier as any, 'verifyOpenSlice');

        await verifier.verifySlice(0);

        expect(slice.open).toHaveBeenCalledTimes(1);
        expect(slice.close).toHaveBeenCalledTimes(1);
        expect(verifyOpenSlice).not.toHaveBeenCalled();
        expect(slice.readChunk).not.toHaveBeenCalled();
    });

    it('full mode opens the slice and reads every chunk', async () => {
        const slice = {
            open: vi.fn().mockResolvedValue(undefined),
            close: vi.fn().mockResolvedValue(undefined),
            seekToHead: vi.fn(),
            readChunk: vi.fn().mockResolvedValue(Buffer.alloc(4))
        };
        const verifier = new FileObjectSliceVerifier(createFileObject(), { mode: 'full', readDelayMs: 0 });
        (verifier as any).prepared = true;
        (verifier as any)._slices = [slice];
        (verifier as any)._configureInternals();
        const verifyOpenSlice = vi.spyOn(verifier as any, 'verifyOpenSlice');

        await verifier.verifySlice(0);

        expect(slice.open).toHaveBeenCalledTimes(1);
        expect(verifyOpenSlice).toHaveBeenCalledTimes(1);
        expect(slice.readChunk).toHaveBeenCalled();
    });

    it('light mode surfaces a header-mismatch failure with its category', async () => {
        const headerErr = Object.assign(new Error('slice header object id mismatch'), { code: 'EHEADER' });
        const slice = {
            open: vi.fn().mockRejectedValue(headerErr),
            close: vi.fn().mockResolvedValue(undefined),
            seekToHead: vi.fn(),
            readChunk: vi.fn()
        };
        const verifier = new FileObjectSliceVerifier(createFileObject(), { mode: 'light' });
        (verifier as any).prepared = true;
        (verifier as any)._slices = [slice];

        await expect(verifier.verifySlice(0)).rejects.toMatchObject({
            code: 'EHEADER',
            sliceIndex: 0,
            volumeId: 1
        });
        // open() failed before the slice was marked open, so close() is skipped
        // and no chunk reads happen.
        expect(slice.close).not.toHaveBeenCalled();
        expect(slice.readChunk).not.toHaveBeenCalled();
    });

    it('light mode surfaces a missing-slice (ENOENT) failure', async () => {
        const missingErr = Object.assign(new Error('no such file'), { code: 'ENOENT' });
        const slice = {
            open: vi.fn().mockRejectedValue(missingErr),
            close: vi.fn().mockResolvedValue(undefined),
            seekToHead: vi.fn(),
            readChunk: vi.fn()
        };
        const verifier = new FileObjectSliceVerifier(createFileObject(), { mode: 'light' });
        (verifier as any).prepared = true;
        (verifier as any)._slices = [slice];

        await expect(verifier.verifySlice(0)).rejects.toMatchObject({
            code: 'ENOENT',
            sliceIndex: 0,
            volumeId: 1
        });
        expect(slice.readChunk).not.toHaveBeenCalled();
    });
});
