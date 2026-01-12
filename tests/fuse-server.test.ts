import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StoredObjectRecord } from '../lib/io/file-object';

const FUSE_ERRORS = {
    EISDIR: 1,
    EROFS: 2,
    EPERM: 3,
    EINVAL: 4,
    EREMOTEIO: 5,
    ECONNRESET: 6,
    EIO: 7,
};

const createLoggerMock = vi.fn(() => {
    const logger = vi.fn();
    logger.error = vi.fn();
    return logger;
});

vi.mock('../lib/log', () => ({
    createLogger: createLoggerMock,
}));

const fuseInstances: Array<{
    mountPath: string;
    handlers: Record<string, (...args: unknown[]) => void>;
    opts: Record<string, unknown>;
    mount: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('fuse-native', () => {
    class FakeFuse {
        static EISDIR = FUSE_ERRORS.EISDIR;
        static EROFS = FUSE_ERRORS.EROFS;
        static EPERM = FUSE_ERRORS.EPERM;
        static EINVAL = FUSE_ERRORS.EINVAL;
        static EREMOTEIO = FUSE_ERRORS.EREMOTEIO;
        static ECONNRESET = FUSE_ERRORS.ECONNRESET;
        static EIO = FUSE_ERRORS.EIO;

        mountPath: string;
        handlers: Record<string, (...args: unknown[]) => void>;
        opts: Record<string, unknown>;
        mount = vi.fn((cb?: (err?: Error | null) => void) => cb?.(null));

        constructor(mountPath: string, handlers: Record<string, (...args: unknown[]) => void>, opts: Record<string, unknown>) {
            this.mountPath = mountPath;
            this.handlers = handlers;
            this.opts = opts;
            fuseInstances.push(this);
        }
    }

    return {
        default: FakeFuse,
    };
});

const databaseMock = {
    getObjectByPath: vi.fn(),
    getObjectById: vi.fn(),
    getObjectsInContainerPath: vi.fn(),
    getTimestampFromId: vi.fn(),
};

vi.mock('../lib/database', () => ({
    database: databaseMock,
}));

class FileObjectStub extends EventEmitter {
    size = 1024;
    acquireIOLock = vi.fn().mockResolvedValue(undefined);
    releaseIOLock = vi.fn().mockResolvedValue(undefined);
    setReadRange = vi.fn();
    loadFromRecord = vi.fn().mockImplementation(async (record: StoredObjectRecord) => {
        this.size = record.size;
    });
    prepareForRead = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    requestId: string | null = null;
    priority: 'normal' | 'low' = 'normal';

    setRequestId(requestId: string | null): void {
        this.requestId = requestId ?? null;
    }

    getRequestId(): string | null {
        return this.requestId;
    }

    setPriority(priority: 'normal' | 'low'): void {
        this.priority = priority;
    }

    getPriority(): 'normal' | 'low' {
        return this.priority;
    }

    getLoggerPrefix(): string {
        const idPart = 'object';
        return this.requestId ? `${this.requestId}:file:${idPart}` : `file:${idPart}`;
    }
}

const fileObjectInstances: FileObjectStub[] = [];
const fileObjectServiceMock = {
    openForRead: vi.fn(async (record: StoredObjectRecord, options?: { requestId?: string | number }) => {
        const instance = new FileObjectStub();
        instance.size = record.size;
        if (options && options.requestId !== undefined)
            instance.setRequestId(options.requestId);
        fileObjectInstances.push(instance);
        return instance;
    }),
    load: vi.fn(),
    createWritable: vi.fn()
};

vi.mock('../lib/io/file-object/service', () => ({
    fileObjectService: fileObjectServiceMock
}));

const createFileRecord = () => ({
    isContainer: false,
    id: 'object',
    size: 128,
    chunkSize: 64,
    dataVolumes: [1],
    parityVolumes: [2],
});

describe('FuseServer', () => {
    beforeEach(() => {
        vi.resetModules();
        fuseInstances.length = 0;
        fileObjectInstances.length = 0;
        Object.values(databaseMock).forEach(mock => mock.mockReset());
        fileObjectServiceMock.openForRead.mockClear();
        fileObjectServiceMock.load.mockClear();
        fileObjectServiceMock.createWritable.mockClear();
    });

    const importServer = async () => {
        const { FuseServer } = await import('../lib/server/fuse/server');
        return new FuseServer();
    };

    it('mounts the filesystem on start', async () => {
        const server = await importServer();
        await server.start();

        expect(fuseInstances).toHaveLength(1);
        const instance = fuseInstances[0];
        expect(instance.mountPath).toBe('/run/strubs/data');
        expect(instance.opts).toMatchObject({ force: true, mkdir: true });
        expect(Object.keys(instance.handlers)).toContain('getattr');
    });

    it('returns directory stats for the root path', async () => {
        const server = await importServer();
        const cb = vi.fn();

        await server.fuse_getattr('/', cb);

        expect(cb).toHaveBeenCalledWith(0, expect.objectContaining({ mode: 0o40755 }));
    });

    it('returns file stats for object paths', async () => {
        const server = await importServer();
        databaseMock.getObjectByPath.mockResolvedValueOnce(createFileRecord());
        databaseMock.getTimestampFromId.mockReturnValueOnce(Date.now());
        const cb = vi.fn();

        await server.fuse_getattr('/object', cb);

        expect(databaseMock.getObjectByPath).toHaveBeenCalledWith('object');
        expect(cb).toHaveBeenCalledWith(0, expect.objectContaining({ size: 128 }));
    });

    it('lists container contents in readdir', async () => {
        const server = await importServer();
        databaseMock.getObjectsInContainerPath.mockResolvedValueOnce([{ name: 'foo' }, { name: 'bar' }]);
        const cb = vi.fn();

        await server.fuse_readdir('/', cb);

        expect(cb).toHaveBeenCalledWith(0, ['foo', 'bar']);
    });

    it('opens files read-only and stores descriptors', async () => {
        const server = await importServer();
        databaseMock.getObjectByPath.mockResolvedValue(createFileRecord());
        const cb = vi.fn();

        await server.fuse_open('/object', 0, cb);

        expect(fileObjectServiceMock.openForRead).toHaveBeenCalledTimes(1);
        const options = fileObjectServiceMock.openForRead.mock.calls[0]?.[1];
        expect(options?.requestId).toMatch(/^fuse-/);
        expect(fileObjectInstances[0]?.getRequestId()).toBe(options?.requestId ?? null);
        expect(cb).toHaveBeenCalledWith(0, 0);
    });

    it('rejects write attempts in fuse_open', async () => {
        const server = await importServer();
        databaseMock.getObjectByPath.mockResolvedValue(createFileRecord());
        const cb = vi.fn();

        await server.fuse_open('/object', 1, cb);

        expect(cb).toHaveBeenCalledWith(FUSE_ERRORS.EROFS);
    });

    it('releases file descriptors and closes objects', async () => {
        const server = await importServer();
        databaseMock.getObjectByPath.mockResolvedValue(createFileRecord());
        const openCb = vi.fn();
        await server.fuse_open('/object', 0, openCb);
        const fd = openCb.mock.calls[0][1] as number;
        const releaseCb = vi.fn();

        await server.fuse_release('/object', fd, releaseCb);

        expect(fileObjectInstances[0].close).toHaveBeenCalledTimes(1);
        expect(releaseCb).toHaveBeenCalledWith(0);
    });

    it('streams data through fuse_read into the provided buffer', async () => {
        const server = await importServer();
        const record = createFileRecord();
        record.size = 8;
        databaseMock.getObjectByPath.mockResolvedValue(record);
        const openCb = vi.fn();
        await server.fuse_open('/object', 0, openCb);
        const fd = openCb.mock.calls[0][1] as number;
        const buffer = Buffer.alloc(8);
        const readCb = vi.fn();

        server.fuse_read('/object', fd, buffer, 8, 0, readCb);
        const fileObject = fileObjectInstances[0];

        await new Promise(resolve => setImmediate(resolve));
        fileObject.emit('data', Buffer.from('1234'));
        fileObject.emit('data', Buffer.from('5678'));

        await new Promise(resolve => setImmediate(resolve));
        expect(readCb).toHaveBeenCalledWith(8);
        expect(buffer.toString()).toBe('12345678');
        expect(fileObject.acquireIOLock).toHaveBeenCalledTimes(1);
        expect(fileObject.releaseIOLock).toHaveBeenCalledTimes(1);
    });

    it('reports read errors as Fuse.EREMOTEIO', async () => {
        const server = await importServer();
        databaseMock.getObjectByPath.mockResolvedValue(createFileRecord());
        const openCb = vi.fn();
        await server.fuse_open('/object', 0, openCb);
        const fd = openCb.mock.calls[0][1] as number;
        const buffer = Buffer.alloc(4);
        const readCb = vi.fn();

        server.fuse_read('/object', fd, buffer, 4, 0, readCb);
        const fileObject = fileObjectInstances[0];

        await new Promise(resolve => setImmediate(resolve));
        fileObject.emit('error', new Error('boom'));

        await new Promise(resolve => setImmediate(resolve));
        expect(readCb).toHaveBeenCalledWith(FUSE_ERRORS.EREMOTEIO);
    });

    it('returns 0 bytes when read starts beyond EOF', async () => {
        const server = await importServer();
        const record = createFileRecord();
        record.size = 4;
        databaseMock.getObjectByPath.mockResolvedValue(record);
        const openCb = vi.fn();
        await server.fuse_open('/object', 0, openCb);
        const fd = openCb.mock.calls[0][1] as number;
        const buffer = Buffer.alloc(4);
        const readCb = vi.fn();

        await server.fuse_read('/object', fd, buffer, 4, 10, readCb);
        await new Promise(resolve => setImmediate(resolve));

        expect(readCb).toHaveBeenCalledWith(0);
        expect(fileObjectInstances[0].acquireIOLock).not.toHaveBeenCalled();
    });

    it('translates acquire lock failures into Fuse error codes', async () => {
        const server = await importServer();
        databaseMock.getObjectByPath.mockResolvedValue(createFileRecord());
        const openCb = vi.fn();
        await server.fuse_open('/object', 0, openCb);
        const fd = openCb.mock.calls[0][1] as number;
        const buffer = Buffer.alloc(4);
        const readCb = vi.fn();
        const fileObject = fileObjectInstances[0];
        fileObject.acquireIOLock.mockRejectedValueOnce({ code: 'EIO' });

        await server.fuse_read('/object', fd, buffer, 4, 0, readCb);

        expect(readCb).toHaveBeenCalledWith(FUSE_ERRORS.EIO);
    });

    it('maps Fuse error codes via _translateError', async () => {
        const server = await importServer();
        const translate = (server as unknown as { _translateError: (err: unknown) => number })._translateError.bind(server);

        expect(translate({ code: 'EISDIR' })).toBe(FUSE_ERRORS.EISDIR);
        expect(translate({ code: 'UNKNOWN' })).toBe(FUSE_ERRORS.ECONNRESET);
    });

    it('validates file metadata in _ensureFileRecord', async () => {
        const server = await importServer();
        const ensure = (server as unknown as { _ensureFileRecord: (obj: unknown) => unknown })._ensureFileRecord.bind(server);

        expect(() => ensure({ id: 'x' })).toThrow('object is missing file metadata');
        expect(() => ensure(createFileRecord())).not.toThrow();
    });

    it('propagates database errors through fuse_getattr callbacks', async () => {
        const server = await importServer();
        databaseMock.getObjectByPath.mockRejectedValueOnce({ code: 'EIO' });
        const cb = vi.fn();

        await server.fuse_getattr('/object', cb);

        expect(cb).toHaveBeenCalledWith(FUSE_ERRORS.EIO);
    });

    it('propagates database errors through fuse_readdir callbacks', async () => {
        const server = await importServer();
        databaseMock.getObjectsInContainerPath.mockRejectedValueOnce({ code: 'EIO' });
        const cb = vi.fn();

        await server.fuse_readdir('/', cb);

        expect(cb).toHaveBeenCalledWith(FUSE_ERRORS.EIO);
    });

    it('serializes concurrent reads on the same file descriptor', async () => {
        const server = await importServer();
        const record = createFileRecord();
        record.size = 16;
        databaseMock.getObjectByPath.mockResolvedValue(record);
        const openCb = vi.fn();
        await server.fuse_open('/object', 0, openCb);
        const fd = openCb.mock.calls[0][1] as number;
        const fileObject = fileObjectInstances[0];

        // Track the order of setReadRange calls to verify serialization
        const setReadRangeCalls: Array<[number, number]> = [];
        fileObject.setReadRange.mockImplementation((start: number, end: number) => {
            setReadRangeCalls.push([start, end]);
        });

        // Implement a proper lock that actually serializes
        let lockResolvers: Array<() => void> = [];
        let lockHeld = false;
        fileObject.acquireIOLock.mockImplementation(() => {
            return new Promise<void>(resolve => {
                if (!lockHeld) {
                    lockHeld = true;
                    resolve();
                } else {
                    lockResolvers.push(() => {
                        lockHeld = true;
                        resolve();
                    });
                }
            });
        });
        fileObject.releaseIOLock.mockImplementation(() => {
            lockHeld = false;
            const next = lockResolvers.shift();
            if (next) next();
        });

        const buffer1 = Buffer.alloc(8);
        const buffer2 = Buffer.alloc(8);
        const readCb1 = vi.fn();
        const readCb2 = vi.fn();

        // Start two concurrent reads
        const read1Promise = server.fuse_read('/object', fd, buffer1, 8, 0, readCb1);
        const read2Promise = server.fuse_read('/object', fd, buffer2, 8, 8, readCb2);

        // First read should acquire lock immediately, second should wait
        await new Promise(resolve => setImmediate(resolve));
        expect(fileObject.acquireIOLock).toHaveBeenCalledTimes(2);
        expect(setReadRangeCalls).toEqual([[0, 8]]); // Only first read's range set

        // Complete first read - this releases lock and allows second read to proceed
        fileObject.emit('data', Buffer.from('11111111'));
        await new Promise(resolve => setImmediate(resolve));

        // Now second read should have proceeded
        await new Promise(resolve => setImmediate(resolve));
        expect(setReadRangeCalls).toEqual([[0, 8], [8, 16]]); // Second read's range now set

        // Complete second read
        fileObject.emit('data', Buffer.from('22222222'));
        await Promise.all([read1Promise, read2Promise]);

        expect(readCb1).toHaveBeenCalledWith(8);
        expect(readCb2).toHaveBeenCalledWith(8);
        expect(buffer1.toString()).toBe('11111111');
        expect(buffer2.toString()).toBe('22222222');
    });

    it('does not remove other reads listeners when one read completes', async () => {
        const server = await importServer();
        const record = createFileRecord();
        record.size = 16;
        databaseMock.getObjectByPath.mockResolvedValue(record);
        const openCb = vi.fn();
        await server.fuse_open('/object', 0, openCb);
        const fd = openCb.mock.calls[0][1] as number;
        const fileObject = fileObjectInstances[0];

        // Make acquireIOLock resolve immediately (no actual locking)
        // This simulates what would happen if the lock wasn't working
        let lockResolvers: Array<() => void> = [];
        fileObject.acquireIOLock.mockImplementation(() => {
            return new Promise<void>(resolve => {
                lockResolvers.push(resolve);
                // Resolve immediately to simulate concurrent access
                resolve();
            });
        });

        const buffer1 = Buffer.alloc(4);
        const readCb1 = vi.fn();

        // Start a read
        server.fuse_read('/object', fd, buffer1, 4, 0, readCb1);
        await new Promise(resolve => setImmediate(resolve));

        // Track listeners before and after
        const listenerCountBefore = fileObject.listenerCount('data');
        expect(listenerCountBefore).toBe(1);

        // Complete the read
        fileObject.emit('data', Buffer.from('1234'));
        await new Promise(resolve => setImmediate(resolve));

        // Listener should be removed for this specific read
        expect(fileObject.listenerCount('data')).toBe(0);
        expect(readCb1).toHaveBeenCalledWith(4);
    });

    it('handles read errors without affecting other pending reads', async () => {
        const server = await importServer();
        const record = createFileRecord();
        record.size = 16;
        databaseMock.getObjectByPath.mockResolvedValue(record);
        const openCb = vi.fn();
        await server.fuse_open('/object', 0, openCb);
        const fd = openCb.mock.calls[0][1] as number;
        const fileObject = fileObjectInstances[0];

        const buffer1 = Buffer.alloc(8);
        const buffer2 = Buffer.alloc(8);
        const readCb1 = vi.fn();
        const readCb2 = vi.fn();

        // Start first read
        const read1Promise = server.fuse_read('/object', fd, buffer1, 8, 0, readCb1);
        await new Promise(resolve => setImmediate(resolve));

        // Error on first read
        fileObject.emit('error', new Error('read error'));
        await new Promise(resolve => setImmediate(resolve));

        expect(readCb1).toHaveBeenCalledWith(FUSE_ERRORS.EREMOTEIO);
        expect(fileObject.releaseIOLock).toHaveBeenCalledTimes(1);

        // Second read should still work (lock released, can acquire again)
        const read2Promise = server.fuse_read('/object', fd, buffer2, 8, 8, readCb2);
        await new Promise(resolve => setImmediate(resolve));

        fileObject.emit('data', Buffer.from('22222222'));
        await Promise.all([read1Promise, read2Promise]);

        expect(readCb2).toHaveBeenCalledWith(8);
        expect(buffer2.toString()).toBe('22222222');
    });

    it('does not double-callback if data arrives after completion', async () => {
        const server = await importServer();
        const record = createFileRecord();
        record.size = 8;
        databaseMock.getObjectByPath.mockResolvedValue(record);
        const openCb = vi.fn();
        await server.fuse_open('/object', 0, openCb);
        const fd = openCb.mock.calls[0][1] as number;
        const fileObject = fileObjectInstances[0];

        const buffer = Buffer.alloc(8);
        const readCb = vi.fn();

        server.fuse_read('/object', fd, buffer, 8, 0, readCb);
        await new Promise(resolve => setImmediate(resolve));

        // Complete the read
        fileObject.emit('data', Buffer.from('12345678'));
        await new Promise(resolve => setImmediate(resolve));

        // Callback should be called once
        expect(readCb).toHaveBeenCalledTimes(1);
        expect(readCb).toHaveBeenCalledWith(8);

        // Listeners should be removed after completion
        expect(fileObject.listenerCount('data')).toBe(0);
        expect(fileObject.listenerCount('error')).toBe(0);
    });

    it('cleans up listeners on read error', async () => {
        const server = await importServer();
        const record = createFileRecord();
        record.size = 8;
        databaseMock.getObjectByPath.mockResolvedValue(record);
        const openCb = vi.fn();
        await server.fuse_open('/object', 0, openCb);
        const fd = openCb.mock.calls[0][1] as number;
        const fileObject = fileObjectInstances[0];

        const buffer = Buffer.alloc(8);
        const readCb = vi.fn();

        server.fuse_read('/object', fd, buffer, 8, 0, readCb);
        await new Promise(resolve => setImmediate(resolve));

        expect(fileObject.listenerCount('data')).toBe(1);
        expect(fileObject.listenerCount('error')).toBe(1);

        // Emit error
        fileObject.emit('error', new Error('boom'));
        await new Promise(resolve => setImmediate(resolve));

        // Listeners should be cleaned up
        expect(fileObject.listenerCount('data')).toBe(0);
        expect(fileObject.listenerCount('error')).toBe(0);
        expect(readCb).toHaveBeenCalledWith(FUSE_ERRORS.EREMOTEIO);
    });
});
