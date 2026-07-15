import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RawBlockDevice } from '../lib/io/device-discovery';
import { DeviceProvisioner } from '../lib/io/device-provisioner';

const createDeps = () => {
    const listRawBlockDevices = vi.fn();

    // WHO IS AT THIS PATH RIGHT NOW -- the DRIVE's own SMART serial, not the USB bridge's (on the real rack the
    // bridge serial repeats across bays and is blank on eight disks). The truthful default is "the same drive we
    // were looking at". The tests that matter make it answer otherwise: a drive that vanished, or a DIFFERENT
    // drive that took the path while we were busy.
    const currentDiskIdentity = vi.fn(async (_path: string): Promise<string | null> => 'DRIVE-WD-0001');
    // ⚠️ A FAKE DATABASE THAT CANNOT LIE ABOUT DELETION.
    //
    // getVolumes() used to be a fixed mockResolvedValue and deleteVolume() a no-op, so the fake happily served
    // rows that the code under test had already destroyed. That is not a stand-in for Mongo; it is a stand-in
    // for a Mongo that never deletes anything -- and it let a metadata-preservation fix pass its test while
    // preserving nothing in production (the real deleteVolume is a hard deleteOne).
    //
    // So the rows are STATE, and deleteVolume actually removes one.
    let rows: Array<Record<string, unknown>> = [{ id: 1 }];
    const database = {
        setVolumes: (next: Array<Record<string, unknown>>) => { rows = next; },
        getVolumes: vi.fn(async () => rows.map(row => ({ ...row }))),
        createVolume: vi.fn(async (volume: Record<string, unknown>) => { rows.push({ ...volume }); }),
        deleteVolume: vi.fn(async (id: number) => { rows = rows.filter(row => row.id !== id); }),
        updateVolumeFlags: vi.fn(async (id: number, changes: Record<string, unknown>) => {
            const row = rows.find(r => r.id === id);
            if (row && changes.isReadOnly !== undefined) row.read_only = changes.isReadOnly;
        }),
        // The fleet default. `undefined` is what an untouched array returns from runtimeConfig, and it must
        // mean "no encryption" -- shipping in `off` is the whole plan.
        getRuntimeConfig: vi.fn().mockResolvedValue(undefined)
    };
    const ioManager = {
        registerVolume: vi.fn().mockResolvedValue(undefined),
        deregisterVolume: vi.fn().mockResolvedValue(undefined),
        updateVolumeFlags: vi.fn().mockResolvedValue(undefined),
        getVolumeEntries: vi.fn().mockReturnValue([])
    };
    const luks = {
        keyfileReadable: vi.fn().mockResolvedValue(true),
        format: vi.fn().mockResolvedValue(undefined),
        addPassphrase: vi.fn().mockResolvedValue(undefined),
        open: vi.fn().mockImplementation(async (_path: string, uuid: string) => `/dev/mapper/strubs-${uuid}`),
        assertRecoverable: vi.fn().mockResolvedValue(undefined),
        testPassphrase: vi.fn().mockResolvedValue('opens'),
        writeNameplate: vi.fn().mockResolvedValue(undefined),
        // The nameplate is LOAD-BEARING on an encrypted volume: it is how a locked disk says it is ours, and
        // the fleet-passphrase guard enumerates encrypted disks by it. So the provisioner reads it back.
        nameplateIsPresent: vi.fn().mockResolvedValue(true),
        mapperPath: vi.fn().mockImplementation((uuid: string) => `/dev/mapper/strubs-${uuid}`),
        // The mapper's backing device, by default the partition we opened -- backed by the disk we meant.
        mapperBackingDevice: vi.fn().mockResolvedValue('sdb1'),
        close: vi.fn().mockResolvedValue(undefined)
    };
    const assertFleetRecoveryPassphrase = vi.fn().mockResolvedValue(undefined);

    // What STRUBS knows without asking anybody: the fleet passphrase, sealed under the keyfile. (The literal,
    // not the PASSPHRASE const -- that is declared inside the describe below, and this factory runs first.)
    const sealedRecoveryPassphrase = vi.fn<() => Promise<string | null>>()
        .mockResolvedValue('correct horse battery staple');
    const hasRecoveryPassphrase = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);

    // Does this passphrase actually open a disk we already encrypted? The database can be restored to before a
    // rotation; the platters cannot. Default: the disks agree with the notes.
    const assertPassphraseOpensTheFleet = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    // The whole fleet, recently proven to open with the passphrase we hold. The one-disk proof above asks
    // whichever platter lsblk listed first; this is the one that asked them all.
    // The gate that stops a passphrase rotation running through the middle of an encrypted provision.
    const withEncryptionSlot = vi.fn(async (fn: () => Promise<unknown>) => fn());
    const spawnHelper = vi.fn().mockResolvedValue({ code: 0, stdout: '' });
    const sleepSecs = vi.fn().mockResolvedValue(undefined);
    // By default: we have an identity (not in recovery), and the target disk is positively established
    // to carry no STRUBS identity.
    const probeDeviceForStrubsIdentity = vi.fn().mockResolvedValue({ status: 'clean' });
    // THE REAL SHAPE. config.identity on this array is a HYPHENATED UUID, and the probe hands back 32 raw hex
    // characters. Testing with a tidy 16-hex string is what let the nameplate ship unparseable by its own
    // reader: the test agreed with the code, and both were wrong about the machine.
    const instanceIdentity = vi.fn().mockReturnValue('2fb05f23-1d5e-4c00-bb71-f3109b42476c');
    return { listRawBlockDevices, currentDiskIdentity, database, ioManager, luks, spawnHelper, sleepSecs, probeDeviceForStrubsIdentity, instanceIdentity, assertFleetRecoveryPassphrase, assertPassphraseOpensTheFleet, sealedRecoveryPassphrase, hasRecoveryPassphrase, withEncryptionSlot };
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
            deps.instanceIdentity.mockReturnValue(null);
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

        // ⚠️ CLAIMED READ-ONLY, DURABLE-ROW, THEN ENABLED. The physical claim and the Mongo row are both written
        // read-only, so the volume is never writable until its row is durable. Only then is it made writable.
        expect(deps.ioManager.registerVolume).toHaveBeenCalledWith(
            expect.objectContaining({ id: 2, read_only: true }), { initializeIdentity: true });
        expect(deps.database.createVolume).toHaveBeenCalledWith(expect.objectContaining({ id: 2, read_only: true }));
        expect(deps.database.updateVolumeFlags).toHaveBeenCalledWith(2, { isReadOnly: false });
        expect(deps.ioManager.updateVolumeFlags).toHaveBeenCalledWith(2, { isReadOnly: false });
        expect(result.read_only).toBe(false);   // returned in its final, writable state
    });

    // ⚠️ ORPHANS BEAT PHANTOMS. A failed database row write must leave a claimed disk with no row (recoverable),
    // never a row pointing at a disk we did not finish claiming. And the volume must never have been writable in
    // that window, so nothing could have been placed on it.
    it('leaves an orphan, not a phantom, when the database row cannot be written', async () => {
        deps.listRawBlockDevices
            .mockResolvedValueOnce([baseDevice])
            .mockResolvedValueOnce([deviceWithPartition(null)])
            .mockResolvedValueOnce([deviceWithPartition('PART-UUID')]);
        deps.database.createVolume.mockRejectedValueOnce(new Error('mongo is down'));

        const provisioner = new DeviceProvisioner(deps);
        await expect(provisioner.provision({ blockPath: '/dev/sdb' }))
            .rejects.toThrow(/recoverable orphan -- it was never made writable/);

        // The physical claim happened, READ-ONLY (never writable)...
        expect(deps.ioManager.registerVolume).toHaveBeenCalledWith(
            expect.objectContaining({ read_only: true }), { initializeIdentity: true });
        // ...and the failed row write was cleaned up, so the fleet is not left serving an unpersisted volume.
        expect(deps.ioManager.deregisterVolume).toHaveBeenCalledWith(2);
        // It was never enabled, so no writable window ever existed.
        expect(deps.ioManager.updateVolumeFlags).not.toHaveBeenCalled();
    });

    // The physical claim comes BEFORE the durable row, and the volume is only made WRITABLE after the row lands.
    it('claims the disk read-only before the row, and enables only after it is durable', async () => {
        const order: string[] = [];
        deps.ioManager.registerVolume.mockImplementation(async () => { order.push('register(ro)'); });
        deps.database.createVolume.mockImplementation(async () => { order.push('createVolume'); });
        deps.database.updateVolumeFlags.mockImplementation(async () => { order.push('enable'); });
        deps.listRawBlockDevices
            .mockResolvedValueOnce([baseDevice])
            .mockResolvedValueOnce([deviceWithPartition(null)])
            .mockResolvedValueOnce([deviceWithPartition('PART-UUID')]);

        const provisioner = new DeviceProvisioner(deps);
        await provisioner.provision({ blockPath: '/dev/sdb' });

        expect(order).toEqual(['register(ro)', 'createVolume', 'enable']);
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

    // ⚠️ EACH DESTRUCTIVE STEP HAS ITS OWN SWAP WINDOW, and each is pinned by asserting the SPECIFIC command it
    // guards never ran. Delete the guard and that command executes on a disk that changed underneath us -- which
    // is exactly what these assertions catch. (currentDiskIdentity returns the disk we meant on the establish
    // call, then the impostor on the guarded check.)
    describe('a disk that swaps at each destructive window', () => {
        const wipeableDisk: RawBlockDevice = {
            ...baseDevice,
            children: [{ type: 'part', name: 'sdb1', size: 1024, uuid: 'OLD-UUID', fstype: 'ext4', mountpoint: null }]
        };

        // ⚠️ THE SAFETY PROBE IS ONLY TRUSTWORTHY IF IT EXAMINES THE DISK WE ANCHORED. If a blank disk is
        // snapshotted at /dev/sdb and a PARTITIONED STRUBS disk takes the path before we probe, the probe --
        // reading a stale empty `children` and then a live whole-disk GPT signature -- could call the swapped-in
        // disk "clean" and we would repartition live data. So the identity is anchored FIRST, the rack is listed
        // AFTER, and the probe is bracketed by serial checks. Pin the ordering: anchor before probe.
        it('anchors the disk identity BEFORE running the safety probe, and lists the rack after', async () => {
            deps.listRawBlockDevices.mockResolvedValue([baseDevice]);
            deps.probeDeviceForStrubsIdentity.mockResolvedValue({ status: 'clean' });

            const provisioner = new DeviceProvisioner(deps);
            // The anchor, list and probe all happen early; we do not need the provision to run to completion.
            await provisioner.provision({ blockPath: '/dev/sdb' }).catch(() => undefined);

            const anchoredAt = deps.currentDiskIdentity.mock.invocationCallOrder[0];
            const probedAt = deps.probeDeviceForStrubsIdentity.mock.invocationCallOrder[0];
            const listedAt = deps.listRawBlockDevices.mock.invocationCallOrder[0];

            expect(anchoredAt).toBeLessThan(probedAt);   // identity established before we trust a read of the disk
            expect(anchoredAt).toBeLessThan(listedAt);    // ...and before the snapshot the probe examines
        });

        // ...and if the disk changes between the anchor and the probe reading it, refuse before any parted.
        it('REFUSES when the disk changes across the safety probe', async () => {
            deps.listRawBlockDevices.mockResolvedValue([baseDevice]);
            deps.probeDeviceForStrubsIdentity.mockResolvedValue({ status: 'clean' });
            deps.currentDiskIdentity
                .mockResolvedValueOnce('DRIVE-WD-0001')       // anchor
                .mockResolvedValue('SWAPPED-DURING-PROBE');   // the bracket check refuses

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb' }))
                .rejects.toThrow(/DIFFERENT PHYSICAL DISK/);

            expect(deps.spawnHelper).not.toHaveBeenCalledWith(
                'parted', ['-s', '/dev/sdb', 'mkpart', 'primary', 'ext4', '0%', '100%']);
        });

        // Window 1: between establishing identity and `parted mklabel` (the wipe). Delete the guard and the
        // partition table of a swapped-in disk is destroyed.
        it('REFUSES before wiping the partition table', async () => {
            deps.listRawBlockDevices
                .mockResolvedValueOnce([wipeableDisk])
                .mockResolvedValueOnce([baseDevice])
                .mockResolvedValueOnce([deviceWithPartition(null)])
                .mockResolvedValueOnce([deviceWithPartition('PART-UUID')]);
            deps.currentDiskIdentity
                .mockResolvedValueOnce('DRIVE-WD-0001')       // establish
                .mockResolvedValue('SWAPPED-IN-IMPOSTOR');    // the pre-wipe check, and everything after

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb', wipe: true }))
                .rejects.toThrow(/DIFFERENT PHYSICAL DISK/);

            expect(deps.spawnHelper).not.toHaveBeenCalledWith('parted', ['-s', '/dev/sdb', 'mklabel', 'gpt']);
        });

        // Window 2: between establishing identity and `parted mkpart` (the new partition table). Non-wipe path.
        it('REFUSES before writing a new partition table', async () => {
            deps.listRawBlockDevices.mockResolvedValue([baseDevice]);
            deps.currentDiskIdentity
                .mockResolvedValueOnce('DRIVE-WD-0001')       // establish
                .mockResolvedValue('SWAPPED-IN-IMPOSTOR');    // the pre-partition check

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb' }))
                .rejects.toThrow(/DIFFERENT PHYSICAL DISK/);

            expect(deps.spawnHelper).not.toHaveBeenCalledWith(
                'parted', ['-s', '/dev/sdb', 'mkpart', 'primary', 'ext4', '0%', '100%']);
        });

        // Window 3: AFTER `parted` created the partition, BEFORE `mkfs` (plaintext). This is the window
        // waitForPartition() opens: parted ran, we slept, we re-enumerated, and the disk could have changed.
        it('REFUSES before mkfs, after the partition was created', async () => {
            deps.listRawBlockDevices
                .mockResolvedValueOnce([baseDevice])
                .mockResolvedValueOnce([deviceWithPartition(null)])
                .mockResolvedValueOnce([deviceWithPartition('PART-UUID')]);
            deps.currentDiskIdentity
                .mockResolvedValueOnce('DRIVE-WD-0001')       // establish
                .mockResolvedValueOnce('DRIVE-WD-0001')       // pre-partition: still ours
                .mockResolvedValue('SWAPPED-IN-IMPOSTOR');    // ...gone by the pre-mkfs check

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb' }))
                .rejects.toThrow(/DIFFERENT PHYSICAL DISK/);

            expect(deps.spawnHelper).not.toHaveBeenCalledWith('mkfs.ext4', ['-F', '/dev/sdb1']);
        });

        // ⚠️ THE FENCES ON INDIVIDUAL WRITES, driven by the PRECEDING write's execution -- not by call counting,
        // so deleting the fence genuinely lets the command through. The disk is itself until the earlier command
        // runs, then swaps; the fence on the next command must catch it.

        // parted mkpart is a SEPARATE write from parted mklabel. Swap after mklabel; mkpart must refuse.
        it('REFUSES parted mkpart when the disk swaps after mklabel', async () => {
            deps.listRawBlockDevices.mockResolvedValue([baseDevice]);
            deps.probeDeviceForStrubsIdentity.mockResolvedValue({ status: 'clean' });
            deps.spawnHelper.mockImplementation(async (cmd: string, args: string[]) => {
                if (cmd === 'parted' && args.includes('mklabel'))
                    deps.currentDiskIdentity.mockResolvedValue('SWAPPED-AFTER-MKLABEL');
                return { code: 0, stdout: '' };
            });

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb' })).rejects.toThrow(/DIFFERENT PHYSICAL DISK/);

            expect(deps.spawnHelper).toHaveBeenCalledWith('parted', ['-s', '/dev/sdb', 'mklabel', 'gpt']);
            expect(deps.spawnHelper).not.toHaveBeenCalledWith(
                'parted', ['-s', '/dev/sdb', 'mkpart', 'primary', 'ext4', '0%', '100%']);
        });

        // The fresh-header proof (testPassphrase on the just-created header) is the base case of the whole
        // single-disk argument, so it is fenced too. Swap after luksFormat; the proof must refuse.
        it('REFUSES the fresh-header proof when the disk swaps after luksFormat', async () => {
            deps.listRawBlockDevices
                .mockResolvedValueOnce([baseDevice])
                .mockResolvedValue([deviceWithPartition(null)]);
            deps.probeDeviceForStrubsIdentity.mockResolvedValue({ status: 'clean' });
            // addPassphrase is fenced and runs; the swap lands just after, before the proof.
            deps.luks.addPassphrase.mockImplementation(async () => {
                deps.currentDiskIdentity.mockResolvedValue('SWAPPED-BEFORE-PROOF');
            });

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb', encrypt: true }))
                .rejects.toThrow(/DIFFERENT PHYSICAL DISK/);

            expect(deps.spawnHelper).not.toHaveBeenCalledWith('mkfs.ext4', expect.anything());
        });

        // luks.addPassphrase is a SEPARATE write from luks.format. Swap after the LUKS header is written; the
        // keyslot write must refuse rather than authenticate with the keyfile against another of our disks.
        it('REFUSES the keyslot write when the disk swaps after luksFormat', async () => {
            deps.listRawBlockDevices
                .mockResolvedValueOnce([baseDevice])
                .mockResolvedValue([deviceWithPartition(null)]);
            deps.probeDeviceForStrubsIdentity.mockResolvedValue({ status: 'clean' });
            deps.luks.format.mockImplementation(async () => {
                deps.currentDiskIdentity.mockResolvedValue('SWAPPED-AFTER-LUKSFORMAT');
            });

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb', encrypt: true }))
                .rejects.toThrow(/DIFFERENT PHYSICAL DISK/);

            expect(deps.luks.format).toHaveBeenCalled();
            expect(deps.luks.addPassphrase).not.toHaveBeenCalled();
        });

        // mkfs is a SEPARATE write again. Swap after mkpart; mkfs must refuse (plaintext).
        it('REFUSES mkfs when the disk swaps after the partition is created', async () => {
            deps.listRawBlockDevices
                .mockResolvedValueOnce([baseDevice])
                .mockResolvedValue([deviceWithPartition('PART-UUID')]);
            deps.probeDeviceForStrubsIdentity.mockResolvedValue({ status: 'clean' });
            deps.spawnHelper.mockImplementation(async (cmd: string, args: string[]) => {
                if (cmd === 'parted' && args.includes('mkpart'))
                    deps.currentDiskIdentity.mockResolvedValue('SWAPPED-AFTER-MKPART');
                return { code: 0, stdout: '' };
            });

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb' })).rejects.toThrow(/DIFFERENT PHYSICAL DISK/);

            expect(deps.spawnHelper).not.toHaveBeenCalledWith('mkfs.ext4', ['-F', '/dev/sdb1']);
        });

        // ⚠️ THE PLAINTEXT IDENTITY CLAIM. Encrypted fences its nameplate write; plaintext writes no nameplate,
        // so its only identity claim is registerVolume -> .identity. Swap after mkfs (during the sleep); the
        // registration must refuse rather than write our identity onto a disk we did not format.
        it('REFUSES to claim identity on a plaintext disk that swapped in after mkfs', async () => {
            deps.listRawBlockDevices
                .mockResolvedValueOnce([baseDevice])
                .mockResolvedValue([deviceWithPartition('PART-UUID')]);
            deps.probeDeviceForStrubsIdentity.mockResolvedValue({ status: 'clean' });
            deps.spawnHelper.mockImplementation(async (cmd: string, args: string[]) => {
                if (cmd === 'mkfs.ext4')
                    deps.currentDiskIdentity.mockResolvedValue('SWAPPED-AFTER-MKFS');
                return { code: 0, stdout: '' };
            });

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb' })).rejects.toThrow(/DIFFERENT PHYSICAL DISK/);

            expect(deps.ioManager.registerVolume).not.toHaveBeenCalled();
        });
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

    // ⚠️ THE MOUNT IS NOT ON THE PARTITION. IT IS ON THE MAPPER UNDERNEATH IT.
    //
    // The design marks this DATA LOSS, and it is: on a LUKS volume the partition carries crypto_LUKS and has NO
    // mountpoint. The ext4 and the mount live on a `crypt` grandchild. So a guard that asked the partition "are
    // you mounted?" was told NO -- by a disk that was mounted, in service, and holding live customer data --
    // and `POST /$/volumes {wipe}` would have repartitioned it.
    describe('the wipe guard sees through LUKS', () => {
        it('REFUSES to wipe a mounted encrypted volume, whose mount is on the crypt grandchild', async () => {
            const encrypted = {
                name: 'sdf', path: '/dev/sdf', type: 'disk', size: 4000, serial: 'ENC1', pttype: 'gpt',
                children: [{
                    type: 'part', name: 'sdf1', path: '/dev/sdf1', size: 4000,
                    fstype: 'crypto_LUKS',
                    mountpoint: null,                       // <- the partition itself is NOT mounted
                    children: [{
                        type: 'crypt', name: 'luks-abc', path: '/dev/mapper/luks-abc', size: 4000,
                        fstype: 'ext4',
                        mountpoint: '/run/strubs/mounts/abc'  // <- ...but the array is very much using it
                    }]
                }]
            };

            deps.listRawBlockDevices.mockResolvedValue([encrypted]);
            // The identity probe would ALSO refuse this (crypto_LUKS => unknown). Make it say 'clean' so this
            // test proves the MOUNT guard on its own, rather than passing on the strength of a different one.
            deps.probeDeviceForStrubsIdentity.mockResolvedValue({ status: 'clean' });

            const provisioner = new DeviceProvisioner(deps);

            await expect(provisioner.provision({ blockPath: '/dev/sdf', wipe: true }))
                .rejects.toThrow(/mounted partitions/);
        });
    });

    // --- DR-G: encryption ---------------------------------------------------------------------------------
    //
    // The array ships in `off`. These tests exist to prove that (a) off really is off, (b) turning it on puts
    // the filesystem in the right place, and (c) when it cannot be done safely we find out BEFORE the disk is
    // destroyed rather than after.
    describe('encryption', () => {
        const luksDevice = (uuid: string | null): RawBlockDevice => ({
            ...baseDevice,
            pttype: 'gpt',
            ptuuid: 'PT-NEW',
            children: [{
                type: 'part',
                name: 'sdb1',
                size: 2048,
                uuid,
                fstype: uuid ? 'crypto_LUKS' : null,
                mountpoint: null
            }]
        });

        const PASSPHRASE = 'correct horse battery staple';

        const stageDiscovery = (final: RawBlockDevice) => {
            deps.listRawBlockDevices
                .mockResolvedValueOnce([baseDevice])
                .mockResolvedValueOnce([deviceWithPartition(null)])
                .mockResolvedValueOnce([final]);
        };

        // THE GATE IS FOR ENCRYPTED PROVISIONS ONLY. A plaintext disk has no keyslot to get wrong, and blocking
        // a passphrase rotation for the ten minutes it takes to mkfs a 4TB disk would be a needless refusal.
        // (An earlier version wrapped EVERY provision while its comment claimed it did not -- worse than either
        // behaviour on its own.)
        it('does not take the encryption gate for a plaintext provision', async () => {
            stageDiscovery(deviceWithPartition('PART-UUID'));

            const provisioner = new DeviceProvisioner(deps);
            await provisioner.provision({ blockPath: '/dev/sdb' });

            expect(deps.withEncryptionSlot).not.toHaveBeenCalled();
        });

        it('DOES take it for an encrypted one -- a rotation must not run through the middle of that', async () => {
            stageDiscovery(luksDevice('LUKS-UUID'));

            const provisioner = new DeviceProvisioner(deps);
            await provisioner.provision({ blockPath: '/dev/sdb', encrypt: true, recoveryPassphrase: PASSPHRASE });

            expect(deps.withEncryptionSlot).toHaveBeenCalled();
        });

        it('does not encrypt by default: an untouched array provisions plaintext', async () => {
            stageDiscovery(deviceWithPartition('PART-UUID'));

            const provisioner = new DeviceProvisioner(deps);
            await provisioner.provision({ blockPath: '/dev/sdb' });

            expect(deps.luks.format).not.toHaveBeenCalled();
            expect(deps.spawnHelper).toHaveBeenCalledWith('mkfs.ext4', ['-F', '/dev/sdb1']);
        });

        it('encrypts when the fleet default says to', async () => {
            deps.database.getRuntimeConfig.mockResolvedValue(true);
            stageDiscovery(luksDevice('LUKS-UUID'));

            const provisioner = new DeviceProvisioner(deps);
            await provisioner.provision({ blockPath: '/dev/sdb', recoveryPassphrase: PASSPHRASE });

            expect(deps.luks.format).toHaveBeenCalledWith('/dev/sdb1');
        });

        // TWO KEYSLOTS OR NOTHING. A volume holding only the keyfile slot is a volume that dies with the OS
        // disk -- every slice on it, unreadable, forever.
        // THE BASE CASE OF THE INDUCTION. Every LATER encryption checks the passphrase against just ONE
        // existing disk, on the grounds that every encrypted volume was verified when it was made. If that is
        // ever false at the moment of creation, every subsequent single-disk check inherits the lie -- and the
        // audit would only find it months later, if at all.
        //
        // assertRecoverable only COUNTS keyslots; it cannot tell you what is IN them. So prove the passphrase
        // actually opens the header we just wrote.
        it('proves the recovery passphrase opens the disk it just encrypted', async () => {
            deps.luks.testPassphrase.mockResolvedValue('rejected');
            stageDiscovery(luksDevice('LUKS-UUID'));

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({
                blockPath: '/dev/sdb', encrypt: true, recoveryPassphrase: PASSPHRASE
            })).rejects.toThrow(/does not open it/);

            // Never went into service, and nothing was recorded. Nothing of value was on it yet.
            expect(deps.spawnHelper).not.toHaveBeenCalledWith('mkfs.ext4', expect.anything());
            expect(deps.database.createVolume).not.toHaveBeenCalled();
        });

        it('adds the recovery passphrase as a second keyslot', async () => {
            stageDiscovery(luksDevice('LUKS-UUID'));

            const provisioner = new DeviceProvisioner(deps);
            await provisioner.provision({ blockPath: '/dev/sdb', encrypt: true, recoveryPassphrase: PASSPHRASE });

            expect(deps.luks.addPassphrase).toHaveBeenCalledWith('/dev/sdb1', PASSPHRASE);
            expect(deps.luks.assertRecoverable).toHaveBeenCalledWith('/dev/sdb1');
        });

        // NOBODY IS PROMPTED. The passphrase is sealed under the keyfile and the provisioner takes it from
        // there -- which is what makes `encryptNewVolumes` honest, because a disk provisioned automatically has
        // no operator standing by to type anything.
        it('takes the passphrase from the seal when the caller does not supply one', async () => {
            stageDiscovery(luksDevice('LUKS-UUID'));

            const provisioner = new DeviceProvisioner(deps);
            await provisioner.provision({ blockPath: '/dev/sdb', encrypt: true });

            expect(deps.sealedRecoveryPassphrase).toHaveBeenCalled();
            expect(deps.luks.addPassphrase).toHaveBeenCalledWith('/dev/sdb1', PASSPHRASE);
            expect(deps.assertFleetRecoveryPassphrase).toHaveBeenCalledWith(PASSPHRASE);
        });

        // ...BUT IT CANNOT BE INVENTED. A volume with only the keyfile slot dies with the OS disk, so if nothing
        // holds a passphrase we stop -- and we stop BEFORE `parted`, while the disk is still whole.
        it('refuses to encrypt when no passphrase exists anywhere, before partitioning', async () => {
            deps.sealedRecoveryPassphrase.mockResolvedValue(null);
            deps.hasRecoveryPassphrase.mockResolvedValue(false);
            deps.listRawBlockDevices.mockResolvedValueOnce([baseDevice]);

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb', encrypt: true }))
                .rejects.toThrow(/has no recovery passphrase/);

            expect(deps.spawnHelper).not.toHaveBeenCalledWith('parted', expect.anything());
            expect(deps.luks.format).not.toHaveBeenCalled();
        });

        // ⚠️ "YOU NEVER SET ONE" AND "I CANNOT USE THE ONE YOU SET" ARE DIFFERENT SENTENCES.
        //
        // An array that recorded a passphrase before STRUBS kept a usable copy holds a hash it can check and
        // cannot produce. Telling that operator "this array has no recovery passphrase" -- when they set one,
        // and wrote it down -- would send them looking for a fault that does not exist, and the fix (say it once
        // more) is nowhere in that sentence.
        it('says the passphrase is UNUSABLE, not missing, when one is on record', async () => {
            deps.sealedRecoveryPassphrase.mockResolvedValue(null);
            deps.hasRecoveryPassphrase.mockResolvedValue(true);
            deps.listRawBlockDevices.mockResolvedValueOnce([baseDevice]);

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb', encrypt: true }))
                .rejects.toThrow(/cannot USE it/);

            expect(deps.spawnHelper).not.toHaveBeenCalledWith('parted', expect.anything());
            expect(deps.luks.format).not.toHaveBeenCalled();
        });

        // A brand-new disk has no previous record to inherit from, and must not pick one up by accident.
        it('gives a genuinely new volume no label', async () => {
            deps.database.setVolumes([{ id: 57, label: '2.1', comment: 'not mine' }]);
            stageDiscovery(luksDevice('LUKS-UUID'));

            const provisioner = new DeviceProvisioner(deps);
            await provisioner.provision({ blockPath: '/dev/sdb', encrypt: true });

            expect(deps.database.createVolume).toHaveBeenCalledWith(expect.objectContaining({
                id: 58, label: null, comment: null
            }));
        });

        // ⚠️ A PATH IS NOT AN IDENTITY, AND `parted` TAKES A PATH.
        //
        // Between the scan and the wipe we run an identity probe, an argon2 hash, and (soon) a passphrase test
        // against a real disk. That is seconds. These are USB spindles on a hub that drops them: /dev/sdb can
        // become a DIFFERENT disk in that window, and the next line formats it. The serial comes from the
        // hardware, not from the kernel's enumeration order.
        it('REFUSES to partition a path that a different disk has taken since we looked', async () => {
            stageDiscovery(luksDevice('LUKS-UUID'));

            // It is the disk we meant when we identify it, and somebody else by the time we would partition it.
            deps.currentDiskIdentity
                .mockResolvedValueOnce('DRIVE-WD-0001')
                .mockResolvedValue('A-COMPLETELY-DIFFERENT-DRIVE');

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb', encrypt: true }))
                .rejects.toThrow(/A DIFFERENT PHYSICAL DISK has taken that path/);

            expect(deps.spawnHelper).not.toHaveBeenCalledWith('parted', expect.anything());
            expect(deps.luks.format).not.toHaveBeenCalled();
        });

        it('REFUSES to partition a drive that will not say who it is', async () => {
            stageDiscovery(luksDevice('LUKS-UUID'));
            deps.currentDiskIdentity.mockResolvedValue(null);

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb', encrypt: true }))
                .rejects.toThrow(/will not report a SMART serial/);

            expect(deps.spawnHelper).not.toHaveBeenCalledWith('parted', expect.anything());
        });

        // ⚠️ THE DATABASE CAN BE RESTORED. THE PLATTERS CANNOT.
        //
        // A Mongo restored from before a passphrase rotation holds notes that agree with each other and with
        // nothing in the rack. Every hash check passes; the disks want a different passphrase entirely. Writing
        // the note onto a fresh disk splits the fleet, silently, and it stays silent until the OS disk dies.
        it('REFUSES to encrypt when the passphrase does not open a disk we already encrypted', async () => {
            deps.assertPassphraseOpensTheFleet.mockRejectedValue(
                new Error('the recovery passphrase does NOT open volume11 (/dev/sdf1)'));
            stageDiscovery(luksDevice('LUKS-UUID'));

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb', encrypt: true }))
                .rejects.toThrow(/does NOT open volume/);

            // BEFORE the disk was touched. The refusal is worthless if it arrives after `parted`.
            expect(deps.spawnHelper).not.toHaveBeenCalledWith('parted', expect.anything());
            expect(deps.luks.format).not.toHaveBeenCalled();
        });

        it('proves the passphrase against a real disk before writing it to a new one', async () => {
            stageDiscovery(luksDevice('LUKS-UUID'));

            const provisioner = new DeviceProvisioner(deps);
            await provisioner.provision({ blockPath: '/dev/sdb', encrypt: true });

            expect(deps.assertPassphraseOpensTheFleet).toHaveBeenCalledWith(PASSPHRASE);
        });

        // ⚠️ THE CLONE THAT ARRIVES AFTER THE SCAN.
        //
        // mgmt scans the volume's platter, proves it holds no slices, unmounts it and deregisters it -- and only
        // THEN does the provisioner touch the disk. Plug a dd'd copy in during that handoff and it answers to
        // the same path, the same partition uuid, the same nameplate, the same .identity file. Every check the
        // provisioner makes on its own would pass, agreeing with itself about a disk nobody ever scanned -- and
        // a clone is full of exactly the recoverable orphans that must never be destroyed.
        //
        // The serial is the one thing it cannot forge. The caller names the disk it MEANT.
        it('REFUSES a disk whose serial is not the one the caller scanned (a clone in the handoff)', async () => {
            stageDiscovery(luksDevice('LUKS-UUID'));

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({
                blockPath: '/dev/sdb', encrypt: true, expectDiskSerial: 'THE-DRIVE-WE-ACTUALLY-SCANNED'
            })).rejects.toThrow(/A DIFFERENT PHYSICAL DISK is sitting at that path/);

            expect(deps.spawnHelper).not.toHaveBeenCalledWith('parted', expect.anything());
            expect(deps.luks.format).not.toHaveBeenCalled();
        });

        it('proceeds when the disk at the path IS the one that was scanned', async () => {
            stageDiscovery(luksDevice('LUKS-UUID'));

            const provisioner = new DeviceProvisioner(deps);
            await provisioner.provision({
                blockPath: '/dev/sdb', encrypt: true, expectDiskSerial: 'DRIVE-WD-0001'
            });

            expect(deps.luks.format).toHaveBeenCalledWith('/dev/sdb1');
        });

        // ⚠️ `parted` IS NOT THE LAST DESTRUCTIVE STEP. After it we sleep, re-enumerate, and hand whatever now
        // sits at that path to luksFormat and mkfs. A disk that drops in THAT window takes its replacement's
        // data with it.
        it('REFUSES to luksFormat a disk that swapped in after parted ran', async () => {
            stageDiscovery(luksDevice('LUKS-UUID'));

            // Itself right up to the partitioning...
            deps.currentDiskIdentity
                .mockResolvedValueOnce('DRIVE-WD-0001')       // the identity check at the start
                .mockResolvedValueOnce('DRIVE-WD-0001')       // ...still itself before parted
                .mockResolvedValue('SOMEBODY-ELSE-ENTIRELY'); // ...and then not

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb', encrypt: true }))
                .rejects.toThrow(/A DIFFERENT PHYSICAL DISK has taken that path/);

            // parted ran -- we cannot un-run it -- but the disk that took the path was NOT encrypted or mkfs'd.
            expect(deps.luks.format).not.toHaveBeenCalled();
            expect(deps.spawnHelper).not.toHaveBeenCalledWith('mkfs.ext4', expect.anything());
        });

        // ⚠️ THE MAPPER HOLDS A DISK, NOT A PATH, AND mkfs RUNS ON THE MAPPER. The classic swap-back: A drops,
        // B takes /dev/sdb, we open a mapper backed by B, A returns to /dev/sdb -- so every PATH check reads A
        // and passes, while the disk under the mapper we are about to mkfs is B. Only asking the mapper who ITS
        // disk is catches this.
        it('REFUSES to mkfs when the MAPPER is backed by a different drive than the one we scanned', async () => {
            stageDiscovery(luksDevice('LUKS-UUID'));

            // Every /dev/sdb probe says the disk we meant -- the swap is invisible at the path.
            deps.currentDiskIdentity.mockImplementation(async (path: string) =>
                path === '/dev/sdd' ? 'THE-IMPOSTOR-DRIVE' : 'DRIVE-WD-0001');
            // ...but the mapper is backed by a partition on a DIFFERENT disk (/dev/sdd).
            deps.luks.mapperBackingDevice.mockResolvedValue('sdd1');

            // Capture the (random) volume uuid the provisioner minted, so we can prove the mapper it tears down
            // is THIS one -- not some unrelated close() call.
            let openedUuid: string | undefined;
            deps.luks.open.mockImplementation(async (_path: string, uuid: string) => {
                openedUuid = uuid;
                return `/dev/mapper/strubs-${uuid}`;
            });

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb', encrypt: true }))
                .rejects.toThrow(/DIFFERENT PHYSICAL DISK was mapped/);

            expect(deps.spawnHelper).not.toHaveBeenCalledWith('mkfs.ext4', expect.anything());
            expect(deps.luks.close).toHaveBeenCalledWith(openedUuid);   // THE bad mapper, torn down by its uuid
        });

        // ⚠️ RECORDING THE PASSPHRASE IS A WRITE, AND IT MUST BE THE LAST ONE. assertFleetRecoveryPassphrase()
        // SEALS the passphrase as a side effect of accepting it -- so if a later guard refuses, the array would
        // be left reporting `passphraseUsable: true` about a passphrase it was not allowed to use. The error
        // would pass; the lie would persist.
        it('does not RECORD the passphrase when the disk proof refuses the encryption', async () => {
            deps.assertPassphraseOpensTheFleet.mockRejectedValue(
                new Error('the recovery passphrase does NOT open volume11'));
            stageDiscovery(luksDevice('LUKS-UUID'));

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb', encrypt: true })).rejects.toThrow();

            expect(deps.assertFleetRecoveryPassphrase).not.toHaveBeenCalled();
        });

        // An explicit passphrase still wins -- the API accepts one, and it is checked against the fleet exactly
        // as it always was.
        it('prefers an explicitly supplied passphrase over the seal', async () => {
            stageDiscovery(luksDevice('LUKS-UUID'));

            const provisioner = new DeviceProvisioner(deps);
            await provisioner.provision({ blockPath: '/dev/sdb', encrypt: true, recoveryPassphrase: PASSPHRASE });

            expect(deps.sealedRecoveryPassphrase).not.toHaveBeenCalled();
            expect(deps.assertFleetRecoveryPassphrase).toHaveBeenCalledWith(PASSPHRASE);
        });

        // A passphrase that does not match the rest of the fleet leaves you holding a key that opens SOME of
        // your disks -- and you find out which on the worst day of the array's life.
        it('refuses a passphrase that disagrees with the fleet, before partitioning', async () => {
            deps.assertFleetRecoveryPassphrase.mockRejectedValue(new Error('that is not the recovery passphrase'));
            deps.listRawBlockDevices.mockResolvedValueOnce([baseDevice]);

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb', encrypt: true, recoveryPassphrase: 'wrong one entirely' }))
                .rejects.toThrow(/recovery passphrase/);

            expect(deps.spawnHelper).not.toHaveBeenCalledWith('parted', expect.anything());
            expect(deps.luks.format).not.toHaveBeenCalled();
        });

        // THE ONE THAT MATTERS. mkfs on the PARTITION would overwrite the LUKS header we just wrote -- an
        // encrypted volume that is not encrypted, silently, with a lock icon in the UI saying otherwise.
        it('puts the filesystem on the MAPPER, never on the ciphertext', async () => {
            stageDiscovery(luksDevice('LUKS-UUID'));

            const provisioner = new DeviceProvisioner(deps);
            const volume = await provisioner.provision({ blockPath: '/dev/sdb', encrypt: true, recoveryPassphrase: PASSPHRASE });

            expect(deps.spawnHelper).toHaveBeenCalledWith('mkfs.ext4', ['-F', `/dev/mapper/strubs-${volume.uuid}`]);
            expect(deps.spawnHelper).not.toHaveBeenCalledWith('mkfs.ext4', ['-F', '/dev/sdb1']);
        });

        // The mapper name is derived from the volume uuid, so the uuid the container was opened under has to be
        // the uuid we then persist -- otherwise the volume mounts once (from the provisioner's still-open
        // mapper) and never again after a restart.
        it('opens the container under the same uuid it persists', async () => {
            stageDiscovery(luksDevice('LUKS-UUID'));

            const provisioner = new DeviceProvisioner(deps);
            const volume = await provisioner.provision({ blockPath: '/dev/sdb', encrypt: true, recoveryPassphrase: PASSPHRASE });

            expect(deps.luks.open).toHaveBeenCalledWith('/dev/sdb1', volume.uuid);
            expect(deps.database.createVolume).toHaveBeenCalledWith(expect.objectContaining({ uuid: volume.uuid }));
        });

        it('refuses BEFORE partitioning when the keyfile is unreadable', async () => {
            deps.luks.keyfileReadable.mockResolvedValue(false);
            deps.listRawBlockDevices.mockResolvedValueOnce([baseDevice]);

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb', encrypt: true, recoveryPassphrase: PASSPHRASE }))
                .rejects.toThrow(/keyfile/);

            // The disk must still be whole. A refusal that leaves a wiped disk behind is not a refusal.
            expect(deps.spawnHelper).not.toHaveBeenCalledWith('parted', expect.anything());
            expect(deps.luks.format).not.toHaveBeenCalled();
        });

        // A container with one keyslot dies with the OS disk holding its keyfile. luks.assertRecoverable is
        // what refuses that, and it must be consulted while walking away still costs us nothing.
        it('stops if the container would be unrecoverable, before the filesystem is made', async () => {
            deps.luks.assertRecoverable.mockRejectedValue(new Error('only 1 keyslot'));
            stageDiscovery(luksDevice('LUKS-UUID'));

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb', encrypt: true, recoveryPassphrase: PASSPHRASE })).rejects.toThrow(/keyslot/);

            expect(deps.luks.open).not.toHaveBeenCalled();
            expect(deps.spawnHelper).not.toHaveBeenCalledWith('mkfs.ext4', expect.anything());
            expect(deps.database.createVolume).not.toHaveBeenCalled();
        });

        // An explicit `false` from the operator beats a fleet default of `true`. The tri-state exists for this.
        it('lets the operator opt one disk out of an encrypting fleet', async () => {
            deps.database.getRuntimeConfig.mockResolvedValue(true);
            stageDiscovery(deviceWithPartition('PART-UUID'));

            const provisioner = new DeviceProvisioner(deps);
            await provisioner.provision({ blockPath: '/dev/sdb', encrypt: false });

            expect(deps.luks.format).not.toHaveBeenCalled();
        });

        // AN ENCRYPTED DISK WITH NO NAMEPLATE IS INVISIBLE TO THE FLEET-PASSPHRASE GUARD, which enumerates the
        // array's encrypted disks by reading their plates off the partition table. A disk it cannot see is a
        // disk the next encryption will not test its passphrase against -- which is how a fleet ends up split
        // across two recovery passphrases. So a plate that does not land is a FAILED PROVISION, not a warning:
        // better a blank encrypted partition than an unidentifiable one in service.
        it('refuses to put an encrypted volume into service if the nameplate did not land', async () => {
            deps.luks.nameplateIsPresent.mockResolvedValue(false);
            stageDiscovery(luksDevice('LUKS-UUID'));

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({
                blockPath: '/dev/sdb', encrypt: true, recoveryPassphrase: PASSPHRASE
            })).rejects.toThrow(/nameplate could not be written/);

            // It never went into service -- AND no record was written. Creating the record first would have
            // made the refusal useless: the next restart would simply mount the nameplate-less volume anyway,
            // which is the exact state we are refusing.
            expect(deps.database.createVolume).not.toHaveBeenCalled();
            expect(deps.ioManager.registerVolume).not.toHaveBeenCalled();
        });

        // The nameplate is how a LOCKED disk says whose it is. It goes on the GPT entry, outside the container.
        it('stamps the GPT nameplate with the identity and the volume id', async () => {
            stageDiscovery(luksDevice('LUKS-UUID'));

            const provisioner = new DeviceProvisioner(deps);
            const volume = await provisioner.provision({ blockPath: '/dev/sdb', encrypt: true, recoveryPassphrase: PASSPHRASE });

            expect(deps.luks.writeNameplate).toHaveBeenCalledWith('/dev/sdb', 1, '2fb05f23-1d5e-4c00-bb71-f3109b42476c', volume.id);
        });

        // --- CONVERSION: wiping one of our OWN disks, on purpose ---------------------------------------------
        //
        // Every other path here refuses a disk carrying our identity. This is the one that requires it -- so the
        // guard inverts, and these tests are the ones that matter most in the file. A conversion aimed at the
        // wrong disk destroys live customer data.
        describe('converting an existing volume', () => {
            // What the probe ACTUALLY returns: 16 raw bytes off the platter, hex-encoded. No hyphens.
            const ourDisk = (volumeId: number, identity = '2fb05f231d5e4c00bb71f3109b42476c') => {
                deps.probeDeviceForStrubsIdentity.mockResolvedValue({
                    status: 'strubs',
                    identity: { volumeId, instanceIdentity: identity }
                });
            };

            // ⚠️ THE LABEL IS WHICH BAY THE DISK IS IN. Encryption rewrites the platter; it does not move the
            // disk to another shelf. The conversion builds a FRESH record under the same id, so every field not
            // copied across is simply gone -- and the label ("2.1" = shelf 2, bay 1) and the comment are
            // operator knowledge that nothing in the system can reconstruct. Volume 57 came back from its first
            // real conversion as an anonymous spindle in a rack of thirty identical ones.
            it('keeps the label and comment: the disk did not move, it only changed clothes', async () => {
                ourDisk(7);
                deps.database.setVolumes([
                    { id: 7, label: '2.1', comment: 'replaced under warranty 2025-11' }
                ]);
                deps.listRawBlockDevices
                    .mockResolvedValueOnce([deviceWithPartition('PART-UUID')])
                    .mockResolvedValueOnce([baseDevice])
                    .mockResolvedValueOnce([deviceWithPartition(null)])
                    .mockResolvedValueOnce([luksDevice('LUKS-UUID')]);

                const provisioner = new DeviceProvisioner(deps);
                await provisioner.provision({
                    blockPath: '/dev/sdb', wipe: true, replace: true, encrypt: true,
                    recoveryPassphrase: PASSPHRASE, convertVolumeId: 7
                });

                expect(deps.database.createVolume).toHaveBeenCalledWith(expect.objectContaining({
                    id: 7,
                    label: '2.1',
                    comment: 'replaced under warranty 2025-11'
                }));
            });

            it('converts our own drained volume, keeping its id', async () => {
                ourDisk(7);
                // A conversion starts from a disk that is ALREADY ours and already partitioned: an ext4 STRUBS
                // volume, drained and stopped. Then: wipe, re-read (bare), partition, and finally LUKS.
                deps.listRawBlockDevices
                    .mockResolvedValueOnce([deviceWithPartition('PART-UUID')])
                    .mockResolvedValueOnce([baseDevice])
                    .mockResolvedValueOnce([deviceWithPartition(null)])
                    .mockResolvedValueOnce([luksDevice('LUKS-UUID')]);

                const provisioner = new DeviceProvisioner(deps);
                const volume = await provisioner.provision({
                    blockPath: '/dev/sdb', wipe: true, replace: true, encrypt: true,
                    recoveryPassphrase: PASSPHRASE, convertVolumeId: 7
                });

                // The id survives. A disk that never left the array must not be renumbered by being rebuilt.
                expect(volume.id).toBe(7);
                expect(deps.luks.format).toHaveBeenCalledWith('/dev/sdb1');
                expect(deps.database.deleteVolume).toHaveBeenCalledWith(7);
                expect(deps.ioManager.deregisterVolume).toHaveBeenCalledWith(7);
            });

            // A MISTYPED VOLUME ID MUST DESTROY NOTHING. The disk has to prove it is the one we were told to
            // convert before anything touches it.
            it('refuses a disk carrying a DIFFERENT volume id', async () => {
                ourDisk(9);   // the disk in the slot is volume 9...
                deps.listRawBlockDevices.mockResolvedValueOnce([baseDevice]);

                const provisioner = new DeviceProvisioner(deps);
                await expect(provisioner.provision({
                    blockPath: '/dev/sdb', wipe: true, replace: true, encrypt: true,
                    recoveryPassphrase: PASSPHRASE, convertVolumeId: 7   // ...but we asked for volume 7
                })).rejects.toThrow(/carries STRUBS volume 9, not volume 7/);

                expect(deps.spawnHelper).not.toHaveBeenCalledWith('parted', expect.anything());
                expect(deps.luks.format).not.toHaveBeenCalled();
            });

            // THE ONE THAT NEARLY SHIPPED BROKEN. `config.identity` is a hyphenated UUID; the probe returns
            // plain hex. Comparing them raw NEVER matches -- so conversion would have refused every disk we
            // own, forever, while telling the operator their own disk belonged to somebody else.
            it('recognises our own disk despite the identity being stored as a hyphenated UUID', async () => {
                ourDisk(7);   // probe: '2fb05f231d5e4c00bb71f3109b42476c'   config: '2fb05f23-1d5e-...'
                deps.listRawBlockDevices
                    .mockResolvedValueOnce([deviceWithPartition('PART-UUID')])
                    .mockResolvedValueOnce([baseDevice])
                    .mockResolvedValueOnce([deviceWithPartition(null)])
                    .mockResolvedValueOnce([luksDevice('LUKS-UUID')]);

                const provisioner = new DeviceProvisioner(deps);
                const volume = await provisioner.provision({
                    blockPath: '/dev/sdb', wipe: true, replace: true, encrypt: true,
                    recoveryPassphrase: PASSPHRASE, convertVolumeId: 7
                });

                expect(volume.id).toBe(7);
            });

            // A LOCKED disk identifies itself by its GPT nameplate, which only carries the FIRST 16 hex
            // characters of the identity. A prefix, not the whole thing -- and it still has to be recognised.
            it('recognises our own disk from a 16-hex nameplate prefix', async () => {
                ourDisk(7, '2fb05f231d5e4c00');   // what parseNameplate() hands back
                deps.listRawBlockDevices
                    .mockResolvedValueOnce([deviceWithPartition('PART-UUID')])
                    .mockResolvedValueOnce([baseDevice])
                    .mockResolvedValueOnce([deviceWithPartition(null)])
                    .mockResolvedValueOnce([luksDevice('LUKS-UUID')]);

                const provisioner = new DeviceProvisioner(deps);
                await expect(provisioner.provision({
                    blockPath: '/dev/sdb', wipe: true, replace: true, encrypt: true,
                    recoveryPassphrase: PASSPHRASE, convertVolumeId: 7
                })).resolves.toMatchObject({ id: 7 });
            });

            it('refuses a disk belonging to another STRUBS instance', async () => {
                ourDisk(7, 'ffffffffffffffffffffffffffffffff');
                deps.listRawBlockDevices.mockResolvedValueOnce([baseDevice]);

                const provisioner = new DeviceProvisioner(deps);
                await expect(provisioner.provision({
                    blockPath: '/dev/sdb', wipe: true, replace: true, encrypt: true,
                    recoveryPassphrase: PASSPHRASE, convertVolumeId: 7
                })).rejects.toThrow(/belongs to STRUBS instance ffffffff/);

                expect(deps.spawnHelper).not.toHaveBeenCalledWith('parted', expect.anything());
            });

            // Fail CLOSED. A disk we could not read is not permission to assume it is the one we meant.
            it('refuses a disk that cannot prove who it is', async () => {
                deps.probeDeviceForStrubsIdentity.mockResolvedValue({ status: 'unknown', reason: 'mount failed' });
                deps.listRawBlockDevices.mockResolvedValueOnce([baseDevice]);

                const provisioner = new DeviceProvisioner(deps);
                await expect(provisioner.provision({
                    blockPath: '/dev/sdb', wipe: true, replace: true, encrypt: true,
                    recoveryPassphrase: PASSPHRASE, convertVolumeId: 7
                })).rejects.toThrow(/must first prove it is the disk you meant/);

                expect(deps.spawnHelper).not.toHaveBeenCalledWith('parted', expect.anything());
            });

            // The last line of defence against a caller that forgot to stop the volume: the disk is still
            // mounted and in service. The mounted-partitions guard must catch it.
            it('refuses a volume that is still mounted', async () => {
                ourDisk(7);
                const mounted: RawBlockDevice = {
                    ...baseDevice,
                    children: [{
                        type: 'part', name: 'sdb1', size: 2048, uuid: 'PART-UUID',
                        fstype: 'ext4', mountpoint: '/run/strubs/mounts/abc'
                    }]
                };
                deps.listRawBlockDevices.mockResolvedValueOnce([mounted]);

                const provisioner = new DeviceProvisioner(deps);
                await expect(provisioner.provision({
                    blockPath: '/dev/sdb', wipe: true, replace: true, encrypt: true,
                    recoveryPassphrase: PASSPHRASE, convertVolumeId: 7
                })).rejects.toThrow(/mounted partitions/);

                expect(deps.spawnHelper).not.toHaveBeenCalledWith('parted', expect.anything());
            });

            it('refuses a conversion that does not say it is destructive', async () => {
                ourDisk(7);
                deps.listRawBlockDevices.mockResolvedValueOnce([baseDevice]);

                const provisioner = new DeviceProvisioner(deps);
                await expect(provisioner.provision({
                    blockPath: '/dev/sdb', encrypt: true, recoveryPassphrase: PASSPHRASE, convertVolumeId: 7
                })).rejects.toThrow(/pass wipe/);
            });
        });
    });
});
