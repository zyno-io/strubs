import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RawBlockDevice } from '../lib/io/device-discovery';
import { DeviceProvisioner } from '../lib/io/device-provisioner';

const createDeps = () => {
    const listRawBlockDevices = vi.fn();
    const database = {
        getVolumes: vi.fn().mockResolvedValue([{ id: 1 }]),
        createVolume: vi.fn().mockResolvedValue(undefined),
        deleteVolume: vi.fn().mockResolvedValue(undefined)
    };
    const ioManager = {
        registerVolume: vi.fn().mockResolvedValue(undefined),
        getVolumeEntries: vi.fn().mockReturnValue([])
    };
    const spawnHelper = vi.fn().mockResolvedValue({ code: 0, stdout: '' });
    const sleepSecs = vi.fn().mockResolvedValue(undefined);
    return { listRawBlockDevices, database, ioManager, spawnHelper, sleepSecs };
};

const baseDevice: RawBlockDevice = {
    name: 'sdb',
    path: '/dev/sdb',
    type: 'disk',
    size: 2048,
    model: 'DiskModel',
    serial: 'SERNEW',
    pttype: null,
    ptuuid: null,
    children: []
};

const deviceWithPartition = (uuid: string | null, mountpoint: string | null = null): RawBlockDevice => ({
    ...baseDevice,
    pttype: 'gpt',
    ptuuid: 'PT-NEW',
    children: [
        {
            type: 'part',
            name: 'sdb1',
            size: 2048,
            uuid,
            fstype: uuid ? 'ext4' : null,
            mountpoint
        }
    ]
});

describe('DeviceProvisioner', () => {
    let deps: ReturnType<typeof createDeps>;

    beforeEach(() => {
        deps = createDeps();
    });

    it('partitions and registers a new volume', async () => {
        deps.listRawBlockDevices
            .mockResolvedValueOnce([baseDevice])
            .mockResolvedValueOnce([deviceWithPartition(null)])
            .mockResolvedValueOnce([deviceWithPartition('PART-UUID')]);

        const provisioner = new DeviceProvisioner(deps);
        const result = await provisioner.provision({ blockPath: '/dev/sdb' });

        expect(result.id).toBe(2);
        expect(deps.spawnHelper).toHaveBeenCalledWith('parted', ['-s', '/dev/sdb', 'mklabel', 'gpt']);
        expect(deps.spawnHelper).toHaveBeenCalledWith('parted', ['-s', '/dev/sdb', 'mkpart', 'primary', 'ext4', '0%', '100%']);
        expect(deps.database.createVolume).toHaveBeenCalledWith(result);
        expect(deps.ioManager.registerVolume).toHaveBeenCalledWith(result);
    });

    it('wipes existing partitions when authorized', async () => {
        const deviceWithExistingPartitions: RawBlockDevice = {
            ...baseDevice,
            children: [
                {
                    type: 'part',
                    name: 'sdb1',
                    size: 1024,
                    uuid: 'OLD-UUID',
                    fstype: 'ext4',
                    mountpoint: null
                }
            ]
        };

        deps.listRawBlockDevices
            .mockResolvedValueOnce([deviceWithExistingPartitions])
            .mockResolvedValueOnce([baseDevice])
            .mockResolvedValueOnce([deviceWithPartition(null)])
            .mockResolvedValueOnce([deviceWithPartition('PART-UUID')]);

        const provisioner = new DeviceProvisioner(deps);
        const result = await provisioner.provision({ blockPath: '/dev/sdb', wipe: true });

        expect(result.partition_uuid).toBe('PART-UUID');
        expect(deps.spawnHelper).toHaveBeenCalledWith('parted', ['-s', '/dev/sdb', 'mklabel', 'gpt']);
    });

    it('replaces existing volumes when replace is true', async () => {
        deps.listRawBlockDevices
            .mockResolvedValueOnce([baseDevice])
            .mockResolvedValueOnce([deviceWithPartition(null)])
            .mockResolvedValueOnce([deviceWithPartition('PART-UUID')]);

        deps.ioManager.getVolumeEntries.mockReturnValue([
            [2, { deviceSerial: 'SERNEW', partitionUuid: null }]
        ]);

        const provisioner = new DeviceProvisioner(deps);
        const result = await provisioner.provision({ blockPath: '/dev/sdb', replace: true });

        expect(deps.database.deleteVolume).toHaveBeenCalledWith(2);
        expect(result.id).toBe(2);
    });

    it('recreates the partition table when wipe is true', async () => {
        const deviceWithExistingPartitions: RawBlockDevice = {
            ...baseDevice,
            children: [
                {
                    type: 'part',
                    name: 'sdb1',
                    size: 1024,
                    uuid: 'OLD-UUID',
                    fstype: 'ext4',
                    mountpoint: null
                }
            ]
        };

        deps.listRawBlockDevices
            .mockResolvedValueOnce([deviceWithExistingPartitions])
            .mockResolvedValueOnce([baseDevice])
            .mockResolvedValueOnce([deviceWithPartition(null)])
            .mockResolvedValueOnce([deviceWithPartition('PART-UUID')]);

        const provisioner = new DeviceProvisioner(deps);
        await provisioner.provision({ blockPath: '/dev/sdb', wipe: true });

        expect(deps.spawnHelper).toHaveBeenCalledWith('parted', ['-s', '/dev/sdb', 'mklabel', 'gpt']);
    });

    it('rejects wipe attempts when partitions are mounted', async () => {
        deps.listRawBlockDevices.mockResolvedValueOnce([deviceWithPartition('OLD-UUID', '/mnt/data')]);

        const provisioner = new DeviceProvisioner(deps);
        await expect(provisioner.provision({ blockPath: '/dev/sdb', wipe: true })).rejects.toThrow('block device has mounted partitions');
        expect(deps.spawnHelper).not.toHaveBeenCalled();
    });
});
