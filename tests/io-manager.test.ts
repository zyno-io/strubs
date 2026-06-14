import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VolumeFleet } from '../lib/io/volume-fleet';

const mkdirMock = vi.fn<Parameters<typeof import('fs/promises').mkdir>, ReturnType<typeof import('fs/promises').mkdir>>();
const readlinkMock = vi.fn<Parameters<typeof import('fs/promises').readlink>, ReturnType<typeof import('fs/promises').readlink>>();
const readdirMock = vi.fn<Parameters<typeof import('fs/promises').readdir>, ReturnType<typeof import('fs/promises').readdir>>();

vi.mock('fs', () => ({
    promises: {
        mkdir: mkdirMock,
        readlink: readlinkMock,
        readdir: readdirMock
    }
}));

const databaseMock = {
    getVolumes: vi.fn()
};

vi.mock('../lib/database', () => ({
    database: databaseMock
}));

const lsblkMock = vi.fn();
const smartctlMock = vi.fn();
const ensureMountRootMock = vi.fn();

vi.mock('../lib/io/helpers', async () => {
    const actual = await vi.importActual<typeof import('../lib/io/helpers')>('../lib/io/helpers');
    return {
        ...actual,
        lsblk: lsblkMock,
        smartctl: smartctlMock,
        formatBytes: (value: number) => `${value}b`
    };
});

vi.mock('../lib/io/mount-root-manager', () => ({
    mountRootManager: {
        ensureExists: ensureMountRootMock
    }
}));

type VolumeMockInstance = {
    id: number;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    isEnabled: boolean;
    bytesTotal: number;
    bytesUsedData: number;
    bytesUsedParity: number;
    bytesFree: number;
    isWritable: boolean;
    isStarted: boolean;
    deviceGroup: number | null;
    blockPath: string | null;
    mountPoint: string | null;
    deviceModel: string | null;
    deviceVendor: string | null;
};

const createdVolumes: VolumeMockInstance[] = [];

vi.mock('../lib/io/volume', () => ({
    Volume: vi.fn(function (this: VolumeMockInstance, config: any) {
        Object.assign(this, {
            id: config.id,
            isEnabled: config.enabled !== false,
            bytesTotal: config.partition_size,
            bytesUsedData: config.data_size ?? 0,
            bytesUsedParity: config.parity_size ?? 0,
            bytesFree: (config.partition_size ?? 0) - (config.data_size ?? 0),
            bytesPending: 0,
            isWritable: true,
            isStarted: false,
            deviceGroup: null,
            blockPath: null,
            mountPoint: null,
            deviceModel: null,
            deviceVendor: null,
            start: vi.fn().mockImplementation(async () => {
                this.isStarted = true;
            }),
            stop: vi.fn().mockResolvedValue(undefined),
            reserveSpace: vi.fn((bytes: number) => {
                this.bytesPending += bytes;
            }),
            releaseReservation: vi.fn((bytes: number) => {
                this.bytesPending = Math.max(0, this.bytesPending - bytes);
            }),
            applyCommittedBytes: vi.fn(),
            updateFreeBytes: vi.fn().mockResolvedValue(undefined)
        });
        createdVolumes.push(this);
    })
}));

const buildBlockDevice = () => ({
    name: 'sda',
    path: '/dev/sda',
    type: 'disk',
    size: 1024,
    model: 'DiskModel',
    pttype: 'gpt',
    ptuuid: 'PT-UUID',
    children: [
        {
            type: 'part',
            name: 'sda1',
            uuid: 'PART-UUID',
            size: 1024,
            fstype: 'ext4',
            mountpoint: '/mnt/data'
        }
    ]
});

const buildVolumeConfig = () => ({
    id: 1,
    uuid: 'vol-uuid',
    enabled: true,
    healthy: true,
    read_only: false,
    disk_serial: 'SER123',
    partition_uuid: 'PART-UUID',
    partition_size: 1024,
    data_size: 256
});

describe('IOManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        createdVolumes.length = 0;
        mkdirMock.mockResolvedValue(undefined);
        readlinkMock.mockResolvedValue('/devices/pci0000:00/usb1/1-1/block/sda');
        readdirMock.mockResolvedValue([]);
        databaseMock.getVolumes.mockResolvedValue([ buildVolumeConfig() ]);
        lsblkMock.mockResolvedValue({ blockdevices: [ buildBlockDevice() ] });
        smartctlMock.mockResolvedValue({ data: { serial_number: 'SER123' }, exitCode: 0 });
        ensureMountRootMock.mockResolvedValue(undefined);
    });

    it('initializes configured volumes and starts available disks', async () => {
        const { IOManager } = await import('../lib/io/manager');
        const manager = new IOManager();
        await manager.init();

        expect(databaseMock.getVolumes).toHaveBeenCalled();
        expect(lsblkMock).toHaveBeenCalled();
        expect(smartctlMock).toHaveBeenCalledWith('-i', '/dev/sda');
        expect(readlinkMock).toHaveBeenCalledWith('/sys/block/sda');
        expect(ensureMountRootMock).toHaveBeenCalledTimes(1);
        expect(createdVolumes).toHaveLength(1);
        expect(createdVolumes[0]?.blockPath).toBe('/dev/sda1');
        expect(createdVolumes[0]?.start).toHaveBeenCalled();
        expect(manager.getVolume(1)).toBeDefined();
        expect(manager.volumeGroupCount).toBeGreaterThan(0);
    });

    it('surfaces lsblk failures as IOFAIL errors', async () => {
        const { IOManager } = await import('../lib/io/manager');
        const manager = new IOManager();
        const failure = new Error('boom');
        lsblkMock.mockRejectedValueOnce(failure);
        await expect(manager.init()).rejects.toMatchObject({
            code: 'IOFAIL'
        });
    });

    it('stops the refresh loop and unmounts volumes on shutdown', async () => {
        const fakeInterval = {} as NodeJS.Timeout;
        const setIntervalSpy = vi.spyOn(global, 'setInterval').mockReturnValue(fakeInterval);
        const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

        const stopVolumesMock = vi.fn().mockResolvedValue(undefined);
        const volumeFleetStub = {
            loadConfig: vi.fn().mockResolvedValue(undefined),
            initializeVolumes: vi.fn(),
            startVolumes: vi.fn().mockResolvedValue(undefined),
            countVolumeGroups: vi.fn().mockReturnValue(0),
            logUtilization: vi.fn(),
            refreshVolumeStats: vi.fn().mockResolvedValue(undefined),
            getVolume: vi.fn(),
            getVolumeEntries: vi.fn().mockReturnValue([]),
            getWritableVolumes: vi.fn().mockReturnValue([]),
            stopVolumes: stopVolumesMock
        };

        const manager = new (await import('../lib/io/manager')).IOManager({
            deviceDiscovery: {
                discover: vi.fn().mockResolvedValue([])
            },
            volumeFleet: volumeFleetStub as unknown as VolumeFleet,
            mountRootManager: {
                ensureExists: vi.fn().mockResolvedValue(undefined)
            }
        });

        await manager.init();
        await manager.stop();

        expect(stopVolumesMock).toHaveBeenCalledTimes(1);
        expect(clearIntervalSpy).toHaveBeenCalledWith(fakeInterval);

        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();
    });

    it('does not skip devices that lack serial numbers', async () => {
        smartctlMock.mockResolvedValueOnce({ data: {}, exitCode: 0 });

        const { IOManager } = await import('../lib/io/manager');
        const manager = new IOManager();
        await manager.init();

        expect(createdVolumes).toHaveLength(1);
        expect(createdVolumes[0]?.deviceSerial).toBeNull();
    });

    it('deduplicates devices sharing the same partition table', async () => {
        const duplicateDevice = {
            ...buildBlockDevice(),
            name: 'sdb',
            path: '/dev/sdb',
            children: [
                {
                    type: 'part',
                    name: 'sdb1',
                    uuid: 'PART-UUID',
                    size: 1024,
                    fstype: 'ext4',
                    mountpoint: '/mnt/data'
                }
            ]
        };

        lsblkMock.mockResolvedValue({ blockdevices: [ buildBlockDevice(), duplicateDevice ] });
        smartctlMock.mockResolvedValueOnce({ data: { serial_number: 'SER123' }, exitCode: 0 });
        smartctlMock.mockResolvedValueOnce({ data: { serial_number: 'SER123' }, exitCode: 0 });

        const { IOManager } = await import('../lib/io/manager');
        const manager = new IOManager();
        await manager.init();

        expect(createdVolumes).toHaveLength(1);
        expect(lsblkMock).toHaveBeenCalledTimes(1);
    });

    it('wakes repair when volume availability changes', async () => {
        const repairWakeMock = vi.fn();
        const volumeFleetStub = {
            registerVolume: vi.fn().mockResolvedValue(undefined),
            updateVolumeFlags: vi.fn().mockResolvedValue(undefined),
            countVolumeGroups: vi.fn().mockReturnValue(1)
        };
        const manager = new (await import('../lib/io/manager')).IOManager({
            deviceDiscovery: {
                discover: vi.fn().mockResolvedValue([])
            },
            volumeFleet: volumeFleetStub as unknown as VolumeFleet,
            mountRootManager: {
                ensureExists: vi.fn().mockResolvedValue(undefined)
            },
            repairWorker: {
                wake: repairWakeMock
            }
        });

        await manager.registerVolume(buildVolumeConfig() as any);
        await manager.updateVolumeFlags(1, { isEnabled: true });

        expect(repairWakeMock).toHaveBeenCalledWith('volume 1 registered');
        expect(repairWakeMock).toHaveBeenCalledWith('volume 1 availability changed');
    });
});
