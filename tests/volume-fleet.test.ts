import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock readProcMounts so stale-mount detection is deterministic; keep the rest of helpers real.
vi.mock('../lib/io/helpers', async (importActual) => {
    const actual = await importActual<typeof import('../lib/io/helpers')>();
    return { ...actual, readProcMounts: vi.fn().mockResolvedValue(new Map<string, string>()) };
});

// The mapper's backing device -- the kernel's own answer to "what is this dm-crypt device actually sitting
// on?". Mocked so the encrypted stale-mount branch is deterministic.
vi.mock('../lib/io/luks', async (importActual) => {
    const actual = await importActual<typeof import('../lib/io/luks')>();
    return { ...actual, mapperBackingDevice: vi.fn().mockResolvedValue(null) };
});

// A mock Volume that models the parts of the real lifecycle reconcile() touches.
vi.mock('../lib/io/volume', () => ({
    Volume: vi.fn(function (this: any, config: any) {
        this.id = config.id;
        this.uuid = config.uuid;
        this.partitionUuid = config.partition_uuid;
        this.bytesTotal = config.partition_size;
        this.isDeleted = config.is_deleted === true;
        this.isEnabled = config.enabled !== false && !this.isDeleted;
        this.isDraining = config.is_draining === true;
        this.isStarted = false;
        this.isPresent = false;
        this.isMounted = false;
        this.mountPoint = null;
        this.blockPath = null;
        this.fsType = null;
        this.deviceName = null;
        this.deviceGroup = null;

        // Derived from the disk, exactly as the real Volume derives it -- never a stored flag.
        Object.defineProperty(this, 'isEncrypted', {
            get: () => (this.fsType ?? '').toLowerCase() === 'crypto_luks'
        });

        this.bindDevice = vi.fn((device: any, partition: any) => {
            this.deviceName = device.name;
            this.fsType = partition.fsType ?? null;
            this.blockPath = partition.path ?? `/dev/${partition.name}`;
            this.mountPoint = partition.mountPoint || null;
            this.isMounted = !!partition.mountPoint;
            this.isPresent = true;
        });
        this.start = vi.fn(async () => {
            if (!this.isMounted) {
                this.mountPoint = `/run/strubs/mounts/${this.uuid}`;
                this.isMounted = true;
            }
            this.isStarted = true;
        });
        this.markMissing = vi.fn(async () => {
            this.isStarted = false;
            this.isMounted = false;
            this.blockPath = null;
            this.fsType = null;
            this.deviceName = null;
            this.mountPoint = null;
            this.isPresent = false;
        });
    })
}));

import { VolumeFleet } from '../lib/io/volume-fleet';
import { readProcMounts } from '../lib/io/helpers';
import { mapperBackingDevice } from '../lib/io/luks';

const readProcMountsMock = vi.mocked(readProcMounts);
const mapperBackingDeviceMock = vi.mocked(mapperBackingDevice);

const logger = () => {
    const log: any = (..._a: any[]) => undefined;
    log.error = (..._a: any[]) => undefined;
    return log;
};

const makeFleet = async (configs: any[]) => {
    const database: any = { getVolumes: vi.fn().mockResolvedValue(configs) };
    const fleet = new VolumeFleet({ database, log: logger() });
    await fleet.loadConfig();
    return fleet;
};

const device = (name: string, partition: any) => ({
    name,
    serial: `SN-${name}`,
    partitions: [partition],
    busGroup: 1
});

const part = (uuid: string, name: string, extra?: any) => ({ uuid, name, path: `/dev/${name}`, size: 1000, fsType: 'ext4', mountPoint: null, ...extra });

beforeEach(() => {
    readProcMountsMock.mockResolvedValue(new Map<string, string>());
});

describe('VolumeFleet.reconcile', () => {
    it('restores an unbound-at-boot volume when its disk appears', async () => {
        const fleet = await makeFleet([{ id: 13, uuid: 'u13', enabled: true, partition_uuid: 'p13', partition_size: 1000 }]);
        fleet.initializeVolumes([]); // disk absent at boot -> volume left unbound
        const volume = fleet.getVolume(13)!;
        expect(volume.blockPath).toBeNull();
        expect(volume.isPresent).toBe(false);

        const transitions = await fleet.reconcile([device('sdf', part('p13', 'sdf1'))]);

        expect(transitions).toEqual([{ volumeId: 13, kind: 'restored', deviceName: 'sdf' }]);
        expect(volume.blockPath).toBe('/dev/sdf1');
        expect(volume.isStarted).toBe(true);
    });

    // ⚠️ A CLONE MUST NOT BE MOUNTED AS THE VOLUME. A dd copy carries the same partition uuid; binding to
    // "whichever the enumeration listed first" could serve the clone's stale data or write onto it. Exactly one,
    // or the volume stays offline until the copy is detached.
    it('REFUSES to bind when a clone carries the same partition uuid, leaving the volume unbound', async () => {
        const fleet = await makeFleet([{ id: 13, uuid: 'u13', enabled: true, partition_uuid: 'p13', partition_size: 1000 }]);
        fleet.initializeVolumes([]);
        const volume = fleet.getVolume(13)!;

        // The real disk AND a clone are both attached, both carrying partition uuid p13.
        const transitions = await fleet.reconcile([
            device('sdf', part('p13', 'sdf1')),
            device('sdx', part('p13', 'sdx1'))   // <- the clone
        ]);

        expect(transitions).toEqual([]);        // not restored to either
        expect(volume.blockPath).toBeNull();
        expect(volume.isPresent).toBe(false);
    });

    // ...and once the clone is detached, the volume binds on its own.
    it('binds normally once exactly one partition carries the uuid', async () => {
        const fleet = await makeFleet([{ id: 13, uuid: 'u13', enabled: true, partition_uuid: 'p13', partition_size: 1000 }]);
        fleet.initializeVolumes([]);

        const transitions = await fleet.reconcile([device('sdf', part('p13', 'sdf1'))]);

        expect(transitions).toEqual([{ volumeId: 13, kind: 'restored', deviceName: 'sdf' }]);
        expect(fleet.getVolume(13)!.blockPath).toBe('/dev/sdf1');
    });

    // ⚠️ RE-ENABLE MUST RE-VALIDATE, NOT TRUST THE CACHED BINDING. stop() unmounts but leaves blockPath set, so
    // a disabled-but-bound volume that is enabled while a clone is attached would otherwise mount the cached
    // path with the exact-one check never running. Enabling re-binds against the current rack, which refuses.
    it('REFUSES to enable a stopped-but-bound volume while a clone carries its uuid', async () => {
        const fleet = await makeFleet([{ id: 13, uuid: 'u13', enabled: true, partition_uuid: 'p13', partition_size: 1000 }]);
        fleet.initializeVolumes([device('sdf', part('p13', 'sdf1'))]);
        const volume = fleet.getVolume(13)!;
        volume.isStarted = false;   // disabled: stopped, but blockPath is still '/dev/sdf1'
        expect(volume.blockPath).toBe('/dev/sdf1');

        // Enable while the real disk AND a clone are both attached.
        await expect(fleet.updateVolumeFlags(13, { isEnabled: true }, [
            device('sdf', part('p13', 'sdf1')),
            device('sdx', part('p13', 'sdx1'))   // <- the clone
        ])).rejects.toThrow(/clone makes its partition uuid ambiguous/);

        expect(volume.isStarted).toBe(false);   // it did NOT mount either
    });

    it('heals a stale mount when the disk was re-added under a new kernel name (vol 57 case)', async () => {
        const fleet = await makeFleet([{ id: 57, uuid: 'u57', enabled: true, partition_uuid: 'p57', partition_size: 1000 }]);
        // Started on /dev/sdan1, mounted at the strubs mountpoint.
        fleet.initializeVolumes([device('sdan', part('p57', 'sdan1', { mountPoint: '/run/strubs/mounts/u57' }))]);
        const volume = fleet.getVolume(57)!;
        volume.isStarted = true;
        expect(volume.deviceName).toBe('sdan');

        // Disk is now /dev/sde1, but the kernel still shows the mount backed by the vanished sdan1.
        readProcMountsMock.mockResolvedValue(new Map([['/run/strubs/mounts/u57', '/dev/sdan1']]));
        const transitions = await fleet.reconcile([device('sde', part('p57', 'sde1'))]);

        expect(transitions).toEqual([{ volumeId: 57, kind: 'healed', deviceName: 'sde' }]);
        expect(volume.markMissing).toHaveBeenCalledTimes(1); // stale mount torn down first
        expect(volume.deviceName).toBe('sde');
        expect(volume.blockPath).toBe('/dev/sde1');
        expect(volume.isStarted).toBe(true);
    });

    // --- ENCRYPTED VOLUMES: the stale-mount check one layer down ---------------------------------------
    //
    // On an encrypted volume /proc/mounts reads `/dev/mapper/strubs-<uuid>`, not the partition -- so comparing
    // the source against the raw partition path never matches and every encrypted volume looks PERPETUALLY
    // stale: unmounted, remounted, unmounted, forever.
    //
    // But matching the mapper NAME is not enough either, and that is the trap. These are USB disks: one drops,
    // the kernel renumbers it, it comes back as a different partition -- and the mapper from its previous life
    // is still there, still called strubs-<uuid>, still mounted, now sitting on a device that is GONE.
    describe('an encrypted volume', () => {
        const luksPart = (uuid: string, name: string, extra?: any) =>
            part(uuid, name, { fsType: 'crypto_LUKS', ...extra });

        it('is not perpetually stale just because the kernel names the mapper', async () => {
            const fleet = await makeFleet([{ id: 21, uuid: 'u21', enabled: true, partition_uuid: 'p21', partition_size: 1000 }]);
            fleet.initializeVolumes([device('sdf', luksPart('p21', 'sdf1', { mountPoint: '/run/strubs/mounts/u21' }))]);
            const volume = fleet.getVolume(21)!;
            volume.isStarted = true;

            // The kernel: the mount is the mapper, and the mapper really is on sdf1.
            readProcMountsMock.mockResolvedValue(new Map([['/run/strubs/mounts/u21', '/dev/mapper/strubs-u21']]));
            mapperBackingDeviceMock.mockResolvedValue('sdf1');

            const transitions = await fleet.reconcile([device('sdf', luksPart('p21', 'sdf1'))]);

            expect(transitions).toEqual([]);                       // healthy: left alone
            expect(volume.markMissing).not.toHaveBeenCalled();
        });

        // THE FAIL-OPEN. The mapper name still matches, so a name-only check calls this healthy -- and leaves
        // the volume bound to a mapper sitting on a device that no longer exists, serving EIO while reporting
        // itself perfectly fine.
        it('IS stale when its mapper is left sitting on a disk that has gone', async () => {
            const fleet = await makeFleet([{ id: 22, uuid: 'u22', enabled: true, partition_uuid: 'p22', partition_size: 1000 }]);
            fleet.initializeVolumes([device('sdf', luksPart('p22', 'sdf1', { mountPoint: '/run/strubs/mounts/u22' }))]);
            const volume = fleet.getVolume(22)!;
            volume.isStarted = true;

            // The mapper is mounted under the right NAME -- but it is backed by the OLD disk. The volume now
            // lives on sdg1.
            readProcMountsMock.mockResolvedValue(new Map([['/run/strubs/mounts/u22', '/dev/mapper/strubs-u22']]));
            mapperBackingDeviceMock.mockResolvedValue('sdf1');

            const transitions = await fleet.reconcile([device('sdg', luksPart('p22', 'sdg1'))]);

            expect(transitions).toEqual([{ volumeId: 22, kind: 'healed', deviceName: 'sdg' }]);
            expect(volume.markMissing).toHaveBeenCalledTimes(1);   // the stale mapper is torn down first
            expect(volume.blockPath).toBe('/dev/sdg1');
        });

        // Fail CLOSED: a mapper we cannot interrogate is not a mapper we get to call healthy.
        it('IS stale when the mapper\'s backing device cannot be read', async () => {
            const fleet = await makeFleet([{ id: 23, uuid: 'u23', enabled: true, partition_uuid: 'p23', partition_size: 1000 }]);
            fleet.initializeVolumes([device('sdf', luksPart('p23', 'sdf1', { mountPoint: '/run/strubs/mounts/u23' }))]);
            const volume = fleet.getVolume(23)!;
            volume.isStarted = true;

            readProcMountsMock.mockResolvedValue(new Map([['/run/strubs/mounts/u23', '/dev/mapper/strubs-u23']]));
            mapperBackingDeviceMock.mockResolvedValue(null);       // could not tell

            await fleet.reconcile([device('sdf', luksPart('p23', 'sdf1'))]);

            expect(volume.markMissing).toHaveBeenCalledTimes(1);
        });
    });

    it('marks a volume missing when its disk disappears', async () => {
        const fleet = await makeFleet([{ id: 8, uuid: 'u8', enabled: true, partition_uuid: 'p8', partition_size: 1000 }]);
        fleet.initializeVolumes([device('sdb', part('p8', 'sdb1'))]);
        const volume = fleet.getVolume(8)!;
        volume.isStarted = true;

        const transitions = await fleet.reconcile([]); // disk gone

        expect(transitions).toEqual([{ volumeId: 8, kind: 'missing', deviceName: 'sdb' }]);
        expect(volume.markMissing).toHaveBeenCalledTimes(1);
        expect(volume.isPresent).toBe(false);
    });

    it('does not re-notify a volume that is already missing', async () => {
        const fleet = await makeFleet([{ id: 8, uuid: 'u8', enabled: true, partition_uuid: 'p8', partition_size: 1000 }]);
        fleet.initializeVolumes([]); // never present
        const first = await fleet.reconcile([]);
        const second = await fleet.reconcile([]);
        expect(first).toEqual([]); // was never present/started -> no edge
        expect(second).toEqual([]);
    });

    it('leaves draining and disabled volumes untouched', async () => {
        const fleet = await makeFleet([
            { id: 1, uuid: 'u1', enabled: true, is_draining: true, partition_uuid: 'p1', partition_size: 1000 },
            { id: 2, uuid: 'u2', enabled: false, partition_uuid: 'p2', partition_size: 1000 }
        ]);
        fleet.initializeVolumes([]);
        const draining = fleet.getVolume(1)!;
        draining.isStarted = true;
        draining.isPresent = true;

        const transitions = await fleet.reconcile([]); // both disks absent

        expect(transitions).toEqual([]);
        expect(draining.markMissing).not.toHaveBeenCalled();
    });

    it('detects missing but holds recovery when autoRecover is false (maintenance freeze)', async () => {
        const fleet = await makeFleet([
            { id: 3, uuid: 'u3', enabled: true, partition_uuid: 'p3', partition_size: 1000 },
            { id: 4, uuid: 'u4', enabled: true, partition_uuid: 'p4', partition_size: 1000 }
        ]);
        // vol 3 present+started; vol 4 unbound.
        fleet.initializeVolumes([device('sdc', part('p3', 'sdc1'))]);
        fleet.getVolume(3)!.isStarted = true;

        // vol 3's disk pulled, vol 4's disk now present — but frozen, so only the removal is acted on.
        const transitions = await fleet.reconcile([device('sdd', part('p4', 'sdd1'))], { autoRecover: false });

        expect(transitions).toEqual([{ volumeId: 3, kind: 'missing', deviceName: 'sdc' }]);
        expect(fleet.getVolume(4)!.isStarted).toBe(false); // recovery held
    });
});
