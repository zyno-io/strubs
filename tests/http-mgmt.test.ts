import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, HttpResponse } from '../lib/server/http/server';

const ioManagerMock = {
    getVolumeEntries: vi.fn(),
    getVolume: vi.fn(),
    registerVolume: vi.fn(),
    softDeleteVolume: vi.fn(),
    updateVolumeFlags: vi.fn(),
    getCachedDevices: vi.fn(),
    reloadBlockDevices: vi.fn()
};

const httpHelpersMock = {
    getObjectMeta: vi.fn()
};

const deviceProvisionerProvisionMock = vi.fn();
const verifyVolumesJobMock = {
    start: vi.fn(),
    stop: vi.fn(),
    getStatus: vi.fn()
};
const verifyFileJobMock = {
    verify: vi.fn()
};
const storageStatsTrackerMock = {
    getSnapshot: vi.fn(),
    reconcile: vi.fn()
};
const databaseSoftDeleteMock = vi.fn();
const databaseUpdateFlagsMock = vi.fn();
const volumeSmartMonitorMock = {
    getSummary: vi.fn(),
    getInfo: vi.fn()
};

vi.mock('../lib/io/manager', () => ({
    ioManager: ioManagerMock
}));

vi.mock('../lib/server/http/helpers', () => ({
    HttpHelpers: httpHelpersMock
}));

vi.mock('../lib/io/device-provisioner', () => ({
    deviceProvisioner: {
        provision: deviceProvisionerProvisionMock
    }
}));

vi.mock('../lib/jobs/verify-volumes-job', () => ({
    verifyVolumesJob: verifyVolumesJobMock
}));

vi.mock('../lib/jobs/verify-file-job', () => ({
    verifyFileJob: verifyFileJobMock
}));

vi.mock('../lib/storage/stats-tracker', () => ({
    storageStatsTracker: storageStatsTrackerMock
}));

const databaseCountOnVolumeMock = vi.fn().mockResolvedValue(0);
vi.mock('../lib/database', () => ({
    database: {
        softDeleteVolume: databaseSoftDeleteMock,
        updateVolumeFlags: databaseUpdateFlagsMock,
        countObjectsOnVolume: databaseCountOnVolumeMock
    }
}));

const evictStartMock = vi.fn().mockResolvedValue(undefined);
const evictStopMock = vi.fn();
vi.mock('../lib/jobs/evict-volume-job', () => ({
    evictVolumeJob: {
        start: evictStartMock,
        stop: evictStopMock,
        evictingVolumeId: () => null,
        resumePendingJob: vi.fn()
    }
}));

const rebalanceStartMock = vi.fn().mockResolvedValue(undefined);
const rebalanceCancelMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/jobs/rebalance-job', () => ({
    rebalanceJob: {
        start: rebalanceStartMock,
        cancel: rebalanceCancelMock,
        stop: vi.fn(),
        isRunning: () => false,
        resumePendingJob: vi.fn()
    }
}));

vi.mock('../lib/io/volume-smart-monitor', () => ({
    volumeSmartMonitor: volumeSmartMonitorMock
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
    ioManagerMock.getCachedDevices.mockReset();
    ioManagerMock.reloadBlockDevices.mockReset();
    databaseSoftDeleteMock.mockReset();
    databaseUpdateFlagsMock.mockReset();
    deviceProvisionerProvisionMock.mockReset();
    verifyVolumesJobMock.start.mockReset();
    verifyVolumesJobMock.stop.mockReset();
    verifyVolumesJobMock.getStatus.mockReset();
    verifyFileJobMock.verify.mockReset();
    storageStatsTrackerMock.getSnapshot.mockReset();
    storageStatsTrackerMock.reconcile.mockReset();
    ioManagerMock.getVolumeEntries.mockReturnValue([]);
    ioManagerMock.getCachedDevices.mockReturnValue([]);
    const summary = {
        updatedAt: '2023-01-01T00:00:00.000Z',
        isHealthy: true,
        temperatureC: 35,
        powerOnHours: 1000,
        error: null,
        statusFlags: [],
        isSupported: true
    };
    volumeSmartMonitorMock.getSummary.mockReturnValue(summary);
    volumeSmartMonitorMock.getInfo.mockReturnValue({
        summary,
        details: { smart_status: { passed: true } }
    });
    storageStatsTrackerMock.getSnapshot.mockResolvedValue({
        updatedAt: new Date('2026-06-14T00:00:00.000Z'),
        system: {
            objectCount: 0,
            logicalBytes: 0,
            dataSliceCount: 0,
            paritySliceCount: 0,
            dataBytes: 0,
            parityBytes: 0,
            physicalBytes: 0,
            unavailableObjectCount: 0,
            unavailableLogicalBytes: 0
        },
        volumes: {}
    });
    storageStatsTrackerMock.reconcile.mockResolvedValue(undefined);
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
    it('POST /$/notify/test delivers a test notification and reports transports', async () => {
        const response = await HttpMgmt.handle(
            99,
            createRequest('POST', '/$/notify/test', { severity: 'warning', title: 'hello' }),
            nullResponse
        ) as { delivered: string[]; failed: unknown[]; suppressed: boolean; transports: string[] };

        // No transports are registered in the unit-test process, so nothing is
        // delivered, but the route must resolve and return the expected shape.
        expect(response).toMatchObject({ delivered: [], failed: [], suppressed: false });
        expect(Array.isArray(response.transports)).toBe(true);
    });

    it('GET /$/faults returns the current fault list', async () => {
        const response = await HttpMgmt.handle(98, createRequest('GET', '/$/faults'), nullResponse) as { faults: unknown[] };
        expect(response).toHaveProperty('faults');
        expect(Array.isArray(response.faults)).toBe(true);
    });

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
            deviceModel: 'DiskModel',
            deviceVendor: 'DiskVendor',
            partitionUuid: 'part-1',
            label: 'Primary',
            bytesTotal: 1024,
            bytesFree: 512,
            verifyErrors: null,
            isDeleted: false,
            mountError: null
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
                deviceModel: 'DiskModel',
                deviceVendor: 'DiskVendor',
                partitionUuid: 'part-1',
                busGroup: null,
                label: 'Primary',
                comment: null,
                bytesTotal: 1024,
                bytesFree: 512,
                verifyErrors: null,
                isDeleted: false,
                mountError: null,
                isSmartHealthy: true,
                smartInfoSummary: {
                    updatedAt: '2023-01-01T00:00:00.000Z',
                    isHealthy: true,
                    temperatureC: 35,
                    powerOnHours: 1000,
                    error: null,
                    statusFlags: [],
                    isSupported: true
                }
            }
        ]);
    });

    it('returns detailed volume SMART info when requested', async () => {
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
            isDeleted: false,
            mountError: null
        };

        ioManagerMock.getVolume.mockReturnValue(volume);

        const response = await HttpMgmt.handle(2, createRequest('GET', '/$/volumes/1'), nullResponse);

        expect(response).toMatchObject({
            id: 1,
            smartInfo: {
                summary: {
                    updatedAt: '2023-01-01T00:00:00.000Z',
                    isHealthy: true,
                    temperatureC: 35,
                    powerOnHours: 1000,
                    error: null,
                    statusFlags: [],
                    isSupported: true
                },
                details: { smart_status: { passed: true } }
            }
        });
        expect(ioManagerMock.getVolume).toHaveBeenCalledWith(1);
        expect(volumeSmartMonitorMock.getInfo).toHaveBeenCalledWith(1);
    });

    it('omits SMART fields when the device does not support SMART', async () => {
        const summary = {
            updatedAt: '2023-01-01T00:00:00.000Z',
            isHealthy: null,
            temperatureC: null,
            powerOnHours: null,
            error: null,
            statusFlags: [],
            isSupported: false
        };
        const smartInfo = {
            summary,
            details: { smart_support: { available: false } }
        };
        volumeSmartMonitorMock.getSummary.mockReturnValueOnce(summary);
        volumeSmartMonitorMock.getInfo.mockReturnValueOnce(smartInfo);
        ioManagerMock.getVolumeEntries.mockReturnValue([[1, {
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
                deviceModel: 'DiskModel',
                deviceVendor: 'DiskVendor',
                partitionUuid: 'part-1',
                label: 'Primary',
                bytesTotal: 1024,
                bytesFree: 512,
                verifyErrors: null,
            isDeleted: false,
            mountError: null
        }]]);

        const response = await HttpMgmt.handle(10, createRequest('GET', '/$/volumes'), nullResponse);

        expect(response[0]?.isSmartHealthy).toBeNull();
        expect(response[0]?.smartInfoSummary).toBeNull();
    });

    it('returns block device listings', async () => {
        const cachedDevices = [
            {
                sysfsPath: '../devices/pci0000:00/slot2',
                name: 'sdb',
                model: 'DiskB',
                vendor: 'VendorB',
                serial: 'SNB',
                byIdPaths: [],
                partitionTableUuid: 'uuid-b',
                partitionTableType: 'gpt',
                size: 2048,
                partitions: [
                    { name: 'sdb1', path: '/dev/sdb1', uuid: 'part-b', size: 1024, fsType: 'ext4', mountPoint: '/mnt/data' }
                ],
                smartInfo: { serial_number: 'SNB' },
                busGroup: 2
            },
            {
                sysfsPath: '../devices/pci0000:00/slot1',
                name: 'sda',
                model: 'DiskA',
                vendor: 'VendorA',
                serial: 'SNA',
                byIdPaths: [],
                partitionTableUuid: 'uuid-a',
                partitionTableType: 'gpt',
                size: 1024,
                partitions: [],
                smartInfo: { serial_number: 'SNA' },
                busGroup: 1
            }
        ];
        ioManagerMock.getCachedDevices.mockReturnValue(cachedDevices);
        ioManagerMock.getVolumeEntries.mockReturnValue([
            [5, { partitionUuid: 'part-b', label: 'Data' }]
        ]);

        const response = await HttpMgmt.handle(3, createRequest('GET', '/$/blockDevices'), nullResponse);

        expect(response).toEqual([
            {
                name: 'sda',
                path: '/dev/sda',
                type: 'disk',
                size: 1024,
                model: 'DiskA',
                vendor: 'VendorA',
                serial: 'SNA',
                ptuuid: 'uuid-a',
                pttype: 'gpt',
                sysfsPath: '/sys/block/devices/pci0000:00/slot1',
                busGroup: 1,
                volumeId: undefined,
                volumeLabel: undefined,
                children: []
            },
            {
                name: 'sdb',
                path: '/dev/sdb',
                type: 'disk',
                size: 2048,
                model: 'DiskB',
                vendor: 'VendorB',
                serial: 'SNB',
                ptuuid: 'uuid-b',
                pttype: 'gpt',
                sysfsPath: '/sys/block/devices/pci0000:00/slot2',
                busGroup: 2,
                volumeId: 5,
                volumeLabel: 'Data',
                children: [
                    {
                        type: 'part',
                        name: 'sdb1',
                        path: '/dev/sdb1',
                        uuid: 'part-b',
                        size: 1024,
                        fstype: 'ext4',
                        mountpoint: '/mnt/data'
                    }
                ]
            }
        ]);
    });

    it('sorts block devices by sysfs path when requested', async () => {
        const cachedDevices = [
            {
                sysfsPath: '../devices/pci0000:00/b',
                name: 'sdb',
                model: 'DiskB',
                vendor: 'VendorB',
                serial: 'SNB',
                byIdPaths: [],
                partitionTableUuid: 'uuid-b',
                partitionTableType: 'gpt',
                size: 2048,
                partitions: [],
                smartInfo: { serial_number: 'SNB' },
                busGroup: 2
            },
            {
                sysfsPath: '../devices/pci0000:00/a',
                name: 'sda',
                model: 'DiskA',
                vendor: 'VendorA',
                serial: 'SNA',
                byIdPaths: [],
                partitionTableUuid: 'uuid-a',
                partitionTableType: 'gpt',
                size: 1024,
                partitions: [],
                smartInfo: { serial_number: 'SNA' },
                busGroup: 1
            }
        ];
        ioManagerMock.getCachedDevices.mockReturnValue(cachedDevices);

        const req = createRequest('GET', '/$/blockDevices');
        req.params.sort = 'sysfsPath';
        const response = await HttpMgmt.handle(4, req, nullResponse);

        expect(response.map(device => device.name)).toEqual(['sda', 'sdb']);
    });

    it('omits deleted volumes when associating block devices', async () => {
        const cachedDevices = [
            {
                sysfsPath: '../devices/pci0000:00/a',
                name: 'sda',
                model: 'DiskA',
                vendor: 'VendorA',
                serial: 'SNA',
                byIdPaths: [],
                partitionTableUuid: 'uuid-a',
                partitionTableType: 'gpt',
                size: 1024,
                partitions: [
                    { name: 'sda1', path: '/dev/sda1', uuid: 'part-a', size: 1024, fsType: 'ext4', mountPoint: null }
                ],
                smartInfo: { serial_number: 'SNA' },
                busGroup: 1
            }
        ];
        ioManagerMock.getCachedDevices.mockReturnValue(cachedDevices);
        ioManagerMock.getVolumeEntries.mockReturnValue([
            [3, { partitionUuid: 'part-a', label: 'Archive', isDeleted: true }]
        ]);

        const response = await HttpMgmt.handle(6, createRequest('GET', '/$/blockDevices'), nullResponse);
        expect(response[0].volumeId).toBeUndefined();
        expect(response[0].volumeLabel).toBeUndefined();
    });

    it('sorts block devices by size when requested', async () => {
        const cachedDevices = [
            {
                sysfsPath: '../devices/pci0000:00/a',
                name: 'sdb',
                model: 'DiskB',
                vendor: 'VendorB',
                serial: 'SNB',
                byIdPaths: [],
                partitionTableUuid: 'uuid-b',
                partitionTableType: 'gpt',
                size: 2048,
                partitions: [],
                smartInfo: { serial_number: 'SNB' },
                busGroup: 2
            },
            {
                sysfsPath: '../devices/pci0000:00/b',
                name: 'sda',
                model: 'DiskA',
                vendor: 'VendorA',
                serial: 'SNA',
                byIdPaths: [],
                partitionTableUuid: 'uuid-a',
                partitionTableType: 'gpt',
                size: 1024,
                partitions: [],
                smartInfo: { serial_number: 'SNA' },
                busGroup: 1
            }
        ];
        ioManagerMock.getCachedDevices.mockReturnValue(cachedDevices);

        const req = createRequest('GET', '/$/blockDevices');
        req.params.sort = 'size';
        const response = await HttpMgmt.handle(5, req, nullResponse);

        expect(response.map(device => device.name)).toEqual(['sda', 'sdb']);
    });

    it('sorts block devices by volume metadata when requested', async () => {
        const cachedDevices = [
            {
                sysfsPath: '../devices/pci0000:00/a',
                name: 'sda',
                model: 'DiskA',
                vendor: 'VendorA',
                serial: 'SNA',
                byIdPaths: [],
                partitionTableUuid: 'uuid-a',
                partitionTableType: 'gpt',
                size: 1024,
                partitions: [
                    { name: 'sda1', path: '/dev/sda1', uuid: 'part-a', size: 1024, fsType: 'ext4', mountPoint: null }
                ],
                smartInfo: { serial_number: 'SNA' },
                busGroup: 1
            },
            {
                sysfsPath: '../devices/pci0000:00/b',
                name: 'sdb',
                model: 'DiskB',
                vendor: 'VendorB',
                serial: 'SNB',
                byIdPaths: [],
                partitionTableUuid: 'uuid-b',
                partitionTableType: 'gpt',
                size: 2048,
                partitions: [
                    { name: 'sdb1', path: '/dev/sdb1', uuid: 'part-b', size: 2048, fsType: 'ext4', mountPoint: null }
                ],
                smartInfo: { serial_number: 'SNB' },
                busGroup: 2
            }
        ];
        ioManagerMock.getCachedDevices.mockReturnValue(cachedDevices);
        ioManagerMock.getVolumeEntries.mockReturnValue([
            [5, { partitionUuid: 'part-b', label: 'Backup' }],
            [3, { partitionUuid: 'part-a', label: 'Archive' }]
        ]);

        const reqId = createRequest('GET', '/$/blockDevices');
        reqId.params.sort = 'volumeId';
        const sortedById = await HttpMgmt.handle(6, reqId, nullResponse);
        expect(sortedById.map(device => device.volumeId)).toEqual([3, 5]);

        const reqLabel = createRequest('GET', '/$/blockDevices');
        reqLabel.params.sort = 'volumeLabel';
        const sortedByLabel = await HttpMgmt.handle(7, reqLabel, nullResponse);
        expect(sortedByLabel.map(device => device.volumeLabel)).toEqual(['Archive', 'Backup']);
    });

    it('reloads block devices when requested', async () => {
        const cachedDevices = [
            {
                sysfsPath: '../devices/pci0000:00/a',
                name: 'sda',
                model: 'DiskA',
                vendor: 'VendorA',
                serial: 'SNA',
                byIdPaths: [],
                partitionTableUuid: 'uuid-a',
                partitionTableType: 'gpt',
                size: 1024,
                partitions: [],
                smartInfo: { serial_number: 'SNA' },
                busGroup: 1
            }
        ];
        ioManagerMock.getCachedDevices.mockReturnValue(cachedDevices);
        ioManagerMock.reloadBlockDevices.mockResolvedValue(cachedDevices);

        const response = await HttpMgmt.handle(6, createRequest('POST', '/$/blockDevices/reload'), nullResponse);

        expect(ioManagerMock.reloadBlockDevices).toHaveBeenCalledTimes(1);
        expect(response).toEqual([
            {
                name: 'sda',
                path: '/dev/sda',
                type: 'disk',
                size: 1024,
                model: 'DiskA',
                vendor: 'VendorA',
                serial: 'SNA',
                ptuuid: 'uuid-a',
                pttype: 'gpt',
                sysfsPath: '/sys/block/devices/pci0000:00/a',
                busGroup: 1,
                children: []
            }
        ]);
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

    it('returns cached storage stats', async () => {
        const snapshot = {
            updatedAt: new Date('2026-06-14T00:00:00.000Z'),
            system: {
                objectCount: 2,
                logicalBytes: 100,
                dataSliceCount: 4,
                paritySliceCount: 2,
                dataBytes: 160,
                parityBytes: 80,
                physicalBytes: 240,
                unavailableObjectCount: 1,
                unavailableLogicalBytes: 25
            },
            volumes: {
                '1': {
                    objectCount: 2,
                    logicalBytes: 100,
                    dataSliceCount: 2,
                    paritySliceCount: 0,
                    dataBytes: 80,
                    parityBytes: 0,
                    physicalBytes: 80
                }
            }
        };
        storageStatsTrackerMock.getSnapshot.mockResolvedValue(snapshot);

        const response = await HttpMgmt.handle(23, createRequest('GET', '/$/storage-stats'), nullResponse);

        expect(response).toBe(snapshot);
        expect(storageStatsTrackerMock.reconcile).not.toHaveBeenCalled();
    });

    it('reconciles storage stats on demand when the cache is missing', async () => {
        const snapshot = {
            updatedAt: new Date('2026-06-14T00:00:00.000Z'),
            system: {
                objectCount: 0,
                logicalBytes: 0,
                dataSliceCount: 0,
                paritySliceCount: 0,
                dataBytes: 0,
                parityBytes: 0,
                physicalBytes: 0,
                unavailableObjectCount: 0,
                unavailableLogicalBytes: 0
            },
            volumes: {}
        };
        storageStatsTrackerMock.getSnapshot
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(snapshot);

        const response = await HttpMgmt.handle(24, createRequest('GET', '/$/storage-stats'), nullResponse);

        expect(storageStatsTrackerMock.reconcile).toHaveBeenCalledTimes(1);
        expect(response).toBe(snapshot);
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

    describe('ui routes', () => {
        it('serves the ui index document', async () => {
            const html = Buffer.from('<html></html>');
            const readSpy = vi.spyOn(fs, 'readFile').mockResolvedValueOnce(html);
            const response = await HttpMgmt.handle(30, createRequest('GET', '/$/ui'), nullResponse);
            expect(readSpy).toHaveBeenCalledWith(path.resolve(process.cwd(), 'ui', 'dist', 'index.html'));
            expect(response).toEqual({
                body: html,
                headers: {
                    'content-type': 'text/html; charset=utf-8',
                    'cache-control': 'no-store'
                }
            });
            readSpy.mockRestore();
        });

        it('serves nested assets with appropriate content type', async () => {
            const script = Buffer.from('console.log("hi")');
            const readSpy = vi.spyOn(fs, 'readFile').mockResolvedValueOnce(script);
            const response = await HttpMgmt.handle(31, createRequest('GET', '/$/ui/assets/app.js'), nullResponse);
            expect(readSpy).toHaveBeenCalledWith(path.resolve(process.cwd(), 'ui', 'dist', 'assets', 'app.js'));
            expect(response).toEqual({
                body: script,
                headers: {
                    'content-type': 'application/javascript; charset=utf-8',
                    'cache-control': 'public, max-age=300'
                }
            });
            readSpy.mockRestore();
        });

        it('rejects attempts to traverse outside the ui directory', async () => {
            await expect(HttpMgmt.handle(32, createRequest('GET', '/$/ui/../../etc/passwd'), nullResponse))
                .rejects.toThrow(HttpNotFoundError);
        });
    });

    it('throws HttpNotFoundError for unknown management routes', async () => {
        await expect(HttpMgmt.handle(3, createRequest('GET', '/$/unknown'), nullResponse))
            .rejects.toBeInstanceOf(HttpNotFoundError);
    });

    it('starts the verify job via POST', async () => {
        verifyVolumesJobMock.start.mockResolvedValue({ startedAt: '2024-01-01T00:00:00.000Z' });
        const response = await HttpMgmt.handle(12, createRequest('POST', '/$/verify-volumes'), nullResponse);
        expect(response).toEqual({ startedAt: '2024-01-01T00:00:00.000Z' });
        expect(verifyVolumesJobMock.start).toHaveBeenCalledTimes(1);
    });

    it('starts the verify job with a volume filter when provided', async () => {
        verifyVolumesJobMock.start.mockResolvedValue({ startedAt: '2024-01-02T00:00:00.000Z' });
        const response = await HttpMgmt.handle(17, createRequest('POST', '/$/verify-volumes', { volumeIds: [3, 3, 4] }), nullResponse);
        expect(response).toEqual({ startedAt: '2024-01-02T00:00:00.000Z' });
        expect(verifyVolumesJobMock.start).toHaveBeenCalledWith({ volumeIds: [3, 4], mode: 'full' });
    });

    it('rejects invalid volume filter payloads', async () => {
        await expect(HttpMgmt.handle(18, createRequest('POST', '/$/verify-volumes', { volumeIds: ['bad'] }), nullResponse))
            .rejects.toBeInstanceOf(HttpBadRequestError);
        expect(verifyVolumesJobMock.start).not.toHaveBeenCalled();
    });

    it('stops the verify job via DELETE', async () => {
        verifyVolumesJobMock.stop.mockResolvedValue(undefined);
        const response = await HttpMgmt.handle(13, createRequest('DELETE', '/$/verify-volumes'), nullResponse);
        expect(response).toEqual({ stopped: true });
        expect(verifyVolumesJobMock.stop).toHaveBeenCalledTimes(1);
    });

    it('returns verify job status via GET', async () => {
        verifyVolumesJobMock.getStatus.mockReturnValue({ running: true, startedAt: 't', objectsVerified: 5, errors: { total: 2, volumes: { '1': 2 } }, concurrency: 3, scope: 'targeted', volumeIds: [1] });
        const response = await HttpMgmt.handle(14, createRequest('GET', '/$/verify-volumes'), nullResponse);
        expect(response).toEqual({ running: true, startedAt: 't', objectsVerified: 5, errors: { total: 2, volumes: { '1': 2 } }, concurrency: 3, scope: 'targeted', volumeIds: [1] });
        expect(verifyVolumesJobMock.getStatus).toHaveBeenCalledTimes(1);
    });

    it('verifies a file via POST', async () => {
        const id = 'aaaaaaaaaaaaaaaaaaaaaaaa';
        const result = { '0': { ok: true, type: 'data', volumeId: 1 } };
        verifyFileJobMock.verify.mockResolvedValue(result);
        const response = await HttpMgmt.handle(19, createRequest('POST', `/$/verify-file/${id}`), nullResponse);
        expect(response).toEqual(result);
        expect(verifyFileJobMock.verify).toHaveBeenCalledWith(id, { mode: 'full' });
    });

    it('rejects invalid verify file ids', async () => {
        await expect(HttpMgmt.handle(20, createRequest('POST', '/$/verify-file/not-hex'), nullResponse))
            .rejects.toBeInstanceOf(HttpBadRequestError);
    });

    it('maps verify file ENOENT to HttpNotFoundError', async () => {
        verifyFileJobMock.verify.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
        await expect(HttpMgmt.handle(21, createRequest('POST', '/$/verify-file/aaaaaaaaaaaaaaaaaaaaaaaa'), nullResponse))
            .rejects.toBeInstanceOf(HttpNotFoundError);
    });

    it('maps verify file ENOTFILE to HttpBadRequestError', async () => {
        verifyFileJobMock.verify.mockRejectedValue(Object.assign(new Error('bad'), { code: 'ENOTFILE' }));
        await expect(HttpMgmt.handle(22, createRequest('POST', '/$/verify-file/aaaaaaaaaaaaaaaaaaaaaaaa'), nullResponse))
            .rejects.toBeInstanceOf(HttpBadRequestError);
    });

    it('soft deletes volumes via DELETE', async () => {
        const req = createRequest('DELETE', '/$/volumes/3');
        databaseSoftDeleteMock.mockResolvedValue(undefined);
        databaseCountOnVolumeMock.mockResolvedValue(0);
        ioManagerMock.softDeleteVolume.mockResolvedValue(undefined);
        const response = await HttpMgmt.handle(15, req, nullResponse);
        expect(response).toEqual({ deleted: true });
        expect(databaseSoftDeleteMock).toHaveBeenCalledWith(3);
        expect(ioManagerMock.softDeleteVolume).toHaveBeenCalledWith(3);
    });

    it('blocks deleting a volume that still holds live object slices (evict first)', async () => {
        const req = createRequest('DELETE', '/$/volumes/3');
        databaseSoftDeleteMock.mockClear();
        databaseCountOnVolumeMock.mockResolvedValue(1200);
        await expect(HttpMgmt.handle(15, req, nullResponse)).rejects.toBeInstanceOf(HttpBadRequestError);
        expect(databaseCountOnVolumeMock).toHaveBeenCalledWith(3, { excludeDead: true });
        expect(databaseSoftDeleteMock).not.toHaveBeenCalled();
    });

    it('evicts a volume via POST /$/volumes/{id}/evict', async () => {
        const req = createRequest('POST', '/$/volumes/7/evict');
        databaseUpdateFlagsMock.mockResolvedValue(undefined);
        ioManagerMock.updateVolumeFlags.mockResolvedValue(undefined);
        evictStartMock.mockClear();
        const response = await HttpMgmt.handle(17, req, nullResponse);
        expect(response).toEqual({ evicting: true, volumeId: 7 });
        expect(databaseUpdateFlagsMock).toHaveBeenCalledWith(7, { isEvicting: true });
        expect(ioManagerMock.updateVolumeFlags).toHaveBeenCalledWith(7, { isEvicting: true });
        expect(evictStartMock).toHaveBeenCalledWith(7);
    });

    it('starts a rebalance via POST /$/rebalance with options', async () => {
        rebalanceStartMock.mockClear();
        const req = createRequest('POST', '/$/rebalance', { deadband: 0.03, maxMoves: 1000 });
        const response = await HttpMgmt.handle(18, req, nullResponse);
        expect(response).toEqual({ rebalancing: true });
        expect(rebalanceStartMock).toHaveBeenCalledWith({ deadband: 0.03, maxMoves: 1000 });
    });

    it('rejects an out-of-range rebalance deadband', async () => {
        const req = createRequest('POST', '/$/rebalance', { deadband: 0.9 });
        await expect(HttpMgmt.handle(18, req, nullResponse)).rejects.toBeInstanceOf(HttpBadRequestError);
    });

    it('cancels a rebalance via DELETE /$/rebalance', async () => {
        rebalanceCancelMock.mockClear();
        const req = createRequest('DELETE', '/$/rebalance');
        const response = await HttpMgmt.handle(19, req, nullResponse);
        expect(response).toEqual({ rebalancing: false });
        expect(rebalanceCancelMock).toHaveBeenCalled();
    });

    it('updates volume flags via PUT', async () => {
        const req = createRequest('PUT', '/$/volumes/4', { isEnabled: false, isReadOnly: true, isHealthy: false });
        databaseUpdateFlagsMock.mockResolvedValue(undefined);
        ioManagerMock.updateVolumeFlags.mockResolvedValue(undefined);

        const response = await HttpMgmt.handle(16, req, nullResponse);

        expect(response).toEqual({ updated: true });
        expect(databaseUpdateFlagsMock).toHaveBeenCalledWith(4, { isEnabled: false, isReadOnly: true, isHealthy: false });
        expect(ioManagerMock.updateVolumeFlags).toHaveBeenCalledWith(4, { isEnabled: false, isReadOnly: true, isHealthy: false });
    });

    it('updates volume labels via PUT', async () => {
        const req = createRequest('PUT', '/$/volumes/7', { label: 'Archive' });
        databaseUpdateFlagsMock.mockResolvedValue(undefined);
        ioManagerMock.updateVolumeFlags.mockResolvedValue(undefined);

        const response = await HttpMgmt.handle(18, req, nullResponse);

        expect(response).toEqual({ updated: true });
        expect(databaseUpdateFlagsMock).toHaveBeenCalledWith(7, { label: 'Archive' });
        expect(ioManagerMock.updateVolumeFlags).toHaveBeenCalledWith(7, { label: 'Archive' });
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
