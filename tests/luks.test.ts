import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../lib/helpers/spawn', () => ({ spawnHelper: vi.fn() }));

vi.mock('fs', () => ({
    promises: {
        stat: vi.fn(),
        realpath: vi.fn(),
        readdir: vi.fn(),
        access: vi.fn()
    }
}));

import { spawnHelper as realSpawnHelper } from '../lib/helpers/spawn';
import { promises as fsp } from 'fs';
const spawnHelper = vi.mocked(realSpawnHelper);
const statMock = vi.mocked(fsp.stat);
const realpathMock = vi.mocked(fsp.realpath);
const readdirMock = vi.mocked(fsp.readdir);

import { assertFleetRecoveryPassphrase, hasRecoveryPassphrase, RECOVERY_VERIFIER_KEY } from '../lib/io/luks-recovery-key';
import {
    addPassphrase,
    assertRecoverable,
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
const fakeDeps = (opts: {
    encrypted?: string[];        // OUR encrypted disks, as read off the platters by nameplate
    unknown?: string[];          // LUKS containers carrying no STRUBS nameplate
    opens?: (path: string, pass: string) => boolean;
    unreadableDisks?: string[];   // the LUKS header could not be read at all
    keyIsUnique?: boolean;
} = {}) => {
    const store = new Map<string, unknown>();
    return {
        store,
        database: {
            getRuntimeConfig: async (key: string) => store.get(key),
            setRuntimeConfig: async (key: string, value: unknown) => { store.set(key, value); },
            setRuntimeConfigIfAbsent: async (key: string, value: unknown) => {
                if (store.has(key)) return false;
                store.set(key, value);
                return true;
            },
            // The unique index on runtimeConfig.key -- what makes setIfAbsent genuinely exclusive.
            runtimeConfigKeyIsUnique: async () => opts.keyIsUnique ?? true
        },
        findEncryptedPartitions: async () => ({ ours: opts.encrypted ?? [], unknown: opts.unknown ?? [] }),
        // THREE answers, not two: a disk we could not read is not a disk that said no.
        testPassphrase: vi.fn(async (path: string, pass: string) => {
            if (opts.unreadableDisks?.includes(path)) return 'unreadable';
            return opts.opens?.(path, pass) ? 'opens' : 'rejected';
        })
    } as any;
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

describe('the fleet recovery passphrase', () => {
    it('records a verifier the first time, and never the passphrase itself', async () => {
        const db = fakeDeps();
        await assertFleetRecoveryPassphrase('correct horse battery staple', db);

        const stored = JSON.stringify(db.store.get(RECOVERY_VERIFIER_KEY));
        expect(stored).not.toContain('correct horse');
        expect(await hasRecoveryPassphrase(db)).toBe(true);
    });

    it('accepts the same passphrase again', async () => {
        const db = fakeDeps();
        await assertFleetRecoveryPassphrase('correct horse battery staple', db);
        await expect(assertFleetRecoveryPassphrase('correct horse battery staple', db)).resolves.toBeUndefined();
    });

    // The silent disaster this exists to prevent: half the fleet encrypted under one passphrase, half under
    // another, and nobody finds out until the OS disk is gone and the safe only opens eleven of thirty disks.
    it('refuses a passphrase that disagrees with the rest of the fleet', async () => {
        const db = fakeDeps();
        await assertFleetRecoveryPassphrase('correct horse battery staple', db);
        await expect(assertFleetRecoveryPassphrase('a different passphrase', db))
            .rejects.toThrow(/not the recovery passphrase/);
    });

    it('refuses a passphrase too short to be worth having', async () => {
        const db = fakeDeps();
        await expect(assertFleetRecoveryPassphrase('short', db)).rejects.toThrow(/at least 12/);
        expect(await hasRecoveryPassphrase(db)).toBe(false);
    });

    it('reports no passphrase on a fleet that has never encrypted anything', async () => {
        expect(await hasRecoveryPassphrase(fakeDeps())).toBe(false);
    });

    // THE DISKS OUTLIVED THE DATABASE.
    //
    // Restore a snapshot, rebuild Mongo, lose the OS disk: the verifier is gone while eighteen encrypted disks
    // are still in the rack. Trusting "no verifier" would let the next encryption establish a BRAND NEW
    // passphrase and split the fleet -- at the exact moment recovery matters most. So we ask a platter.
    describe('when the verifier is gone but the encrypted disks are not', () => {
        it('refuses a passphrase that opens none of the existing encrypted volumes', async () => {
            const db = fakeDeps({ encrypted: ['/dev/sdf1', '/dev/sdg1'], opens: () => false });

            await expect(assertFleetRecoveryPassphrase('a brand new passphrase', db))
                .rejects.toThrow(/opens\s+NONE of them/);

            // And it did not quietly record the new one on the way out.
            expect(await hasRecoveryPassphrase(db)).toBe(false);
        });

        it('accepts a passphrase that opens EVERY encrypted volume, and re-records the verifier', async () => {
            const db = fakeDeps({
                encrypted: ['/dev/sdf1', '/dev/sdg1'],
                opens: (_path, pass) => pass === 'the real fleet passphrase'
            });

            await expect(assertFleetRecoveryPassphrase('the real fleet passphrase', db)).resolves.toBeUndefined();
            expect(await hasRecoveryPassphrase(db)).toBe(true);
        });

        // THE FLEET IS ALREADY SPLIT, AND THIS IS THE MOMENT WE FIND OUT.
        //
        // Stopping at the first disk that says yes would take the one occasion we are actually holding a
        // passphrase and reading real LUKS headers, and use it to CERTIFY the disaster: record X as the fleet
        // passphrase, while volume B -- encrypted under Y -- quietly becomes a disk that nothing in the
        // database knows we cannot open.
        it('refuses a passphrase that opens SOME of the disks but not all of them', async () => {
            const db = fakeDeps({
                encrypted: ['/dev/sdf1', '/dev/sdg1', '/dev/sdh1'],
                opens: (path) => path !== '/dev/sdh1'      // sdh1 was encrypted with a different passphrase
            });

            await expect(assertFleetRecoveryPassphrase('opens two of the three', db))
                .rejects.toThrow(/ALREADY SPLIT ACROSS TWO PASSPHRASES/);

            // It names the disk that refused, and it does not record the passphrase as the fleet's.
            await expect(assertFleetRecoveryPassphrase('opens two of the three', db)).rejects.toThrow(/sdh1/);
            expect(await hasRecoveryPassphrase(db)).toBe(false);
        });

        // On a fleet with NO encrypted volumes there is nothing to ask, and the first passphrase is simply the
        // first passphrase -- no platter should be touched.
        it('does not interrogate the disks on a fleet that has never encrypted anything', async () => {
            const db = fakeDeps({ encrypted: [] });

            await assertFleetRecoveryPassphrase('correct horse battery staple', db);

            expect(db.testPassphrase).not.toHaveBeenCalled();
        });
    });

    // Two first-encryptions racing with DIFFERENT passphrases: both read "no verifier", both write. The loser's
    // passphrase is already baked into a disk's keyslot and recorded NOWHERE. Exactly one may create it.
    it('refuses the loser of a concurrent first-encryption race', async () => {
        const db = fakeDeps();

        const [first, second] = await Promise.allSettled([
            assertFleetRecoveryPassphrase('the first passphrase here', db),
            assertFleetRecoveryPassphrase('a different one entirely', db)
        ]);

        // Exactly one won; the other was refused rather than silently overwriting the verifier.
        const outcomes = [first.status, second.status].sort();
        expect(outcomes).toEqual(['fulfilled', 'rejected']);
    });

    // MONGO MUST NOT OVERRULE THE DISKS. This is the governing principle of the whole system, and the verifier
    // is the one place it was quietly inverted: the stored hash was consulted FIRST and short-circuited on a
    // match, so a stale or wrong verifier -- restored from an old snapshot, hand-edited, written by the loser
    // of a race -- could authorise a passphrase that opens nothing on any platter in the rack.
    describe('when the database disagrees with the platters', () => {
        it('refuses a passphrase the VERIFIER accepts but the DISKS reject', async () => {
            const db = fakeDeps({ encrypted: ['/dev/sdf1'], opens: () => false });

            // Establish a verifier for a passphrase the disks do not actually take (a stale one).
            await db.database.setRuntimeConfig(RECOVERY_VERIFIER_KEY, await (async () => {
                const clean = fakeDeps();                       // no disks to ask -> records the verifier
                await assertFleetRecoveryPassphrase('a stale recorded passphrase', clean);
                return clean.store.get(RECOVERY_VERIFIER_KEY);
            })());

            // Mongo says yes. Every disk in the rack says no. The disks win.
            await expect(assertFleetRecoveryPassphrase('a stale recorded passphrase', db))
                .rejects.toThrow(/opens\s+NONE of them/);
        });

        // ...and the converse: a passphrase that opens EVERY disk is the fleet passphrase, whatever Mongo
        // thinks. The stale verifier is replaced, not obeyed.
        it('accepts a passphrase the DISKS accept but the verifier does not, and repairs the verifier', async () => {
            const db = fakeDeps({
                encrypted: ['/dev/sdf1', '/dev/sdg1'],
                opens: (_p, pass) => pass === 'the real fleet passphrase'
            });
            await db.database.setRuntimeConfig(RECOVERY_VERIFIER_KEY,
                { salt: '00'.repeat(16), hash: 'ff'.repeat(32), setAt: 'stale' });

            await expect(assertFleetRecoveryPassphrase('the real fleet passphrase', db)).resolves.toBeUndefined();

            // The verifier now matches the platters: the same passphrase is accepted again with no disks present.
            const repaired = fakeDeps();
            repaired.store.set(RECOVERY_VERIFIER_KEY, db.store.get(RECOVERY_VERIFIER_KEY));
            await expect(assertFleetRecoveryPassphrase('the real fleet passphrase', repaired)).resolves.toBeUndefined();
        });

        // AN UNIDENTIFIABLE LUKS DISK IS NOT A DISK WE GET TO IGNORE.
        //
        // It carries no nameplate, so it may be one of ours whose plate never landed. Shrug it off and the next
        // encryption never tests its passphrase against it -- which is precisely how a fleet ends up split.
        // (Encrypted provisioning now REFUSES to put a nameplate-less disk into service, so one of ours should
        // never reach this state; if we are looking at one anyway, something is wrong.)
        it('refuses to encrypt anything while an unidentifiable LUKS container is attached', async () => {
            const db = fakeDeps({ encrypted: ['/dev/sdf1'], unknown: ['/dev/sdz1'], opens: () => true });

            await expect(assertFleetRecoveryPassphrase('the real fleet passphrase', db))
                .rejects.toThrow(/no STRUBS nameplate/);

            expect(await hasRecoveryPassphrase(db)).toBe(false);
        });

        // A DISK WE COULD NOT READ IS NOT A DISK THAT SAID NO.
        //
        // Its header might take this passphrase perfectly well -- we simply could not ask. Calling that a
        // rejection reports a DYING DRIVE as a fleet split, and sends the operator hunting for a passphrase
        // that never existed while the real fault is a disk falling off the bus. (cryptsetup is unambiguous
        // about this: exit 2 is "no key available", exit 4 is "I could not read the device".)
        it('does not mistake an unreadable disk for a rejected passphrase', async () => {
            const db = fakeDeps({
                encrypted: ['/dev/sdf1', '/dev/sdg1'],
                unreadableDisks: ['/dev/sdg1'],
                opens: () => true                      // sdf1 opens fine; sdg1 cannot be read at all
            });

            await expect(assertFleetRecoveryPassphrase('the real fleet passphrase', db))
                .rejects.toThrow(/could not be read/);

            // ...and specifically NOT the "your fleet is split" alarm.
            await expect(assertFleetRecoveryPassphrase('the real fleet passphrase', db))
                .rejects.not.toThrow(/SPLIT/);
        });

        // The first passphrase ever recorded is the one moment a race is UNRECOVERABLE: two callers, two
        // passphrases, two disks, one of them written down. setIfAbsent is only exclusive because of the unique
        // index -- so if the index is not there, say so instead of pretending.
        it('refuses to record the FIRST passphrase without the unique index that makes it atomic', async () => {
            const db = fakeDeps({ keyIsUnique: false });

            await expect(assertFleetRecoveryPassphrase('the very first passphrase', db))
                .rejects.toThrow(/unique index on runtimeConfig.key is not in place/);

            expect(await hasRecoveryPassphrase(db)).toBe(false);
        });
    });

});

// WHICH ENCRYPTED DISKS DOES THIS ARRAY HAVE? -- asked of the platters, never of the volume table.
//
// The passphrase guard used to get this list from `ioManager.getVolumeEntries()`, i.e. from MONGO. That made
// the whole check conditional on the database being right: restore a volume table from before the conversion
// and the encrypted disks in the rack become INVISIBLE to it -- so it sees "no encrypted volumes", takes the
// verifier-only path, and records a brand-new passphrase. The bug it was written to prevent, one layer out.
describe('finding the encrypted disks on the platters', () => {
    const IDENTITY = '2fb05f23-1d5e-4c00-bb71-f3109b42476c';   // the real, hyphenated form

    const disks = (children: Array<Record<string, unknown>>) =>
        (async () => [{ name: 'sdf', path: '/dev/sdf', type: 'disk', size: 1, children }]) as never;

    it('finds our own encrypted disks by their nameplate -- no key, no mount, no database', async () => {
        const found = await findEncryptedPartitions(IDENTITY, disks([
            { type: 'part', name: 'sdf1', path: '/dev/sdf1', fstype: 'crypto_LUKS', partlabel: 'strubs-2fb05f231d5e4c00-57' }
        ]));

        expect(found.ours).toEqual(['/dev/sdf1']);
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
            { type: 'part', name: 'sdf1', path: '/dev/sdf1', fstype: null, partlabel: 'strubs-2fb05f231d5e4c00-57' }
        ]));

        expect(found.ours).toEqual(['/dev/sdf1']);   // NOT invisible
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