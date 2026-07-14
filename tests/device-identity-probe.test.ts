import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnHelperMock, readFileMock } = vi.hoisted(() => ({
    spawnHelperMock: vi.fn(),
    readFileMock: vi.fn()
}));

vi.mock('../lib/helpers/spawn', () => ({ spawnHelper: spawnHelperMock }));
vi.mock('fs', async () => {
    const real = await vi.importActual<typeof import('fs')>('fs');
    return {
        ...real,
        promises: {
            ...real.promises,
            mkdtemp: vi.fn(async () => '/tmp/strubs-probe-test'),
            readFile: readFileMock,
            rm: vi.fn(async () => undefined)
        }
    };
});

import { probeStrubsIdentity, probeDeviceForStrubsIdentity } from '../lib/io/device-identity-probe';
import { buildVolumeIdentityBuffer } from '../lib/io/volume-identity';

const extPartition = { type: 'part', name: 'sdb1', path: '/dev/sdb1', size: 100, fstype: 'ext4' } as any;

const enoent = () => { const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };

describe('device identity probe', () => {
    beforeEach(() => {
        spawnHelperMock.mockReset();
        readFileMock.mockReset();
        spawnHelperMock.mockResolvedValue({ code: 0, stdout: '' });   // mount + umount succeed
    });

    it('identifies a real STRUBS disk from its .identity record', async () => {
        const identityBuffer = Buffer.from('2fb05f231d5e4c00bb71f3109b42476c', 'hex');
        readFileMock.mockResolvedValue(buildVolumeIdentityBuffer({
            volumeId: 17,
            volumeUuid: '11111111-2222-3333-4444-555555555555',
            identityBuffer
        }));

        const result = await probeStrubsIdentity(extPartition);
        expect(result).toEqual({
            status: 'strubs',
            identity: { instanceIdentity: '2fb05f231d5e4c00bb71f3109b42476c', volumeId: 17 }
        });
    });

    it('mounts READ-ONLY and never replays the journal (a probe must not write to what it inspects)', async () => {
        readFileMock.mockImplementation(enoent);
        await probeStrubsIdentity(extPartition);

        const mountCall = spawnHelperMock.mock.calls.find(c => c[0] === 'mount');
        expect(mountCall![1]).toEqual(['-o', 'ro,noload', '-t', 'ext4', '/dev/sdb1', '/tmp/strubs-probe-test']);
        // ...and it always unmounts, even when it finds nothing.
        expect(spawnHelperMock.mock.calls.some(c => c[0] === 'umount')).toBe(true);
    });

    it('reports CLEAN only when it positively read the filesystem and found no identity', async () => {
        readFileMock.mockImplementation(enoent);
        expect(await probeStrubsIdentity(extPartition)).toEqual({ status: 'clean' });
    });

    // NO FSTYPE IS NOT PROOF OF BLANKNESS -- IT IS THE ABSENCE OF PROOF.
    //
    // lsblk reports fstype null for a genuinely blank partition. It reports it null just the same when it could
    // not READ the superblock -- which is what a dying disk does. So a live STRUBS volume whose ext4 superblock
    // has gone unreadable looks exactly like a blank one, and this guard -- whose entire job is to stop us
    // repartitioning a disk with data on it -- would wave 4TB of somebody's only copy straight through.
    //
    // Blankness is now ESTABLISHED with a direct probe, not assumed from an absence.
    const blank = { type: 'part', name: 'sdb1', path: '/dev/sdb1', size: 100, fstype: null } as any;

    // AND THE PROBE ITSELF MUST NOT HAVE THE SAME AMBIGUITY.
    //
    // The first version used `blkid -p` and read exit 2 as "positively blank". blkid(8) documents exit 2 for
    // BOTH "no signature found" AND "impossible to gather any information about the device" -- the exact two
    // things this guard exists to tell apart, collapsed into one, inside the function written to stop that.
    //
    // `wipefs -n --json` has no such ambiguity, and these are its real shapes, taken from the live host.
    const WIPEFS_BLANK = { code: 0, stdout: '{\n   "signatures": [\n\n   ]\n}\n' };
    const WIPEFS_EXT4 = { code: 0, stdout: JSON.stringify({ signatures: [{ device: 'sdb1', type: 'ext4' }] }) };
    const WIPEFS_LUKS = { code: 0, stdout: JSON.stringify({ signatures: [{ device: 'sdb1', type: 'crypto_LUKS' }] }) };
    const WIPEFS_FAIL = { code: 1, stdout: 'wipefs: error: /dev/sdb1: probing initialization failed' };

    it('PROBES a partition with no fstype, and reports CLEAN only when the probe positively finds nothing', async () => {
        spawnHelperMock.mockResolvedValueOnce(WIPEFS_BLANK);

        expect(await probeStrubsIdentity(blank)).toEqual({ status: 'clean' });
        expect(spawnHelperMock).toHaveBeenCalledWith('wipefs', ['-n', '--json', '/dev/sdb1']);
    });

    it('reports UNKNOWN when wipefs exits 0 but says something it does not understand', async () => {
        // An answer we cannot read is not an answer of "the disk is blank". Falling back to an empty list here
        // would be the same fail-open one level further down, inside the function written to close it.
        for (const stdout of ['', '{}', '{"signatures": "nope"}', 'not json at all']) {
            spawnHelperMock.mockReset();
            spawnHelperMock.mockResolvedValueOnce({ code: 0, stdout });

            const result = await probeStrubsIdentity(blank);
            expect(result.status, `stdout=${JSON.stringify(stdout)}`).toBe('unknown');
        }
    });

    it('reports UNKNOWN when a partition with no fstype cannot be probed -- a dying disk looks blank', async () => {
        spawnHelperMock.mockResolvedValueOnce(WIPEFS_FAIL);

        const result = await probeStrubsIdentity(blank);
        expect(result.status).toBe('unknown');
        expect((result as { reason: string }).reason).toMatch(/superblock cannot be READ/);
    });

    // ⚠️ WHICH SIGNATURE WIPEFS HAPPENED TO LIST FIRST MUST NOT DECIDE WHETHER WE DESTROY 4.4TB.
    //
    // wipefs reports EVERY signature it finds, and a real STRUBS disk can carry a stale one alongside its ext4
    // (an old mdraid superblock, a leftover LVM header). Returning `types[0]` meant such a disk could come back
    // as "mdraid" -- and the guard only goes and READS a partition it believes is ext. Anything else it calls
    // positively-not-ours and waves through to be repartitioned.
    it('finds the ext signature even when a stale one is listed first', async () => {
        spawnHelperMock.mockResolvedValueOnce({
            code: 0,
            stdout: JSON.stringify({ signatures: [{ type: 'linux_raid_member' }, { type: 'ext4' }] })
        });
        // ...and then it MOUNTS it, because that is what it does with anything that might be ours.
        spawnHelperMock.mockResolvedValueOnce({ code: 0, stdout: '' });

        const result = await probeStrubsIdentity(blank);

        // It went and read the disk rather than dismissing it as a foreign filesystem.
        expect(spawnHelperMock.mock.calls[1][0]).toBe('mount');
        expect(result.status).not.toBe('clean');
    });

    // A SIGNATURE WE COULD NOT NAME IS NOT A SIGNATURE WE MAY IGNORE. wipefs said there is SOMETHING on this
    // disk; dropping the only evidence of it and then calling the disk "not ext, therefore clean" would
    // repartition a disk that told us it had something on it.
    it('refuses a disk carrying a signature it cannot name', async () => {
        spawnHelperMock.mockResolvedValueOnce({
            code: 0,
            stdout: JSON.stringify({ signatures: [{ device: 'sdb1' }] })   // present, but no type
        });

        const result = await probeStrubsIdentity(blank);

        expect(result.status).toBe('unknown');
        expect((result as { reason: string }).reason).toMatch(/cannot name|no type/i);
    });

    it('catches a LUKS partition that lsblk did not cache an fstype for', async () => {
        spawnHelperMock.mockResolvedValueOnce(WIPEFS_LUKS);

        const result = await probeStrubsIdentity(blank);
        expect(result.status).toBe('unknown');
        expect((result as { reason: string }).reason).toMatch(/LUKS/);
    });

    // THE NAMEPLATE: how a LOCKED disk says who it is. It lives in the GPT partition entry, outside the
    // container, so it is readable with no key at all -- and reading it is what stops the wipe guard from
    // saying "I cannot tell" about a disk that is plainly ours.
    it('identifies a LOCKED STRUBS disk from its nameplate, without the key', async () => {
        const locked = {
            type: 'part', name: 'sdb1', path: '/dev/sdb1', size: 100,
            fstype: 'crypto_LUKS', partlabel: 'strubs-3f9a1b2c5d6e7f80-12'
        } as any;

        const result = await probeStrubsIdentity(locked);

        expect(result.status).toBe('strubs');
        expect((result as any).identity).toEqual({ instanceIdentity: '3f9a1b2c5d6e7f80', volumeId: 12 });
        // Not one process spawned: no unlock, no mount, no cryptsetup. The partition table said it all.
        expect(spawnHelperMock).not.toHaveBeenCalled();
    });

    // ...and an encrypted disk WITHOUT a nameplate is still a refusal. It is either a stranger's or ours with
    // a lost key, and neither is a disk to reformat on a hunch. 'unknown' must never collapse into 'clean'.
    it('still refuses a LUKS disk carrying no nameplate', async () => {
        const anon = {
            type: 'part', name: 'sdb1', path: '/dev/sdb1', size: 100,
            fstype: 'crypto_LUKS', partlabel: null
        } as any;

        const result = await probeStrubsIdentity(anon);
        expect(result.status).toBe('unknown');
    });

    // parted writes "primary" into that field by default. It is not a nameplate, and must not be read as one.
    it('does not mistake parted\'s default partition name for a nameplate', async () => {
        const parted = {
            type: 'part', name: 'sdb1', path: '/dev/sdb1', size: 100,
            fstype: 'crypto_LUKS', partlabel: 'primary'
        } as any;

        expect((await probeStrubsIdentity(parted)).status).toBe('unknown');
    });

    it('MOUNTS AND READS a partition whose ext4 the probe found but lsblk did not cache', async () => {
        // Returning 'clean' here would be a direct route to repartitioning a live STRUBS disk: lsblk was simply
        // quiet, and the ext4 is right there. It has to be read, not shrugged at.
        spawnHelperMock
            .mockResolvedValueOnce(WIPEFS_EXT4)                  // the probe finds ext4
            .mockResolvedValueOnce({ code: 0, stdout: '' })      // ...so we mount it
            .mockResolvedValueOnce({ code: 0, stdout: '' });     // ...and unmount
        readFileMock.mockResolvedValueOnce(buildVolumeIdentityBuffer({
            volumeId: 7, volumeUuid: '11111111-2222-3333-4444-555555555555',
            identityBuffer: Buffer.from('2fb05f231d5e4c00bb71f3109b42476c', 'hex')
        }));

        const result = await probeStrubsIdentity(blank);
        expect(result.status).toBe('strubs');
    });

    // THE bug this tri-state exists to prevent: a failed mount used to return "nothing found", which the
    // provisioner read as "not ours" and happily wiped. A disk we cannot read is not a blank disk.
    // AN ENCRYPTED DISK IS NOT A BLANK ONE. IT IS A DISK WE CANNOT SEE INSIDE.
    //
    // Under LUKS the partition reports crypto_LUKS and the ext4 lives on a device-mapper child. Every byte of
    // the array can be sitting there, and this probe -- which decides whether a disk may be REPARTITIONED --
    // would see a fstype that is not ext and call it CLEAN.
    //
    // That was true by accident until now: STRUBS never created an encrypted disk, so there were none to
    // mistake. DR-G changes exactly that. Shipping encryption with this in place would ARM the bug -- the first
    // encrypted disk in the rack becomes a 4TB disk the wipe guard is delighted to destroy.
    it('reports UNKNOWN for a LUKS partition -- an encrypted disk is unreadable, not blank', async () => {
        const luks = { type: 'part', name: 'sdb1', path: '/dev/sdb1', size: 100, fstype: 'crypto_LUKS' } as any;

        const result = await probeStrubsIdentity(luks);

        expect(result.status).toBe('unknown');
        expect((result as { reason: string }).reason).toMatch(/LUKS/);

        // ...and it never even tried to mount it. There is nothing there to mount without the key.
        expect(spawnHelperMock).not.toHaveBeenCalled();
    });

    it('reports UNKNOWN (never clean) when the filesystem exists but will not mount', async () => {
        spawnHelperMock.mockResolvedValue({ code: 32, stdout: 'mount: /dev/sdb1 already mounted' });
        const result = await probeStrubsIdentity(extPartition);
        expect(result.status).toBe('unknown');
        expect(result.status === 'unknown' && result.reason).toMatch(/could not read-only mount/);
    });

    // Cleanup is part of the safety property. A 'clean' verdict we could not unmount after is a verdict
    // about a disk we left in an unknown state -- and the caller is about to reformat it.
    it('downgrades a CLEAN verdict to UNKNOWN if the probe could not be unmounted', async () => {
        readFileMock.mockImplementation(enoent);                       // would otherwise be 'clean'
        spawnHelperMock
            .mockResolvedValueOnce({ code: 0, stdout: '' })            // mount ok
            .mockResolvedValueOnce({ code: 1, stdout: 'target is busy' }); // umount FAILS

        const result = await probeStrubsIdentity(extPartition);
        expect(result.status).toBe('unknown');
        expect(result.status === 'unknown' && result.reason).toMatch(/could not unmount/);
    });

    it('reports UNKNOWN for a truncated or bad-magic identity file', async () => {
        readFileMock.mockResolvedValue(Buffer.alloc(10));
        expect((await probeStrubsIdentity(extPartition)).status).toBe('unknown');

        readFileMock.mockResolvedValue(Buffer.alloc(41));   // right length, wrong magic
        expect((await probeStrubsIdentity(extPartition)).status).toBe('unknown');
    });

    describe('whole device', () => {
        it('a single STRUBS partition condemns the device', async () => {
            const identityBuffer = Buffer.from('2fb05f231d5e4c00bb71f3109b42476c', 'hex');
            readFileMock
                .mockImplementationOnce(enoent)                       // sdb1: clean
                .mockResolvedValueOnce(buildVolumeIdentityBuffer({    // sdb2: ours
                    volumeId: 4, volumeUuid: '11111111-2222-3333-4444-555555555555', identityBuffer
                }));

            const result = await probeDeviceForStrubsIdentity({
                name: 'sdb', path: '/dev/sdb', pttype: 'gpt',
                children: [extPartition, { ...extPartition, name: 'sdb2', path: '/dev/sdb2' }]
            } as any);
            expect(result.status).toBe('strubs');
        });

        it('an UNKNOWN partition condemns the device too -- clean requires ALL partitions be clean', async () => {
            spawnHelperMock
                .mockResolvedValueOnce({ code: 0, stdout: '' })       // sdb1 mount ok
                .mockResolvedValueOnce({ code: 0, stdout: '' })       // sdb1 umount
                .mockResolvedValueOnce({ code: 32, stdout: 'busy' }); // sdb2 mount FAILS
            readFileMock.mockImplementationOnce(enoent);              // sdb1: clean

            const result = await probeDeviceForStrubsIdentity({
                name: 'sdb', path: '/dev/sdb', pttype: 'gpt',
                children: [extPartition, { ...extPartition, name: 'sdb2', path: '/dev/sdb2' }]
            } as any);
            expect(result.status).toBe('unknown');
        });

        // THIS TEST USED TO ASSERT THE FAIL-OPEN.
        //
        // "No partitions, therefore clean" is exactly how a whole-disk LUKS container -- or a whole-disk STRUBS
        // volume -- gets repartitioned. With no device path there is nothing to probe, so an empty answer is the
        // only answer available, and the only honest thing to do with it is refuse.
        it('reports UNKNOWN when there is nothing to inspect and nothing to probe', async () => {
            expect((await probeDeviceForStrubsIdentity(undefined)).status).toBe('unknown');
            expect((await probeDeviceForStrubsIdentity({ children: [] } as any)).status).toBe('unknown');
        });
    });

    // A WHOLE-DISK LUKS CONTAINER HAS NO PARTITIONS TO INSPECT.
    //
    // `cryptsetup luksFormat /dev/sdf` with no partition table puts crypto_LUKS on the DISK and gives it no
    // `part` children. The device-level loop then inspects NOTHING -- and used to return 'clean' on the strength
    // of having looked at nothing at all. 4TB of somebody's only copy, waved through to be repartitioned.
    describe('the device as a whole', () => {
        it('reports UNKNOWN for a whole-disk LUKS container with no partitions', async () => {
            // Note it is PROBED, not read off `fstype`: device-discovery's sanitizer strips the top-level
            // fstype, so a check that trusted that field was reading something that never arrives. A real
            // whole-disk crypto_LUKS device would have sailed straight through it, looking like bare media.
            spawnHelperMock.mockResolvedValueOnce({
                code: 0, stdout: JSON.stringify({ signatures: [{ device: 'sdf', type: 'crypto_LUKS' }] })
            });

            const result = await probeDeviceForStrubsIdentity({ name: 'sdf', path: '/dev/sdf', children: [] } as any);

            expect(result.status).toBe('unknown');
            expect((result as { reason: string }).reason).toMatch(/WHOLE-DISK LUKS/);
            expect(spawnHelperMock).toHaveBeenCalledWith('wipefs', ['-n', '--json', '/dev/sdf']);
        });

        it('reports UNKNOWN for a disk that claims a partition table and shows no partitions', async () => {
            // Either the table is corrupt, or the enumeration was stale, or the kernel could not read it. We
            // inspected nothing, so we know nothing -- and this guard decides whether to repartition the disk.
            const result = await probeDeviceForStrubsIdentity({
                name: 'sdf', path: '/dev/sdf', pttype: 'gpt', children: []
            } as any);

            expect(result.status).toBe('unknown');
            expect((result as { reason: string }).reason).toMatch(/not one partition could be enumerated/);
        });

        it('still reports CLEAN for a genuinely blank disk: no signature, no partition table', async () => {
            // The ordinary case for adding a disk to the array must keep working, or the guard is an outage.
            // exit 0 with an EMPTY signature list: it probed the device and there is positively nothing there.
            spawnHelperMock.mockResolvedValueOnce({ code: 0, stdout: '{"signatures":[]}' });

            const result = await probeDeviceForStrubsIdentity({ name: 'sdf', path: '/dev/sdf', children: [] } as any);
            expect(result).toEqual({ status: 'clean' });
        });

        it('reports UNKNOWN for a whole disk that cannot be probed at all', async () => {
            spawnHelperMock.mockResolvedValueOnce({ code: 1, stdout: 'probing initialization failed' });

            const result = await probeDeviceForStrubsIdentity({ name: 'sdf', path: '/dev/sdf', children: [] } as any);
            expect(result.status).toBe('unknown');
        });
    });
});