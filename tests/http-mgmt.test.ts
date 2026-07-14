import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, HttpResponse } from '../lib/server/http/server';

const ioManagerMock = {
    getVolumeEntries: vi.fn(),
    getVolume: vi.fn(),
    // Mirrors the real delegator: find a non-deleted volume by partition UUID from the current entries.
    getVolumeByPartitionUuid: vi.fn((uuid: string) => {
        const entries = (ioManagerMock.getVolumeEntries() as Array<[number, any]> | undefined) ?? [];
        for (const [, volume] of entries)
            if (volume && !volume.isDeleted && volume.partitionUuid === uuid)
                return volume;
        return undefined;
    }),
    registerVolume: vi.fn(),
    softDeleteVolume: vi.fn(),
    deregisterVolume: vi.fn(),
    updateVolumeFlags: vi.fn(),
    getCachedDevices: vi.fn(),
    reloadBlockDevices: vi.fn()
};

const httpHelpersMock = {
    getObjectMeta: vi.fn()
};

const deviceProvisionerProvisionMock = vi.fn();
const buildSliceIndexMock = vi.fn(async () => new Map());
// The kernel's mount table. The platter guard asks THIS, not the volume's in-memory isMounted flag -- a stale
// flag would otherwise have it scan an empty directory on the root filesystem and call the disk clean.
const readProcMountsMock = vi.fn(async () => new Map<string, string>());
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

vi.mock('../lib/io/helpers', async importOriginal => ({
    ...await importOriginal<typeof import('../lib/io/helpers')>(),
    readProcMounts: readProcMountsMock
}));

vi.mock('../lib/recovery/recovery', async importOriginal => ({
    ...await importOriginal<typeof import('../lib/recovery/recovery')>(),
    buildSliceIndex: buildSliceIndexMock
}));

// The encrypted-volume record and the fleet scan. Real in production; injected here so the undelete guard can
// be driven without a rack of disks.
const scanFleetMock = vi.fn(async () => ({ ours: [] as unknown[], unknown: [] as string[], absent: [] as number[] }));
// ⚠️ Asked of THIS volume's disk. `scanFleet().absent` CANNOT answer it -- that list excludes deleted volumes,
// so it can never report the very volume being undeleted. An earlier guard asked it anyway (dead code), and the
// test mocked `absent: [15]` -- a state the real code cannot produce. The test agreed with me, not the machine.
const volumeDiskIsAttachedMock = vi.fn(async () => true);
// The gate that stops a passphrase rotation straddling a change to WHICH VOLUMES the fleet expects to be
// encrypted -- an encrypted provision, or a volume delete/undelete.
const withEncryptionSlotMock = vi.fn(async (fn: () => Promise<unknown>) => fn());

vi.mock('../lib/io/luks-recovery-key', async importOriginal => ({
    ...await importOriginal<typeof import('../lib/io/luks-recovery-key')>(),
    scanFleet: scanFleetMock,
    volumeDiskIsAttached: volumeDiskIsAttachedMock,
    withEncryptionSlot: withEncryptionSlotMock
}));

vi.mock('../lib/io/device-provisioner', () => ({
    deviceProvisioner: {
        provision: deviceProvisionerProvisionMock
    },
    ENCRYPT_NEW_VOLUMES_KEY: 'encryptNewVolumes'
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
const databaseBucketAuthMock = {
    getRuntimeConfig: vi.fn(async () => false),
    setRuntimeConfig: vi.fn(async () => undefined),
    listBuckets: vi.fn(async () => [] as any[]),
    computeBucketStats: vi.fn(async () => [] as any[]),
    listContainerEntries: vi.fn(async () => ({ entries: [] as any[], hasMore: false })),
    resolveContainerStrict: vi.fn(async () => null as string | null | undefined),
    setBucketPolicy: vi.fn(async () => true),
    getBucketByName: vi.fn(async () => null),
    listCredentials: vi.fn(async () => [] as any[]),
    createCredential: vi.fn(async () => undefined),
    setCredentialGrants: vi.fn(async () => true),
    setCredentialEnabled: vi.fn(async () => true),
    setCredentialSecretHash: vi.fn(async () => true),
    removeCredential: vi.fn(async () => true)
};

const databaseGetVolumesMock = vi.fn(async () => [] as any[]);
// A DRAIN KEEPS THE SOURCE, so a drained platter is FULL of slice files -- every one a stale copy of an object
// that now lives elsewhere. Counting them and refusing made the conversion refuse the one flow it exists for.
const databaseClassifySlicesMock = vi.fn(async () => ({ stale: 0, stillReferenced: [] as string[], orphans: [] as string[] }));

// NOT redeclared here: `databaseBucketAuthMock` already carries getRuntimeConfig/setRuntimeConfig, and it is
// spread LAST into the factory below -- so a second pair declared here would be silently overridden and every
// assertion against them would see zero calls while the code under test worked perfectly.
const databaseGetRuntimeConfigMock = databaseBucketAuthMock.getRuntimeConfig;
const databaseSetRuntimeConfigMock = databaseBucketAuthMock.setRuntimeConfig;

vi.mock('../lib/database', () => ({
    database: {
        softDeleteVolume: databaseSoftDeleteMock,
        updateVolumeFlags: databaseUpdateFlagsMock,
        countObjectsOnVolume: databaseCountOnVolumeMock,
        classifySlicesOnVolume: databaseClassifySlicesMock,
        getVolumes: databaseGetVolumesMock,
        ...databaseBucketAuthMock
    }
}));

const drainStartMock = vi.fn().mockResolvedValue(undefined);
const drainStopMock = vi.fn();
vi.mock('../lib/jobs/drain-volume-job', () => ({
    drainVolumeJob: {
        start: drainStartMock,
        stop: drainStopMock,
        drainingVolumeId: () => null,
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

// A REAL Journal, wired to a fake fleet -- so relocateOff()'s postcondition check (the thing under test)
// runs its real logic. Only onFleetChange is stubbed, because re-election is what we want to lie about:
// resolving while leaving the journal exactly where it was is precisely the failure the guard exists for.
const { journalFleetChangeMock, journalState } = vi.hoisted(() => ({
    journalFleetChangeMock: vi.fn().mockResolvedValue(undefined),
    journalState: { replicaVolumeIds: [] as number[] }
}));
vi.mock('../lib/io/journal', async importOriginal => {
    const actual = await importOriginal<typeof import('../lib/io/journal')>();
    // A fleet of MOUNTED volumes whose mount points hold no journal at all. That is the ordinary case for
    // these tests (they are about the mgmt routes, not the journal), and it keeps the real guard logic
    // running rather than stubbing it: an unmounted volume it cannot read would be REFUSED, which is a
    // different test.
    const real = new actual.Journal({
        getWritableVolumes: () => [],
        getFleetVolumes: () => [3, 7, 9, 11, 15].map(id => ({
            id, mountPoint: `/tmp/strubs-mgmt-test-no-journal-${id}`, isDeleted: false, isMounted: true
        }))
    });
    real.onFleetChange = journalFleetChangeMock;
    // An OWN property, to shadow the prototype getter (Object.assign would just throw on it).
    Object.defineProperty(real, 'replicaVolumeIds', { get: () => journalState.replicaVolumeIds });
    return { ...actual, journal: real };
});

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
                stateUpdatedAt: null,
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
            [5, { id: 5, partitionUuid: 'part-b', label: 'Data' }]
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
            [5, { id: 5, partitionUuid: 'part-b', label: 'Backup' }],
            [3, { id: 3, partitionUuid: 'part-a', label: 'Archive' }]
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
            mountError: 'failed to mount',
            // The disk is not there, so we cannot read its filesystem: its encryption state is UNKNOWN, and
            // "unknown" must never be reported as "plaintext".
            isPresent: false,
            isEncrypted: false
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
            mountError: null,
            isPresent: true,
            isEncrypted: false
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
            gbFree: 100 / (1024 ** 3),
            encryption: {
                encryptNewVolumes: false,
                hasRecoveryPassphrase: false,
                // Never audited. Reported as null rather than as healthy -- on an encrypted fleet, "nobody has
                // ever confirmed these disks can be recovered" is a fact worth stating, not an absence.
                lastAudit: null,
                encryptedVolumeIds: [],
                // volume2's disk is present and plaintext: pulling it still leaks every slice on it.
                plaintextVolumeIds: [2],
                // volume1's disk is missing, so we do not know -- and we do not guess.
                unknownVolumeIds: [1]
            }
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

    // The counters are a CACHE. Under live traffic the incremental deltas drift, and a volume once reported
    // "-16 files" -- an impossible number that sat there because a scheduled reconcile was six hours away and
    // there was no way to ASK for one.
    it('recomputes the storage statistics on request', async () => {
        const snapshot = { system: { objectCount: 5 }, volumes: {} };
        storageStatsTrackerMock.reconcile.mockResolvedValue(undefined);
        storageStatsTrackerMock.getSnapshot.mockResolvedValue(snapshot);

        const response = await HttpMgmt.handle(
            5, createRequest('POST', '/$/storage-stats'), nullResponse);

        expect(storageStatsTrackerMock.reconcile).toHaveBeenCalled();
        expect(response).toEqual(snapshot);
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

    it('blocks deleting a volume that still holds live object slices (drain first)', async () => {
        const req = createRequest('DELETE', '/$/volumes/3');
        databaseSoftDeleteMock.mockClear();
        databaseCountOnVolumeMock.mockResolvedValue(1200);
        await expect(HttpMgmt.handle(15, req, nullResponse)).rejects.toBeInstanceOf(HttpBadRequestError);
        expect(databaseCountOnVolumeMock).toHaveBeenCalledWith(3, { excludeDead: true });
        expect(databaseSoftDeleteMock).not.toHaveBeenCalled();
    });

    it('drains a volume via POST /$/volumes/{id}/drain', async () => {
        const req = createRequest('POST', '/$/volumes/7/drain');
        databaseUpdateFlagsMock.mockResolvedValue(undefined);
        ioManagerMock.updateVolumeFlags.mockResolvedValue(undefined);
        drainStartMock.mockClear();
        const response = await HttpMgmt.handle(17, req, nullResponse);
        expect(response).toEqual({ draining: true, volumeId: 7 });
        expect(databaseUpdateFlagsMock).toHaveBeenCalledWith(7, { isDraining: true, isReadOnly: true });
        expect(ioManagerMock.updateVolumeFlags).toHaveBeenCalledWith(7, { isDraining: true, isReadOnly: true });
        expect(drainStartMock).toHaveBeenCalledWith(7);
    });

    // "The drain returned" is what an operator reads as "safe to pull the drive". So the drain has to
    // PROVE the journal left, not merely ask it to.
    describe('the drain will not start until the journal has actually moved off the volume', () => {
        beforeEach(() => {
            journalState.replicaVolumeIds = [];
            journalFleetChangeMock.mockClear();
            journalFleetChangeMock.mockResolvedValue(undefined);
            drainStartMock.mockClear();
            databaseUpdateFlagsMock.mockResolvedValue(undefined);
            ioManagerMock.updateVolumeFlags.mockResolvedValue(undefined);
        });

        it('refuses when re-election RESOLVED but left the journal on the volume', async () => {
            // Re-election does not adopt a replica whose segment copy failed -- it logs and carries on with
            // one fewer. So onFleetChange resolving is not proof of anything: the journal can still be
            // sitting on the disk the operator is about to pull.
            journalState.replicaVolumeIds = [7, 9];

            const req = createRequest('POST', '/$/volumes/7/drain');
            await expect(HttpMgmt.handle(17, req, nullResponse)).rejects.toThrow(/still replicated on volume 7/);
            expect(journalFleetChangeMock).toHaveBeenCalled();
            expect(drainStartMock).not.toHaveBeenCalled();
        });

        it('refuses when re-election itself failed', async () => {
            journalFleetChangeMock.mockRejectedValue(new Error('no writable volume left to adopt'));

            const req = createRequest('POST', '/$/volumes/7/drain');
            await expect(HttpMgmt.handle(17, req, nullResponse)).rejects.toThrow(/could not be relocated off it/);
            expect(drainStartMock).not.toHaveBeenCalled();
        });

        it('starts the drain once the journal is demonstrably elsewhere', async () => {
            journalState.replicaVolumeIds = [9, 11];

            const req = createRequest('POST', '/$/volumes/7/drain');
            await expect(HttpMgmt.handle(17, req, nullResponse)).resolves.toEqual({ draining: true, volumeId: 7 });
            expect(drainStartMock).toHaveBeenCalledWith(7);
        });
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

    describe('bucket auth endpoints', () => {
        beforeEach(() => {
            for (const fn of Object.values(databaseBucketAuthMock)) fn.mockClear();
            databaseBucketAuthMock.getRuntimeConfig.mockResolvedValue(false as any);
            databaseBucketAuthMock.setBucketPolicy.mockResolvedValue(true as any);
            databaseBucketAuthMock.setCredentialGrants.mockResolvedValue(true as any);
            databaseBucketAuthMock.setCredentialEnabled.mockResolvedValue(true as any);
            databaseBucketAuthMock.setCredentialSecretHash.mockResolvedValue(true as any);
        });

        it('GET /$/buckets returns policy + activity + enforcement', async () => {
            databaseBucketAuthMock.listBuckets.mockResolvedValue([
                { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'photo', publicRead: true },
                { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: 'empty' }
            ] as any);
            const res = await HttpMgmt.handle(1, createRequest('GET', '/$/buckets'), nullResponse) as any;
            expect(res.enforced).toBe(false);
            const photo = res.buckets.find((b: any) => b.name === 'photo');
            expect(photo).toMatchObject({ publicRead: true, publicWrite: null });
            expect(photo.activity).toEqual({ anon: 0, auth: 0 });
            expect(res.buckets.find((b: any) => b.name === 'empty')).toBeTruthy();
        });

        it('PUT /$/buckets/{id}/policy validates and forwards booleans', async () => {
            const id = 'a'.repeat(24);
            const res = await HttpMgmt.handle(1, createRequest('PUT', `/$/buckets/${id}/policy`, { publicRead: true, publicWrite: false }), nullResponse) as any;
            expect(res).toEqual({ updated: true });
            expect(databaseBucketAuthMock.setBucketPolicy).toHaveBeenCalledWith(id, { publicRead: true, publicWrite: false });
        });

        it('PUT /$/buckets/{id}/policy rejects a non-boolean', async () => {
            const id = 'a'.repeat(24);
            await expect(HttpMgmt.handle(1, createRequest('PUT', `/$/buckets/${id}/policy`, { publicRead: 'yes' }), nullResponse))
                .rejects.toThrow(/boolean/);
        });

        it('POST /$/credentials returns a secret once and stores a hash + validated grants', async () => {
            const res = await HttpMgmt.handle(1, createRequest('POST', '/$/credentials', {
                name: 'app', grants: [{ bucket: 'photo', read: true, write: false }, { bucket: '*', read: true, write: false }]
            }), nullResponse) as any;
            expect(typeof res.accessKeyId).toBe('string');
            expect(typeof res.secret).toBe('string');
            const stored = databaseBucketAuthMock.createCredential.mock.calls[0][0] as any;
            expect(stored.secretHash).toMatch(/^scrypt\$/);
            expect(stored).not.toHaveProperty('secret');
            expect(stored.grants).toHaveLength(2);
            expect(stored.enabled).toBe(true);
        });

        it('POST /$/credentials rejects an invalid grant bucket', async () => {
            await expect(HttpMgmt.handle(1, createRequest('POST', '/$/credentials', {
                name: 'bad', grants: [{ bucket: 'Bad Name', read: true, write: true }]
            }), nullResponse)).rejects.toThrow(/valid bucket name/);
            expect(databaseBucketAuthMock.createCredential).not.toHaveBeenCalled();
        });

        it('PUT /$/credentials/{id} validates the whole payload before any write', async () => {
            // Valid grants but a malformed `enabled`: nothing must be written (no partial grant change
            // that outlives the verify-cache), and the request is rejected.
            await expect(HttpMgmt.handle(1, createRequest('PUT', '/$/credentials/AKIA123', {
                grants: [{ bucket: 'photo', read: true, write: false }], enabled: 'yes'
            }), nullResponse)).rejects.toThrow(/boolean/);
            expect(databaseBucketAuthMock.setCredentialGrants).not.toHaveBeenCalled();
            expect(databaseBucketAuthMock.setCredentialEnabled).not.toHaveBeenCalled();
        });

        it('POST /$/credentials/{id}/rotate issues a fresh secret', async () => {
            const res = await HttpMgmt.handle(1, createRequest('POST', '/$/credentials/AKIA123/rotate', {}), nullResponse) as any;
            expect(typeof res.secret).toBe('string');
            expect(databaseBucketAuthMock.setCredentialSecretHash).toHaveBeenCalledWith('AKIA123', expect.stringMatching(/^scrypt\$/));
        });

        it('DELETE /$/credentials/{id} removes it', async () => {
            databaseBucketAuthMock.removeCredential.mockResolvedValue(true as any);
            const res = await HttpMgmt.handle(1, createRequest('DELETE', '/$/credentials/AKIA123'), nullResponse) as any;
            expect(res).toEqual({ removed: true });
            expect(databaseBucketAuthMock.removeCredential).toHaveBeenCalledWith('AKIA123');
        });

        it('GET /$/buckets does NOT compute object counts (that aggregation is the slow half)', async () => {
            databaseBucketAuthMock.listBuckets.mockResolvedValue([
                { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'photo', publicRead: true }
            ] as any);
            const res = await HttpMgmt.handle(1, createRequest('GET', '/$/buckets'), nullResponse) as any;
            expect(res.buckets[0]).toMatchObject({ name: 'photo', publicRead: true });
            // The counts come from /$/buckets/stats so the names and toggles render immediately.
            expect(databaseBucketAuthMock.computeBucketStats).not.toHaveBeenCalled();
        });

        it('GET /$/buckets/stats caches the aggregation instead of rescanning every poll', async () => {
            databaseBucketAuthMock.computeBucketStats.mockResolvedValue([
                { bucketId: 'aaaaaaaaaaaaaaaaaaaaaaaa', objectCount: 5, logicalBytes: 100 }
            ] as any);

            const a = await HttpMgmt.handle(1, createRequest('GET', '/$/buckets/stats'), nullResponse) as any;
            const b = await HttpMgmt.handle(2, createRequest('GET', '/$/buckets/stats'), nullResponse) as any;

            expect(a.stats[0]).toMatchObject({ objectCount: 5 });
            expect(b.stats).toEqual(a.stats);
            expect(databaseBucketAuthMock.computeBucketStats).toHaveBeenCalledTimes(1);   // second served from cache
        });

        describe('GET /$/browse', () => {
            it('lists the root (the buckets) when given no path', async () => {
                databaseBucketAuthMock.listContainerEntries.mockResolvedValue({
                    entries: [{ id: 'b1', name: 'photo', isContainer: true }],
                    hasMore: false
                } as any);

                const res = await HttpMgmt.handle(1, createRequest('GET', '/$/browse'), nullResponse) as any;
                expect(res.path).toBe('');
                expect(res.entries[0]).toMatchObject({ name: 'photo', isContainer: true });
                expect(databaseBucketAuthMock.resolveContainerStrict).not.toHaveBeenCalled();  // root needs no walk
            });

            it('re-traverses the path and 404s a path that no longer exists', async () => {
                // undefined = the walk hit a missing component. It must NOT fall back to some other folder.
                databaseBucketAuthMock.resolveContainerStrict.mockResolvedValue(undefined);

                const req = createRequest('GET', '/$/browse');
                req.params.path = 'photo/gone';
                await expect(HttpMgmt.handle(1, req, nullResponse)).rejects.toThrow(/no such path/);
                expect(databaseBucketAuthMock.listContainerEntries).not.toHaveBeenCalled();
            });

            it('lists a resolved container and reports whether more entries remain', async () => {
                databaseBucketAuthMock.resolveContainerStrict.mockResolvedValue('c1');
                databaseBucketAuthMock.listContainerEntries.mockResolvedValue({
                    entries: [{ id: 'o1', name: 'cat.jpg', isFile: true, size: 1234, mime: 'image/jpeg' }],
                    hasMore: true
                } as any);

                const req = createRequest('GET', '/$/browse');
                req.params.path = '/photo/2024/';       // leading/trailing slashes tolerated
                const res = await HttpMgmt.handle(1, req, nullResponse) as any;

                expect(res.path).toBe('photo/2024');
                expect(res.hasMore).toBe(true);
                expect(res.entries[0]).toMatchObject({ name: 'cat.jpg', isFile: true, size: 1234, mime: 'image/jpeg' });
            });
        });

        it('GET and PUT /$/auth/settings read and write the authEnforced flag', async () => {
            const get = await HttpMgmt.handle(1, createRequest('GET', '/$/auth/settings'), nullResponse) as any;
            expect(get).toEqual({ authEnforced: false });
            const put = await HttpMgmt.handle(1, createRequest('PUT', '/$/auth/settings', { authEnforced: true }), nullResponse) as any;
            expect(put).toEqual({ authEnforced: true });
            expect(databaseBucketAuthMock.setRuntimeConfig).toHaveBeenCalledWith('authEnforced', true);
        });
    });

// THE GUARD WRITTEN TO PREVENT A LOCKOUT WAS THE LOCKOUT.
//
// The namespace-recovery allowlist decides what an operator may still call while the array is sitting in
// recovery mode with an empty database. The first version of it was written FROM MEMORY, and it got the auth
// routes wrong -- it allowed `/$/login` and `/$/password`, which do not exist in this codebase. The real ones
// (`POST /$/session`, `PUT /$/admin/password`) were therefore REFUSED, so nobody could log in, so nobody could
// reach `POST /$/restore`, which is the only way out of that mode. The array would have been bricked by the
// very code written to keep it recoverable.
//
// So the allowlist is checked against the REAL route table. An entry that matches no actual route is not a
// harmless typo here -- it is a door that is supposed to be open and is not.
describe('mgmt: the namespace-recovery allowlist is real', () => {
    it('every allowlisted route ACTUALLY EXISTS in the route table', async () => {
        const { HttpMgmt } = await import('../lib/server/http/mgmt');

        for (const entry of HttpMgmt.NAMESPACE_RECOVERY_ALLOWLIST) {
            const url = entry.path === '/$/ui' ? '/$/ui/' : entry.path;
            const route = HttpMgmt.findRoute(entry.method, url);
            expect(route, `allowlisted route ${entry.method} ${entry.path} does not exist`).not.toBeNull();
        }
    });

    it('allows the way OUT, and refuses the two routes that would destroy the namespace', async () => {
        const { HttpMgmt } = await import('../lib/server/http/mgmt');
        const allowed = (m: string, u: string) =>
            HttpMgmt.NAMESPACE_RECOVERY_ALLOWLIST.some(a =>
                a.method === m && (a.path === '/$/ui' ? u.startsWith('/$/ui') : u === a.path));

        // The only way out, and the auth needed to get to it.
        expect(allowed('POST', '/$/restore')).toBe(true);
        expect(allowed('POST', '/$/recover-fleet')).toBe(true);
        expect(allowed('POST', '/$/session')).toBe(true);           // log in
        expect(allowed('GET', '/$/auth/status')).toBe(true);

        // POST /$/snapshot would snapshot the EMPTY namespace and publish the pointer to every disk -- the
        // exact catastrophe this mode exists to prevent.
        expect(allowed('POST', '/$/snapshot')).toBe(false);

        // DELETE a volume asks Mongo how many objects are on it. On an empty database, the answer for a live,
        // full 3TB platter is zero -- and then every future recovery skips that disk.
        expect(allowed('DELETE', '/$/volumes/1')).toBe(false);

        // An allowlist, not a blocklist: anything not named is refused, so a route added next year is safe by
        // default rather than dangerous by default.
        expect(allowed('POST', '/$/rebalance')).toBe(false);
        expect(allowed('PUT', '/$/maintenance-freeze')).toBe(false);
    });
});

// ---------------------------------------------------------------------------------------------------------
// ENCRYPTION (DR-G). Converting a volume WIPES A DISK THAT IS ALREADY OURS -- the most destructive thing this
// API can be asked to do. These tests exist for the guards, not the happy path.
// ---------------------------------------------------------------------------------------------------------
describe('encrypting a volume', () => {
    // A REAL directory with a REAL strubs/ tree in it, because the guard stats the mount point for real -- it
    // will not take an empty readdir of a directory it could not read as proof that a disk is empty.
    let mountPoint: string;

    beforeAll(async () => {
        mountPoint = await fs.mkdtemp(path.join(os.tmpdir(), 'strubs-encrypt-'));
        await fs.mkdir(path.join(mountPoint, 'strubs'), { recursive: true });
    });

    afterAll(async () => {
        await fs.rm(mountPoint, { recursive: true, force: true }).catch(() => undefined);
    });

    const plaintextVolume = {
        id: 15,
        uuid: 'vol-15',
        blockPath: '/dev/sde',
        // Mounted, because the journal guard REFUSES a volume it cannot read: an unmounted disk might be the
        // last home of a journal segment and there is no way to know. Volume 15 is in the journal mock's fleet.
        isMounted: true,
        get mountPoint() { return mountPoint; },
        isPresent: true,
        isEncrypted: false,
        isDeleted: false,
        isDraining: false,
        isReadOnly: true,
        verifyErrors: null,
        bytesTotal: 1, bytesFree: 1
    };

    beforeEach(() => {
        vi.clearAllMocks();
        ioManagerMock.getVolume.mockReturnValue(plaintextVolume);
        ioManagerMock.getVolumeEntries.mockReturnValue([[15, plaintextVolume]]);
        ioManagerMock.registerVolume.mockResolvedValue(undefined);
        ioManagerMock.deregisterVolume.mockResolvedValue(undefined);
        ioManagerMock.updateVolumeFlags.mockResolvedValue(undefined);
        databaseCountOnVolumeMock.mockResolvedValue(0);   // drained
        journalState.replicaVolumeIds = [3, 7, 9];        // not the last journal copy
        deviceProvisionerProvisionMock.mockResolvedValue({ id: 15, uuid: 'vol-15-new' });
        buildSliceIndexMock.mockResolvedValue(new Map());   // the platter is genuinely empty
        databaseClassifySlicesMock.mockResolvedValue({ stale: 0, stillReferenced: [], orphans: [] });
        // ...and the kernel agrees the disk really is mounted where the volume thinks it is.
        readProcMountsMock.mockResolvedValue(new Map([[mountPoint, '/dev/sde']]));
    });

    const encrypt = (body: unknown) =>
        HttpMgmt.handle(5, createRequest('POST', '/$/volumes/15/encrypt', body), nullResponse);

    // THE ONE THAT MATTERS. A PUT commits its SLICE FILES before it inserts the object record, so a write
    // already in flight has slices on the platter and nothing in Mongo. If we flipped the volume read-only
    // ourselves and scanned a moment later, that write would still land -- the scan sees nothing, the wipe
    // destroys the slices, and the insert arrives afterwards pointing at them. A phantom, which reads as data
    // loss. So the volume must ALREADY be read-only: the quiesce is the operator's hours-long drain, not a
    // millisecond of ours.
    it('refuses a volume that is still writable, and wipes nothing', async () => {
        ioManagerMock.getVolume.mockReturnValue({ ...plaintextVolume, isReadOnly: false });

        await expect(encrypt({ recoveryPassphrase: 'correct horse battery staple' }))
            .rejects.toThrow(/still writable/);

        expect(deviceProvisionerProvisionMock).not.toHaveBeenCalled();
        expect(ioManagerMock.deregisterVolume).not.toHaveBeenCalled();
    });

    // ⚠️ A DRAINED DISK IS NOT AN EMPTY DISK -- AND THAT IS THE WHOLE POINT OF A DRAIN.
    //
    // The drain COPIES each slice elsewhere, flips the reference, and LEAVES THE ORIGINAL. So a drained disk is
    // a full redundant copy until somebody wipes it. Volume 57 sat there with 4,963 slice files after a clean
    // drain -- and an earlier version of this guard counted files and refused, which made the conversion REFUSE
    // THE ONE FLOW IT EXISTS FOR. Every disk you would ever convert has just been drained, and every drained
    // disk looks exactly like this.
    it('converts a DRAINED disk whose platter is still full of stale copies', async () => {
        buildSliceIndexMock.mockResolvedValue(new Map([['507f1f77bcf86cd799439011', new Uint16Array(32)]]));
        databaseClassifySlicesMock.mockResolvedValue({ stale: 4963, stillReferenced: [], orphans: [] });

        await encrypt({ recoveryPassphrase: 'correct horse battery staple' });

        expect(deviceProvisionerProvisionMock).toHaveBeenCalled();
    });

    // THE DISK IS AUTHORITATIVE; MONGO IS A DERIVED INDEX. A slice file whose object has NO RECORD AT ALL is an
    // ORPHAN -- recoverable data, which a rebuild turns back into an object (that is the whole of DR-E). Mongo
    // has never heard of it, so `countObjectsOnVolume` says zero. Wiping it is the worst kind of data loss: the
    // sort nobody notices.
    it('refuses when the platter holds TRUE ORPHANS, which Mongo cannot see', async () => {
        buildSliceIndexMock.mockResolvedValue(new Map([['507f1f77bcf86cd799439011', new Uint16Array(32)]]));
        databaseClassifySlicesMock.mockResolvedValue({
            stale: 0, stillReferenced: [], orphans: ['507f1f77bcf86cd799439011']
        });

        await expect(encrypt({ recoveryPassphrase: 'correct horse battery staple' }))
            .rejects.toThrow(/ORPHANS/);

        expect(deviceProvisionerProvisionMock).not.toHaveBeenCalled();
    });

    // ...and a slice the database still points at is LIVE, whatever its own count claimed.
    it('refuses when a slice file is still referenced by a live object', async () => {
        buildSliceIndexMock.mockResolvedValue(new Map([['507f1f77bcf86cd799439011', new Uint16Array(32)]]));
        databaseClassifySlicesMock.mockResolvedValue({
            stale: 0, stillReferenced: ['507f1f77bcf86cd799439011'], orphans: []
        });

        await expect(encrypt({ recoveryPassphrase: 'correct horse battery staple' }))
            .rejects.toThrow(/still referenced by live objects/);

        expect(deviceProvisionerProvisionMock).not.toHaveBeenCalled();
    });

    // Fail CLOSED. A platter we could not scan is not a platter with nothing on it.
    it('refuses when the platter cannot be scanned', async () => {
        buildSliceIndexMock.mockRejectedValue(new Error('3 directories could not be read'));

        await expect(encrypt({ recoveryPassphrase: 'correct horse battery staple' }))
            .rejects.toThrow(/could not be scanned/);

        expect(deviceProvisionerProvisionMock).not.toHaveBeenCalled();
    });

    it('refuses an unmounted volume, whose platter cannot be scanned at all', async () => {
        ioManagerMock.getVolume.mockReturnValue({ ...plaintextVolume, isMounted: false });

        await expect(encrypt({ recoveryPassphrase: 'correct horse battery staple' }))
            .rejects.toThrow(/not mounted/);

        expect(deviceProvisionerProvisionMock).not.toHaveBeenCalled();
    });

    it('refuses a volume that still holds live slices, and wipes nothing', async () => {
        databaseCountOnVolumeMock.mockResolvedValue(1234);

        await expect(encrypt({ recoveryPassphrase: 'correct horse battery staple' }))
            .rejects.toThrow(/still holds 1234 live object slice/);

        expect(deviceProvisionerProvisionMock).not.toHaveBeenCalled();
        expect(ioManagerMock.deregisterVolume).not.toHaveBeenCalled();
    });

    // NOTE: the journal guard (refuse to wipe the last surviving copy of a journal segment) is NOT pinned
    // here. It reads its own fleet view from the Journal, not from ioManager, so this fixture cannot express
    // "volume 15 holds the last segment" -- a test written against it would pass without asserting anything,
    // which is worse than no test. The conversion calls the very same `assertVolumeRemovable()` as the delete
    // path, where the guard IS covered; the live-slices test above proves the call is on this path.

    it('refuses without a recovery passphrase, before touching anything', async () => {
        await expect(encrypt({})).rejects.toThrow(/recoveryPassphrase is required/);
        expect(databaseUpdateFlagsMock).not.toHaveBeenCalled();
        expect(deviceProvisionerProvisionMock).not.toHaveBeenCalled();
    });

    it('refuses a volume that is already encrypted', async () => {
        ioManagerMock.getVolume.mockReturnValue({ ...plaintextVolume, isEncrypted: true });

        await expect(encrypt({ recoveryPassphrase: 'correct horse battery staple' }))
            .rejects.toThrow(/already encrypted/);
        expect(deviceProvisionerProvisionMock).not.toHaveBeenCalled();
    });

    it('refuses a volume whose disk is not present', async () => {
        ioManagerMock.getVolume.mockReturnValue({ ...plaintextVolume, isPresent: false, blockPath: null });

        await expect(encrypt({ recoveryPassphrase: 'correct horse battery staple' }))
            .rejects.toThrow(/no disk present/);
        expect(deviceProvisionerProvisionMock).not.toHaveBeenCalled();
    });

    it('passes the passphrase and the volume id through to the conversion', async () => {
        await encrypt({ recoveryPassphrase: 'correct horse battery staple' });

        expect(deviceProvisionerProvisionMock).toHaveBeenCalledWith(expect.objectContaining({
            blockPath: '/dev/sde',
            wipe: true,
            encrypt: true,
            convertVolumeId: 15,
            recoveryPassphrase: 'correct horse battery staple'
        }));
    });

    // A failed conversion leaves the volume deregistered. A volume that is merely ABSENT is one nobody
    // investigates -- so it must come back and fail VISIBLY instead of quietly vanishing from the fleet.
    it('puts the volume back into the fleet if the conversion fails', async () => {
        deviceProvisionerProvisionMock.mockRejectedValue(new Error('cryptsetup exploded'));
        databaseGetVolumesMock.mockResolvedValue([{ id: 15, uuid: 'vol-15' }]);

        await expect(encrypt({ recoveryPassphrase: 'correct horse battery staple' }))
            .rejects.toThrow(/cryptsetup exploded/);

        expect(ioManagerMock.registerVolume).toHaveBeenCalledWith({ id: 15, uuid: 'vol-15' });
    });

    // ⚠️ UNDELETING AN ENCRYPTED VOLUME BRINGS BACK A DISK THAT MAY HAVE MISSED A ROTATION.
    //
    // Rotation only walks volumes that are NOT deleted, so while this one was retired the fleet passphrase may
    // have been changed without it. Bring it back and it holds a key nobody has -- and nothing in normal service
    // would ever notice, because STRUBS mounts with the keyfile and never touches the passphrase slot.
    describe('restoring a deleted ENCRYPTED volume', () => {
        beforeEach(() => {
            ioManagerMock.getVolume.mockReturnValue({ id: 15, isDeleted: true });
        });

        it('refuses while its disk is not attached -- a rotation could not have reached it', async () => {
            volumeDiskIsAttachedMock.mockResolvedValue(false);

            await expect(HttpMgmt.handle(
                5, createRequest('PUT', '/$/volumes/15', { isDeleted: false }), nullResponse
            )).rejects.toThrow(/its disk is not attached/);

            expect(databaseUpdateFlagsMock).not.toHaveBeenCalled();
        });

        it('allows it once the disk is back', async () => {
            volumeDiskIsAttachedMock.mockResolvedValue(true);

            await HttpMgmt.handle(
                5, createRequest('PUT', '/$/volumes/15', { isDeleted: false }), nullResponse);

            expect(databaseUpdateFlagsMock).toHaveBeenCalledWith(15, expect.objectContaining({ isDeleted: false }));
        });

        // A rotation walks only the volumes that are NOT deleted -- so a volume changing deleted-ness mid-rotation
        // is one the rotation may reach, or may skip, depending on nothing but timing. Both routes take the gate.
        it('takes the rotation gate for a delete and for an undelete', async () => {
            volumeDiskIsAttachedMock.mockResolvedValue(true);
            databaseCountOnVolumeMock.mockResolvedValue(0);
            journalState.replicaVolumeIds = [3, 7, 9];

            withEncryptionSlotMock.mockClear();
            await HttpMgmt.handle(5, createRequest('PUT', '/$/volumes/15', { isDeleted: false }), nullResponse);
            expect(withEncryptionSlotMock).toHaveBeenCalledTimes(1);

            ioManagerMock.softDeleteVolume.mockResolvedValue(undefined);
            withEncryptionSlotMock.mockClear();
            await HttpMgmt.handle(5, createRequest('DELETE', '/$/volumes/15'), nullResponse);
            expect(withEncryptionSlotMock).toHaveBeenCalledTimes(1);
        });

        // ...but nothing else about a volume touches the passphrase, so nothing else should block a rotation.
        it('does NOT take the gate for a label change', async () => {
            withEncryptionSlotMock.mockClear();

            await HttpMgmt.handle(5, createRequest('PUT', '/$/volumes/15', { label: 'bay 3' }), nullResponse);

            expect(withEncryptionSlotMock).not.toHaveBeenCalled();
        });

        // ⚠️ NO DISK, NO UNDELETE -- for ANY volume, encrypted or not.
        //
        // An earlier guard asked a database record ("which volumes are encrypted?") first, and returned early if
        // the id was not in it. But that record lived in the same database a restore can take away: "not in the
        // record" does not mean "not encrypted", it can equally mean "the record is gone". The check meant to be
        // unconditional was conditional on the one thing least worth trusting. The record has since been deleted
        // outright, and this rule needs nothing but the disk.
        it('refuses to restore ANY volume whose disk is not attached', async () => {
            volumeDiskIsAttachedMock.mockResolvedValue(false);

            await expect(HttpMgmt.handle(
                5, createRequest('PUT', '/$/volumes/15', { isDeleted: false }), nullResponse
            )).rejects.toThrow(/we cannot tell what is on it/);

            expect(databaseUpdateFlagsMock).not.toHaveBeenCalled();
        });
    });

    // The audit is the only thing in the system that ever asks whether the recovery passphrase still works.
    // It needs the passphrase, and we will not keep that on the machine it exists to recover -- so the endpoint
    // demands it and refuses without one.
    it('refuses to audit without the recovery passphrase', async () => {
        await expect(HttpMgmt.handle(
            5, createRequest('POST', '/$/encryption/audit', {}), nullResponse
        )).rejects.toThrow(/recoveryPassphrase is required/);
    });

    // Turning the fleet default on must not convert a single existing disk. "Encryption: on" is exactly what
    // an operator would expect to encrypt their data, and it does not -- so it had better not pretend to.
    it('the fleet default setting converts nothing', async () => {
        await HttpMgmt.handle(
            5, createRequest('PUT', '/$/encryption/settings', { encryptNewVolumes: true }), nullResponse);

        expect(databaseSetRuntimeConfigMock).toHaveBeenCalledWith('encryptNewVolumes', true);
        expect(deviceProvisionerProvisionMock).not.toHaveBeenCalled();
        expect(ioManagerMock.deregisterVolume).not.toHaveBeenCalled();
    });
});
