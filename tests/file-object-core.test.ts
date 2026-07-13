import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hydratePlan } from './helpers/plan';

const databaseMock = {
    createObjectRecord: vi.fn(),
    deleteObjectById: vi.fn()
};

// The journal's whole value is WHERE it sits in the write path, so record the order of everything that
// touches disk or Mongo and assert on the sequence.
const callOrder: string[] = [];
const journalMock = {
    append: vi.fn(async (record: { op: string }) => { callOrder.push(`journal:${record.op}`); })
};
vi.mock('../lib/io/journal', () => ({ journal: journalMock }));

const planMock = {
    generatePlan: vi.fn()
};

type WriterInstance = {
    prepare: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    finish: ReturnType<typeof vi.fn>;
    commit: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    md5: Buffer | null;
};

type ReaderInstance = {
    prepare: ReturnType<typeof vi.fn>;
    setReadRange: ReturnType<typeof vi.fn>;
    readChunk: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
};

type DestroyerInstance = {
    destroy: ReturnType<typeof vi.fn>;
};

const writerInstances: WriterInstance[] = [];
const readerInstances: ReaderInstance[] = [];
const destroyerInstances: DestroyerInstance[] = [];

let nextWriterConfigurator: ((instance: WriterInstance) => void) | null = null;
const configureNextWriter = (fn: (instance: WriterInstance) => void): void => {
    nextWriterConfigurator = fn;
};

const createWriterInstance = (): WriterInstance => ({
    prepare: vi.fn().mockResolvedValue(undefined),
    write: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    // abort() removes the slices of an in-flight write, so it is an unlink for ordering purposes too.
    abort: vi.fn(async () => { callOrder.push('disk:unlink'); }),
    md5: Buffer.from('beef', 'hex')
});

const createReaderInstance = (): ReaderInstance => ({
    prepare: vi.fn().mockResolvedValue(undefined),
    setReadRange: vi.fn(),
    readChunk: vi.fn().mockResolvedValue(Buffer.from('chunk')),
    close: vi.fn().mockResolvedValue(undefined)
});

const createDestroyerInstance = (): DestroyerInstance => ({
    // This is what actually unlinks the slice files, so it takes its place in the recorded order.
    destroy: vi.fn(async () => { callOrder.push('disk:unlink'); })
});

vi.mock('stream', () => {
    class BasicEmitter {
        private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

        on(event: string, listener: (...args: unknown[]) => void): this {
            (this.listeners[event] ||= []).push(listener);
            return this;
        }

        addListener(event: string, listener: (...args: unknown[]) => void): this {
            return this.on(event, listener);
        }

        once(event: string, listener: (...args: unknown[]) => void): this {
            const wrapper = (...args: unknown[]) => {
                this.off(event, wrapper);
                listener(...args);
            };
            return this.on(event, wrapper);
        }

        off(event: string, listener: (...args: unknown[]) => void): this {
            const items = this.listeners[event];
            if (!items) return this;
            this.listeners[event] = items.filter(fn => fn !== listener);
            return this;
        }

        removeListener(event: string, listener: (...args: unknown[]) => void): this {
            return this.off(event, listener);
        }

        removeAllListeners(event?: string): this {
            if (event)
                delete this.listeners[event];
            else
                this.listeners = {};
            return this;
        }

        emit(event: string, ...args: unknown[]): boolean {
            const items = this.listeners[event];
            if (!items || items.length === 0) return false;
            for (const fn of [ ...items ])
                fn(...args);
            return true;
        }
    }

    class MockDuplex extends BasicEmitter {
        push(chunk: any): boolean {
            if (chunk === null) {
                this.emit('end');
                return false;
            }
            this.emit('data', chunk);
            return true;
        }

        destroy(error?: Error | null): this {
            if (error)
                this.emit('error', error);
            this.emit('close');
            return this;
        }

        pipe(): this {
            return this;
        }
    }

    return { Duplex: MockDuplex };
});

vi.mock('../lib/database', () => ({
    database: databaseMock
}));

vi.mock('../lib/io/planner', async () => {
    const actual = await vi.importActual<typeof import('../lib/io/planner')>('../lib/io/planner');
    planMock.generatePlan.mockImplementation(async (size: number) => {
        const plan = {
            fileSize: size,
            chunkSize: 64,
            dataSliceCount: 2,
            paritySliceCount: 1,
            dataVolumes: [1, 2],
            parityVolumes: [3],
            sliceSize: null,
            startChunkDataSize: null,
            standardChunkDataSize: null,
            endChunkDataSize: null,
            standardChunkCountPerSlice: null,
            standardChunkSetOffset: null,
            endChunkSetDataOffset: null
        } as any;
        hydratePlan(plan);
        return plan;
    });
    return {
        ...actual,
        planner: planMock
    };
});

vi.mock('../lib/io/file-object/writer', () => ({
    FileObjectWriter: vi.fn(function (this: WriterInstance) {
        Object.assign(this, createWriterInstance());
        writerInstances.push(this);
        nextWriterConfigurator?.(this);
        nextWriterConfigurator = null;
    })
}));

vi.mock('../lib/io/file-object/reader', () => ({
    FileObjectReader: vi.fn(function (this: ReaderInstance) {
        Object.assign(this, createReaderInstance());
        readerInstances.push(this);
    })
}));

vi.mock('../lib/io/file-object/destroyer', () => ({
    FileObjectDestroyer: vi.fn(function (this: DestroyerInstance) {
        Object.assign(this, createDestroyerInstance());
        destroyerInstances.push(this);
    })
}));

vi.mock('../lib/io/helpers', async () => {
    const actual = await vi.importActual<typeof import('../lib/io/helpers')>('../lib/io/helpers');
    return {
        ...actual,
        generateObjectId: vi.fn(() => Buffer.from('00112233445566778899aabb', 'hex'))
    };
});

vi.mock('../lib/log', () => ({
    createLogger: () => Object.assign(() => {}, { error: () => {} })
}));

const { FileObject } = await import('../lib/io/file-object');

const resetState = (): void => {
    callOrder.length = 0;
    journalMock.append.mockClear();
    databaseMock.createObjectRecord.mockReset();
    databaseMock.deleteObjectById.mockReset();
    databaseMock.createObjectRecord.mockImplementation(async () => { callOrder.push('mongo:insert'); });
    databaseMock.deleteObjectById.mockImplementation(async () => { callOrder.push('mongo:delete'); });
    writerInstances.length = 0;
    readerInstances.length = 0;
    destroyerInstances.length = 0;
    nextWriterConfigurator = null;
    (planMock.generatePlan as ReturnType<typeof vi.fn>).mockReset();
    planMock.generatePlan.mockResolvedValue(hydratePlan({
        chunkSize: 32,
        dataSliceCount: 2,
        paritySliceCount: 1,
        dataVolumes: [ 1, 2 ],
        parityVolumes: [ 3 ]
    }));
};

const waitForEvent = <T>(emitter: EventEmitter, event: string): Promise<T> =>
    new Promise(resolve => emitter.once(event, resolve as any));

describe('FileObject', () => {
    beforeEach(() => resetState());

    const createRecord = () => ({
        id: 'abc',
        containerId: null,
        isFile: true,
        name: 'doc.bin',
        size: 8,
        md5: Buffer.from('beef', 'hex'),
        mime: 'application/octet-stream',
        chunkSize: 32,
        dataVolumes: [ 1, 2 ],
        parityVolumes: [ 3 ]
    });

    it('generates metadata using planner and prepares the writer', async () => {
        const object = new FileObject();
        await object.createWithSize(10);
        expect(writerInstances).toHaveLength(1);
        expect(writerInstances[0]?.prepare).toHaveBeenCalled();
        expect(object.id).toBe('00112233445566778899aabb');
        expect(object.dataSliceVolumeIds).toEqual([ 1, 2 ]);
        expect(object.paritySliceVolumeIds).toEqual([ 3 ]);
    });

    it('commits metadata to the database after a successful write', async () => {
        const object = new FileObject();
        await object.createWithSize(4);
        const writer = writerInstances[0];
        object.name = 'cat.jpg';
        object.containerId = 'root';
        object.mime = null;
        writer && (writer.md5 = Buffer.from('ca11ab1e', 'hex'));
        await object.commit();
        expect(writer?.commit).toHaveBeenCalled();
        expect(databaseMock.createObjectRecord).toHaveBeenCalledWith(expect.objectContaining({
            id: object.id,
            containerId: 'root',
            name: 'cat.jpg'
        }));
    });

    it('loads from an existing record and prepares the reader', async () => {
        const object = new FileObject();
        const record = createRecord();
        await object.loadFromRecord(record);
        await object.prepareForRead();
        expect(readerInstances).toHaveLength(1);
        expect(readerInstances[0]?.prepare).toHaveBeenCalled();
        object.setReadRange(0, record.size, true);
        expect(readerInstances[0]?.setReadRange).toHaveBeenCalledWith(0, record.size);
    });

    it('rejects read operations when not in read mode', async () => {
        const object = new FileObject();
        await expect(() => object.setReadRange(0, 1)).toThrow('file object is not in a readable state');
        const errorPromise = waitForEvent<Error>(object, 'error');
        await (object as any)._read();
        await expect(errorPromise).resolves.toBeInstanceOf(Error);
    });

    it('delegates writes and finalization to the writer', async () => {
        const object = new FileObject();
        await object.createWithSize(4);
        const writer = writerInstances[0];
        await new Promise<void>((resolve, reject) => {
            (object as any)._write(Buffer.from('data'), 'buffer', err => err ? reject(err) : resolve());
        });
        expect(writer?.write).toHaveBeenCalled();
        await new Promise<void>((resolve, reject) => {
            (object as any)._final(err => err ? reject(err) : resolve());
        });
        expect(writer?.finish).toHaveBeenCalled();
        expect(object.md5?.toString('hex')).toBe('beef');
    });

    it('reads data through the reader when in read mode', async () => {
        const object = new FileObject();
        const record = createRecord();
        await object.loadFromRecord(record);
        await object.prepareForRead();
        object.setReadRange(0, record.size, true);
        const dataPromise = waitForEvent<Buffer>(object, 'data');
        await (object as any)._read();
        const chunk = await dataPromise;
        expect(chunk.toString()).toBe('chunk');
    });

    it('closes the reader and resets state', async () => {
        const object = new FileObject();
        const record = createRecord();
        await object.loadFromRecord(record);
        await object.prepareForRead();
        await object.close();
        expect(readerInstances[0]?.close).toHaveBeenCalled();
    });

    it('aborts active writes when deleting before persistence', async () => {
        const object = new FileObject();
        await object.createWithSize(4);
        await object.delete();
        expect(writerInstances[0]?.abort).toHaveBeenCalled();
        expect(databaseMock.deleteObjectById).not.toHaveBeenCalled();
    });

    it('destroys stored slices and removes the record when persisted', async () => {
        const object = new FileObject();
        const record = createRecord();
        await object.loadFromRecord(record);
        await object.delete();
        expect(destroyerInstances[0]?.destroy).toHaveBeenCalled();
        expect(databaseMock.deleteObjectById).toHaveBeenCalledWith(record.id);
    });

    // ---- JOURNAL ORDERING ----
    //
    // The journal's entire value is WHERE it sits. These two tests are the phase.

    it('ORDER on create: slices committed -> journal -> Mongo', async () => {
        const object = new FileObject();
        await object.createWithSize(4);
        object.name = 'cat.jpg';
        object.containerId = 'root';
        await object.commit();

        // A crash between the journal and Mongo leaves the object on disk AND named in the journal, so a
        // rebuild finds it whole. The reverse would leave it in Mongo but NOT the journal -- and a
        // snapshot+journal restore would miss it entirely, degrading it to a nameless orphan.
        expect(callOrder).toEqual(['journal:put', 'mongo:insert']);
        expect(journalMock.append).toHaveBeenCalledWith(expect.objectContaining({
            op: 'put', name: 'cat.jpg', cid: 'root'
        }));
    });

    it('ORDER on delete: journal -> Mongo -> unlink slices (orphans beat phantoms, twice)', async () => {
        const object = new FileObject();
        const record = createRecord();
        await object.loadFromRecord(record);

        await object.delete();

        // The same rule applied at both boundaries, and the unlink loses both times.
        //
        // journal BEFORE unlink: crash between them and you get slices with no journal record -- an ORPHAN,
        // which lost+found recovers. The reverse leaves the object in the journal as live with its slices
        // already gone, so a replay resurrects a PHANTOM.
        //
        // Mongo BEFORE unlink: crash between them and you get slices with no row -- again an orphan, and one
        // the journal has already recorded as deleted, so no replay brings it back. The reverse strands a
        // row pointing at slices that no longer exist, which reads as data loss for an object the user
        // deliberately deleted.
        expect(callOrder).toEqual(['journal:del', 'mongo:delete', 'disk:unlink']);
        expect(journalMock.append).toHaveBeenCalledWith(expect.objectContaining({ op: 'del', id: record.id }));
    });

    // The subtle one. commit() journals the PUT before the Mongo insert, so if that insert throws, the put
    // is DURABLE in the journal while the object was never persisted. The cleanup path would treat it as a
    // mere aborted upload, unlink the slices and journal nothing -- leaving a `put` record for an object
    // with no slices and no row, which a replay would faithfully restore as a PHANTOM.
    it('compensates a half-failed create: a journaled PUT whose Mongo insert failed still gets a del', async () => {
        databaseMock.createObjectRecord.mockImplementation(async () => {
            callOrder.push('mongo:insert');
            throw new Error('mongo is down');
        });

        const object = new FileObject();
        await object.createWithSize(4);
        object.name = 'cat.jpg';
        await expect(object.commit()).rejects.toThrow('mongo is down');

        // Now the failure path cleans up, exactly as object-put-request does.
        await object.delete();

        expect(callOrder).toEqual([
            'journal:put', 'mongo:insert',      // the put IS durable; the insert then failed
            'journal:del', 'disk:unlink'        // ...so the delete must be journaled before the slices go
        ]);
    });

    // The mirror image of the test above, and the nastier one: the Mongo insert SUCCEEDS and something
    // after it throws. If the object is not marked persisted the instant the row exists, the cleanup path
    // unlinks the slices and then skips deleteObjectById() -- leaving a Mongo row pointing at nothing.
    // That is a phantom: it reads as data loss for an object that was never really there.
    it('leaves no PHANTOM when a create fails AFTER the Mongo insert succeeded', async () => {
        // The stats hook runs after the insert and is the realistic thing to blow up there.
        const object = new FileObject({
            recordObjectCreated: () => { throw new Error('stats hook blew up'); }
        });
        await object.createWithSize(4);
        object.name = 'cat.jpg';
        await expect(object.commit()).rejects.toThrow('stats hook blew up');

        await object.delete();          // the failure path, exactly as object-put-request runs it

        // The row exists, so the cleanup MUST remove it. Unlinking the slices and leaving the row is the
        // phantom; leaving the row and the slices would at worst be a live object.
        expect(databaseMock.deleteObjectById).toHaveBeenCalled();
        expect(callOrder).toEqual([
            'journal:put', 'mongo:insert',               // the insert landed...
            'journal:del', 'mongo:delete', 'disk:unlink' // ...so the row has to come back out with the slices
        ]);
    });

    it('does NOT journal an aborted upload -- it was never a namespace change', async () => {
        const object = new FileObject();
        await object.createWithSize(4);
        await object.delete();                       // abort an in-flight write, not a real deletion
        expect(journalMock.append).not.toHaveBeenCalled();
    });

    it('serializes IO locks to guard concurrent access', async () => {
        const object = new FileObject();
        const firstLock = object.acquireIOLock();
        const secondLock = object.acquireIOLock();
        let secondResolved = false;
        void secondLock.then(() => { secondResolved = true; });
        await firstLock;
        expect(secondResolved).toBe(false);
        object.releaseIOLock();
        await secondLock;
        expect(secondResolved).toBe(true);
    });

    it('rejects create when the planner response is incomplete', async () => {
        planMock.generatePlan.mockResolvedValueOnce({
            chunkSize: undefined,
            dataSliceCount: undefined,
            paritySliceCount: undefined,
            dataVolumes: [],
            parityVolumes: []
        });
        const object = new FileObject();
        await expect(object.createWithSize(1)).rejects.toThrow('plan is incomplete');
    });

    it('aborts slice allocation when writer preparation fails', async () => {
        configureNextWriter(instance => {
            instance.prepare.mockRejectedValueOnce(new Error('prep fail'));
        });
        const failing = new FileObject();
        await expect(failing.createWithSize(4)).rejects.toThrow('failed to create file object');
        expect(writerInstances.at(-1)?.abort).toHaveBeenCalled();
    });

    it('guards stream helpers when not in the proper mode', async () => {
        const object = new FileObject();
        await expect(object.commit()).rejects.toThrow('file object is not in a writable state');
        await new Promise<void>(resolve => {
            (object as any)._write(Buffer.from('x'), 'buffer', err => {
                expect(err?.message).toBe('file object is not in a writable state');
                resolve();
            });
        });
        await new Promise<void>(resolve => {
            (object as any)._final(err => {
                expect(err?.message).toBe('file object is not in a writable state');
                resolve();
            });
        });
        expect(() => object.setReadRange(0, 1)).toThrow('file object is not in a readable state');
        await expect(object.close()).rejects.toThrow('file object is not in a readable state');
        const errorPromise = waitForEvent<Error>(object, 'error');
        await (object as any)._read();
        await expect(errorPromise).resolves.toBeInstanceOf(Error);
    });
});
