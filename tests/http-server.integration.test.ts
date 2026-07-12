import http from 'http';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { TestContext } from 'vitest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { hydratePlan } from './helpers/plan';

import type { StoredObjectRecord } from '../lib/io/file-object';

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

    async reset(): Promise<void> {
        await fs.rm(this.basePath, { recursive: true, force: true });
        await this.init();
    }

    async createTemporaryFh(fileName: string): Promise<FakeVolumeHandle> {
        return fs.open(this.resolveTemp(fileName), 'w+');
    }

    async openCommittedFh(fileName: string): Promise<FakeVolumeHandle> {
        return fs.open(this.resolveCommitted(fileName), 'r');
    }

    async commitTemporaryFile(fileName: string): Promise<void> {
        const dest = this.resolveCommitted(fileName);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.rename(this.resolveTemp(fileName), dest);
    }

    async deleteTemporaryFile(fileName: string): Promise<void> {
        await fs.rm(this.resolveTemp(fileName), { force: true });
    }

    async deleteCommittedFile(fileName: string): Promise<void> {
        await fs.rm(this.resolveCommitted(fileName), { force: true });
    }

    async getCommitedPath(fileName: string): Promise<string> {
        const resolved = this.resolveCommitted(fileName);
        await fs.access(resolved);
        return resolved;
    }

    async listCommitted(): Promise<string[]> {
        try {
            return await fs.readdir(this.committedPath);
        }
        catch (err: any) {
            if (err.code === 'ENOENT') return [];
            throw err;
        }
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

const fakeIoManager = {
    getVolume: (id: number) => {
        const volume = fakeVolumes.get(id);
        if (!volume)
            throw new Error('volume not found for id ' + id);
        return volume;
    },
    getWritableVolumes: () => Array.from(fakeVolumes.values()),
    getVolumeEntries: () => Array.from(fakeVolumes.entries()),
};

vi.mock('../lib/io/manager', () => ({
    ioManager: fakeIoManager
}));

const planConfig = {
    chunkSize: 128,
    dataSliceCount: 2,
    paritySliceCount: 1,
    dataVolumes: [1, 2],
    parityVolumes: [3]
};

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

const createDatabaseMock = () => {
    const storedRecords = new Map<string, StoredObjectRecord>();
    const objectPathsById = new Map<string, string>();
    const pathToObjectId = new Map<string, string>();
    const containerIdsByPath = new Map<string, string>();
    const containerPathsById = new Map<string, string>();
    let containerCounter = 0;

    const stringifyId = (id: unknown): string => {
        if (typeof id === 'string') return id;
        if (Buffer.isBuffer(id)) return id.toString('hex');
        if (typeof (id as { toHexString?: () => string }).toHexString === 'function')
            return (id as { toHexString(): string }).toHexString();
        throw new Error('unsupported id type');
    };

    const notFound = (): never => {
        const err = new Error('object not found') as Error & { code?: string };
        err.code = 'ENOENT';
        throw err;
    };

    const normalizeComponents = (pathValue: string | string[]): string[] => {
        const components = Array.isArray(pathValue) ? pathValue : pathValue.split('/');
        return components.filter(component => component.length > 0);
    };

    const getContainerPath = (containerId: string | null | undefined): string => {
        if (!containerId) return '';
        return containerPathsById.get(containerId) ?? '';
    };

    const mock = {
        createObjectRecord: vi.fn(async (record: StoredObjectRecord) => {
            storedRecords.set(record.id, { ...record });
            const pathKey = getContainerPath(record.containerId ?? null)
                ? `${getContainerPath(record.containerId ?? null)}/${record.name}`
                : record.name;
            pathToObjectId.set(pathKey, record.id);
            objectPathsById.set(record.id, pathKey);
        }),
        deleteObjectById: vi.fn(async (id: string) => {
            const key = stringifyId(id);
            const pathKey = objectPathsById.get(key);
            if (pathKey)
                pathToObjectId.delete(pathKey);
            storedRecords.delete(key);
        }),
        getOrCreateContainer: vi.fn(async (pathValue: string | string[]) => {
            const components = normalizeComponents(pathValue);
            if (!components.length)
                return null;
            let currentPath = '';
            let lastId: string | null = null;
            for (const component of components) {
                currentPath = currentPath ? `${currentPath}/${component}` : component;
                let containerId = containerIdsByPath.get(currentPath);
                if (!containerId) {
                    containerId = `container-${++containerCounter}`;
                    containerIdsByPath.set(currentPath, containerId);
                    containerPathsById.set(containerId, currentPath);
                }
                lastId = containerId;
            }
            return lastId;
        }),
        getOrCreateContainerWithBucket: vi.fn(async (pathValue: string | string[]) => {
            const containerId = await mock.getOrCreateContainer(pathValue);
            const components = normalizeComponents(pathValue);
            const bucketId = components.length ? containerIdsByPath.get(components[0]) ?? null : null;
            return { containerId, bucketId };
        }),
        getObjectByPath: vi.fn(async (pathValue: string) => {
            const normalized = pathValue.replace(/^\/+/, '');
            const components = normalized.split('/').filter(Boolean);
            const name = components.pop();
            if (!name) notFound();
            const containerPath = components.join('/');
            const key = containerPath ? `${containerPath}/${name}` : name;
            const objectId = pathToObjectId.get(key);
            if (!objectId) notFound();
            const record = storedRecords.get(objectId);
            if (!record) notFound();
            return { ...record };
        }),
        getObjectById: vi.fn(async (id: string) => {
            const key = stringifyId(id);
            const record = storedRecords.get(key);
            if (!record) notFound();
            return { ...record };
        }),
        reset: () => {
            storedRecords.clear();
            objectPathsById.clear();
            pathToObjectId.clear();
            containerIdsByPath.clear();
            containerPathsById.clear();
            containerCounter = 0;
            mock.createObjectRecord.mockClear();
            mock.deleteObjectById.mockClear();
            mock.getOrCreateContainer.mockClear();
            mock.getOrCreateContainerWithBucket.mockClear();
            mock.getObjectByPath.mockClear();
            mock.getObjectById.mockClear();
        }
    };

    return mock;
};

const databaseMock = createDatabaseMock();

vi.mock('../lib/database', () => ({
    database: databaseMock
}));

type HttpResponseDetails = {
    statusCode?: number;
    headers?: http.IncomingHttpHeaders;
    body: Buffer;
};

describe('HttpServer integration', () => {
    let nodeServer: http.Server;
    let serverPort: number;
    let tempRoot: string;
    let skipReason: string | null = null;

    beforeAll(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'strubs-http-'));
        for (const volumeId of [...planConfig.dataVolumes, ...planConfig.parityVolumes]) {
            if (fakeVolumes.has(volumeId)) continue;
            const volume = new FakeVolume(volumeId, path.join(tempRoot, String(volumeId)));
            await volume.init();
            fakeVolumes.set(volumeId, volume);
        }

        nodeServer = http.createServer();
        const { HttpServer } = await import('../lib/server/http/server');
        new HttpServer(0, nodeServer);

        try {
            await new Promise<void>((resolve, reject) => {
                nodeServer.once('listening', resolve);
                nodeServer.once('error', reject);
                nodeServer.listen(0, '127.0.0.1');
            });
        }
        catch (err) {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code === 'EPERM') {
                skipReason = 'Loopback sockets require elevated privileges.';
                return;
            }
            throw err;
        }

        const address = nodeServer.address() as AddressInfo;
        serverPort = address.port;
    });

    afterEach(async () => {
        if (skipReason)
            return;
        databaseMock.reset();
        plannerMock.generatePlan.mockClear();
        for (const volume of fakeVolumes.values())
            await volume.reset();
    });

    afterAll(async () => {
        if (nodeServer && !skipReason) {
            await new Promise<void>((resolve, reject) => {
                nodeServer.close(err => err ? reject(err) : resolve());
            });
        }
        await fs.rm(tempRoot, { recursive: true, force: true });
    });

    const makeRequest = (options: http.RequestOptions & { body?: Buffer | string }): Promise<HttpResponseDetails> => {
        const { body, ...rest } = options;
        return new Promise((resolve, reject) => {
            const request = http.request(
                {
                    hostname: '127.0.0.1',
                    ...rest,
                },
                response => {
                    const chunks: Buffer[] = [];
                    response.on('data', chunk => chunks.push(Buffer.from(chunk)));
                    response.on('end', () => {
                        resolve({
                            statusCode: response.statusCode ?? undefined,
                            headers: response.headers,
                            body: Buffer.concat(chunks),
                        });
                    });
                }
            );
            request.on('error', reject);
            if (body) request.write(body);
            request.end();
        });
    };

    const storeObject = async (targetPath: string, payload: Buffer, headers: Record<string, string> = {}) => {
        const response = await makeRequest({
            method: 'PUT',
            port: serverPort,
            path: targetPath,
            headers: {
                'content-length': String(payload.length),
                ...headers,
            },
            body: payload,
        });
        expect(response.statusCode).toBe(201);
        const objectIdHeader = response.headers?.['x-object-id'];
        const objectId = Array.isArray(objectIdHeader) ? objectIdHeader[0] : objectIdHeader;
        if (!objectId)
            throw new Error('PUT response missing x-object-id header');
        return { objectId, response };
    };

    const ensureNotSkipped = (ctx: TestContext): boolean => {
        if (skipReason) {
            ctx?.skip?.();
            return false;
        }
        return true;
    };

    it('stores and serves objects via PUT and GET', async (ctx: TestContext) => {
        if (!ensureNotSkipped(ctx))
            return;

        const body = Buffer.from('HTTP storage payload');
        await storeObject('/photos/image.bin', body);

        const getResponse = await makeRequest({
            method: 'GET',
            port: serverPort,
            path: '/photos/image.bin',
        });

        expect(getResponse.statusCode).toBe(200);
        expect(getResponse.body.equals(body)).toBe(true);
        expect(getResponse.headers).toMatchObject({
            'content-length': String(body.length),
            'accept-ranges': 'bytes',
        });
    });

    it('streams ranged GET responses after upload', async (ctx: TestContext) => {
        if (!ensureNotSkipped(ctx))
            return;

        const body = Buffer.from('abcdefghijklmnopqrstuvwxyz');
        await storeObject('/files/range.bin', body);

        const response = await makeRequest({
            method: 'GET',
            port: serverPort,
            path: '/files/range.bin',
            headers: {
                range: 'bytes=5-11',
            },
        });

        expect(response.statusCode).toBe(206);
        expect(response.body.toString()).toBe(body.toString('utf8', 5, 12));
        expect(response.headers).toMatchObject({
            'content-range': `bytes 5-11/${body.length}`,
        });
    });

    it('returns metadata via HEAD without transferring body', async (ctx: TestContext) => {
        if (!ensureNotSkipped(ctx))
            return;

        const body = Buffer.from('head request payload');
        const { objectId } = await storeObject('/exports/report.bin', body, { 'content-type': 'application/octet-stream' });

        const response = await makeRequest({
            method: 'HEAD',
            port: serverPort,
            path: '/exports/report.bin',
        });

        expect(response.statusCode).toBe(200);
        expect(response.body.length).toBe(0);
        expect(response.headers).toMatchObject({
            'x-object-id': objectId,
            'content-length': String(body.length),
            'x-data-slice-count': String(planConfig.dataSliceCount),
        });
    });

    it('deletes committed objects via HTTP DELETE', async (ctx: TestContext) => {
        if (!ensureNotSkipped(ctx))
            return;

        const body = Buffer.from('delete me');
        await storeObject('/trash/item.bin', body);

        const deleteResponse = await makeRequest({
            method: 'DELETE',
            port: serverPort,
            path: '/trash/item.bin',
        });

        expect(deleteResponse.statusCode).toBe(200);

        const missingResponse = await makeRequest({
            method: 'GET',
            port: serverPort,
            path: '/trash/item.bin',
        });
        expect(missingResponse.statusCode).toBe(404);
        expect(missingResponse.body.toString()).toBe('404');

        for (const volume of fakeVolumes.values()) {
            expect(await volume.listCommitted()).toHaveLength(0);
        }
    });
});
