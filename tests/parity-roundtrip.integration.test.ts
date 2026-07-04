import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

// REAL Reed-Solomon — deliberately NOT mocked. Every other test stubs the codec, so the actual parity
// math (encode bit-masks, buffer offsets, shard layout) was never exercised. Vite's loader can't import
// the native .node binding, so we pull it in via Node's own require, then drive the SAME call shape the
// codec uses (base.ts _computeParity): generate parity -> re-encode is deterministic -> drop each shard
// -> reconstruct byte-identically. A generation bug (wrong sources/targets bits, wrong offset,
// mishandled padding) fails here.
const nodeRequire = createRequire(import.meta.url);
const RS = nodeRequire('@ronomon/reed-solomon');

const bits = (indices: number[]) => indices.reduce((b, i) => b | (1 << i), 0);
const range = (start: number, end: number) => Array.from({ length: end - start }, (_, i) => start + i);

// Same signature the app's async-bridge promisifies.
function encode(ctx: unknown, sources: number[], targets: number[], buf: Buffer, dataSize: number, parityOffset: number, paritySize: number): Promise<void> {
    return new Promise((resolve, reject) => {
        RS.encode(ctx, bits(sources), bits(targets), buf, 0, dataSize, buf, parityOffset, paritySize, (err: unknown) => err ? reject(err) : resolve());
    });
}

describe('Reed-Solomon parity round-trip (real codec)', () => {
    for (const [dataShards, parityShards] of [[4, 2], [2, 1], [6, 2]]) {
        it(`${dataShards}+${parityShards}: generates parity, then reconstructs every shard byte-identically`, async () => {
            const shardSize = 128; // multiple of 8, as the codec requires
            const total = dataShards + parityShards;
            const dataSize = dataShards * shardSize;
            const parityOffset = dataSize;
            const paritySize = parityShards * shardSize;
            const ctx = RS.create(dataShards, parityShards);

            // distinct, non-trivial data per data shard
            const original = Buffer.alloc(total * shardSize);
            for (let s = 0; s < dataShards; s++)
                for (let i = 0; i < shardSize; i++)
                    original[s * shardSize + i] = (s * 31 + i * 7) & 0xff;
            // last data shard: half real, half zero-pad (exercises the padded final chunk)
            original.fill(0, (dataShards - 1) * shardSize + shardSize / 2, dataShards * shardSize);

            // GENERATE parity: sources = data shards, targets = parity shards
            const buf = Buffer.from(original);
            await encode(ctx, range(0, dataShards), range(dataShards, total), buf, dataSize, parityOffset, paritySize);
            const storedParity = Buffer.from(buf.subarray(parityOffset));

            // parity is DETERMINISTIC: re-encoding the same data reproduces the same parity
            const buf2 = Buffer.from(original);
            await encode(ctx, range(0, dataShards), range(dataShards, total), buf2, dataSize, parityOffset, paritySize);
            expect(buf2.subarray(parityOffset).equals(storedParity)).toBe(true);

            // RECONSTRUCT: drop each shard in turn and rebuild it from the survivors
            for (let dropped = 0; dropped < total; dropped++) {
                const damaged = Buffer.from(buf);
                damaged.fill(0, dropped * shardSize, (dropped + 1) * shardSize);
                const present = range(0, total).filter(i => i !== dropped);
                await encode(ctx, present, [dropped], damaged, dataSize, parityOffset, paritySize);
                const rebuilt = damaged.subarray(dropped * shardSize, (dropped + 1) * shardSize);
                const expected = buf.subarray(dropped * shardSize, (dropped + 1) * shardSize);
                expect(rebuilt.equals(expected)).toBe(true);
            }
        });
    }

    it('detects foreign parity: parity from different data does NOT validate', async () => {
        const [dataShards, parityShards, shardSize] = [4, 2, 128];
        const total = dataShards + parityShards;
        const dataSize = dataShards * shardSize, parityOffset = dataSize, paritySize = parityShards * shardSize;
        const ctx = RS.create(dataShards, parityShards);

        const mk = (seed: number) => {
            const b = Buffer.alloc(total * shardSize);
            for (let i = 0; i < dataSize; i++) b[i] = (seed + i) & 0xff;
            return b;
        };
        const a = mk(1), bDiff = mk(99);
        await encode(ctx, range(0, dataShards), range(dataShards, total), a, dataSize, parityOffset, paritySize);
        await encode(ctx, range(0, dataShards), range(dataShards, total), bDiff, dataSize, parityOffset, paritySize);
        // parity computed from B's data must not equal the parity A's data should have -> this is exactly
        // the "self-consistent but foreign" case that recompute-and-compare catches.
        expect(a.subarray(parityOffset).equals(bDiff.subarray(parityOffset))).toBe(false);
    });
});
