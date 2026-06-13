import { createLogger } from '../../log';
import type { FileObject } from '../file-object';
import { FileObjectReader } from './reader';
import { Slice } from './slice';
import type { Base } from './base';

// Rebuilds a single slice file in place from the surviving slices, restoring
// redundancy without touching the object id, record, or other slices. The
// reconstructed bytes are written to a fresh temp file and atomically committed
// over the damaged slice (which also forces the filesystem/drive to allocate
// new blocks, retiring the bad sector). Loaded-from-record objects carry no
// volume reservations, so this performs no byte-accounting side effects.
export class SliceRepairer {
    private readonly log: ReturnType<typeof createLogger>;

    constructor(deps?: { createLogger?: typeof createLogger }) {
        this.log = (deps?.createLogger ?? createLogger)('slice-repairer');
    }

    async repair(object: FileObject, sliceIndex: number): Promise<void> {
        const reader = new FileObjectReader(object);
        // prepare() throws EQUORUM if the slice cannot be reconstructed; the
        // caller leaves the fault in place rather than writing garbage.
        await reader.prepare();
        reader.setReadRange(0, object.size);

        const target = new Slice(object, reader as unknown as Base, sliceIndex);
        await target.create();

        try {
            let chunkSet: { buffer: Buffer; chunkDataSize: number } | null;
            while ((chunkSet = await reader.reconstructFullChunkSet()) !== null) {
                const start = sliceIndex * chunkSet.chunkDataSize;
                const chunk = chunkSet.buffer.subarray(start, start + chunkSet.chunkDataSize);
                await target.writeChunk(chunk);
            }
            await target.close();
            await target.commit();
        }
        catch (err) {
            await target.delete().catch(() => undefined);
            throw err;
        }
        finally {
            await reader.close();
        }

        this.log('repaired slice %d of object %s', sliceIndex, object.id ?? 'unknown');
    }
}

export const sliceRepairer = new SliceRepairer();
