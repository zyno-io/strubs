import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock readProcMounts so stale-mount detection is deterministic; keep the rest of helpers real.
vi.mock('../lib/io/helpers', async (importActual) => {
    const actual = await importActual<typeof import('../lib/io/helpers')>();
    return { ...actual, readProcMounts: vi.fn().mockResolvedValue(new Map<string, string>()) };
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

const readProcMountsMock = vi.mocked(readProcMounts);

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
