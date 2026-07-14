import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RawBlockDevice } from '../lib/io/device-discovery';
import { DeviceProvisioner } from '../lib/io/device-provisioner';

const createDeps = () => {
    const listRawBlockDevices = vi.fn();
    const database = {
        getVolumes: vi.fn().mockResolvedValue([{ id: 1 }]),
        createVolume: vi.fn().mockResolvedValue(undefined),
        deleteVolume: vi.fn().mockResolvedValue(undefined),
        // The fleet default. `undefined` is what an untouched array returns from runtimeConfig, and it must
        // mean "no encryption" -- shipping in `off` is the whole plan.
        getRuntimeConfig: vi.fn().mockResolvedValue(undefined)
    };
    const ioManager = {
        registerVolume: vi.fn().mockResolvedValue(undefined),
        deregisterVolume: vi.fn().mockResolvedValue(undefined),
        getVolumeEntries: vi.fn().mockReturnValue([])
    };
    const luks = {
        keyfileReadable: vi.fn().mockResolvedValue(true),
        format: vi.fn().mockResolvedValue(undefined),
        addPassphrase: vi.fn().mockResolvedValue(undefined),
        open: vi.fn().mockImplementation(async (_path: string, uuid: string) => `/dev/mapper/strubs-${uuid}`),
        assertRecoverable: vi.fn().mockResolvedValue(undefined),
        writeNameplate: vi.fn().mockResolvedValue(undefined),
        // The nameplate is LOAD-BEARING on an encrypted volume: it is how a locked disk says it is ours, and
        // the fleet-passphrase guard enumerates encrypted disks by it. So the provisioner reads it back.
        nameplateIsPresent: vi.fn().mockResolvedValue(true),
        mapperPath: vi.fn().mockImplementation((uuid: string) => `/dev/mapper/strubs-${uuid}`)
    };
    const assertFleetRecoveryPassphrase = vi.fn().mockResolvedValue(undefined);
    const spawnHelper = vi.fn().mockResolvedValue({ code: 0, stdout: '' });
    const sleepSecs = vi.fn().mockResolvedValue(undefined);
    // By default: we have an identity (not in recovery), and the target disk is positively established
    // to carry no STRUBS identity.
    const probeDeviceForStrubsIdentity = vi.fn().mockResolvedValue({ status: 'clean' });
    // THE REAL SHAPE. config.identity on this array is a HYPHENATED UUID, and the probe hands back 32 raw hex
    // characters. Testing with a tidy 16-hex string is what let the nameplate ship unparseable by its own
    // reader: the test agreed with the code, and both were wrong about the machine.
    const instanceIdentity = vi.fn().mockReturnValue('2fb05f23-1d5e-4c00-bb71-f3109b42476c');
    return { listRawBlockDevices, database, ioManager, luks, spawnHelper, sleepSecs, probeDeviceForStrubsIdentity, instanceIdentity, assertFleetRecoveryPassphrase };
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
        it('adds the recovery passphrase as a second keyslot', async () => {
            stageDiscovery(luksDevice('LUKS-UUID'));

            const provisioner = new DeviceProvisioner(deps);
            await provisioner.provision({ blockPath: '/dev/sdb', encrypt: true, recoveryPassphrase: PASSPHRASE });

            expect(deps.luks.addPassphrase).toHaveBeenCalledWith('/dev/sdb1', PASSPHRASE);
            expect(deps.luks.assertRecoverable).toHaveBeenCalledWith('/dev/sdb1');
        });

        it('refuses to encrypt with no recovery passphrase at all, before partitioning', async () => {
            deps.listRawBlockDevices.mockResolvedValueOnce([baseDevice]);

            const provisioner = new DeviceProvisioner(deps);
            await expect(provisioner.provision({ blockPath: '/dev/sdb', encrypt: true }))
                .rejects.toThrow(/recovery passphrase/);

            expect(deps.spawnHelper).not.toHaveBeenCalledWith('parted', expect.anything());
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
