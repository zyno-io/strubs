import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StoredObjectRecord } from '../lib/io/file-object';

const databaseMock = {
    getOrCreateContainer: vi.fn(),
    getOrCreateContainerWithBucket: vi.fn(),
};

vi.mock('../lib/database', () => ({
    database: databaseMock
}));

type FileObjectBehavior = {
    createWithSize: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    loadFromRecord: ReturnType<typeof vi.fn>;
    prepareForRead: ReturnType<typeof vi.fn>;
    setReadRange: ReturnType<typeof vi.fn>;
    commit: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    onFinish: ReturnType<typeof vi.fn>;
};

const fileObjectBehavior = {} as FileObjectBehavior;

const applyDefaultBehavior = (): void => {
    fileObjectBehavior.createWithSize = vi.fn().mockResolvedValue(undefined);
    fileObjectBehavior.write = vi.fn().mockResolvedValue(undefined);
    fileObjectBehavior.delete = vi.fn().mockResolvedValue(undefined);
    fileObjectBehavior.loadFromRecord = vi.fn().mockResolvedValue(undefined);
    fileObjectBehavior.prepareForRead = vi.fn().mockResolvedValue(undefined);
    fileObjectBehavior.setReadRange = vi.fn();
    fileObjectBehavior.commit = vi.fn().mockResolvedValue(undefined);
    fileObjectBehavior.close = vi.fn().mockResolvedValue(undefined);
    fileObjectBehavior.onFinish = vi.fn((instance: MockFileObject) => {
        instance.md5 = Buffer.from('beef', 'hex');
    });
};

applyDefaultBehavior();

class MockFileObject extends PassThrough {
    static instances: MockFileObject[] = [];

    id: string | null = 'mock-object-id';
    containerId: string | null = null;
    name: string | null = null;
    md5: Buffer | null = Buffer.from('beef', 'hex');
    mime: string | null = null;
    size = 0;
    dataSliceVolumeIds: number[] = [1, 2];
    paritySliceVolumeIds: number[] = [3];
    chunkSize = 8;
    deleted = false;
    range: { start: number; end: number; transmit?: boolean } | null = null;
    private finishEmitted = false;
    isPiped = false;
    forceBackpressure = false;
    requestId: string | number | null = null;

    constructor() {
        super();
        MockFileObject.instances.push(this);
        this.on('error', () => {});
        this.once('finish', () => {
            this.finishEmitted = true;
            fileObjectBehavior.onFinish(this);
        });
    }

    async createWithSize(size: number): Promise<void> {
        this.size = size;
        await fileObjectBehavior.createWithSize(size);
    }

    override write(chunk: Buffer): boolean {
        void fileObjectBehavior.write(chunk);
        if (this.forceBackpressure) {
            this.forceBackpressure = false;
            return false;
        }
        return super.write(chunk);
    }

    async delete(): Promise<void> {
        this.deleted = true;
        await fileObjectBehavior.delete();
    }

    async loadFromRecord(record: StoredObjectRecord): Promise<void> {
        this.id = record.id;
        this.size = record.size;
        this.dataSliceVolumeIds = record.dataVolumes;
        this.paritySliceVolumeIds = record.parityVolumes;
        await fileObjectBehavior.loadFromRecord(record);
    }

    async prepareForRead(): Promise<void> {
        await fileObjectBehavior.prepareForRead();
    }

    setRequestId(requestId: string | number | null): void {
        this.requestId = requestId ?? null;
    }

    getRequestId(): string | number | null {
        return this.requestId;
    }

    getLoggerPrefix(): string {
        const idPart = this.id ?? 'mock-object-id';
        return this.requestId !== null ? `${this.requestId}:file:${idPart}` : `file:${idPart}`;
    }

    setReadRange(start: number, end: number, shouldTransmitEOR?: boolean): void {
        this.range = { start, end, transmit: shouldTransmitEOR };
        fileObjectBehavior.setReadRange(start, end, shouldTransmitEOR);
    }

    async commit(): Promise<void> {
        await fileObjectBehavior.commit();
    }

    async close(): Promise<void> {
        await fileObjectBehavior.close();
    }

    override pipe<T extends NodeJS.WritableStream>(destination: T, options?: { end?: boolean }): T {
        this.isPiped = true;
        return super.pipe(destination, options);
    }

    override end(chunk?: any, encoding?: BufferEncoding, callback?: () => void): this {
        const result = super.end(chunk, encoding, callback);
        if (!this.finishEmitted) {
            queueMicrotask(() => {
                if (!this.finishEmitted)
                    this.emit('finish');
            });
        }
        return result;
    }
}

vi.mock('../lib/io/file-object', () => ({
    FileObject: MockFileObject
}));

const resetMocks = (): void => {
    databaseMock.getOrCreateContainer.mockReset();
    databaseMock.getOrCreateContainerWithBucket.mockReset();
    applyDefaultBehavior();
    MockFileObject.instances = [];
};

type Headers = Record<string, string | number>;

class MockHttpResponse extends Writable {
    headers: Record<string, string | number> = {};
    statusCode = 200;
    statusMessage?: string;
    body: Buffer = Buffer.alloc(0);
    headersSent = false;
    finished = false;
    destroyed = false;

    constructor() {
        super();
    }

    setHeader(name: string, value: string | number): void {
        this.headers[name] = value;
    }

    hasHeader(name: string): boolean {
        return Object.prototype.hasOwnProperty.call(this.headers, name);
    }

    writeHead(statusCode: number, statusMessage?: string | Headers, headers?: Headers): this {
        this.statusCode = statusCode;
        if (typeof statusMessage === 'string') {
            this.statusMessage = statusMessage;
        }
        else if (statusMessage && typeof statusMessage === 'object') {
            Object.assign(this.headers, statusMessage);
        }
        if (headers)
            Object.assign(this.headers, headers);
        this.headersSent = true;
        return this;
    }

    override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        this.body = Buffer.concat([ this.body, chunk ]);
        callback();
    }

    override end(chunk?: any): this {
        if (chunk) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            this.body = Buffer.concat([ this.body, buffer ]);
        }
        this.finished = true;
        super.end();
        return this;
    }

    override destroy(error?: Error): this {
        this.destroyed = true;
        if (error)
            this.emit('error', error);
        return this;
    }
}

class MockHttpRequest extends EventEmitter {
    headers: Record<string, string>;
    method: string;
    url: string;
    params = {};
    socket = { remoteAddress: '127.0.0.1', remotePort: 443 };
    paused = false;

    constructor(method: string, url: string, headers: Record<string, string> = {}) {
        super();
        this.method = method;
        this.url = url;
        this.headers = headers;
    }

    pause(): void {
        this.paused = true;
    }

    resume(): void {
        this.paused = false;
    }
}

const createRequest = (method: string, url: string, headers?: Record<string, string>) => new MockHttpRequest(method, url, headers);
const createResponse = () => new MockHttpResponse();

const writeChunks = (request: MockHttpRequest, chunks: Buffer[]): void => {
    for (const chunk of chunks)
        request.emit('data', chunk);
};

const flushFileObject = (data: Buffer | string): void => {
    const instance = MockFileObject.instances.at(-1);
    if (!instance)
        throw new Error('file object instance not found');
    setImmediate(() => {
        instance.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        instance.push(null);
    });
};

const signalUploadCompletion = (): void => {
    const instance = MockFileObject.instances.at(-1);
    if (!instance)
        throw new Error('file object instance not found');
    setImmediate(() => instance.emit('finish'));
};

const waitForAsync = () => new Promise<void>(resolve => setImmediate(resolve));
const waitForCondition = async (predicate: () => boolean, attempts = 20): Promise<void> => {
    for (let i = 0; i < attempts; i++) {
        if (predicate())
            return;
        await waitForAsync();
    }
    throw new Error('condition not met');
};

const { ObjectPutRequest } = await import('../lib/server/http/object-put-request');
const { ObjectGetRequest } = await import('../lib/server/http/object-get-request');
const { ObjectDeleteRequest } = await import('../lib/server/http/object-delete-request');

const createObjectRecord = (): StoredObjectRecord => ({
    id: 'abc',
    containerId: 'root',
    isFile: true,
    name: 'file.bin',
    size: 11,
    chunkSize: 4,
    dataVolumes: [ 1, 2 ],
    parityVolumes: [ 3 ],
    md5: Buffer.from('beef', 'hex'),
    mime: 'application/octet-stream'
});

describe('ObjectPutRequest', () => {
    beforeEach(() => resetMocks());

    it('stores a new object successfully', async () => {
        const req = createRequest('PUT', '/photos/cat.jpg', { 'content-length': '12' });
        const res = createResponse();
        databaseMock.getOrCreateContainerWithBucket.mockResolvedValue({ containerId: 'container123', bucketId: 'bucket123' });

        const putRequest = new ObjectPutRequest(1, req as any, res as any);
        const promise = putRequest.process();

        await waitForAsync();
        writeChunks(req, [ Buffer.from('hello '), Buffer.from('world!') ]);
        await waitForAsync();
        req.emit('end');
        signalUploadCompletion();

        await promise;

        expect(res.statusCode).toBe(201);
        expect(res.headers['x-object-id']).toBe('mock-object-id');
        expect(res.headers['x-container-id']).toBe('container123');
        expect(res.headers['content-md5']).toBe('beef');
        expect(fileObjectBehavior.commit).toHaveBeenCalled();
        expect(fileObjectBehavior.delete).not.toHaveBeenCalled();
    });

    it('responds with 400 when content-length is invalid', async () => {
        const req = createRequest('PUT', '/file.bin', { 'content-length': 'nope' });
        const res = createResponse();
        const putRequest = new ObjectPutRequest(2, req as any, res as any);
        await putRequest.process();
        expect(res.statusCode).toBe(400);
        expect(res.body.toString()).toBe('Invalid Content-Length');
    });

    it('responds with 400 when content-length header is missing', async () => {
        const req = createRequest('PUT', '/file.bin');
        const res = createResponse();
        const putRequest = new ObjectPutRequest(11, req as any, res as any);
        await putRequest.process();
        expect(res.statusCode).toBe(400);
    });

    it('aborts when bytes received differ from header', async () => {
        const req = createRequest('PUT', '/file.bin', { 'content-length': '5' });
        const res = createResponse();
        const putRequest = new ObjectPutRequest(3, req as any, res as any);
        const promise = putRequest.process();
        await waitForAsync();
        writeChunks(req, [ Buffer.from('abc') ]);
        await waitForAsync();
        req.emit('end');
        signalUploadCompletion();
        await promise;
        expect(res.statusCode).toBe(455);
        expect(fileObjectBehavior.delete).toHaveBeenCalled();
    });

    it('rejects when MD5 does not match provided header', async () => {
        const req = createRequest('PUT', '/file.bin', { 'content-length': '3', 'content-md5': 'bad' });
        const res = createResponse();
        const putRequest = new ObjectPutRequest(4, req as any, res as any);
        const promise = putRequest.process();
        await waitForAsync();
        writeChunks(req, [ Buffer.from('abc') ]);
        await waitForAsync();
        req.emit('end');
        signalUploadCompletion();
        await promise;
        expect(res.statusCode).toBe(456);
        expect(res.headers['X-Received-MD5']).toBe('beef');
        expect(fileObjectBehavior.delete).toHaveBeenCalled();
    });

    it('propagates errors when the destination lacks a filename', async () => {
        const req = createRequest('PUT', '/', { 'content-length': '3' });
        const res = createResponse();
        const putRequest = new ObjectPutRequest(5, req as any, res as any);
        const promise = putRequest.process();
        await waitForAsync();
        writeChunks(req, [ Buffer.from('abc') ]);
        await waitForAsync();
        req.emit('end');
        signalUploadCompletion();
        await expect(promise).rejects.toThrow('missing file name');
        expect(fileObjectBehavior.delete).toHaveBeenCalled();
    });

    it('aborts when the client disconnects mid-upload', async () => {
        const req = createRequest('PUT', '/file.bin', { 'content-length': '4' });
        const res = createResponse();
        const putRequest = new ObjectPutRequest(6, req as any, res as any);
        const promise = putRequest.process();
        await waitForAsync();
        writeChunks(req, [ Buffer.from('ab') ]);
        await waitForAsync();
        req.emit('aborted');
        await promise;
        expect(fileObjectBehavior.delete).toHaveBeenCalled();
    });

    it('fails when slice allocation cannot be performed', async () => {
        fileObjectBehavior.createWithSize.mockRejectedValueOnce(new Error('alloc fail'));
        const req = createRequest('PUT', '/file.bin', { 'content-length': '1' });
        const res = createResponse();
        const putRequest = new ObjectPutRequest(7, req as any, res as any);
        await expect(putRequest.process()).rejects.toThrow('alloc fail');
    });

    it('pauses incoming data when the file object back-pressures', async () => {
        const req = createRequest('PUT', '/file.bin', { 'content-length': '2' });
        const res = createResponse();
        const putRequest = new ObjectPutRequest(8, req as any, res as any);
        const promise = putRequest.process();
        await waitForAsync();
        const instance = MockFileObject.instances.at(-1);
        instance.forceBackpressure = true;
        writeChunks(req, [ Buffer.from('aa') ]);
        await waitForAsync();
        expect(req.paused).toBe(true);
        instance.emit('drain');
        await waitForAsync();
        expect(req.paused).toBe(false);
        req.emit('end');
        signalUploadCompletion();
        await promise;
    });

    it('stores the provided content-type header on the object', async () => {
        const req = createRequest('PUT', '/file.bin', {
            'content-length': '1',
            'content-type': ['image/png'] as unknown as string
        });
        const res = createResponse();
        const putRequest = new ObjectPutRequest(9, req as any, res as any);
        const promise = putRequest.process();
        await waitForAsync();
        writeChunks(req, [ Buffer.from('x') ]);
        await waitForAsync();
        req.emit('end');
        signalUploadCompletion();
        await promise;
        expect(MockFileObject.instances[0]?.mime).toBe('image/png');
    });

    it('returns an empty container header when storing at the root', async () => {
        const req = createRequest('PUT', '/file.bin', { 'content-length': '1' });
        const res = createResponse();
        const putRequest = new ObjectPutRequest(12, req as any, res as any);
        const promise = putRequest.process();
        await waitForAsync();
        writeChunks(req, [ Buffer.from('x') ]);
        await waitForAsync();
        req.emit('end');
        signalUploadCompletion();
        await promise;
        expect(res.headers['x-container-id']).toBe('');
    });

    it('rejects when committing file slices fails', async () => {
        fileObjectBehavior.commit.mockRejectedValueOnce(new Error('commit fail'));
        const req = createRequest('PUT', '/file.bin', { 'content-length': '1' });
        const res = createResponse();
        const putRequest = new ObjectPutRequest(10, req as any, res as any);
        const promise = putRequest.process();
        await waitForAsync();
        writeChunks(req, [ Buffer.from('x') ]);
        await waitForAsync();
        req.emit('end');
        signalUploadCompletion();
        await expect(promise).rejects.toThrow('commit fail');
    });

    it('bubbles request transport errors', async () => {
        const req = createRequest('PUT', '/file.bin', { 'content-length': '2' });
        const res = createResponse();
        const putRequest = new ObjectPutRequest(7, req as any, res as any);
        const promise = putRequest.process();
        await waitForAsync();
        writeChunks(req, [ Buffer.from('ab') ]);
        await waitForAsync();
        req.emit('error', new Error('socket closed'));
        await expect(promise).rejects.toThrow('socket closed');
        expect(fileObjectBehavior.delete).toHaveBeenCalled();
    });

    it('destroys the upload when the file object errors', async () => {
        const req = createRequest('PUT', '/file.bin', { 'content-length': '2' });
        const res = createResponse();
        const putRequest = new ObjectPutRequest(8, req as any, res as any);
        const promise = putRequest.process();
        await waitForAsync();
        writeChunks(req, [ Buffer.from('ab') ]);
        await waitForAsync();
        const instance = MockFileObject.instances.at(-1);
        instance?.emit('error', new Error('disk error'));
        await expect(promise).rejects.toThrow('disk error');
        expect(fileObjectBehavior.delete).toHaveBeenCalled();
    });

    it('propagates container creation failures', async () => {
        databaseMock.getOrCreateContainerWithBucket.mockRejectedValue(new Error('db down'));
        const req = createRequest('PUT', '/photos/cat.jpg', { 'content-length': '1' });
        const res = createResponse();
        const putRequest = new ObjectPutRequest(9, req as any, res as any);
        const promise = putRequest.process();
        await waitForAsync();
        writeChunks(req, [ Buffer.from('a') ]);
        await waitForAsync();
        req.emit('end');
        signalUploadCompletion();
        await expect(promise).rejects.toThrow('db down');
        expect(fileObjectBehavior.delete).toHaveBeenCalled();
    });
});

describe('ObjectGetRequest', () => {
    beforeEach(() => resetMocks());

    const buildRequest = (headers: Record<string, string> = {}, url = '/file.bin') =>
        createRequest('GET', url, headers);

    const buildResponse = () => createResponse();

    it('streams an entire object to the response', async () => {
        const record = createObjectRecord();
        const req = buildRequest();
        const res = buildResponse();
        const request = new ObjectGetRequest(1, record, req as any, res as any);
        const promise = request.process();
        flushFileObject('payload');
        await promise;
        expect(res.statusCode).toBe(200);
        expect(res.body.toString()).toBe('payload');
        expect(res.headers['Content-Length']).toBe(record.size);
        // Active-content hardening on every object response.
        expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
        // octet-stream is inline-safe, so no forced download and no sandbox lockdown.
        expect(res.headers['Content-Security-Policy']).toBe("default-src 'none'; media-src 'self'; img-src 'self'");
        expect(res.headers['Content-Disposition']).toBeUndefined();
    });

    it('forces a download for active content types (html, svg) so they cannot execute', async () => {
        for (const mime of ['text/html', 'image/svg+xml', 'application/json', 'application/xml']) {
            const record = { ...createObjectRecord(), mime };
            const req = buildRequest();
            const res = buildResponse();
            const request = new ObjectGetRequest(1, record, req as any, res as any);
            const promise = request.process();
            flushFileObject('x');
            await promise;
            expect(res.headers['Content-Disposition'], mime).toBe('attachment');
            expect(res.headers['X-Content-Type-Options'], mime).toBe('nosniff');
            // Force-downloaded content gets the FULL lockdown: if a browser renders it anyway, it can
            // load nothing and run nothing.
            expect(res.headers['Content-Security-Policy'], mime).toBe("default-src 'none'; sandbox");
        }
    });

    it('serves genuinely-inert media inline (image/video/audio)', async () => {
        for (const mime of ['image/jpeg', 'image/png', 'video/mp4', 'audio/mpeg']) {
            const record = { ...createObjectRecord(), mime };
            const req = buildRequest();
            const res = buildResponse();
            const request = new ObjectGetRequest(1, record, req as any, res as any);
            const promise = request.process();
            flushFileObject('x');
            await promise;
            expect(res.headers['Content-Disposition'], mime).toBeUndefined();
        }
    });

    // Regression: a blanket `default-src 'none'; sandbox` was sent on EVERY object response, including
    // the media we deliberately render inline. Navigating to a video makes the browser wrap it in a viewer
    // document that the CSP then applies to -- so `default-src 'none'` (no media-src) forbade loading the
    // very bytes it was opened to show, and `sandbox` blocked the viewer's scripts. Direct playback of
    // every video and audio object was broken.
    it('does NOT sandbox or block inert media, so a directly-opened video can actually play', async () => {
        for (const mime of ['video/mp4', 'audio/mpeg', 'image/png']) {
            const record = { ...createObjectRecord(), mime };
            const req = buildRequest();
            const res = buildResponse();
            const request = new ObjectGetRequest(1, record, req as any, res as any);
            const promise = request.process();
            flushFileObject('x');
            await promise;
            const csp = res.headers['Content-Security-Policy'] as string;
            expect(csp, mime).toBe("default-src 'none'; media-src 'self'; img-src 'self'");
            expect(csp, mime).not.toContain('sandbox');   // would block the browser's own media viewer
            expect(res.headers['X-Content-Type-Options'], mime).toBe('nosniff');   // still no MIME sniffing
        }
    });

    it('handles range requests and sets the appropriate headers', async () => {
        const record = { ...createObjectRecord(), size: 100 };
        const req = buildRequest({ range: 'bytes=10-19' });
        const res = buildResponse();
        const request = new ObjectGetRequest(2, record, req as any, res as any);
        const promise = request.process();
        flushFileObject('0123456789');
        await promise;
        expect(res.statusCode).toBe(206);
        expect(res.headers['Content-Range']).toBe('bytes 10-19/100');
        expect(fileObjectBehavior.setReadRange).toHaveBeenCalledWith(10, 20, true);
    });

    it('treats duplicate range headers as a single value', async () => {
        const record = { ...createObjectRecord(), size: 40 };
        const req = buildRequest({ range: ['bytes=0-9', 'bytes=10-19'] as unknown as string });
        const res = buildResponse();
        const request = new ObjectGetRequest(3, record, req as any, res as any);
        const promise = request.process();
        flushFileObject('0123456789');
        await promise;
        expect(res.statusCode).toBe(206);
        expect(res.headers['Content-Range']).toBe('bytes 0-9/40');
    });

    it('omits optional headers when the stored record lacks metadata', async () => {
        const record = { ...createObjectRecord(), containerId: null, md5: null, mime: null };
        const req = buildRequest();
        const res = buildResponse();
        const request = new ObjectGetRequest(4, record, req as any, res as any);
        const promise = request.process();
        flushFileObject('payload');
        await promise;
        expect(res.headers['X-Container-Id']).toBeUndefined();
        expect(res.headers['Content-MD5']).toBeUndefined();
        expect(res.headers['Content-Type']).toBeUndefined();
    });

    it('sets a download filename when requested', async () => {
        const record = createObjectRecord();
        const req = buildRequest();
        (req as any).params = { download_as: 'report.csv' };
        const res = buildResponse();
        const request = new ObjectGetRequest(4, record, req as any, res as any);
        const promise = request.process();
        flushFileObject('payload');
        await promise;
        expect(res.headers['Content-Disposition']).toBe('attachment; filename="report.csv"');
    });

    it('rejects invalid ranges with 416', async () => {
        const record = { ...createObjectRecord(), size: 5 };
        const req = buildRequest({ range: 'bytes=10-1' });
        const res = buildResponse();
        const request = new ObjectGetRequest(5, record, req as any, res as any);
        await request.process();
        expect(res.statusCode).toBe(416);
        expect(res.body.toString()).toBe('');
    });

    it('rejects ranges whose ending byte precedes the start', async () => {
        const record = { ...createObjectRecord(), size: 20 };
        const req = buildRequest({ range: 'bytes=5-2' });
        const res = buildResponse();
        const request = new ObjectGetRequest(6, record, req as any, res as any);
        await request.process();
        expect(res.statusCode).toBe(416);
    });

    it('rejects ranges that start at or beyond the file size', async () => {
        const record = { ...createObjectRecord(), size: 5 };
        const req = buildRequest({ range: 'bytes=5-10' });
        const res = buildResponse();
        const request = new ObjectGetRequest(6, record, req as any, res as any);
        await request.process();
        expect(res.statusCode).toBe(416);
    });

    it('closes files when the client connection drops mid-transfer', async () => {
        const record = createObjectRecord();
        const req = buildRequest();
        const res = buildResponse();
        const request = new ObjectGetRequest(7, record, req as any, res as any);
        const promise = request.process();
        await waitForAsync();
        res.emit('close');
        await promise;
        expect(fileObjectBehavior.close).toHaveBeenCalled();
    });

    it('ignores connection close events after the transfer completes', async () => {
        const record = createObjectRecord();
        const req = buildRequest();
        const res = buildResponse();
        const request = new ObjectGetRequest(8, record, req as any, res as any);
        const promise = request.process();
        flushFileObject('payload');
        await promise;
        const closeCalls = fileObjectBehavior.close.mock.calls.length;
        res.emit('close');
        await waitForAsync();
        expect(fileObjectBehavior.close).toHaveBeenCalledTimes(closeCalls);
    });

    it('destroys the response when the file stream errors', async () => {
        const record = createObjectRecord();
        const req = buildRequest();
        const res = buildResponse();
        res.on('error', () => {});
        const request = new ObjectGetRequest(7, record, req as any, res as any);
        const promise = request.process();
        await waitForAsync();
        const instance = MockFileObject.instances.at(-1);
        if (!instance)
            throw new Error('file object instance not found');
        instance.emit('error', new Error('boom'));
        await expect(promise).rejects.toThrow('boom');
        expect(res.destroyed).toBe(true);
        expect(res.body.toString()).toContain('transfer incomplete');
    });

    it('responds with 500 when the object cannot be prepared for reading', async () => {
        fileObjectBehavior.prepareForRead.mockRejectedValue(new Error('prepare failed'));
        const record = createObjectRecord();
        const req = buildRequest();
        const res = buildResponse();
        const request = new ObjectGetRequest(8, record, req as any, res as any);
        await expect(request.process()).rejects.toThrow('prepare failed');
        expect(res.statusCode).toBe(500);
        expect(res.body.toString()).toContain('STRUBS encountered an error');
    });

    it('invokes the stream error handler directly for coverage', async () => {
        const record = createObjectRecord();
        const req = buildRequest();
        const res = buildResponse();
        res.on('error', () => {});
        const request = new ObjectGetRequest(9, record, req as any, res as any);
        const instance = new MockFileObject();
        const cleanup = vi.fn();
        const reject = vi.fn();
        (request as any)._handleStreamError(instance, new Error('boom'), cleanup, reject);
        expect(res.statusCode).toBe(500);
        expect(res.destroyed).toBe(true);
        expect(cleanup).toHaveBeenCalled();
        expect(reject).toHaveBeenCalled();
    });
});

describe('ObjectDeleteRequest', () => {
    beforeEach(() => resetMocks());

    it('deletes a stored object and emits metadata headers', async () => {
        const record = createObjectRecord();
        const req = createRequest('DELETE', '/file.bin');
        const res = createResponse();
        const request = new ObjectDeleteRequest(5, record, req as any, res as any);
        await request.process();
        expect(res.statusCode).toBe(200);
        expect(fileObjectBehavior.delete).toHaveBeenCalledWith();
        expect(res.headers['X-Object-Id']).toBe(record.id);
    });

    it('propagates slice deletion failures as HTTP 500', async () => {
        fileObjectBehavior.delete.mockRejectedValue(new Error('disk fail'));
        const record = createObjectRecord();
        const req = createRequest('DELETE', '/file.bin');
        const res = createResponse();
        const request = new ObjectDeleteRequest(6, record, req as any, res as any);
        await expect(request.process()).rejects.toThrow('disk fail');
        expect(res.statusCode).toBe(500);
    });
});
