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
    // By default: we have an identity (not in recovery), and the target disk is positively established
    // to carry no STRUBS identity.
    const probeDeviceForStrubsIdentity = vi.fn().mockResolvedValue({ status: 'clean' });
    const hasInstanceIdentity = vi.fn().mockReturnValue(true);
    return { listRawBlockDevices, database, ioManager, spawnHelper, sleepSecs, probeDeviceForStrubsIdentity, hasInstanceIdentity };
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

    // Provisioning FORMATS DISKS. These two gates are the only thing standing between a mistaken or
    // malicious POST /$/volumes and 130TB of live customer data, in exactly the states where the volumes
    // collection cannot help: a fleet that never started, or a fresh/wiped Mongo.
    describe('destructive-provisioning guards', () => {
        const noDiskWasTouched = () => {
            const cmds = deps.spawnHelper.mock.calls.map(c => `${c[0]} ${(c[1] as string[]).join(' ')}`);
            expect(cmds.some(c => c.includes('parted'))).toBe(false);
            expect(cmds.some(c => c.includes('mkfs'))).toBe(false);
            expect(cmds.some(c => c.includes('wipefs') || c.includes('dd'))).toBe(false);
            expect(deps.database.createVolume).not.toHaveBeenCalled();
        };

        it('REFUSES to wipe a disk that already carries a STRUBS identity', async () => {
            deps.listRawBlockDevices.mockResolvedValue([deviceWithPartition('PART-UUID')]);
            deps.probeDeviceForStrubsIdentity.mockResolvedValue({
                status: 'strubs',
                identity: { instanceIdentity: 'deadbeef', volumeId: 17 }
            });

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb', wipe: true }))
                .rejects.toThrow(/carries STRUBS volume 17/);
            noDiskWasTouched();
        });

        // The probe must FAIL CLOSED. If the filesystem is there but will not mount -- busy, dirty
        // journal, failing sectors -- we do not get to call the disk blank and reformat it. An earlier
        // version returned "nothing found" on a failed mount, which the caller read as "not ours": a
        // guard whose sole purpose is to fail closed, failing open.
        it('REFUSES to wipe a disk it could not read (unknown != blank)', async () => {
            deps.listRawBlockDevices.mockResolvedValue([deviceWithPartition('PART-UUID')]);
            deps.probeDeviceForStrubsIdentity.mockResolvedValue({
                status: 'unknown',
                reason: 'could not read-only mount /dev/sdb1: device is busy'
            });

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb', wipe: true }))
                .rejects.toThrow(/could not establish whether it belongs to this STRUBS array/);
            noDiskWasTouched();
        });

        it('REFUSES to provision at all while in recovery (no instance identity)', async () => {
            deps.hasInstanceIdentity.mockReturnValue(false);
            deps.listRawBlockDevices.mockResolvedValue([baseDevice]);

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb', wipe: true }))
                .rejects.toThrow(/disabled during recovery/);

            // Refused BEFORE we even look at the hardware -- the array we are trying to rescue must not
            // be offered up for reinitialisation.
            expect(deps.listRawBlockDevices).not.toHaveBeenCalled();
            expect(deps.spawnHelper).not.toHaveBeenCalled();
        });

        // The NON-wipe path runs parted + mkfs too, so it is equally destructive. It is only safe because
        // it refuses a partitioned disk -- but an empty `children` list is not proof of blankness. If
        // partition enumeration failed or is stale, a live STRUBS disk presents as bare media.
        it('REFUSES the non-wipe path on a disk that claims a partition table but shows no partitions', async () => {
            deps.listRawBlockDevices.mockResolvedValue([{ ...baseDevice, pttype: 'gpt', ptuuid: 'PT-1', children: [] }]);

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb' }))
                .rejects.toThrow(/cannot be established as blank/);
            noDiskWasTouched();
        });

        it('still provisions a genuinely blank disk', async () => {
            deps.listRawBlockDevices
                .mockResolvedValueOnce([baseDevice])
                .mockResolvedValueOnce([deviceWithPartition(null)])
                .mockResolvedValueOnce([deviceWithPartition('PART-UUID')]);
            deps.probeDeviceForStrubsIdentity.mockResolvedValue({ status: 'clean' });

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb' })).resolves.toMatchObject({ id: 2 });
        });
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
        // Provisioning is the ONLY path allowed to stamp our identity onto a disk -- it just formatted it.
        expect(deps.ioManager.registerVolume).toHaveBeenCalledWith(result, { initializeIdentity: true });
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
