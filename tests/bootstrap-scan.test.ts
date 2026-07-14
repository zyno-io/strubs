import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/helpers/spawn', () => ({ spawnHelper: vi.fn() }));
vi.mock('../lib/io/device-discovery', () => ({ listRawBlockDevices: vi.fn() }));

import { spawnHelper as realSpawnHelper } from '../lib/helpers/spawn';
import { listRawBlockDevices as realListRawBlockDevices } from '../lib/io/device-discovery';
import { findManifestsOnDevices } from '../lib/recovery/bootstrap';

const spawnHelper = vi.mocked(realSpawnHelper);
const listRawBlockDevices = vi.mocked(realListRawBlockDevices);

const OK = { code: 0, stdout: '' };

const oneDisk = (fstype: string | null) => ([{
    name: 'sdf',
    path: '/dev/sdf',
    type: 'disk',
    size: 4000,
    children: [{ type: 'part', name: 'sdf1', path: '/dev/sdf1', size: 4000, fstype }]
}] as never);

// The `silent` list is attached to the returned array — the caller weighs the vote against the disks that did
// NOT answer, rather than only against the ones that did.
const silentOf = (found: unknown) => (found as { silent?: string[] }).silent ?? [];

// THE VOTE THAT DECIDES WHICH ARRAY THIS HOST BELONGS TO.
//
// A disk gets one of three answers, and conflating two of them has already cost this codebase dearly:
//
//   'manifest' -- it is ours, and here is the volume table.
//   'none'     -- it mounted perfectly well and has no manifest: the host's own root disk, a stranger's ext4.
//                 It ANSWERED, and the answer was "I am not one of yours."
//   'silent'   -- it would not mount, or would not read. On a bare host, very likely one of OURS, broken --
//                 and possibly carrying the newest volume table.
describe('the bootstrap scan', () => {
    beforeEach(() => {
        spawnHelper.mockReset();
        listRawBlockDevices.mockReset();
    });

    // ⚠️ THE FAIL-OPEN. `spawnHelper` RESOLVES on a non-zero exit -- it does not throw -- so a partition that
    // FAILED TO MOUNT fell straight through to the manifest read, found an empty temp directory, got ENOENT,
    // and was recorded as 'none': "it mounted fine and it is not one of ours."
    //
    // That is the one answer it must never give. A disk that will not mount is exactly the disk most likely to
    // be ours and broken -- and it was being counted as a stranger's, silently, in the vote that decides which
    // array this host is. The same costume the bug wears everywhere else in this system: a failure to LOOK,
    // reported as a fact about the DATA.
    it('counts a partition that WILL NOT MOUNT as silent, not as a foreign disk', async () => {
        listRawBlockDevices.mockResolvedValue(oneDisk('ext4'));
        spawnHelper.mockResolvedValue({ code: 32, stdout: '', stderr: 'mount: wrong fs type or bad superblock' });

        const found = await findManifestsOnDevices();

        expect(found).toHaveLength(0);
        expect(silentOf(found)).toEqual(['/dev/sdf1']);   // NOT silently dismissed as somebody else's disk
    });

    // ...but a disk that mounted and simply has no manifest ANSWERED. Counting that as silence would let the
    // machine's own boot disk vote against the array.
    it('does not count the host\'s own root filesystem as silent', async () => {
        listRawBlockDevices.mockResolvedValue(oneDisk('ext4'));
        spawnHelper.mockResolvedValue(OK);   // mounts fine; there is simply no .bootstrap.json on it

        const found = await findManifestsOnDevices();

        expect(found).toHaveLength(0);
        expect(silentOf(found)).toEqual([]);
    });

    // AN ENCRYPTED DISK IS NOT AN ABSENT ONE. The manifest lives INSIDE the filesystem, so on a LUKS volume it
    // is behind the encryption. Skipping these means that on a fully encrypted fleet the recovery scan finds
    // nothing, reports a bare host with a pile of foreign disks, and the supported DR path is simply dead --
    // at the exact moment encryption has made losing the metadata unrecoverable rather than merely painful.
    it('reports an encrypted disk it cannot open as LOCKED, never as foreign', async () => {
        listRawBlockDevices.mockResolvedValue(oneDisk('crypto_LUKS'));
        // No keyfile (stat fails), and no passphrase offered.
        spawnHelper.mockResolvedValue({ code: 1, stdout: 'No key available' });

        const found = await findManifestsOnDevices();

        expect(found).toHaveLength(0);
        // A locked disk is a disk that did not answer, and it must be counted against the recovery.
        expect(silentOf(found)).toEqual(['/dev/sdf1']);
    });

    it('offers the recovery passphrase to a LUKS disk when the keyfile is gone', async () => {
        listRawBlockDevices.mockResolvedValue(oneDisk('crypto_LUKS'));
        spawnHelper.mockResolvedValue({ code: 1, stdout: 'No key available' });

        await findManifestsOnDevices({ recoveryPassphrase: 'the fleet recovery passphrase' });

        // It tried to unlock, and the passphrase went in on STDIN -- never on the command line, which is
        // world-readable through /proc for the life of the process.
        const unlock = spawnHelper.mock.calls.find(call => (call[1] as string[])[0] === 'luksOpen');
        expect(unlock).toBeDefined();
        expect((unlock![1] as string[]).join(' ')).not.toContain('the fleet recovery passphrase');
        expect((unlock![2] as { stdin?: string } | undefined)?.stdin).toBe('the fleet recovery passphrase');
    });

    // ⚠️ THE SAME FAIL-OPEN, THIRD GUARD. This loop used to read `child.fstype` directly, so an ENCRYPTED disk
    // of ours whose fstype lsblk had not cached was skipped as though it were a stranger's: never unlocked,
    // never counted as locked or silent, and so it never VOTED on which array this host is. Recovery could then
    // adopt a volume table from a subset of the fleet and quietly decide the missing volumes never existed.
    it('PROBES a partition whose fstype lsblk did not cache, and unlocks it if it is LUKS', async () => {
        listRawBlockDevices.mockResolvedValue(oneDisk(null));
        spawnHelper.mockImplementation(async (cmd, args) => {
            if (cmd === 'wipefs')
                return { code: 0, stdout: JSON.stringify({ signatures: [{ type: 'crypto_LUKS' }] }) };
            if (cmd === 'cryptsetup')
                return { code: 1, stdout: 'No key available' };   // we hold no key for it
            return OK;
        });

        const found = await findManifestsOnDevices({ recoveryPassphrase: 'the fleet recovery passphrase' });

        expect(found).toHaveLength(0);
        // It was recognised as an encrypted disk and counted against the recovery -- NOT skipped as foreign.
        expect(silentOf(found)).toEqual(['/dev/sdf1']);

        // ...and it was actually TREATED as encrypted: we tried to unlock it. Asserting only that it votes
        // would still pass if the classifier had merely dumped it into `silent` without ever recognising it as
        // a LUKS container -- which is a different bug wearing this one's clothes.
        const unlock = spawnHelper.mock.calls.find(call => (call[1] as string[])[0] === 'luksOpen');
        expect(unlock).toBeDefined();
    });

    // And a partition we could not identify at all is SILENT, not absent. A disk that will not answer is not a
    // disk with nothing on it -- and here it is a disk that does not get to be left out of the vote.
    it('counts an unidentifiable partition as silent', async () => {
        listRawBlockDevices.mockResolvedValue(oneDisk(null));
        spawnHelper.mockResolvedValue({ code: 1, stdout: 'wipefs: cannot open /dev/sdf1' });

        const found = await findManifestsOnDevices();

        expect(silentOf(found)).toEqual(['/dev/sdf1']);
    });

    // We only ever mkfs ext. Trying to mount a stranger's XFS is how a recovery tool starts touching things it
    // has no business touching -- and it is not silence either: the disk is positively not one of ours.
    it('leaves a foreign filesystem alone entirely', async () => {
        listRawBlockDevices.mockResolvedValue(oneDisk('xfs'));

        const found = await findManifestsOnDevices();

        expect(found).toHaveLength(0);
        expect(silentOf(found)).toEqual([]);
        expect(spawnHelper).not.toHaveBeenCalled();   // it was never touched
    });
});
