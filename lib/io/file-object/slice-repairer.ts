import { createLogger } from '../../log';
import { createError, type StrubsError } from '../../helpers';
import type { RepairBlockDetails } from '../../remediation/fault';
import type { FileObject } from '../file-object';
import { ioManager } from '../manager';
import { FileObjectReader } from './reader';
import { Slice } from './slice';
import type { Base } from './base';

type SliceRepairerDeps = {
    createLogger?: typeof createLogger;
    ioManager?: Pick<typeof ioManager, 'getVolume'>;
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
            ioManager: deps?.ioManager ?? ioManager
        };
        this.log = this.deps.createLogger('slice-repairer');
    }

    async repair(object: FileObject, sliceIndex: number): Promise<void> {
        this.assertTargetWritable(object, sliceIndex);

        const reader = new FileObjectReader(object);
        let target: Slice | null = null;

        try {
            // prepare() throws EQUORUM if the slice cannot be reconstructed; the
            // caller leaves the fault in place rather than writing garbage.
            await reader.prepare();
            reader.setReadRange(0, object.size);

            target = new Slice(object, reader as unknown as Base, sliceIndex);
            await target.create();

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
