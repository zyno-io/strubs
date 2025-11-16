import { EventEmitter } from 'events';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, HttpResponse } from '../lib/server/http/server';
import type { RawBlockDevice } from '../lib/io/device-discovery';

const ioManagerMock = {
    getVolumeEntries: vi.fn(),
    getVolume: vi.fn(),
    registerVolume: vi.fn(),
    softDeleteVolume: vi.fn(),
    updateVolumeFlags: vi.fn()
};

const httpHelpersMock = {
    getObjectMeta: vi.fn()
};

const listRawBlockDevicesMock = vi.fn();
const deviceProvisionerProvisionMock = vi.fn();
const verifyJobMock = {
    start: vi.fn(),
    stop: vi.fn(),
    getStatus: vi.fn()
};
const databaseSoftDeleteMock = vi.fn();
const databaseUpdateFlagsMock = vi.fn();

vi.mock('../lib/io/manager', () => ({
    ioManager: ioManagerMock
}));

vi.mock('../lib/server/http/helpers', () => ({
    HttpHelpers: httpHelpersMock
}));

vi.mock('../lib/io/device-discovery', async () => {
    const actual = await vi.importActual<typeof import('../lib/io/device-discovery')>('../lib/io/device-discovery');
    return {
        ...actual,
        listRawBlockDevices: listRawBlockDevicesMock
    };
});

vi.mock('../lib/io/device-provisioner', () => ({
    deviceProvisioner: {
        provision: deviceProvisionerProvisionMock
    }
}));

vi.mock('../lib/jobs/verify-job', () => ({
    verifyJob: verifyJobMock
}));

vi.mock('../lib/database', () => ({
    database: {
        softDeleteVolume: databaseSoftDeleteMock,
        updateVolumeFlags: databaseUpdateFlagsMock
    }
}));

let HttpMgmt: typeof import('../lib/server/http/mgmt').HttpMgmt;
let HttpNotFoundError: typeof import('../lib/server/http/errors').HttpNotFoundError;
let HttpBadRequestError: typeof import('../lib/server/http/errors').HttpBadRequestError;

beforeAll(async () => {
    ({ HttpMgmt } = await import('../lib/server/http/mgmt'));
    ({ HttpNotFoundError, HttpBadRequestError } = await import('../lib/server/http/errors'));
});

beforeEach(() => {
    vi.clearAllMocks();
    ioManagerMock.getVolumeEntries.mockReset();
    ioManagerMock.getVolume.mockReset();
    ioManagerMock.registerVolume.mockReset();
    ioManagerMock.softDeleteVolume.mockReset();
    ioManagerMock.updateVolumeFlags.mockReset();
    databaseSoftDeleteMock.mockReset();
    databaseUpdateFlagsMock.mockReset();
    listRawBlockDevicesMock.mockReset();
    deviceProvisionerProvisionMock.mockReset();
    verifyJobMock.start.mockReset();
    verifyJobMock.stop.mockReset();
    verifyJobMock.getStatus.mockReset();
    ioManagerMock.getVolumeEntries.mockReturnValue([]);
});

const createRequest = (method: string, url: string, body?: unknown): HttpRequest => {
    const emitter = new EventEmitter();
    const req = Object.assign(emitter, {
        method,
        url,
        headers: {},
        params: {},
        httpVersion: '',
        socket: {} as any,
        statusCode: undefined,
        statusMessage: undefined,
        setTimeout: (() => undefined) as any,
        destroy: (() => undefined) as any,
        readable: true,
        writable: true
    }) as HttpRequest & EventEmitter;

    if (body !== undefined) {
        const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
        process.nextTick(() => {
            req.emit('data', payload);
            req.emit('end');
        });
    }
    else {
        process.nextTick(() => req.emit('end'));
    }

    return req;
};

const nullResponse = {} as HttpResponse;

describe('HttpMgmt.handle', () => {
    it('returns serialized volume status', async () => {
        const volume = {
            uuid: 'vol-1',
            blockPath: '/dev/sda1',
            mountPoint: '/mnt/1',
            isMounted: true,
            isVerified: true,
            isStarted: true,
            isEnabled: true,
            isHealthy: true,
            isReadOnly: false,
            deviceSerial: 'SN123',
            partitionUuid: 'part-1',
            bytesTotal: 1024,
            bytesFree: 512,
            verifyErrors: null,
            isDeleted: false
        };

        ioManagerMock.getVolumeEntries.mockReturnValue([[1, volume]]);

        const response = await HttpMgmt.handle(1, createRequest('GET', '/$/volumes'), nullResponse);

        expect(response).toEqual([
            {
                id: 1,
                uuid: 'vol-1',
                blockPath: '/dev/sda1',
                mountPoint: '/mnt/1',
                isMounted: true,
                isVerified: true,
                isStarted: true,
                isEnabled: true,
                isHealthy: true,
                isReadOnly: false,
                deviceSerial: 'SN123',
                partitionUuid: 'part-1',
                bytesTotal: 1024,
                bytesFree: 512,
                verifyErrors: null,
                isDeleted: false,
                mountError: undefined
            }
        ]);
    });

    it('returns block device listings', async () => {
        const blockDevices: RawBlockDevice[] = [
            { name: 'sdb', path: '/dev/sdb', type: 'disk', size: 2048, children: [] },
            { name: 'sda', path: '/dev/sda', type: 'disk', size: 1024, children: [] }
        ];
        listRawBlockDevicesMock.mockResolvedValue(blockDevices);
        const { readlinkSync } = require('fs');
        const readlinkSpy = vi.spyOn(require('fs'), 'readlinkSync').mockImplementation((target: string) => {
            if (target === '/sys/block/sda')
                return '../devices/pci0000:00/sda';
            if (target === '/sys/block/sdb')
                return '../devices/pci0000:00/sdb';
            throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        });

        const response = await HttpMgmt.handle(3, createRequest('GET', '/$/blockDevices'), nullResponse);

        expect(response).toEqual([
            { ...blockDevices[1], sysfsPath: '/sys/block/devices/pci0000:00/sda' },
            { ...blockDevices[0], sysfsPath: '/sys/block/devices/pci0000:00/sdb' }
        ]);
        readlinkSpy.mockRestore();
    });

    it('sorts block devices by sysfs path when requested', async () => {
        const blockDevices: RawBlockDevice[] = [
            { name: 'sda', path: '/dev/sda', type: 'disk', size: 1024, children: [] },
            { name: 'sdb', path: '/dev/sdb', type: 'disk', size: 2048, children: [] }
        ];
        listRawBlockDevicesMock.mockResolvedValue(blockDevices);
        const readlinkSpy = vi.spyOn(require('fs'), 'readlinkSync').mockImplementation((target: string) => {
            if (target === '/sys/block/sda')
                return '../devices/pci0000:00/slot2';
            if (target === '/sys/block/sdb')
                return '../devices/pci0000:00/slot1';
            throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        });

        const req = createRequest('GET', '/$/blockDevices');
        req.params.sort = 'sysfsPath';
        const response = await HttpMgmt.handle(4, req, nullResponse);

        expect(response).toEqual([
            { ...blockDevices[1], sysfsPath: '/sys/block/devices/pci0000:00/slot1' },
            { ...blockDevices[0], sysfsPath: '/sys/block/devices/pci0000:00/slot2' }
        ]);
        readlinkSpy.mockRestore();
    });

    it('sorts block devices by size when requested', async () => {
        const blockDevices: RawBlockDevice[] = [
            { name: 'sdb', path: '/dev/sdb', type: 'disk', size: 2048, children: [] },
            { name: 'sda', path: '/dev/sda', type: 'disk', size: 1024, children: [] }
        ];
        listRawBlockDevicesMock.mockResolvedValue(blockDevices);

        const req = createRequest('GET', '/$/blockDevices');
        req.params.sort = 'size';
        const response = await HttpMgmt.handle(5, req, nullResponse);

        expect(response.map(device => device.name)).toEqual(['sda', 'sdb']);
    });

    it('returns array state in status endpoint', async () => {
        const volume1 = {
            uuid: 'vol-1',
            blockPath: null,
            mountPoint: null,
            isMounted: false,
            isVerified: false,
            isStarted: false,
            isEnabled: true,
            isHealthy: true,
            isReadOnly: false,
            deviceSerial: 'SN1',
            partitionUuid: 'part-1',
            bytesTotal: 100,
            bytesFree: 50,
            bytesUsedData: 40,
            bytesUsedParity: 10,
            verifyErrors: { checksum: 1, total: 2 },
            isDeleted: false,
            mountError: 'failed to mount'
        };
        const volume2 = {
            uuid: 'vol-2',
            blockPath: '/dev/sdb1',
            mountPoint: '/mnt/2',
            isMounted: true,
            isVerified: true,
            isStarted: true,
            isEnabled: false,
            isHealthy: true,
            isReadOnly: true,
            deviceSerial: 'SN2',
            partitionUuid: 'part-2',
            bytesTotal: 200,
            bytesFree: 100,
            bytesUsedData: 80,
            bytesUsedParity: 0,
            verifyErrors: null,
            isDeleted: false,
            mountError: null
        };
        ioManagerMock.getVolumeEntries.mockReturnValue([[1, volume1], [2, volume2]]);

        const response = await HttpMgmt.handle(5, createRequest('GET', '/$/status'), nullResponse);

        expect(response).toEqual({
            availableVolumeIds: [2],
            unavailableVolumeIds: [1],
            disabledVolumeIds: [2],
            readOnlyVolumeIds: [2],
            verifyErrors: { '1': { checksum: 1, total: 2 } },
            gbStored: 80 / (1024 ** 3),
            gbCapacity: 200 / (1024 ** 3),
            gbFree: 100 / (1024 ** 3)
        });
    });

    it('creates a new volume when provisioning a block device', async () => {
        deviceProvisionerProvisionMock.mockResolvedValue({
            id: 2,
            uuid: 'new-vol',
            enabled: true,
            healthy: true,
            read_only: false,
            disk_serial: 'SERNEW',
            partition_uuid: 'PART-UUID',
            partition_size: 2048,
            data_size: 0,
            parity_size: 0
        });

        ioManagerMock.getVolume.mockReturnValue({
            uuid: 'vol-uuid',
            blockPath: '/dev/disk/by-uuid/PART-UUID',
            mountPoint: '/run/strubs2/mounts/vol-uuid',
            isMounted: true,
            isVerified: true,
            isStarted: true,
            isEnabled: true,
            isHealthy: true,
            isReadOnly: false,
            deviceSerial: 'SERNEW',
            partitionUuid: 'PART-UUID',
            bytesTotal: 2048,
            bytesFree: 2048
        });

        const response = await HttpMgmt.handle(
            10,
            createRequest('POST', '/$/volumes', { blockPath: '/dev/sdb' }),
            nullResponse
        );

        expect(deviceProvisionerProvisionMock).toHaveBeenCalledWith({ blockPath: '/dev/sdb', wipe: undefined, replace: undefined });
        expect(response).toMatchObject({
            id: 2,
            deviceSerial: 'SERNEW',
            partitionUuid: 'PART-UUID'
        });
    });

    it('validates wipe timestamp input', async () => {
        await expect(HttpMgmt.handle(
            12,
            createRequest('POST', '/$/volumes', { blockPath: '/dev/sdb', wipe: 'not-a-timestamp' }),
            nullResponse
        )).rejects.toBeInstanceOf(HttpBadRequestError);

        const stale = Date.now() - 20000;
        await expect(HttpMgmt.handle(
            12,
            createRequest('POST', '/$/volumes', { blockPath: '/dev/sdb', wipe: stale }),
            nullResponse
        )).rejects.toBeInstanceOf(HttpBadRequestError);

        expect(deviceProvisionerProvisionMock).not.toHaveBeenCalled();
    });

    it('validates replace input types', async () => {
        await expect(HttpMgmt.handle(
            13,
            createRequest('POST', '/$/volumes', { blockPath: '/dev/sdb', replace: 'yes' }),
            nullResponse
        )).rejects.toBeInstanceOf(HttpBadRequestError);

        expect(deviceProvisionerProvisionMock).not.toHaveBeenCalled();
    });

    it('rejects provisioning when the device already has partitions', async () => {
        deviceProvisionerProvisionMock.mockRejectedValue(new HttpBadRequestError('block device already partitioned'));

        await expect(HttpMgmt.handle(
            11,
            createRequest('POST', '/$/volumes', { blockPath: '/dev/sdc', wipe: Date.now(), replace: true }),
            nullResponse
        )).rejects.toBeInstanceOf(HttpBadRequestError);

        expect(deviceProvisionerProvisionMock).toHaveBeenCalledWith({ blockPath: '/dev/sdc', wipe: true, replace: true });
    });

    it('resolves file info requests with slice locations', async () => {
        const objectMeta = {
            id: '0123456789abcdef01234567',
            containerId: 'root',
            md5: Buffer.from('beef', 'hex'),
            mime: 'image/jpeg',
            dataVolumes: [1, 2],
            parityVolumes: [3],
            chunkSize: 16384
        };

        httpHelpersMock.getObjectMeta.mockResolvedValue(objectMeta);

        const volumePaths = ['/data/0', '/data/1'];
        const parityPaths = ['/parity/0'];

        ioManagerMock.getVolume.mockImplementation((id: number) => ({
            getCommitedPath: vi.fn().mockResolvedValue(
                id <= objectMeta.dataVolumes.length
                    ? volumePaths[id - 1]
                    : parityPaths[id - objectMeta.dataVolumes.length - 1]
            )
        }));

        const response = await HttpMgmt.handle(2, createRequest('GET', '/$/fileInfo/photos/cat.jpg'), nullResponse);

        expect(response).toEqual({
            'X-Object-Id': objectMeta.id,
            'X-Container-Id': objectMeta.containerId,
            'Content-MD5': objectMeta.md5.toString('hex'),
            'Content-Type': objectMeta.mime,
            'X-Data-Slice-Count': 2,
            'X-Data-Slice-Volumes': objectMeta.dataVolumes,
            'X-Parity-Slice-Count': 1,
            'X-Parity-Slice-Volumes': objectMeta.parityVolumes,
            'X-Chunk-Size': objectMeta.chunkSize,
            slicePaths: volumePaths,
            parityPaths
        });

        expect(ioManagerMock.getVolume).toHaveBeenCalledTimes(3);
        expect(httpHelpersMock.getObjectMeta).toHaveBeenCalledWith('/photos/cat.jpg');
    });

    it('returns error entries when a volume is missing', async () => {
        const objectMeta = {
            id: 'fedcba987654321001234567',
            containerId: null,
            md5: null,
            mime: undefined,
            dataVolumes: [10],
            parityVolumes: [11],
            chunkSize: 4096
        };

        httpHelpersMock.getObjectMeta.mockResolvedValue(objectMeta);
        ioManagerMock.getVolume.mockReturnValue(undefined);

        const response = await HttpMgmt.handle(5, createRequest('GET', '/$/fileInfo/logs/system'), nullResponse);

        expect(response.slicePaths).toEqual(['Error: volume 10 not found']);
        expect(response.parityPaths).toEqual(['Error: volume 11 not found']);
    });

    it('captures errors encountered while resolving slice paths', async () => {
        const objectMeta = {
            id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
            containerId: 'root',
            md5: null,
            mime: undefined,
            dataVolumes: [1],
            parityVolumes: [],
            chunkSize: 8192
        };

        httpHelpersMock.getObjectMeta.mockResolvedValue(objectMeta);
        ioManagerMock.getVolume.mockReturnValue({
            getCommitedPath: vi.fn().mockRejectedValue(new Error('disk offline'))
        });

        const response = await HttpMgmt.handle(6, createRequest('GET', '/$/fileInfo/errors'), nullResponse);

        expect(response.slicePaths).toEqual(['Error: Error: disk offline']);
        expect(response.parityPaths).toEqual([]);
    });

    it('uses the provided leading slash when the fileinfo path includes one', async () => {
        const objectMeta = {
            id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
            containerId: null,
            md5: null,
            mime: undefined,
            dataVolumes: [1],
            parityVolumes: [2],
            chunkSize: 1024
        };

        httpHelpersMock.getObjectMeta.mockResolvedValue(objectMeta);
        ioManagerMock.getVolume.mockReturnValue({
            getCommitedPath: vi.fn().mockResolvedValue('/data/vol')
        });

        await HttpMgmt.handle(7, createRequest('GET', '/$/fileInfo///logs/system.log'), nullResponse);

        expect(httpHelpersMock.getObjectMeta).toHaveBeenLastCalledWith('//logs/system.log');
    });

    it('throws HttpNotFoundError for unknown management routes', async () => {
        await expect(HttpMgmt.handle(3, createRequest('GET', '/$/unknown'), nullResponse))
            .rejects.toBeInstanceOf(HttpNotFoundError);
    });

    it('starts the verify job via POST', async () => {
        verifyJobMock.start.mockResolvedValue({ startedAt: '2024-01-01T00:00:00.000Z' });
        const response = await HttpMgmt.handle(12, createRequest('POST', '/$/jobs/verify'), nullResponse);
        expect(response).toEqual({ startedAt: '2024-01-01T00:00:00.000Z' });
        expect(verifyJobMock.start).toHaveBeenCalledTimes(1);
    });

    it('starts the verify job with a volume filter when provided', async () => {
        verifyJobMock.start.mockResolvedValue({ startedAt: '2024-01-02T00:00:00.000Z' });
        const response = await HttpMgmt.handle(17, createRequest('POST', '/$/jobs/verify', { volumeIds: [3, 3, 4] }), nullResponse);
        expect(response).toEqual({ startedAt: '2024-01-02T00:00:00.000Z' });
        expect(verifyJobMock.start).toHaveBeenCalledWith({ volumeIds: [3, 4] });
    });

    it('rejects invalid volume filter payloads', async () => {
        await expect(HttpMgmt.handle(18, createRequest('POST', '/$/jobs/verify', { volumeIds: ['bad'] }), nullResponse))
            .rejects.toBeInstanceOf(HttpBadRequestError);
        expect(verifyJobMock.start).not.toHaveBeenCalled();
    });

    it('stops the verify job via DELETE', async () => {
        verifyJobMock.stop.mockResolvedValue(undefined);
        const response = await HttpMgmt.handle(13, createRequest('DELETE', '/$/jobs/verify'), nullResponse);
        expect(response).toEqual({ stopped: true });
        expect(verifyJobMock.stop).toHaveBeenCalledTimes(1);
    });

    it('returns verify job status via GET', async () => {
        verifyJobMock.getStatus.mockReturnValue({ running: true, startedAt: 't', objectsVerified: 5, errors: { total: 2, volumes: { '1': 2 } } });
        const response = await HttpMgmt.handle(14, createRequest('GET', '/$/jobs/verify'), nullResponse);
        expect(response).toEqual({ running: true, startedAt: 't', objectsVerified: 5, errors: { total: 2, volumes: { '1': 2 } } });
        expect(verifyJobMock.getStatus).toHaveBeenCalledTimes(1);
    });

    it('soft deletes volumes via DELETE', async () => {
        const req = createRequest('DELETE', '/$/volumes/3');
        databaseSoftDeleteMock.mockResolvedValue(undefined);
        ioManagerMock.softDeleteVolume.mockResolvedValue(undefined);
        const response = await HttpMgmt.handle(15, req, nullResponse);
        expect(response).toEqual({ deleted: true });
        expect(databaseSoftDeleteMock).toHaveBeenCalledWith(3);
        expect(ioManagerMock.softDeleteVolume).toHaveBeenCalledWith(3);
    });

    it('updates volume flags via PUT', async () => {
        const req = createRequest('PUT', '/$/volumes/4', { isEnabled: false, isReadOnly: true });
        databaseUpdateFlagsMock.mockResolvedValue(undefined);
        ioManagerMock.updateVolumeFlags.mockResolvedValue(undefined);

        const response = await HttpMgmt.handle(16, req, nullResponse);

        expect(response).toEqual({ updated: true });
        expect(databaseUpdateFlagsMock).toHaveBeenCalledWith(4, { isEnabled: false, isReadOnly: true });
        expect(ioManagerMock.updateVolumeFlags).toHaveBeenCalledWith(4, { isEnabled: false, isReadOnly: true });
    });

    it('throws HttpNotFoundError when file metadata cannot be resolved', async () => {
        httpHelpersMock.getObjectMeta.mockResolvedValue(null);
        await expect(HttpMgmt.handle(4, createRequest('GET', '/$/fileInfo/missing'), nullResponse))
            .rejects.toBeInstanceOf(HttpNotFoundError);
    });
});
    it('optionally includes deleted volumes', async () => {
        const active = {
            uuid: 'vol-1',
            blockPath: '/dev/sda1',
            mountPoint: null,
            isMounted: false,
            isVerified: false,
            isStarted: false,
            isEnabled: true,
            isHealthy: true,
            isReadOnly: false,
            deviceSerial: 'SN123',
            partitionUuid: 'part-1',
            bytesTotal: 100,
            bytesFree: 50,
            verifyErrors: null,
            isDeleted: false
        };
        const deleted = { ...active, uuid: 'vol-2', isDeleted: true };
        ioManagerMock.getVolumeEntries.mockReturnValue([[1, active], [2, deleted]]);

        const req = createRequest('GET', '/$/volumes');
        const defaultResult = await HttpMgmt.handle(2, req, nullResponse);
        expect(defaultResult).toHaveLength(1);

        const includeReq = createRequest('GET', '/$/volumes');
        includeReq.params.includeDeleted = 'true';
        const included = await HttpMgmt.handle(3, includeReq, nullResponse);
        expect(included).toHaveLength(2);
    });
