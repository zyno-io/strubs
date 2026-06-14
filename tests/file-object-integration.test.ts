import { once } from 'events';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { hydratePlan } from './helpers/plan';

import { constants } from '../lib/constants';
import { volumePriorityManager } from '../lib/io/volume-priority-manager';

vi.mock('@ronomon/reed-solomon', () => {
    const create = (dataSliceCount: number, paritySliceCount: number) => ({ dataSliceCount, paritySliceCount });
    const encode = (
        ctx: { dataSliceCount: number; paritySliceCount: number },
        sourcesBits: number,
        targetsBits: number,
        input: Buffer,
        inputOffset: number,
        inputSize: number,
        output: Buffer,
        outputOffset: number,
        _outputSize: number,
        callback: (err: Error | null) => void
    ) => {
        try {
            const chunkSize = inputSize / ctx.dataSliceCount;
            const totalSlices = ctx.dataSliceCount + ctx.paritySliceCount;
            const readSlice = (sliceIdx: number): Buffer => {
                if (sliceIdx < ctx.dataSliceCount) {
                    const start = inputOffset + sliceIdx * chunkSize;
                    return input.subarray(start, start + chunkSize);
                }
                const parityIdx = sliceIdx - ctx.dataSliceCount;
                const start = outputOffset + parityIdx * chunkSize;
                return output.subarray(start, start + chunkSize);
            };
            const writeSlice = (sliceIdx: number, data: Buffer): void => {
                if (sliceIdx < ctx.dataSliceCount) {
                    const start = inputOffset + sliceIdx * chunkSize;
                    data.copy(output, start);
                    return;
                }
                const parityIdx = sliceIdx - ctx.dataSliceCount;
                const start = outputOffset + parityIdx * chunkSize;
                data.copy(output, start);
            };
            for (let sliceIdx = 0; sliceIdx < totalSlices; sliceIdx++) {
                if ((targetsBits & (1 << sliceIdx)) === 0)
                    continue;
                const buffer = Buffer.alloc(chunkSize, 0);
                if (sliceIdx >= ctx.dataSliceCount) {
                    for (let dataIdx = 0; dataIdx < ctx.dataSliceCount; dataIdx++) {
                        if ((sourcesBits & (1 << dataIdx)) === 0)
                            continue;
                        const source = readSlice(dataIdx);
                        for (let byteIdx = 0; byteIdx < chunkSize; byteIdx++)
                            buffer[byteIdx] ^= source[byteIdx];
                    }
                }
                else {
                    const paritySliceIdx = ctx.dataSliceCount;
                    const parityData = readSlice(paritySliceIdx);
                    parityData.copy(buffer);
                    for (let dataIdx = 0; dataIdx < ctx.dataSliceCount; dataIdx++) {
                        if (dataIdx === sliceIdx)
                            continue;
                        if ((sourcesBits & (1 << dataIdx)) === 0)
                            continue;
                        const source = readSlice(dataIdx);
                        for (let byteIdx = 0; byteIdx < chunkSize; byteIdx++)
                            buffer[byteIdx] ^= source[byteIdx];
                    }
                }
                writeSlice(sliceIdx, buffer);
            }
            callback(null);
        }
        catch (err) {
            callback(err as Error);
        }
    };
    const search = vi.fn();
    const XOR = vi.fn();
    const defaultExport = { create, encode, search, XOR };
    return {
        default: defaultExport,
        create,
        encode,
        search,
        XOR
    };
});

type FakeVolumeHandle = Awaited<ReturnType<typeof fs.open>>;

class FakeVolume {
    readonly id: number;
    readonly basePath: string;
    readonly tempPath: string;
    readonly committedPath: string;
    isReadable = true;
    isWritable = true;
    isStarted = true;
    isEnabled = true;
    isHealthy = true;
    isReadOnly = false;
    bytesFree = 10 ** 9;
    bytesPending = 0;
    bytesUsedData = 0;
    bytesUsedParity = 0;

    constructor(id: number, basePath: string) {
        this.id = id;
        this.basePath = basePath;
        this.tempPath = path.join(basePath, 'tmp');
        this.committedPath = path.join(basePath, 'committed');
    }

    private resolveTemp(fileName: string): string {
        return path.join(this.tempPath, fileName);
    }

    private resolveCommitted(fileName: string): string {
        return path.join(this.committedPath, fileName);
    }

    async init(): Promise<void> {
        await fs.mkdir(this.tempPath, { recursive: true });
        await fs.mkdir(this.committedPath, { recursive: true });
    }

    async createTemporaryFh(fileName: string): Promise<FakeVolumeHandle> {
        return fs.open(this.resolveTemp(fileName), 'w+');
    }

    async openCommittedFh(fileName: string): Promise<FakeVolumeHandle> {
        return fs.open(this.resolveCommitted(fileName), 'r');
    }

    async commitTemporaryFile(fileName: string): Promise<void> {
        await fs.rename(this.resolveTemp(fileName), this.resolveCommitted(fileName));
    }

    async deleteTemporaryFile(fileName: string): Promise<void> {
        await fs.rm(this.resolveTemp(fileName), { force: true });
    }

    async deleteCommittedFile(fileName: string): Promise<void> {
        await fs.rm(this.resolveCommitted(fileName), { force: true });
    }

    reserveSpace(bytes: number): void {
        this.bytesPending += bytes;
    }

    releaseReservation(bytes: number): void {
        this.bytesPending = Math.max(0, this.bytesPending - bytes);
    }

    applyCommittedBytes(_reserved: number, bytesWritten: number): void {
        this.releaseReservation(_reserved);
        this.bytesFree -= bytesWritten;
    }

    releaseCommittedBytes(bytes: number): void {
        this.bytesFree += bytes;
    }
}

const fakeVolumes = new Map<number, FakeVolume>();
const fakeManager = {
    getVolume: (id: number) => {
        const volume = fakeVolumes.get(id);
        if (!volume)
            throw new Error('volume not found for id ' + id);
        return volume;
    },
    getWritableVolumes: () => Array.from(fakeVolumes.values())
};

const databaseMock = {
    createObjectRecord: vi.fn(),
    deleteObjectById: vi.fn(),
    // Exercised when a corrupted slice is detected during read and reported to
    // the remediation pipeline (best-effort persistence).
    upsertFault: vi.fn(),
    listFaults: vi.fn().mockResolvedValue([]),
    deleteFault: vi.fn()
};

const planConfig = {
    chunkSize: 128,
    dataSliceCount: 2,
    paritySliceCount: 1,
    dataVolumes: [ 1, 2 ],
    parityVolumes: [ 3 ]
};

vi.mock('../lib/io/manager', () => ({
    ioManager: fakeManager
}));

vi.mock('../lib/database', () => ({
    database: databaseMock
}));

const plannerMock = {
    generatePlan: vi.fn()
};

plannerMock.generatePlan.mockImplementation(async (size: number) => {
    const plan = {
        fileSize: size,
        chunkSize: planConfig.chunkSize,
        dataSliceCount: planConfig.dataSliceCount,
        paritySliceCount: planConfig.paritySliceCount,
        dataVolumes: planConfig.dataVolumes,
        parityVolumes: planConfig.parityVolumes
    } as any;
    hydratePlan(plan);
    return plan;
});

vi.mock('../lib/io/planner', async () => {
    const actual = await vi.importActual<typeof import('../lib/io/planner')>('../lib/io/planner');
    return {
        ...actual,
        planner: plannerMock
    };
});

const { FileObject } = await import('../lib/io/file-object');

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'strubs-io-'));

const volumeIds = [ 1, 2, 3 ];
for (const id of volumeIds) {
    const volume = new FakeVolume(id, path.join(tempRoot, String(id)));
    await volume.init();
    fakeVolumes.set(id, volume);
}

const writeToObject = async (object: FileObject, payload: Buffer): Promise<void> => {
    const completion = once(object, 'finish');
    object.end(payload);
    await completion;
};

const readFromObject = (object: FileObject): Promise<Buffer> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => chunks.push(chunk);
    const cleanup = (): void => {
        object.off('data', onData);
        object.off('error', onError);
    };
    const onEnd = (): void => {
        cleanup();
        resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error): void => {
        cleanup();
        reject(err);
    };
    object.on('data', onData);
    object.once('end', onEnd);
    object.once('error', onError);
});

const listFiles = async (dir: string): Promise<string[]> => {
    try {
        return await fs.readdir(dir);
    }
    catch (err: any) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
};

describe('FileObject integration', () => {
    afterEach(async () => {
        databaseMock.createObjectRecord.mockReset();
        databaseMock.deleteObjectById.mockReset();
        for (const volume of fakeVolumes.values()) {
            volume.isReadable = true;
            volume.isWritable = true;
            volume.isStarted = true;
            volume.isEnabled = true;
            volume.isHealthy = true;
            volume.isReadOnly = false;
            await fs.rm(volume.tempPath, { recursive: true, force: true });
            await fs.rm(volume.committedPath, { recursive: true, force: true });
            await volume.init();
        }
    });

    afterAll(async () => {
        await fs.rm(tempRoot, { recursive: true, force: true });
    });

    it('commits slices to disk and records metadata', async () => {
        const payload = Buffer.from('hello strubs file object');
        const object = new FileObject();
        await object.createWithSize(payload.length);
        object.name = 'payload.bin';
        object.containerId = 'root';
        await writeToObject(object, payload);
        await object.commit();

        expect(databaseMock.createObjectRecord).toHaveBeenCalledTimes(1);
        const storedRecord = databaseMock.createObjectRecord.mock.calls[0][0];
        expect(storedRecord.size).toBe(payload.length);
        expect(storedRecord.dataVolumes).toEqual(planConfig.dataVolumes);
        for (const volumeId of volumeIds) {
            const files = await listFiles(fakeVolumes.get(volumeId)!.committedPath);
            expect(files).toContain(`${storedRecord.id}.${volumeId - 1}`);
        }
    });

    it('loads, streams, and deletes persisted slices', async () => {
        const payload = Buffer.from('streamed data range example');
        const object = new FileObject();
        await object.createWithSize(payload.length);
        object.name = 'payload.bin';
        await writeToObject(object, payload);
        await object.commit();
        const storedRecord = databaseMock.createObjectRecord.mock.calls[0][0];

        const reader = new FileObject();
        await reader.loadFromRecord(storedRecord);
        await reader.prepareForRead();
        reader.setReadRange(0, storedRecord.size, true);
        const data = await readFromObject(reader);
        expect(data).toEqual(payload);
        await reader.close();

        const deleter = new FileObject();
        await deleter.loadFromRecord(storedRecord);
        await deleter.delete();
        expect(databaseMock.deleteObjectById).toHaveBeenCalledWith(storedRecord.id);
        for (const volume of fakeVolumes.values()) {
            expect(await listFiles(volume.committedPath)).toHaveLength(0);
        }
    });

    it('streams zero-byte objects without touching chunk data', async () => {
        const object = new FileObject();
        await object.createWithSize(0);
        object.name = 'empty.bin';
        await writeToObject(object, Buffer.alloc(0));
        await object.commit();
        const storedRecord = databaseMock.createObjectRecord.mock.calls[0][0];

        const reader = new FileObject();
        await reader.loadFromRecord(storedRecord);
        await reader.prepareForRead();
        reader.setReadRange(0, 0, true);
        const data = await readFromObject(reader);
        expect(data).toEqual(Buffer.alloc(0));
        await reader.close();
    });

    it('supports partial range reads and EOF tracking', async () => {
        const payload = Buffer.from('ABCDEFGH12345678');
        const object = new FileObject();
        await object.createWithSize(payload.length);
        await writeToObject(object, payload);
        await object.commit();
        const storedRecord = databaseMock.createObjectRecord.mock.calls[0][0];

        const reader = new FileObject();
        await reader.loadFromRecord(storedRecord);
        await reader.prepareForRead();
        const start = 4;
        const end = payload.length - 3;
        reader.setReadRange(start, end, true);
        const chunks: Buffer[] = [];
        reader.on('data', chunk => chunks.push(chunk));
        await once(reader, 'end');
        expect(Buffer.concat(chunks)).toEqual(payload.slice(start, end));
    });

    it('reconstructs data when slices are unavailable', async () => {
        const payload = Buffer.from('ReedSolomonProtectsData!');
        const object = new FileObject();
        await object.createWithSize(payload.length);
        await writeToObject(object, payload);
        await object.commit();
        const storedRecord = databaseMock.createObjectRecord.mock.calls[0][0];

        const damagedRecord = { ...storedRecord, unavailableSlices: [0] };
        const damagedSliceFile = path.join(fakeVolumes.get(1)!.committedPath, `${storedRecord.id}.0`);
        await fs.rm(damagedSliceFile);

        const reader = new FileObject();
        await reader.loadFromRecord(damagedRecord);
        await reader.prepareForRead();
        reader.setReadRange(0, payload.length, true);
        const data = await readFromObject(reader);
        expect(data).toEqual(payload);
    });

    it('recovers from a chunk checksum mismatch by reconstructing from parity', async () => {
        const payload = Buffer.from('checksum validation buffer');
        const object = new FileObject();
        await object.createWithSize(payload.length);
        await writeToObject(object, payload);
        await object.commit();
        const storedRecord = databaseMock.createObjectRecord.mock.calls[0][0];
        const sliceFile = path.join(fakeVolumes.get(1)!.committedPath, `${storedRecord.id}.0`);
        const fh = await fs.open(sliceFile, 'r+');
        const corruptionOffset = constants.FILE_HEADER_SIZE + constants.CHUNK_HEADER_SIZE;
        await fh.write(Buffer.from([0xff]), 0, 1, corruptionOffset);
        await fh.close();

        const reader = new FileObject();
        await reader.loadFromRecord(storedRecord);
        await reader.prepareForRead();
        reader.setReadRange(0, payload.length, true);
        // A single corrupted slice is detected (checksum mismatch) and rebuilt
        // from the surviving data + parity slices, so the read still succeeds.
        const data = await readFromObject(reader);
        expect(data).toEqual(payload);
        await reader.close();
    });

    it('rebuilds a damaged slice in place via SliceRepairer', async () => {
        const { SliceRepairer } = await import('../lib/io/file-object/slice-repairer');
        const payload = Buffer.from('repair me from parity please!!');
        const object = new FileObject();
        await object.createWithSize(payload.length);
        await writeToObject(object, payload);
        await object.commit();
        const storedRecord = databaseMock.createObjectRecord.mock.calls[0][0];

        const sliceFile = path.join(fakeVolumes.get(1)!.committedPath, `${storedRecord.id}.0`);
        const corruptionOffset = constants.FILE_HEADER_SIZE + constants.CHUNK_HEADER_SIZE;
        const fh = await fs.open(sliceFile, 'r+');
        await fh.write(Buffer.from([0xff]), 0, 1, corruptionOffset);
        await fh.close();

        const repairObject = new FileObject();
        await repairObject.loadFromRecord(storedRecord);
        await new SliceRepairer().repair(repairObject, 0);

        // The on-disk slice was rewritten: the corrupted byte is gone...
        const after = await fs.readFile(sliceFile);
        expect(after[corruptionOffset]).not.toBe(0xff);

        // ...and the object reads back correctly straight from the repaired slice.
        const reader = new FileObject();
        await reader.loadFromRecord(storedRecord);
        await reader.prepareForRead();
        reader.setReadRange(0, payload.length, true);
        const data = await readFromObject(reader);
        expect(data).toEqual(payload);
        await reader.close();
    });

    it('does not open source slices when the repair target is not writable', async () => {
        const { SliceRepairer } = await import('../lib/io/file-object/slice-repairer');
        const payload = Buffer.from('do not open sources');
        const object = new FileObject();
        await object.createWithSize(payload.length);
        await writeToObject(object, payload);
        await object.commit();
        const storedRecord = databaseMock.createObjectRecord.mock.calls[0][0];

        const openSpies = Array.from(fakeVolumes.values()).map(volume => vi.spyOn(volume, 'openCommittedFh'));
        fakeVolumes.get(1)!.isWritable = false;

        const repairObject = new FileObject();
        await repairObject.loadFromRecord(storedRecord);

        try {
            await expect(new SliceRepairer().repair(repairObject, 0)).rejects.toMatchObject({
                code: 'EVOLUMEUNWRITABLE',
                repairDetails: { targetVolumeId: 1 }
            });
            for (const spy of openSpies)
                expect(spy).not.toHaveBeenCalled();
        }
        finally {
            openSpies.forEach(spy => spy.mockRestore());
        }
    });

    it('closes source slices when target creation fails after reader prepare', async () => {
        const { SliceRepairer } = await import('../lib/io/file-object/slice-repairer');
        const payload = Buffer.from('close opened sources');
        const object = new FileObject();
        await object.createWithSize(payload.length);
        await writeToObject(object, payload);
        await object.commit();
        const storedRecord = databaseMock.createObjectRecord.mock.calls[0][0];

        const targetVolume = fakeVolumes.get(1)!;
        const createSpy = vi.spyOn(targetVolume, 'createTemporaryFh').mockRejectedValue(new Error('target create failed'));

        const repairObject = new FileObject();
        await repairObject.loadFromRecord(storedRecord);
        const priorityStatsBefore = volumePriorityManager.getStats();

        try {
            await expect(new SliceRepairer().repair(repairObject, 0)).rejects.toThrow('target create failed');
            expect(volumePriorityManager.getStats()).toEqual(priorityStatsBefore);
        }
        finally {
            createSpy.mockRestore();
        }
    });

    it('cleans up temporary slices when deleted before commit', async () => {
        const payload = Buffer.from('temporary data');
        const object = new FileObject();
        await object.createWithSize(payload.length);
        await writeToObject(object, payload);
        await object.delete();
        for (const volume of fakeVolumes.values()) {
            expect(await listFiles(volume.tempPath)).toHaveLength(0);
        }
        expect(databaseMock.deleteObjectById).not.toHaveBeenCalled();
    });
});
