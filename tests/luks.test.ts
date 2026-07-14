import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../lib/helpers/spawn', () => ({ spawnHelper: vi.fn() }));

vi.mock('fs', () => ({
    promises: {
        stat: vi.fn(),
        realpath: vi.fn(),
        readdir: vi.fn(),
        access: vi.fn(),
        open: vi.fn(),
        mkdir: vi.fn()
    }
}));

import { spawnHelper as realSpawnHelper } from '../lib/helpers/spawn';
import { promises as fsp } from 'fs';
const spawnHelper = vi.mocked(realSpawnHelper);
const statMock = vi.mocked(fsp.stat);
const realpathMock = vi.mocked(fsp.realpath);
const readdirMock = vi.mocked(fsp.readdir);
const openMock = vi.mocked(fsp.open);
const mkdirMock = vi.mocked(fsp.mkdir);

import {
    absentVolumeIds,
    scanFleet,
    assertFleetRecoveryPassphrase,
    auditRecoveryKey,
    hasRecoveryPassphrase,
    lastRecoveryAudit,
    setFleetRecoveryPassphrase,
    withEncryptionSlot,
    RECOVERY_AUDIT_KEY,
    RECOVERY_VERIFIER_KEY
} from '../lib/io/luks-recovery-key';
import {
    addPassphrase,
    assertRecoverable,
    ensureKeyfile,
    ensureKeyfileSlot,
    findEncryptedPartitions,
    testPassphrase,
    isLuksFsType,
    keyslotCount,
    mapperName,
    mapperPath,
    nameplateFor,
    open as luksOpen,
    parseNameplate
} from '../lib/io/luks';

// An in-memory stand-in for the runtimeConfig collection, with the ATOMIC create-if-absent the real one has.
// A fleet whose passphrase keyslots WE write, because we hold the keyfile. `slots` is what is actually on each
// disk -- which is the only thing that decides whether a passphrase opens it.
const fakeDeps = (opts: {
    encrypted?: string[];
    unknown?: string[];
    unreadableDisks?: string[];
    keyIsUnique?: boolean;
    absentVolumes?: number[];
    identity?: string | null;
} = {}) => {
    const store = new Map<string, unknown>();
    let encrypted = opts.encrypted ?? [];

    // The passphrase keyslot on each disk. This IS the disk, as far as any of this is concerned.
    const slots: Record<string, Set<string>> = {};
    const slotsOf = (path: string) => (slots[path] ??= new Set());
    let absent = opts.absentVolumes ?? [];
    const uuidAt: Record<string, string> = {};
    const liveUuidAt: Record<string, string> = {};

    return {
        store,
        slotsOf,
        setEncrypted: (paths: string[]) => { encrypted = paths; },

        database: {
            getRuntimeConfig: async (key: string) => store.get(key),
            setRuntimeConfig: async (key: string, value: unknown) => { store.set(key, value); },
            setRuntimeConfigIfAbsent: async (key: string, value: unknown) => {
                if (store.has(key)) return false;
                store.set(key, value);
                return true;
            },
            runtimeConfigKeyIsUnique: async () => opts.keyIsUnique ?? true
        },

        setAbsent: (ids: number[]) => { absent = ids; },
        instanceIdentity: () => opts.identity === undefined ? '2fb05f23-1d5e-4c00-bb71-f3109b42476c' : opts.identity,

        // ONE snapshot answering all three questions -- ours, unknown, and absent. Two listings is a race, and
        // these are USB disks that flap: a volume absent for the first and back for the second falls through
        // BOTH guards.
        scanFleet: async () => ({
            ours: encrypted.map(path => ({ path, volumeId: VOLUME_IDS[path] ?? 99, luksUuid: uuidAt[path] ?? `luks-${path}` })),
            unknown: opts.unknown ?? [],
            absent
        }),

        // ⚠️ A PATH IS NOT AN IDENTITY. This is the uuid read from whatever is at that path RIGHT NOW -- which
        // is NOT necessarily what the scan saw. That gap is the bug.
        containerUuid: vi.fn(async (path: string) => liveUuidAt[path] ?? uuidAt[path] ?? `luks-${path}`),
        // A USB disk drops and ANOTHER of our encrypted disks lands on the same path AFTER the scan. The scan's
        // record is unchanged; the disk actually sitting there is not the one it saw.
        swapDiskAt: (path: string) => { liveUuidAt[path] = `luks-${path}-a-different-disk`; },

        // We hold the keyfile, so writing a keyslot always works on a disk that is there.
        addPassphrase: vi.fn(async (path: string, pass: string) => {
            if (opts.unreadableDisks?.includes(path)) throw new Error('I/O error');
            slotsOf(path).add(pass);
        }),
        removePassphrase: vi.fn(async (path: string, pass: string) => {
            if (opts.unreadableDisks?.includes(path)) throw new Error('I/O error');
            slotsOf(path).delete(pass);
        }),
        testPassphrase: vi.fn(async (path: string, pass: string) => {
            if (opts.unreadableDisks?.includes(path)) return 'unreadable';
            return slotsOf(path).has(pass) ? 'opens' : 'rejected';
        })
    } as any;
};

// A stable id per disk, so a test that swaps the path list still models the SAME disks.
const VOLUME_IDS: Record<string, number> = {
    '/dev/sdf1': 11, '/dev/sdg1': 12, '/dev/sdh1': 13, '/dev/sdz1': 99
};

const luksDump = (slots: number) => ({
    code: 0,
    stdout: 'LUKS header information\nKeyslots:\n'
        + Array.from({ length: slots }, (_unused, i) => `  ${i}: luks2\n\tKey:        512 bits`).join('\n')
});

describe('luks', () => {
    // stat() is used for BOTH "does the mapper exist" and "is the keyfile readable", so the fake answers by
    // PATH rather than by call order -- an order-dependent mock here just breaks whenever the code changes
    // shape, and tells you nothing when it does.
    let mapperExists = false;

    const stubFs = () => {
        statMock.mockImplementation(async (target: any) => {
            const path = String(target);
            if (path === '/var/lib/strubs/luks.key')
                return { mode: 0o400 } as any;
            if (path.startsWith('/dev/mapper/')) {
                if (!mapperExists) throw new Error('ENOENT');
                return {} as any;
            }
            throw new Error('ENOENT');
        });
    };

    beforeEach(() => {
        spawnHelper.mockReset();
        statMock.mockReset();
        realpathMock.mockReset();
        readdirMock.mockReset();
        openMock.mockReset();
        mkdirMock.mockReset();
        mapperExists = false;   // default: no mapper open yet
        stubFs();
    });

    describe('the mapper', () => {
        it('names one mapper per volume, derivable from the uuid alone', () => {
            // Derivable with no database: that is what lets a recovery path find its own mappers.
            expect(mapperName('abc-123')).toBe('strubs-abc-123');
            expect(mapperPath('abc-123')).toBe('/dev/mapper/strubs-abc-123');
        });

        it('recognises the LUKS fstype however lsblk chooses to capitalise it', () => {
            expect(isLuksFsType('crypto_LUKS')).toBe(true);
            expect(isLuksFsType('crypto_luks')).toBe(true);
            expect(isLuksFsType('ext4')).toBe(false);
            expect(isLuksFsType(null)).toBe(false);
        });
    });

    // THE STALE MAPPER. These are USB disks: one drops, the kernel renumbers it, it comes back as a different
    // partition -- and the mapper from its previous life is still sitting there, still named strubs-<uuid>,
    // now backed by a device that is gone. Returning it because the NAME matched hands the volume a mapper
    // pointing at nothing: it looks mounted and serves EIO.
    describe('unlocking when a mapper already exists', () => {
        it('reuses a mapper that is on the RIGHT disk, without touching cryptsetup', async () => {
            mapperExists = true;
            realpathMock.mockResolvedValue('/dev/dm-3');
            readdirMock.mockResolvedValue(['sdf1'] as any);         // ...and it is on sdf1

            expect(await luksOpen('/dev/sdf1', 'abc')).toBe('/dev/mapper/strubs-abc');
            expect(spawnHelper).not.toHaveBeenCalled();
        });

        it('tears down a mapper that is on the WRONG disk, and unlocks the real one', async () => {
            // The mapper is there and backed by sdf1 -- but this volume now lives on sdg1.
            mapperExists = true;
            realpathMock.mockResolvedValue('/dev/dm-3');
            readdirMock.mockResolvedValue(['sdf1'] as any);
            spawnHelper.mockImplementation(async (_cmd, args) => {
                if ((args as string[])[0] === 'luksClose') mapperExists = false;   // it closed
                return { code: 0, stdout: '' };
            });

            await luksOpen('/dev/sdg1', 'abc');

            const commands = spawnHelper.mock.calls.map(call => (call[1] as string[])[0]);
            expect(commands).toEqual(['luksClose', 'luksOpen']);
        });

        // A mapper we cannot interrogate is NOT a mapper we get to trust. Fail closed.
        it('does not trust a mapper whose backing device it cannot read', async () => {
            mapperExists = true;
            realpathMock.mockRejectedValue(new Error('EACCES'));    // cannot tell what it is on
            spawnHelper.mockImplementation(async (_cmd, args) => {
                if ((args as string[])[0] === 'luksClose') mapperExists = false;
                return { code: 0, stdout: '' };
            });

            await luksOpen('/dev/sdf1', 'abc');

            // It closed it rather than reusing it on a guess.
            expect((spawnHelper.mock.calls[0][1] as string[])[0]).toBe('luksClose');
        });

        // It would not close -- something still holds it. Opening a SECOND mapper for the same volume, or
        // serving the stale one, are both worse than refusing.
        it('refuses when a wrong-disk mapper will not close', async () => {
            mapperExists = true;                                    // and it stays open: luksClose fails
            realpathMock.mockResolvedValue('/dev/dm-3');
            readdirMock.mockResolvedValue(['sdf1'] as any);
            spawnHelper.mockResolvedValue({ code: 1, stdout: 'device-mapper: device is busy' });

            await expect(luksOpen('/dev/sdg1', 'abc')).rejects.toThrow(/will not close/);
        });
    });

    describe('the recovery passphrase', () => {
        // THE ONE THAT MATTERS FOR SECRECY. argv is world-readable in /proc for the life of the process, so a
        // passphrase on the command line is a passphrase handed to every user on the box.
        it('never puts the passphrase on the command line', async () => {
            spawnHelper.mockResolvedValue({ code: 0, stdout: '' });

            await addPassphrase('/dev/sdb1', 'correct horse battery staple');

            const [, args, options] = spawnHelper.mock.calls[0];
            expect(args).not.toContain('correct horse battery staple');
            expect(args.join(' ')).not.toContain('correct horse');
            expect(options.stdin).toBe('correct horse battery staple');
        });

        it('refuses an empty passphrase rather than adding an empty keyslot', async () => {
            await expect(addPassphrase('/dev/sdb1', '')).rejects.toThrow(/empty recovery passphrase/);
            expect(spawnHelper).not.toHaveBeenCalled();
        });
    });

    // RE-ARMING UNATTENDED BOOT AFTER A RECOVERY. `luksAddKey <device> [<new key file>]` -- the POSITIONAL is
    // the NEW key, and the EXISTING one comes from --key-file. Get that backwards and you authenticate with
    // the key you are trying to add, on a disk you cannot open, on the worst day of the array's life.
    //
    // Verified against the real binary on a loopback LUKS container; this test is what keeps it that way.
    describe('ensureKeyfileSlot', () => {
        it('authenticates with the PASSPHRASE and adds the KEYFILE, in that order', async () => {
            spawnHelper
                .mockResolvedValueOnce({ code: 1, stdout: 'No key available' })   // the keyfile does not open it
                .mockResolvedValueOnce({ code: 0, stdout: '' });                  // ...so add it

            expect(await ensureKeyfileSlot('/dev/sdf1', 'the fleet passphrase')).toBe('added');

            const [, args, options] = spawnHelper.mock.calls[1];
            expect(args).toEqual([
                'luksAddKey',
                '--batch-mode',
                '--key-file', '-',                  // EXISTING key: the passphrase, on stdin
                '/dev/sdf1',
                '/var/lib/strubs/luks.key'          // NEW key: the keyfile being restored
            ]);
            expect(options.stdin).toBe('the fleet passphrase');

            // ...and never on the command line.
            expect(args.join(' ')).not.toContain('the fleet passphrase');
        });

        // Idempotent: a disk the keyfile already opens must not have a fourth keyslot bolted onto it every
        // time a recovery is re-run.
        it('does nothing when the keyfile already opens the disk', async () => {
            spawnHelper.mockResolvedValueOnce({ code: 0, stdout: '' });   // it already opens

            expect(await ensureKeyfileSlot('/dev/sdf1', 'the fleet passphrase')).toBe('already-present');
            expect(spawnHelper).toHaveBeenCalledTimes(1);
        });

        it('says so loudly when the slot cannot be restored', async () => {
            spawnHelper
                .mockResolvedValueOnce({ code: 1, stdout: 'No key available' })
                .mockResolvedValueOnce({ code: 1, stdout: 'No usable keyslot is available' });

            await expect(ensureKeyfileSlot('/dev/sdf1', 'wrong passphrase'))
                .rejects.toThrow(/will not survive a reboot/);
        });
    });

    // THREE ANSWERS, NOT TWO -- measured against the real cryptsetup:
    //   exit 0 = a keyslot opened.  exit 2 = "No key available" (a definitive no, from a header we read fine).
    //   exit 4 = the device is absent/unreadable/not LUKS. We learned NOTHING.
    //
    // Folding 4 into "rejected" reports a DYING DISK as a fleet split across two passphrases -- sending the
    // operator hunting for a passphrase that never existed while a drive falls off the bus.
    describe('testPassphrase', () => {
        it('maps cryptsetup\'s exit codes to three distinct answers', async () => {
            spawnHelper.mockResolvedValueOnce({ code: 0, stdout: '' });
            expect(await testPassphrase('/dev/sdf1', 'x')).toBe('opens');

            spawnHelper.mockResolvedValueOnce({ code: 2, stdout: 'No key available with this passphrase.' });
            expect(await testPassphrase('/dev/sdf1', 'x')).toBe('rejected');

            spawnHelper.mockResolvedValueOnce({ code: 4, stdout: 'Device /dev/sdf1 does not exist' });
            expect(await testPassphrase('/dev/sdf1', 'x')).toBe('unreadable');
        });
    });

    // ⚠️ A MISSING KEYFILE IS NOT ALWAYS A NEW ARRAY. IT IS ALSO WHAT A LOST ONE LOOKS LIKE.
    //
    // An operator should not have to hand-roll a secret with `dd` before they can use a feature, so STRUBS makes
    // the keyfile itself at startup. But restore the OS disk from an old backup, or wipe /var/lib/strubs, and the
    // keyfile is gone while thirty ENCRYPTED disks are still in the rack. Generate a fresh one there and STRUBS
    // comes up looking perfectly healthy while not one disk in the building opens with it -- silently, at boot,
    // with no operator in the room. That is the worst thing this codebase could do.
    describe('ensuring the keyfile exists', () => {
        const disks = (fstypes: Array<string | null>) =>
            (async () => [{
                name: 'sdf', path: '/dev/sdf', type: 'disk', size: 1,
                children: fstypes.map((fstype, i) => ({ type: 'part', name: `sdf${i}`, path: `/dev/sdf${i}`, fstype }))
            }]) as never;

        it('creates one when nothing is encrypted -- there is no key to have lost', async () => {
            statMock.mockRejectedValue(new Error('ENOENT'));   // no keyfile
            const written: Buffer[] = [];
            const handle = {
                write: vi.fn(async (b: Buffer) => { written.push(b); }),
                sync: vi.fn().mockResolvedValue(undefined),
                close: vi.fn().mockResolvedValue(undefined)
            };
            mkdirMock.mockResolvedValue(undefined as never);
            openMock.mockResolvedValue(handle as never);

            expect(await ensureKeyfile('/var/lib/strubs/luks.key', disks(['ext4', null]))).toEqual({ state: 'created' });

            // Exclusive create, mode 0400, and 512 bytes of real entropy that hit the platter before we say so.
            expect(openMock).toHaveBeenCalledWith('/var/lib/strubs/luks.key', 'wx', 0o400);
            expect(written[0].length).toBe(512);
            expect(handle.sync).toHaveBeenCalled();
        });

        // THE ONE THAT MATTERS.
        it('REFUSES to invent a key while encrypted disks are in the rack', async () => {
            statMock.mockRejectedValue(new Error('ENOENT'));   // the keyfile is gone...
            openMock.mockResolvedValue({} as never);

            const result = await ensureKeyfile('/var/lib/strubs/luks.key', disks(['crypto_LUKS', 'ext4']));

            expect(result).toEqual({ state: 'missing-but-disks-are-encrypted', disks: ['/dev/sdf0'] });

            // It did not create anything. A fresh key opens NONE of those disks, and a system that looks healthy
            // and cannot read a byte is worse than one that refuses to start quietly.
            expect(openMock).not.toHaveBeenCalled();
        });

        it('leaves an existing keyfile alone', async () => {
            statMock.mockResolvedValue({ mode: 0o400 } as never);

            expect(await ensureKeyfile('/var/lib/strubs/luks.key', disks([]))).toEqual({ state: 'present' });
            expect(openMock).not.toHaveBeenCalled();
        });
    });

    // A KEYFILE-ONLY FLEET DIES WITH THE OS DISK. This guard is the only thing that stops us building one.
    describe('assertRecoverable', () => {
        it('refuses a container with only the keyfile slot', async () => {
            spawnHelper.mockResolvedValue(luksDump(1));
            await expect(assertRecoverable('/dev/sdb1')).rejects.toThrow(/DIES WITH THE OS DISK/);
        });

        it('accepts a container with a keyfile and a passphrase', async () => {
            spawnHelper.mockResolvedValue(luksDump(2));
            await expect(assertRecoverable('/dev/sdb1')).resolves.toBeUndefined();
        });

        // Fail CLOSED. An unreadable luksDump is not permission to assume the slots are fine.
        it('refuses when it cannot read the header at all', async () => {
            spawnHelper.mockResolvedValue({ code: 1, stdout: 'Device /dev/sdb1 does not exist' });
            expect(await keyslotCount('/dev/sdb1')).toBe(-1);
            await expect(assertRecoverable('/dev/sdb1')).rejects.toThrow(/unreadable/);
        });
    });

    describe('the nameplate', () => {
        it('round-trips the identity and volume id', () => {
            const plate = nameplateFor('3f9a1b2c5d6e7f80aabbccdd', 13);
            expect(plate).toBe('strubs-3f9a1b2c5d6e7f80-13');
            expect(parseNameplate(plate)).toEqual({ identity: '3f9a1b2c5d6e7f80', volumeId: 13 });
        });

        // THE IDENTITY ON THIS ARRAY IS A HYPHENATED UUID (2fb05f23-1d5e-4c00-bb71-f3109b42476c). Slicing it
        // raw produced `strubs-2fb05f23-1d5e-4-12` -- hyphens in the middle, which parseNameplate then refuses.
        // The plate would have been stamped onto every encrypted disk and read back by nobody: the whole
        // locked-disk identification mechanism, silently dead on the only array that matters.
        it('round-trips the HYPHENATED UUID this array actually uses', () => {
            const plate = nameplateFor('2fb05f23-1d5e-4c00-bb71-f3109b42476c', 12);

            expect(plate).toBe('strubs-2fb05f231d5e4c00-12');
            expect(parseNameplate(plate)).toEqual({ identity: '2fb05f231d5e4c00', volumeId: 12 });
        });

        it('does not mistake parted\'s default partition name for one of ours', () => {
            expect(parseNameplate('primary')).toBeNull();
            expect(parseNameplate('')).toBeNull();
            expect(parseNameplate(null)).toBeNull();
        });

        // 36 characters is the hard limit of the GPT partition-name field.
        it('fits in the GPT name field', () => {
            expect(nameplateFor('3f9a1b2c5d6e7f80aabbccdd', 999).length).toBeLessThanOrEqual(36);
        });
    });
});

// ---------------------------------------------------------------------------------------------------------
// THE FLEET RECOVERY PASSPHRASE.
//
// THE KEYFILE IS THE AUTHORITY. It opens every disk, so the passphrase is not a fact we DISCOVER from the
// platters and defend against drifting -- it is a fact we ENFORCE, by writing it into every disk's second
// keyslot whenever we choose. Validation is therefore local (an argon2id hash), and the disks are only ever
// touched when the passphrase CHANGES.
//
// An earlier design tried to derive the passphrase from the platters -- testing candidates against every LUKS
// header, fingerprinting keyslot areas to catch tampering, refusing to trust its own database. All of that
// existed to defend against an admin hand-editing keyslots, which is a threat no part of this system can defend
// against anyway: the same root shell can `dd` over the header.
// ---------------------------------------------------------------------------------------------------------
describe('the fleet recovery passphrase', () => {
    const PASS = 'correct horse battery staple';

    it('records an argon2id hash the first time, and never the passphrase itself', async () => {
        const db = fakeDeps();
        await assertFleetRecoveryPassphrase(PASS, db);

        const stored = db.store.get(RECOVERY_VERIFIER_KEY) as any;
        expect(stored.algorithm).toBe('argon2id');
        expect(JSON.stringify(stored)).not.toContain('correct horse');
        expect(await hasRecoveryPassphrase(db)).toBe(true);
    });

    it('accepts the recorded passphrase, and refuses any other -- without touching a disk', async () => {
        const db = fakeDeps({ encrypted: ['/dev/sdf1', '/dev/sdg1'] });
        ['/dev/sdf1', '/dev/sdg1'].forEach(path => db.slotsOf(path).add(PASS));
        await setFleetRecoveryPassphrase(PASS, undefined, db);   // the fleet's passphrase, on record
        db.testPassphrase.mockClear();

        await expect(assertFleetRecoveryPassphrase(PASS, db)).resolves.toBeUndefined();
        await expect(assertFleetRecoveryPassphrase('a different passphrase', db))
            .rejects.toThrow(/not this fleet's recovery passphrase/);

        // THE POINT OF THE WHOLE REDESIGN: no disk was consulted. The disks carry what we wrote to them.
        expect(db.testPassphrase).not.toHaveBeenCalled();
    });

    it('refuses a passphrase too short to be worth having', async () => {
        const db = fakeDeps();
        await expect(assertFleetRecoveryPassphrase('short', db)).rejects.toThrow(/at least 12/);
        expect(await hasRecoveryPassphrase(db)).toBe(false);
    });

    // The first passphrase is the one moment a race is unrecoverable: two callers, two passphrases, two disks,
    // and only one of them written down. setIfAbsent is atomic only because of the unique index.
    it('refuses to record the FIRST passphrase without the unique index that makes it atomic', async () => {
        const db = fakeDeps({ keyIsUnique: false });

        await expect(assertFleetRecoveryPassphrase('the very first passphrase', db))
            .rejects.toThrow(/unique index on runtimeConfig.key is not in place/);

        expect(await hasRecoveryPassphrase(db)).toBe(false);
    });

    // ⚠️ NO VERIFIER + ENCRYPTED DISKS IN THE RACK ARE NOT "THE FIRST ENCRYPTION".
    //
    // Restore an older snapshot, rebuild Mongo, hand-delete the key: the verifier is gone while the encrypted
    // disks are still there, opening with a passphrase nothing has a record of. Treating that as "first" would
    // record a BRAND NEW passphrase, write it to the ONE new disk, and leave every existing disk behind on a
    // passphrase that nothing knows.
    //
    // The keyfile makes the remedy trivial, so we insist on it: rotate, which writes the passphrase to EVERY
    // disk.
    it('refuses to encrypt when the verifier is gone but encrypted disks are not', async () => {
        const db = fakeDeps({ encrypted: ['/dev/sdf1', '/dev/sdg1'] });   // ...and no verifier recorded

        await expect(assertFleetRecoveryPassphrase('a brand new passphrase', db))
            .rejects.toThrow(/no recovery passphrase on record/);

        expect(await hasRecoveryPassphrase(db)).toBe(false);   // it recorded nothing
    });

    // ⚠️ THE HOLE MOVED NEXT DOOR. I fixed this for ROTATION and not for ENCRYPTION, and Codex found it sitting
    // there one function away.
    //
    // With no verifier, the record of which volumes are encrypted is very likely gone too (same database, same
    // fate). The attached disks might all be plaintext -- while a volume sits unplugged in a drawer, encrypted,
    // and nothing left on this machine can tell us. Recording a brand-new passphrase would establish it for the
    // new disk alone, and that absent one comes back later holding the old key with nothing to say so.
    it('refuses to encrypt with no verifier while any volume is absent -- it might be an encrypted one', async () => {
        const db = fakeDeps({ absentVolumes: [12] });   // nothing encrypted is ATTACHED, and no verifier

        await expect(assertFleetRecoveryPassphrase('a brand new passphrase', db))
            .rejects.toThrow(/volume\(s\) 12 are not attached/);

        expect(await hasRecoveryPassphrase(db)).toBe(false);
    });

    // An unidentifiable LUKS container might be OURS, with a nameplate that never landed. With no verifier to
    // check it against, treating this as "the first encryption ever" would record a brand-new passphrase and
    // leave that disk behind on whatever it already carries. The rotation fails closed on these; so must this.
    it('refuses to encrypt with no verifier while an unidentifiable LUKS container is attached', async () => {
        const db = fakeDeps({ unknown: ['/dev/sdz1'] });

        await expect(assertFleetRecoveryPassphrase('a brand new passphrase', db))
            .rejects.toThrow(/no STRUBS nameplate/);

        expect(await hasRecoveryPassphrase(db)).toBe(false);
    });

    // ⚠️ NO IDENTITY MEANS WE CANNOT RECOGNISE OUR OWN DISKS. In RECOVERY mode the whole encrypted-disk scan is
    // keyed on the instance identity -- a disk's nameplate is compared against it. With no identity, our own
    // encrypted disks are classified as NEITHER ours NOR unknown: they simply vanish. A passphrase operation
    // would see an empty fleet, take the "nothing is encrypted yet" branch, and write a verifier into Mongo that
    // no disk in the rack has ever heard of.
    it('refuses every passphrase operation while the array has no identity', async () => {
        const db = fakeDeps({ identity: null });

        await expect(assertFleetRecoveryPassphrase('a brand new passphrase', db)).rejects.toThrow(/RECOVERY mode/);
        await expect(setFleetRecoveryPassphrase('a brand new passphrase', undefined, db))
            .rejects.toThrow(/RECOVERY mode/);
        await expect(auditRecoveryKey('a brand new passphrase', db)).rejects.toThrow(/RECOVERY mode/);

        expect(await hasRecoveryPassphrase(db)).toBe(false);
    });

    it('refuses the loser of a concurrent first-encryption race', async () => {
        const db = fakeDeps();

        const outcomes = (await Promise.allSettled([
            assertFleetRecoveryPassphrase('the first passphrase here', db),
            assertFleetRecoveryPassphrase('a different one entirely', db)
        ])).map(r => r.status).sort();

        expect(outcomes).toEqual(['fulfilled', 'rejected']);
    });
});

// ---------------------------------------------------------------------------------------------------------
// CHANGING IT -- which is possible because we hold the keyfile, and is what makes everything else simple.
// ---------------------------------------------------------------------------------------------------------
describe('changing the fleet recovery passphrase', () => {
    const OLD = 'the old fleet passphrase';
    const NEW = 'the new fleet passphrase';

    // A fleet already encrypted under OLD.
    const fleetOn = async (paths: string[], pass: string, opts: Record<string, unknown> = {}) => {
        const db = fakeDeps({ encrypted: paths, ...opts });
        paths.forEach(path => db.slotsOf(path).add(pass));
        await setFleetRecoveryPassphrase(pass, undefined, db);   // record it
        await auditRecoveryKey(pass, db);                        // and note which volumes are encrypted
        return db;
    };

    it('writes the new passphrase to EVERY disk, and retires the old one', async () => {
        const db = await fleetOn(['/dev/sdf1', '/dev/sdg1'], OLD);

        const result = await setFleetRecoveryPassphrase(NEW, OLD, db);

        expect(result.volumes.sort()).toEqual([11, 12]);
        for (const path of ['/dev/sdf1', '/dev/sdg1']) {
            expect(db.slotsOf(path).has(NEW)).toBe(true);    // the new one opens it...
            expect(db.slotsOf(path).has(OLD)).toBe(false);   // ...and the old one no longer does
        }

        // And the recorded hash is the new passphrase.
        await expect(assertFleetRecoveryPassphrase(NEW, db)).resolves.toBeUndefined();
        await expect(assertFleetRecoveryPassphrase(OLD, db)).rejects.toThrow();
    });

    // ⚠️⚠️ THE ONE THAT WOULD HAVE DISARMED THE WHOLE FLEET.
    //
    // The add is idempotent (it skips a disk that already opens with `next`), and the retire step removes the
    // slot that `current` opens. If next === current those are THE SAME KEYSLOT: nothing is added, and the one
    // recovery keyslot on every disk is deleted. The array is left KEYFILE-ONLY -- the precise unrecoverable
    // state that the two-keyslot rule, assertRecoverable(), and half of this module exist to make impossible.
    //
    // Introduced by the idempotency fix, which was itself added to stop keyslot bloat. One safety measure eating
    // another.
    it('REFUSES to rotate to the same passphrase, which would strip the keyslot from every disk', async () => {
        const db = await fleetOn(['/dev/sdf1', '/dev/sdg1'], OLD);

        await expect(setFleetRecoveryPassphrase(OLD, OLD, db)).rejects.toThrow(/same as the current one/);

        // Every disk still opens with it. Nothing was disarmed.
        expect(db.slotsOf('/dev/sdf1').has(OLD)).toBe(true);
        expect(db.slotsOf('/dev/sdg1').has(OLD)).toBe(true);
        expect(db.removePassphrase).not.toHaveBeenCalled();
    });

    // Belt and braces: if a removal ever DID take the wrong slot, stop before doing it to the rest of the fleet.
    it('stops immediately if retiring the old passphrase breaks a disk', async () => {
        const db = await fleetOn(['/dev/sdf1', '/dev/sdg1'], OLD);

        // Removing OLD from sdf1 also takes NEW with it -- the disk is now keyfile-only.
        db.removePassphrase.mockImplementationOnce(async (path: string) => {
            db.slotsOf(path).delete(OLD);
            db.slotsOf(path).delete(NEW);
        });

        await expect(setFleetRecoveryPassphrase(NEW, OLD, db)).rejects.toThrow(/no longer opens/);

        // ...and it did NOT go on to do the same to the second disk.
        expect(db.removePassphrase).toHaveBeenCalledTimes(1);
        expect(db.slotsOf('/dev/sdg1').has(NEW)).toBe(true);
    });

    // ⚠️ A PATH IS NOT AN IDENTITY.
    //
    // These are USB disks: /dev/sdf1 is whatever the kernel most recently decided to call the thing in that
    // slot, and it gets REUSED. The rotation scans the fleet, then spends ~3 seconds per disk in argon2 -- and in
    // that window the disk it scanned can drop and ANOTHER of our own encrypted disks can land on the same path.
    //
    // `luksAddKey /dev/sdf1` then succeeds against the WRONG header. The proof tests the wrong header. The
    // verifier is updated. And the volume we meant to rotate was never reached at all -- it keeps the old
    // passphrase, while the database swears it does not.
    it('refuses to touch a disk that is no longer the one it scanned', async () => {
        const db = await fleetOn(['/dev/sdf1', '/dev/sdg1'], OLD);

        // Between the scan and the write, the disk at sdf1 is swapped for a different one of ours.
        db.swapDiskAt('/dev/sdf1');

        await expect(setFleetRecoveryPassphrase(NEW, OLD, db))
            .rejects.toThrow(/no longer the disk we scanned/);

        // Nothing was written. The OLD passphrase still opens every disk.
        expect(db.addPassphrase).not.toHaveBeenCalled();
        await expect(assertFleetRecoveryPassphrase(OLD, db)).resolves.toBeUndefined();
    });

    // ⚠️ THE "DO NOTHING" BRANCH NEEDS THE GUARD MORE THAN THE WRITE PATH DOES, NOT LESS.
    //
    // The idempotency check is argon2 -- about three seconds, during which the disk at this path can be swapped
    // for another of ours. If the replacement already opens with the new passphrase, the skip fires and we
    // `continue`, believing we have dealt with the disk we scanned when we have not touched it at all. It keeps
    // the old passphrase; the rotation records the new one; nothing says otherwise.
    //
    // A write that lands on the wrong disk at least leaves evidence. A skip leaves none.
    it('refuses when a disk swaps during the idempotency check and the replacement already opens', async () => {
        const db = await fleetOn(['/dev/sdf1', '/dev/sdg1'], OLD);

        // The disk at sdf1 is swapped WHILE we are asking whether it already takes the new passphrase -- and the
        // one that lands there does.
        db.testPassphrase.mockImplementationOnce(async () => {
            db.swapDiskAt('/dev/sdf1');
            return 'opens';
        });

        await expect(setFleetRecoveryPassphrase(NEW, OLD, db))
            .rejects.toThrow(/no longer the disk we scanned/);

        // Nothing was recorded: the OLD passphrase is still the fleet's, and still opens everything.
        await expect(assertFleetRecoveryPassphrase(OLD, db)).resolves.toBeUndefined();
    });

    it('requires the current passphrase to change it', async () => {
        const db = await fleetOn(['/dev/sdf1'], OLD);

        await expect(setFleetRecoveryPassphrase(NEW, undefined, db))
            .rejects.toThrow(/current recovery passphrase is required/);
        await expect(setFleetRecoveryPassphrase(NEW, 'not the old one', db))
            .rejects.toThrow(/current recovery passphrase is not correct/);

        // Nothing was touched.
        expect(db.slotsOf('/dev/sdf1').has(NEW)).toBe(false);
    });

    // ⚠️ A DISK THAT MISSES A ROTATION KEEPS THE OLD PASSPHRASE -- silently, and discoverably only on the day it
    // matters. This is the one failure the keyfile cannot enforce away, so it is refused up front.
    // ⚠️ EVERY DISK MUST BE HERE -- NOT "every disk we believe is encrypted". EVERY DISK.
    //
    // The clever version consulted `luksEncryptedVolumes` and refused only for volumes it believed were
    // encrypted. It produced a defect in EVERY review round, and the reason was structural: that record lives in
    // the same database as everything else we lose. Restore an old snapshot and it is gone or partial; let an
    // audit repopulate it from the disks that happen to be plugged in and it is CONFIDENTLY partial, which is
    // worse. Each fix moved the hole somewhere else.
    //
    // No record, no inference. If a volume of this fleet is not in front of us, we do not rewrite the fleet's
    // passphrase behind its back. The cost is plugging the drives in -- which is required for the operation to
    // be CORRECT anyway.
    it('refuses to rotate while ANY volume is absent -- encrypted or not, recorded or not', async () => {
        const db = await fleetOn(['/dev/sdf1'], OLD);

        db.setAbsent([12]);   // some volume -- we do not even ask whether it is encrypted

        await expect(setFleetRecoveryPassphrase(NEW, OLD, db))
            .rejects.toThrow(/volume\(s\) 12 are not attached/);

        expect(db.slotsOf('/dev/sdf1').has(NEW)).toBe(false);   // nothing was half-rotated
    });

    it('just records the passphrase when nothing is encrypted yet', async () => {
        const db = fakeDeps();

        const result = await setFleetRecoveryPassphrase('the very first passphrase', undefined, db);

        expect(result.volumes).toEqual([]);
        expect(await hasRecoveryPassphrase(db)).toBe(true);
        expect(db.addPassphrase).not.toHaveBeenCalled();
    });
});

describe('finding the encrypted disks on the platters', () => {
    const IDENTITY = '2fb05f23-1d5e-4c00-bb71-f3109b42476c';   // the real, hyphenated form

    const disks = (children: Array<Record<string, unknown>>) =>
        (async () => [{ name: 'sdf', path: '/dev/sdf', type: 'disk', size: 1, children }]) as never;

    it('finds our own encrypted disks by their nameplate -- no key, no mount, no database', async () => {
        const found = await findEncryptedPartitions(IDENTITY, disks([
            {
                type: 'part', name: 'sdf1', path: '/dev/sdf1', fstype: 'crypto_LUKS',
                uuid: 'LUKS-CONTAINER-UUID', partlabel: 'strubs-2fb05f231d5e4c00-57'
            }
        ]));

        // The volume id comes off the nameplate, so a disk keeps its identity even when the bus renumbers it.
        // The LUKS uuid identifies the HEADER, so a re-encrypted disk is not mistaken for the one we audited.
        expect(found.ours).toEqual([{ path: '/dev/sdf1', volumeId: 57, luksUuid: 'LUKS-CONTAINER-UUID' }]);
        expect(found.unknown).toEqual([]);
    });

    it('ignores an encrypted disk belonging to a DIFFERENT STRUBS instance', async () => {
        const found = await findEncryptedPartitions(IDENTITY, disks([
            { type: 'part', name: 'sdf1', path: '/dev/sdf1', fstype: 'crypto_LUKS', partlabel: 'strubs-ffffffffffffffff-3' }
        ]));

        expect(found.ours).toEqual([]);
        expect(found.unknown).toEqual([]);   // positively not ours: it said so itself
    });

    // The fail-open that would undo the whole guard: an unlabelled LUKS container treated as "not ours".
    it('reports an unlabelled LUKS container as UNKNOWN, never as not-ours', async () => {
        const found = await findEncryptedPartitions(IDENTITY, disks([
            { type: 'part', name: 'sdf1', path: '/dev/sdf1', fstype: 'crypto_LUKS', partlabel: null },
            { type: 'part', name: 'sdf2', path: '/dev/sdf2', fstype: 'crypto_LUKS', partlabel: 'primary' }
        ]));

        expect(found.ours).toEqual([]);
        expect(found.unknown).toEqual(['/dev/sdf1', '/dev/sdf2']);   // parted's default name is not a nameplate
    });

    // ⚠️ P1, THE THIRD COSTUME. Filtering on `fstype === 'crypto_LUKS'` skips a partition whose fstype lsblk
    // simply did not cache -- and one of OUR encrypted disks in that state becomes INVISIBLE to this guard:
    // neither ours nor unknown, so the next encryption never tests its passphrase against it. That is the fleet
    // split, reached through a field that happened to be empty. An absent fstype is not an answer.
    it('PROBES a partition whose fstype lsblk did not cache, rather than skipping it', async () => {
        spawnHelper.mockResolvedValue({
            code: 0,
            stdout: JSON.stringify({ signatures: [{ type: 'crypto_LUKS' }] })
        });

        const found = await findEncryptedPartitions(IDENTITY, disks([
            {
                type: 'part', name: 'sdf1', path: '/dev/sdf1', fstype: null,
                uuid: 'LUKS-CONTAINER-UUID', partlabel: 'strubs-2fb05f231d5e4c00-57'
            }
        ]));

        expect(found.ours).toEqual([
            { path: '/dev/sdf1', volumeId: 57, luksUuid: 'LUKS-CONTAINER-UUID' }
        ]);   // NOT invisible
    });

    // ...and a device we could not probe AT ALL is treated as an unidentified LUKS container, which blocks
    // encryption. A partition we cannot read is not a partition we may assume is harmless.
    it('treats an unprobeable partition as an unidentified LUKS container', async () => {
        spawnHelper.mockResolvedValue({ code: 1, stdout: 'wipefs: cannot open /dev/sdf1' });

        const found = await findEncryptedPartitions(IDENTITY, disks([
            { type: 'part', name: 'sdf1', path: '/dev/sdf1', fstype: null, partlabel: null }
        ]));

        expect(found.unknown).toEqual(['/dev/sdf1']);
    });

    it('does not care about plaintext partitions at all', async () => {
        const found = await findEncryptedPartitions(IDENTITY, disks([
            { type: 'part', name: 'sdf1', path: '/dev/sdf1', fstype: 'ext4', partlabel: 'primary' }
        ]));

        expect(found).toEqual({ ours: [], unknown: [] });
    });
});

// ---------------------------------------------------------------------------------------------------------
// THE AUDIT. The one question about an encrypted fleet that NOTHING ELSE IN THE SYSTEM WILL EVER ASK.
//
// STRUBS mounts with the KEYFILE. The passphrase keyslot is never exercised in normal service -- so a disk
// whose passphrase slot has rotted, been changed by hand, or was never the fleet's to begin with mounts and
// serves flawlessly, for years, and announces itself on exactly one day: the OS disk is dead, you take the
// passphrase out of the safe, and it opens eleven of your thirty disks.
//
// This is what finds that, while there is still time to do something about it.
// ---------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------
// THE AUDIT -- prove it, rather than believe it.
//
// The keyfile makes the passphrase enforceable, so this is no longer the authority it briefly tried to be. But
// there is exactly one way for a disk to be on the wrong passphrase that no amount of enforcement prevents: it
// was ABSENT when the passphrase was rotated, and came back afterwards. Nothing else will ever notice, because
// STRUBS mounts with the keyfile and never touches that slot.
// ---------------------------------------------------------------------------------------------------------
describe('the recovery passphrase audit', () => {
    const PASS = 'the fleet recovery passphrase';

    const fleetOn = (paths: string[], pass: string, opts: Record<string, unknown> = {}) => {
        const db = fakeDeps({ encrypted: paths, ...opts });
        paths.forEach(path => db.slotsOf(path).add(pass));
        return db;
    };

    it('reports a healthy fleet when the passphrase opens every disk', async () => {
        const db = fleetOn(['/dev/sdf1', '/dev/sdg1'], PASS);

        const audit = await auditRecoveryKey(PASS, db);

        expect(audit.healthy).toBe(true);
        expect(audit.opened.map(d => d.path)).toEqual(['/dev/sdf1', '/dev/sdg1']);
    });

    // THE DISASTER THIS EXISTS TO FIND. Volume 12 was unplugged when the passphrase was last rotated, so it kept
    // the OLD one. It mounts, serves, scrubs and verifies perfectly -- and the passphrase in the safe does not
    // open it. Nothing else in the system will ever tell you that.
    it('finds a disk that missed a rotation, and names it', async () => {
        const db = fleetOn(['/dev/sdf1', '/dev/sdg1'], PASS);
        db.slotsOf('/dev/sdg1').delete(PASS);
        db.slotsOf('/dev/sdg1').add('the passphrase from two rotations ago');

        const audit = await auditRecoveryKey(PASS, db);

        expect(audit.healthy).toBe(false);
        expect(audit.refused.map(d => d.volumeId)).toEqual([12]);
        expect(audit.opened.map(d => d.volumeId)).toEqual([11]);
    });

    // A disk we could not READ is not a disk that said no. Its recoverability is UNKNOWN, which is a disk fault
    // -- not the same emergency as a disk on the wrong passphrase.
    it('separates a disk it could not read from one that refused', async () => {
        const db = fleetOn(['/dev/sdf1', '/dev/sdg1'], PASS, { unreadableDisks: ['/dev/sdg1'] });

        const audit = await auditRecoveryKey(PASS, db);

        expect(audit.healthy).toBe(false);
        expect(audit.unreadable.map(d => d.path)).toEqual(['/dev/sdg1']);
        expect(audit.refused).toEqual([]);
    });

    // ⚠️ AN AUDIT THAT DID NOT SEE EVERY DISK CANNOT SAY THE FLEET IS RECOVERABLE.
    //
    // It asks the platters in front of it. A volume whose disk is unplugged is not asked AT ALL -- and it is the
    // likeliest one to be wrong, because it is the one a rotation could not reach. Reporting "healthy" on the
    // strength of the disks that happened to be plugged in is the exact false reassurance this exists to prevent.
    it('is NOT healthy while a volume it could not even ask about is absent', async () => {
        const db = fleetOn(['/dev/sdf1'], PASS);
        db.setAbsent([12]);

        const audit = await auditRecoveryKey(PASS, db);

        expect(audit.healthy).toBe(false);
        expect(audit.notChecked).toEqual([12]);
        expect(audit.opened.map(d => d.volumeId)).toEqual([11]);   // it did open the one it could see
    });

    it('is not healthy while an unidentifiable LUKS container is attached', async () => {
        const db = fleetOn(['/dev/sdf1'], PASS, { unknown: ['/dev/sdz1'] });

        const audit = await auditRecoveryKey(PASS, db);

        expect(audit.healthy).toBe(false);
        expect(audit.unidentified).toEqual(['/dev/sdz1']);
    });

    // A TYPO IS NOT A BROKEN FLEET. A passphrase that opens nothing is almost certainly just wrong -- and
    // recording that as "none of your disks open" would leave a false four-alarm banner, making the real alarm
    // indistinguishable from a fat finger.
    it('refuses a passphrase that opens nothing, and records nothing', async () => {
        const db = fleetOn(['/dev/sdf1', '/dev/sdg1'], PASS);

        await expect(auditRecoveryKey('a mistyped passphrase', db)).rejects.toThrow(/opens NONE/);
        expect(await lastRecoveryAudit(db)).toBeNull();
    });

    it('records nothing when every disk is unreadable -- it learned nothing', async () => {
        const db = fleetOn(['/dev/sdf1'], PASS, { unreadableDisks: ['/dev/sdf1'] });

        await expect(auditRecoveryKey(PASS, db)).rejects.toThrow(/disk problem/);
        expect(await lastRecoveryAudit(db)).toBeNull();
    });

    it('records what it found, and never the passphrase', async () => {
        const db = fleetOn(['/dev/sdf1'], PASS);

        await auditRecoveryKey(PASS, db);

        expect(JSON.stringify(db.store.get(RECOVERY_AUDIT_KEY))).not.toContain('recovery passphrase');
        expect((await lastRecoveryAudit(db))?.healthy).toBe(true);
    });

    it('reports never-audited as null rather than as healthy', async () => {
        expect(await lastRecoveryAudit(fakeDeps())).toBeNull();
    });
});

// ---------------------------------------------------------------------------------------------------------
// ROTATION AND ENCRYPTION MUST NOT OVERLAP.
//
// They disagree about what the fleet passphrase IS, and each is right for a moment. A rotation writes NEW to
// every disk it saw and then records NEW; an encryption reads the recorded passphrase (still OLD), spends
// minutes formatting a disk, and writes OLD into it. Interleave them and the new disk is created with OLD --
// AFTER the rotation finished and recorded NEW. Nothing looks wrong anywhere, and the volume simply does not
// open with the passphrase in the safe.
// ---------------------------------------------------------------------------------------------------------
describe('rotation and encryption do not overlap', () => {
    const PASS = 'the fleet recovery passphrase';

    it('refuses to rotate while a volume is being encrypted', async () => {
        const db = fakeDeps();
        await setFleetRecoveryPassphrase(PASS, undefined, db);

        // A provision is in flight -- and it will write a keyslot when it gets there, minutes from now.
        let release: () => void;
        const provision = withEncryptionSlot(() => new Promise<void>(resolve => { release = resolve; }));

        await expect(setFleetRecoveryPassphrase('a new fleet passphrase', PASS, db))
            .rejects.toThrow(/while 1 volume\(s\) are being encrypted/);

        release!();
        await provision;

        // Once it finishes, the rotation is allowed.
        await expect(setFleetRecoveryPassphrase('a new fleet passphrase', PASS, db)).resolves.toBeTruthy();
    });

    // ⚠️ AND A DELETE/UNDELETE MUST NOT STRADDLE A ROTATION EITHER.
    //
    // Rotation walks only the volumes that are NOT deleted -- and `scanFleet()` snapshots the volume list, then
    // enumerates the disks. An undelete landing in that window makes volume 12 active again while the rotation's
    // snapshot still calls it deleted: the rotation skips it, records the new passphrase, and the disk comes
    // back into service holding a key nobody has. Nothing in normal service would ever notice, because STRUBS
    // mounts with the keyfile.
    //
    // The volume delete/undelete routes take the SAME gate as an encrypted provision. This is what enforces it.
    it('refuses a volume delete/undelete while the passphrase is being rotated', async () => {
        const db = fakeDeps({ encrypted: ['/dev/sdf1'] });
        db.slotsOf('/dev/sdf1').add(PASS);
        await setFleetRecoveryPassphrase(PASS, undefined, db);

        const rotation = setFleetRecoveryPassphrase('a new fleet passphrase', PASS, db);

        // This is what DELETE /$/volumes/{id} and the undelete branch of PUT /$/volumes/{id} do.
        await expect(withEncryptionSlot(async () => 'undeleted'))
            .rejects.toThrow(/passphrase is being changed right now/);

        await rotation;
        await expect(withEncryptionSlot(async () => 'undeleted')).resolves.toBe('undeleted');
    });

    it('refuses to encrypt while the passphrase is being rotated', async () => {
        const db = fakeDeps({ encrypted: ['/dev/sdf1'] });
        db.slotsOf('/dev/sdf1').add(PASS);
        await setFleetRecoveryPassphrase(PASS, undefined, db);

        // A rotation is under way. It takes seconds -- argon2, then a keyslot write per disk -- and for all of
        // that time an encryption starting now would be building a disk with the OLD passphrase.
        const rotation = setFleetRecoveryPassphrase('a new fleet passphrase', PASS, db);

        await expect(withEncryptionSlot(async () => 'encrypted'))
            .rejects.toThrow(/passphrase is being changed right now/);

        await rotation;

        // ...and once it is done, encryption is allowed again.
        await expect(withEncryptionSlot(async () => 'encrypted')).resolves.toBe('encrypted');
    });
});

// ---------------------------------------------------------------------------------------------------------
// WHICH VOLUMES EXIST BUT ARE NOT PLUGGED IN? -- and why this cannot be `volume.isPresent`.
//
// This decides whether a passphrase rotation may run. A volume it fails to report as absent is a volume that
// misses the rotation and keeps the OLD passphrase -- silently, and discoverable only on the day the keyfile is
// gone.
//
// ⚠️ `isPresent` is a BELIEF, maintained by VolumeFleet.reconcile() -- and reconcile deliberately SKIPS volumes
// that are deleted, disabled, or DRAINING before it can mark them missing. So an encrypted volume that was
// bound and then pulled WHILE DRAINING -- which is exactly the sequence an operator follows to retire a disk --
// keeps `isPresent: true` forever, and a rotation would look straight at it and see nothing wrong.
//
// So: ask the disks.
// ---------------------------------------------------------------------------------------------------------
describe('finding the volumes whose disks are not here', () => {
    const disks = (partitionUuids: Array<string | null>) =>
        (async () => [{
            name: 'sdf', path: '/dev/sdf', type: 'disk', size: 1,
            children: partitionUuids.map((uuid, i) => ({
                type: 'part', name: `sd${i}1`, path: `/dev/sd${i}1`, uuid
            }))
        }]) as never;

    const volume = (id: number, partitionUuid: string | null, isDeleted = false) => ({ id, partitionUuid, isDeleted });

    it('reports a volume whose partition is not attached', async () => {
        const found = await absentVolumeIds(
            [volume(11, 'part-11'), volume(12, 'part-12')],
            disks(['part-11'])   // only volume 11's disk is plugged in
        );

        expect(found).toEqual([12]);
    });

    // THE ONE THAT MATTERS. The volume is mid-drain, so reconcile never marked it missing and `isPresent` is
    // still true -- but its disk is not on this machine. Asking the platters gets the right answer; asking the
    // cache does not.
    it('reports a DRAINING volume whose disk was pulled -- the cache would still say it is present', async () => {
        const draining = { id: 12, partitionUuid: 'part-12', isDeleted: false, isPresent: true, isDraining: true };

        const found = await absentVolumeIds([volume(11, 'part-11'), draining], disks(['part-11']));

        expect(found).toEqual([12]);
    });

    it('says nothing about a volume whose disk IS attached', async () => {
        expect(await absentVolumeIds([volume(11, 'part-11')], disks(['part-11']))).toEqual([]);
    });

    // A retired volume is not one the fleet must keep in step -- it has left the building.
    it('ignores a soft-deleted volume', async () => {
        expect(await absentVolumeIds([volume(12, 'part-12', true)], disks([]))).toEqual([]);
    });

    // No partition uuid means no way to look for its disk. We cannot say it is here, so we do not.
    it('cannot vouch for a volume it has no way to look for', async () => {
        expect(await absentVolumeIds([volume(12, null)], disks(['part-12']))).toEqual([12]);
    });

    // Fail CLOSED. "I could not enumerate the disks" is not permission to rewrite the keys of a 130TB array.
    it('throws rather than reporting an empty list when discovery fails', async () => {
        const broken = (async () => { throw new Error('lsblk failed'); }) as never;

        await expect(absentVolumeIds([volume(12, 'part-12')], broken)).rejects.toThrow(/lsblk failed/);
    });
});

// ---------------------------------------------------------------------------------------------------------
// ONE SNAPSHOT, THREE ANSWERS.
//
// ⚠️ Rotation asks the disks TWO questions -- "which encrypted disks are ours?" and "which volumes are
// missing?" -- and an earlier version answered them from TWO separate enumerations of the block devices.
//
// These are USB disks. They flap. Encrypted volume 12 absent during the first listing (so it is not in `ours`,
// and never gets rotated) and back before the second (so it is not reported absent, and nothing refuses) falls
// through BOTH guards. The rotation rewrites every disk it saw, records the new hash, and volume 12 keeps the
// old passphrase with nothing left to say so.
// ---------------------------------------------------------------------------------------------------------
describe('scanning the fleet', () => {
    const IDENTITY = '2fb05f23-1d5e-4c00-bb71-f3109b42476c';

    it('answers "ours", "unknown" and "absent" from a SINGLE enumeration of the disks', async () => {
        const list = vi.fn(async () => [{
            name: 'sdf', path: '/dev/sdf', type: 'disk', size: 1,
            children: [{
                type: 'part', name: 'sdf1', path: '/dev/sdf1', uuid: 'part-11',
                fstype: 'crypto_LUKS', partlabel: 'strubs-2fb05f231d5e4c00-11'
            }]
        }]) as never;

        const scan = await scanFleet(
            IDENTITY,
            [{ id: 11, partitionUuid: 'part-11', isDeleted: false },
             { id: 12, partitionUuid: 'part-12', isDeleted: false }],
            list
        );

        expect(scan.ours.map(d => d.volumeId)).toEqual([11]);
        expect(scan.absent).toEqual([12]);

        // THE POINT: the disks were enumerated ONCE. A second listing is a window a flapping disk slips through.
        expect(list).toHaveBeenCalledTimes(1);
    });
});
