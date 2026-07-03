import crypto from 'crypto';

import { createLogger } from '../../log';
import { createError, type StrubsError } from '../../helpers';
import type { RepairBlockDetails } from '../../remediation/fault';
import type { FileObject } from '../file-object';
import { ioManager } from '../manager';
import { FileObjectReader } from './reader';
import { Slice } from './slice';
import type { Base } from './base';

type ReaderLike = {
    prepare(): Promise<void>;
    setReadRange(start: number, end: number): void;
    reconstructFullChunkSet(): Promise<{ buffer: Buffer; chunkDataSize: number } | null>;
    close(): Promise<void>;
};
type SliceLike = {
    create(): Promise<void>;
    writeChunk(chunk: Buffer): Promise<void>;
    close(): Promise<void>;
    commit(): Promise<void>;
    delete(): Promise<void>;
};
type SliceRepairerDeps = {
    createLogger?: typeof createLogger;
    ioManager?: Pick<typeof ioManager, 'getVolume'>;
    createReader?: (object: FileObject) => ReaderLike;
    createSlice?: (object: FileObject, reader: ReaderLike, sliceIndex: number) => SliceLike;
};

// Rebuilds a single slice file in place from the surviving slices, restoring
// redundancy without touching the object id, record, or other slices. The
// reconstructed bytes are written to a fresh temp file and atomically committed
// over the damaged slice (which also forces the filesystem/drive to allocate
// new blocks, retiring the bad sector). Loaded-from-record objects carry no
// volume reservations, so this performs no byte-accounting side effects.
export class SliceRepairer {
    private readonly deps: Required<SliceRepairerDeps>;
    private readonly log: ReturnType<typeof createLogger>;

    constructor(deps?: SliceRepairerDeps) {
        this.deps = {
            createLogger: deps?.createLogger ?? createLogger,
            ioManager: deps?.ioManager ?? ioManager,
            createReader: deps?.createReader ?? ((object: FileObject) => new FileObjectReader(object)),
            createSlice: deps?.createSlice ?? ((object: FileObject, reader: ReaderLike, sliceIndex: number) => new Slice(object, reader as unknown as Base, sliceIndex))
        };
        this.log = this.deps.createLogger('slice-repairer');
    }

    async repair(object: FileObject, sliceIndex: number): Promise<void> {
        this.assertTargetWritable(object, sliceIndex);

        const reader = this.deps.createReader(object);
        let target: SliceLike | null = null;

        // Whole-object integrity gate, computed DURING reconstruction: as each chunk set is rebuilt,
        // hash its data region (the data-slice bytes in order == the object plaintext). Per-slice
        // checksums can't catch a foreign-but-self-consistent surviving slice, so a reconstruction
        // from such a slice would produce valid-looking-but-wrong bytes and OVERWRITE a good slice.
        // We refuse to commit unless the reconstruction reproduces the stored whole-object md5.
        const expectedMd5 = object.md5;
        const objectHash = expectedMd5 ? crypto.createHash('md5') : null;
        const dataSliceCount = object.dataSliceCount;
        // The final chunk set's data region is zero-padded past the real data, but the stored md5
        // covers only object.size bytes -- cap the hashed length so a valid reconstruction still matches.
        let hashedBytes = 0;

        try {
            // prepare() throws EQUORUM if the slice cannot be reconstructed; the
            // caller leaves the fault in place rather than writing garbage.
            await reader.prepare();
            reader.setReadRange(0, object.size);

            target = this.deps.createSlice(object, reader, sliceIndex);
            await target.create();

            let chunkSet: { buffer: Buffer; chunkDataSize: number } | null;
            while ((chunkSet = await reader.reconstructFullChunkSet()) !== null) {
                if (objectHash) {
                    const take = Math.min(dataSliceCount * chunkSet.chunkDataSize, object.size - hashedBytes);
                    if (take > 0) {
                        objectHash.update(chunkSet.buffer.subarray(0, take));
                        hashedBytes += take;
                    }
                }
                const start = sliceIndex * chunkSet.chunkDataSize;
                const chunk = chunkSet.buffer.subarray(start, start + chunkSet.chunkDataSize);
                await target.writeChunk(chunk);
            }
            await target.close();

            if (objectHash && expectedMd5 && !objectHash.digest().equals(expectedMd5)) {
                const err = createError('ECORRUPT', 'reconstruction does not match stored object md5; refusing to overwrite slice') as StrubsError;
                throw err;
            }

            await target.commit();
        }
        catch (err) {
            await target?.delete().catch(() => undefined);
            throw err;
        }
        finally {
            await reader.close();
        }

        this.log('repaired slice %d of object %s', sliceIndex, object.id ?? 'unknown');
    }

    private assertTargetWritable(object: FileObject, sliceIndex: number): void {
        const volumeId = this.targetVolumeId(object, sliceIndex);
        const volume = this.deps.ioManager.getVolume(volumeId);
        if (!volume?.isWritable) {
            const err = createError('EVOLUMEUNWRITABLE', 'volume is not writable') as StrubsError & { repairDetails?: RepairBlockDetails };
            err.repairDetails = { targetVolumeId: volumeId, message: err.message };
            throw err;
        }
    }

    private targetVolumeId(object: FileObject, sliceIndex: number): number {
        if (sliceIndex < object.dataSliceCount) {
            const volumeId = object.dataSliceVolumeIds[sliceIndex];
            if (typeof volumeId !== 'number')
                throw new Error('invalid slice index');
            return volumeId;
        }

        const parityIndex = sliceIndex - object.dataSliceCount;
        const volumeId = object.paritySliceVolumeIds[parityIndex];
        if (typeof volumeId !== 'number')
            throw new Error('invalid slice index');
        return volumeId;
    }
}

export const sliceRepairer = new SliceRepairer();
