import { beforeEach, describe, expect, it, vi } from 'vitest';

const lsblkMock = vi.fn();

vi.mock('../lib/io/helpers', () => ({
    lsblk: lsblkMock,
    smartctl: vi.fn(),
    formatBytes: vi.fn()
}));

vi.mock('../lib/io/smart-info', () => ({
    smartInfoService: {
        fetch: vi.fn()
    }
}));

describe('listRawBlockDevices', () => {
    let listRawBlockDevices: typeof import('../lib/io/device-discovery').listRawBlockDevices;

    beforeEach(async () => {
        vi.resetModules();
        ({ listRawBlockDevices } = await import('../lib/io/device-discovery'));
        lsblkMock.mockReset();
    });

    it('sanitizes lsblk results to the defined RawBlockDevice fields', async () => {
        lsblkMock.mockResolvedValue({
            blockdevices: [
                {
                    name: 'sda',
                    path: '/dev/sda',
                    type: 'disk',
                    size: '1024',
                    model: 'DiskModel',
                    vendor: 'DiskVendor',
                    serial: 'SER123',
                    pttype: 'gpt',
                    ptuuid: 'PT-UUID',
                    smartInfo: { serial_number: 'SER123' },
                    extraField: 'should be dropped',
                    children: [
                        {
                            type: 'part',
                            name: 'sda1',
                            size: '512',
                            uuid: 'PART-UUID',
                            partuuid: 'PART-PUUID',
                            fstype: 'ext4',
                            mountpoint: '/mnt/data',
                            something: 'else'
                        },
                        {
                            type: 'rom',
                            name: 'sr0',
                            size: '2048'
                        }
                    ]
                },
                {
                    name: 'sr0',
                    path: '/dev/sr0',
                    type: 'rom',
                    size: '2048'
                }
            ]
        });

        const blockDevices = await listRawBlockDevices();

        expect(blockDevices).toEqual([
            {
                name: 'sda',
                path: '/dev/sda',
                type: 'disk',
                size: 1024,
                model: 'DiskModel',
                vendor: 'DiskVendor',
                serial: 'SER123',
                pttype: 'gpt',
                ptuuid: 'PT-UUID',
                smartInfo: { serial_number: 'SER123' },
                children: [
                    {
                        type: 'part',
                        name: 'sda1',
                        path: '/dev/sda1',
                        size: 512,
                        uuid: 'PART-UUID',
                        fstype: 'ext4',
                        mountpoint: '/mnt/data',
                        partlabel: null,
                        partuuid: 'PART-PUUID',
                        children: []
                    }
                ]
            }
        ]);
    });

    // A LUKS PARTITION'S FILESYSTEM -- AND ITS MOUNTPOINT -- ARE NOT ON THE PARTITION.
    //
    //     sdf          disk
    //     └─sdf1       part   fstype=crypto_LUKS   mountpoint=null
    //       └─luks-..  crypt  fstype=ext4          mountpoint=/run/..
    //
    // This used to filter children to `type === 'part'` and flatten everything below them away. That did not
    // merely hide the filesystem -- it hid the MOUNTPOINT, and the wipe guard asks a partition whether it is
    // mounted. A mounted, in-service, encrypted disk full of live data would have answered "no".
    //
    // (Verified against a real LUKS device on the host: lsblk nests the crypt child under the partition and
    // puts the mountpoint on it.)
    it('KEEPS the crypt child of a LUKS partition, and the mountpoint that lives on it', async () => {
        lsblkMock.mockResolvedValue({
            blockdevices: [{
                name: 'sdf', path: '/dev/sdf', type: 'disk', size: '4000', pttype: 'gpt',
                children: [{
                    type: 'part', name: 'sdf1', path: '/dev/sdf1', size: '4000',
                    fstype: 'crypto_LUKS', mountpoint: null, partlabel: 'strubs-3f9a1b2c5d6e7f80-13',
                    children: [{
                        type: 'crypt', name: 'luks-abc', path: '/dev/mapper/luks-abc', size: '4000',
                        fstype: 'ext4', mountpoint: '/run/strubs/mounts/abc'
                    }]
                }]
            }]
        });

        const [device] = await listRawBlockDevices();
        const part = device.children![0];

        expect(part.fstype).toBe('crypto_LUKS');
        expect(part.mountpoint).toBeNull();                       // the partition itself is not mounted...
        expect(part.partlabel).toBe('strubs-3f9a1b2c5d6e7f80-13'); // ...but it says who it is, unlocked or not

        const mapper = part.children![0];
        expect(mapper.type).toBe('crypt');
        expect(mapper.fstype).toBe('ext4');
        expect(mapper.mountpoint).toBe('/run/strubs/mounts/abc');  // ...and THIS is where the array is using it
    });
});

// ---------------------------------------------------------------------------------------------------------
// THE CACHED VIEW -- what the fleet actually binds volumes against.
//
// Raw discovery was fixed to KEEP the `crypt` grandchild. This is the same bug one function later: the CACHE
// then read the mountpoint off the PARTITION, where an encrypted volume never has one.
// ---------------------------------------------------------------------------------------------------------
describe('DeviceDiscovery.discover', () => {
    let DeviceDiscovery: typeof import('../lib/io/device-discovery').DeviceDiscovery;

    beforeEach(async () => {
        vi.resetModules();
        ({ DeviceDiscovery } = await import('../lib/io/device-discovery'));
        lsblkMock.mockReset();
    });

    // The deps DeviceDiscovery needs to get as far as caching a partition: a serial (a device without one is
    // skipped outright) and a sysfs path.
    const discovery = () => new DeviceDiscovery({
        smartInfoService: { fetch: vi.fn().mockResolvedValue({ serial_number: 'SN-TEST' }) } as never,
        readlink: vi.fn().mockResolvedValue('../devices/pci0000:00/usb1/host0/block/sdx') as never,
        readdir: vi.fn().mockResolvedValue([]) as never
    });

    // ⚠️ A MOUNTED ENCRYPTED VOLUME MUST NOT CACHE AS UNMOUNTED.
    //
    //     sdf          disk
    //     └─sdf1       part   fstype=crypto_LUKS  mountpoint=null      <- what the cache used to read
    //       └─dm-3     crypt  fstype=ext4         mountpoint=/run/..   <- where the mount actually is
    //
    // Reading the partition's mountpoint returns null for a volume that is mounted, in service, and holding
    // live data. On the next restart with encrypted volumes still mounted, every one of them binds as
    // UNMOUNTED and start() tries to mount a mapper that is already mounted. Enough of those and reads go
    // below quorum -- an outage caused entirely by asking the wrong layer where the mount is.
    it('takes an encrypted volume\'s mountpoint from the crypt child, not the partition', async () => {
        lsblkMock.mockResolvedValue({
            blockdevices: [{
                name: 'sdf',
                path: '/dev/sdf',
                type: 'disk',
                size: 4000,
                serial: 'SN-SDF',
                children: [{
                    name: 'sdf1',
                    path: '/dev/sdf1',
                    type: 'part',
                    size: 4000,
                    uuid: 'LUKS-CONTAINER-UUID',
                    fstype: 'crypto_LUKS',
                    mountpoint: null,
                    children: [{
                        name: 'dm-3',
                        path: '/dev/mapper/strubs-u57',
                        type: 'crypt',
                        size: 4000,
                        fstype: 'ext4',
                        mountpoint: '/run/strubs/mounts/u57'
                    }]
                }]
            }]
        });

        const devices = await discovery().discover();
        const partition = devices[0].partitions[0];

        // The MOUNT comes from the crypt child...
        expect(partition.mountPoint).toBe('/run/strubs/mounts/u57');

        // ...but the FSTYPE stays the partition's, because that is what `Volume.isEncrypted` is derived from.
        // Take it from the child and every encrypted volume would report itself as plaintext ext4.
        expect(partition.fsType).toBe('crypto_LUKS');
    });

    it('leaves a plaintext partition exactly as it was', async () => {
        lsblkMock.mockResolvedValue({
            blockdevices: [{
                name: 'sdb',
                path: '/dev/sdb',
                type: 'disk',
                size: 4000,
                serial: 'SN-SDB',
                children: [{
                    name: 'sdb1',
                    path: '/dev/sdb1',
                    type: 'part',
                    size: 4000,
                    uuid: 'PART-UUID',
                    fstype: 'ext4',
                    mountpoint: '/run/strubs/mounts/u8'
                }]
            }]
        });

        const partition = (await discovery().discover())[0].partitions[0];

        expect(partition.mountPoint).toBe('/run/strubs/mounts/u8');
        expect(partition.fsType).toBe('ext4');
    });
});
