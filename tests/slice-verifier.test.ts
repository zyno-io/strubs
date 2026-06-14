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
});
