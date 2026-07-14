import { createHash, randomBytes } from 'crypto';
import { promises as fsp } from 'fs';
import path from 'path';

import { spawnHelper } from '../helpers/spawn';
import { listRawBlockDevices, type RawBlockDeviceChild } from './device-discovery';
import { classifyPartition } from './signature-probe';
import { createLogger } from '../log';

const log = createLogger('luks');

// ENCRYPTION AT REST -- WHAT IT DEFENDS AGAINST, STATED FIRST, BECAUSE IT COLLAPSES THE DESIGN.
//
// Exactly one thing: A DISK LEAVING OUR PHYSICAL CONTROL. RMA'd, sold, discarded, stolen. That is a real threat
// -- failing drives are pulled from this rack routinely, and they hold customers' photographs, video and call
// recordings.
//
// It does NOT defend against a compromised host: the key must be online to serve reads, so a root shell on this
// machine reads everything regardless. It does not defend against the network either. This is defence in depth,
// not a foundation, and pretending otherwise would be the most dangerous thing in this file.
//
// It also DEPENDS ON THE RECOVERY STORY EXISTING FIRST (DR-A through DR-F). Encryption converts "we lost the
// metadata" into "we lost everything": a lost key is unrecoverable in a way that a lost MongoDB simply is not.
//
// LUKS, NOT APPLICATION-LEVEL. Measured on this host (i5-7500, AES-NI, while a rebalance was running):
// AES-XTS-256 runs at ~2,400 MiB/s per thread against a peak observed disk load of ~217 MB/s -- about 9% of one
// core, and ~94 kB of kernel slab per device (~3 MB for the whole fleet). The disks are an order of magnitude
// slower than the cipher. dm-crypt also runs in kernel context on the I/O path, entirely off the Node event
// loop, where application-level encryption would contend in the libuv threadpool with RS encoding and hashing.
//
// NOT dm-integrity. LUKS2 can do authenticated encryption, but it costs a journal write per write (brutal on
// spinning disks) and it only DETECTS. We already detect via per-chunk MD5 and can REPAIR from parity, which is
// strictly better.

// The keyfile unlocks every volume unattended. `Restart=always` means a passphrase prompt at boot is a
// non-starter, so the key lives on the OS disk -- and we are honest about what that buys: it protects disks
// that leave the building, not the host they are plugged into. That is precisely the threat we have.
export const DEFAULT_KEYFILE = process.env.STRUBS_LUKS_KEYFILE || '/var/lib/strubs/luks.key';

export const LUKS_FSTYPE = 'crypto_luks';

// One mapper per volume, named from its uuid so the name is stable across reboots, derivable without a
// database, and impossible to collide with another array's.
export const mapperName = (volumeUuid: string): string => `strubs-${volumeUuid}`;
export const mapperPath = (volumeUuid: string): string => `/dev/mapper/${mapperName(volumeUuid)}`;

export const isLuksFsType = (fsType: string | null | undefined): boolean =>
    (fsType ?? '').toLowerCase() === LUKS_FSTYPE;

export class LuksError extends Error {
    constructor(message: string, readonly code: 'no-key' | 'wrong-key' | 'busy' | 'failed') {
        super(message);
        this.name = 'LuksError';
    }
}

// Is the keyfile there, and only readable by us? A 0644 key on a shared box is not a key, it is a formality.
// The keyfile's bytes. It is the key to every disk in the fleet, so it is never logged and never leaves this
// process -- but the recovery-passphrase seal needs it, and the alternative (a second copy of the "where does
// the key live" logic) is how the fstype bug got written three times.
export async function readKeyfile(keyfile = DEFAULT_KEYFILE): Promise<Buffer | null> {
    try {
        return await fsp.readFile(keyfile);
    }
    catch {
        return null;
    }
}

export async function keyfileReadable(keyfile = DEFAULT_KEYFILE): Promise<boolean> {
    try {
        const st = await fsp.stat(keyfile);
        const mode = st.mode & 0o777;

        if (mode & 0o077)
            log.error('%s is mode %s -- it is readable by users other than root. The disks are encrypted and the '
                + 'key is not. Fix it: chmod 0400.', keyfile, mode.toString(8));

        return true;
    }
    catch {
        return false;
    }
}

// ENSURE THE KEYFILE EXISTS -- AND REFUSE, LOUDLY, IF ITS ABSENCE MEANS SOMETHING TERRIBLE.
//
// An operator should not have to hand-roll a secret with `dd` before they can use a feature. So STRUBS makes
// the keyfile itself, at startup, if there isn't one.
//
// ⚠️ BUT A MISSING KEYFILE IS NOT ALWAYS A NEW ARRAY. IT IS ALSO WHAT A LOST ONE LOOKS LIKE.
//
// Restore the OS disk from an old backup, or wipe /var/lib/strubs, and the keyfile is gone while thirty
// encrypted disks are still in the rack. If we simply generated a fresh one, STRUBS would come up looking
// perfectly healthy -- and not one disk in the building would open with it. Every volume would fail to unlock,
// and the new key would be a 512-byte file with no relationship to anything. That is the single worst thing
// this codebase could do, and it would do it silently, at boot, with no operator in the room.
//
// So the rule is not "make one if it is missing". The rule is:
//
//   nothing encrypted   -- there is no key to lose, so a fresh one costs nothing. MAKE IT.
//   something encrypted -- the key we needed is GONE. Do not paper over that with a new one that opens nothing.
//                          REFUSE, say so at `critical`, and let the operator restore it -- or recover with the
//                          recovery passphrase, which re-installs a keyfile slot on every disk (see the
//                          bootstrap recovery path). That is what the passphrase is FOR.
//
// The check asks the PLATTERS, not the database: a LUKS container is a LUKS container whatever Mongo thinks.
export type KeyfileState =
    | { state: 'present' }
    | { state: 'created' }
    | { state: 'missing-but-disks-are-encrypted'; disks: string[] };

export async function ensureKeyfile(
    keyfile = DEFAULT_KEYFILE,
    list: typeof listRawBlockDevices = listRawBlockDevices
): Promise<KeyfileState> {
    if (await keyfileReadable(keyfile))
        return { state: 'present' };

    // Any LUKS container at all -- ours, a stranger's, or one we cannot identify. If there is encryption on this
    // machine and no key for it, we are not in a position to be inventing keys.
    const encrypted: string[] = [];
    for (const device of await list())
        for (const child of device.children ?? [])
            if (isLuksFsType(child.fstype))
                encrypted.push(child.path ?? `/dev/${child.name}`);

    if (encrypted.length) {
        log.error('THE LUKS KEYFILE (%s) IS MISSING, AND THERE ARE %d ENCRYPTED DISK(S) ON THIS MACHINE (%s). '
            + 'This is not a new array -- it is an array whose key has been LOST, most likely because the OS disk '
            + 'was restored or /var/lib/strubs was wiped. STRUBS will NOT generate a new keyfile: a fresh key '
            + 'opens NONE of those disks, and creating one would leave a system that looks healthy and cannot '
            + 'read a single byte. Restore the keyfile from your backup, or recover with the fleet recovery '
            + 'passphrase (which will write a new keyfile slot onto every disk).',
            keyfile, encrypted.length, encrypted.join(', '));

        return { state: 'missing-but-disks-are-encrypted', disks: encrypted };
    }

    // Nothing is encrypted, so there is no key to have lost. Make one.
    await fsp.mkdir(path.dirname(keyfile), { recursive: true, mode: 0o700 });

    // 'wx' -- create exclusively. If two starts race, the loser fails rather than clobbering a key the winner
    // may already have encrypted a disk with.
    const handle = await fsp.open(keyfile, 'wx', 0o400);
    try {
        await handle.write(randomBytes(512));
        await handle.sync();   // it is a KEY. It goes to the platter before we tell anyone it exists.
    }
    finally {
        await handle.close();
    }

    log('created a LUKS keyfile at %s (nothing is encrypted, so there was no key to lose). It is mode 0400 and '
        + 'it is the key to every disk this array will ever encrypt: back it up, and do not lose it. The recovery '
        + 'passphrase is what saves you if you do.', keyfile);

    return { state: 'created' };
}

// UNLOCK. Returns the mapper path.
//
// Idempotent: a mapper that is already open is a success, not a conflict -- a restart of the process must not
// require the disks to be re-unlocked, and a hotplug reconciler must be able to call this without checking.
export async function open(partitionPath: string, volumeUuid: string, keyfile = DEFAULT_KEYFILE): Promise<string> {
    const name = mapperName(volumeUuid);
    const path = mapperPath(volumeUuid);

    // ALREADY UNLOCKED? -- BUT ON TOP OF WHAT?
    //
    // A mapper by the right name is not proof it is sitting on the right disk. These are USB drives: one drops,
    // the kernel renumbers, it comes back as a different partition -- and the mapper from its previous life is
    // still there, still named strubs-<uuid>, now backed by a device that has gone. Returning it because the
    // NAME matched would hand the volume a mapper pointing at nothing, and it would look mounted while serving
    // errors.
    //
    // So ask the mapper what it is built on. Right disk -> reuse it. Wrong disk (or a mapper we cannot
    // interrogate) -> tear it down and open the real one. This is the same class of bug as the stale-mount
    // check, one layer further down.
    if (await fsp.stat(path).then(() => true, () => false)) {
        const backing = await mapperBackingDevice(name);
        const expected = partitionPath.replace(/^\/dev\//, '');

        if (backing === expected) {
            log('%s is already unlocked at %s', partitionPath, path);
            return path;
        }

        log.error('the mapper %s is open on %s, but volume %s now lives on %s. Closing the stale mapper and '
            + 'unlocking the real disk.', name, backing ?? 'a device we could not identify', volumeUuid, expected);

        await close(volumeUuid);

        // It would not close -- something is still holding it. Refusing is the only safe answer: opening a
        // second mapper for the same volume, or serving the stale one, are both worse.
        if (await fsp.stat(path).then(() => true, () => false))
            throw new LuksError(
                `the mapper ${name} is open on the wrong device (${backing ?? 'unknown'}) and will not close. `
                + `Volume ${volumeUuid} cannot be unlocked safely until whatever is holding it lets go.`,
                'busy');
    }

    if (!await keyfileReadable(keyfile))
        throw new LuksError(
            `${partitionPath} is encrypted and the keyfile ${keyfile} is not readable. This volume cannot be `
            + `unlocked, and its slices cannot be served. The REST OF THE FLEET IS UNAFFECTED -- but if enough `
            + `volumes are locked, objects go below quorum.`,
            'no-key');

    const { code, stdout } = await spawnHelper('cryptsetup',
        ['luksOpen', '--key-file', keyfile, partitionPath, name]);

    if (code !== 0) {
        const detail = (stdout ?? '').trim();

        // "No key available with this passphrase" -- the disk is LUKS, and it is not OURS. That is a very
        // different thing from a broken disk, and an operator needs to hear which one it is.
        if (/no key available|no usable keyslot/i.test(detail))
            throw new LuksError(
                `${partitionPath} is a LUKS container, but our key does not open it. This is not our disk -- or it `
                + `is ours and was encrypted with a different key. Nothing has been changed.`,
                'wrong-key');

        throw new LuksError(`could not unlock ${partitionPath}: ${detail || `cryptsetup exit ${code}`}`, 'failed');
    }

    log('unlocked %s at %s', partitionPath, path);
    return path;
}

// ---------------------------------------------------------------------------------------------------------
// RECOVERY. A bare host, a pile of encrypted drives, and an operator holding the passphrase.
//
// The normal unlock path uses the keyfile, and on the worst day the keyfile is gone with the OS disk. That is
// the entire reason the passphrase keyslot exists -- but it is only worth having if the recovery code can
// actually USE it, so these two functions are what make the recovery path real rather than theoretical.
// ---------------------------------------------------------------------------------------------------------

// Unlock a partition under an arbitrary mapper name, with the keyfile OR a passphrase. Used by the bootstrap
// scan, which has no volume uuid to derive a name from -- it does not yet know what any of these disks are.
export async function openWithSecret(
    partitionPath: string, name: string, secret: { keyfile?: string; passphrase?: string }
): Promise<void> {
    const usingPassphrase = typeof secret.passphrase === 'string';

    const { code, stdout } = await spawnHelper('cryptsetup', [
        'luksOpen',
        '--key-file', usingPassphrase ? '-' : (secret.keyfile ?? DEFAULT_KEYFILE),
        partitionPath,
        name
    ], usingPassphrase ? { stdin: secret.passphrase } : {});

    if (code !== 0) {
        const detail = (stdout ?? '').trim();
        if (/no key available|no usable keyslot/i.test(detail))
            throw new LuksError(`${partitionPath} did not accept the key offered`, 'wrong-key');
        throw new LuksError(`could not unlock ${partitionPath}: ${detail || `cryptsetup exit ${code}`}`, 'failed');
    }
}

export async function closeByName(name: string): Promise<void> {
    if (!await fsp.stat(`/dev/mapper/${name}`).then(() => true, () => false))
        return;
    await spawnHelper('cryptsetup', ['luksClose', name]);
}

// RE-ARM UNATTENDED BOOT AFTER A RECOVERY.
//
// You have recovered the array with the passphrase. Every volume now unlocks -- if a human types it. But
// `Restart=always` means the next reboot has nobody to ask, and a fleet that only opens by hand is a fleet
// that is down until somebody notices.
//
// So once the passphrase has proved itself, put the NEW keyfile back into a keyslot on every disk. Without
// this step, recovery hands you an array that works exactly once.
//
// Idempotent: a disk the keyfile already opens is left alone.
export async function ensureKeyfileSlot(
    partitionPath: string, passphrase: string, keyfile = DEFAULT_KEYFILE
): Promise<'added' | 'already-present'> {
    const { code: opens } = await spawnHelper('cryptsetup',
        ['luksOpen', '--test-passphrase', '--key-file', keyfile, partitionPath]);

    if (opens === 0)
        return 'already-present';

    // `luksAddKey <device> [<new key file>]` -- the POSITIONAL argument is the NEW key; the EXISTING one comes
    // from --key-file. So this reads: authenticate with the passphrase (from stdin), and add the keyfile.
    //
    // `--key-file -` is stated explicitly rather than left off. Without it cryptsetup falls back to its
    // interactive prompt, which happens to read stdin when there is no tty -- verified working on a loopback
    // container, and precisely the kind of accident that stops being true the day something gives the process a
    // terminal, at which point this would HANG in the middle of a disaster recovery.
    const { code, stdout } = await spawnHelper('cryptsetup', [
        'luksAddKey',
        '--batch-mode',
        '--key-file', '-',   // the EXISTING key: the recovery passphrase, on stdin
        partitionPath,
        keyfile              // the NEW key: the keyfile we are putting back
    ], { stdin: passphrase });

    if (code !== 0)
        throw new LuksError(
            `could not restore the keyfile keyslot on ${partitionPath}: ${(stdout ?? '').trim() || `exit ${code}`}. `
            + `The volume will unlock with the passphrase but NOT unattended, so it will not survive a reboot.`,
            'failed');

    log('keyfile keyslot restored on %s', partitionPath);
    return 'added';
}

// WHAT IS THIS MAPPER ACTUALLY SITTING ON? Returns the kernel name of its backing device ("sdf1"), or null if
// we could not tell -- and null is treated as "not the right one", because a mapper we cannot interrogate is
// not a mapper we should trust.
//
// /sys/block/dm-N/slaves is the kernel's own answer. dm-crypt has exactly one slave.
export async function mapperBackingDevice(name: string): Promise<string | null> {
    try {
        // /dev/mapper/<name> is a symlink to ../dm-N.
        const target = await fsp.realpath(`/dev/mapper/${name}`);
        const dmName = target.split('/').pop();
        if (!dmName)
            return null;

        const slaves = await fsp.readdir(`/sys/block/${dmName}/slaves`);
        return slaves.length === 1 ? slaves[0] : null;   // a dm-crypt device has exactly one
    }
    catch {
        return null;
    }
}

// LOCK. Called after unmount; a volume that is not open is not an error.
export async function close(volumeUuid: string): Promise<void> {
    const name = mapperName(volumeUuid);

    if (!await fsp.stat(mapperPath(volumeUuid)).then(() => true, () => false))
        return;

    const { code, stdout } = await spawnHelper('cryptsetup', ['luksClose', name]);

    if (code !== 0) {
        // A mapper that will not close is usually a mount we did not know about, and leaving it open is far
        // better than tearing it out from under whoever is using it.
        log.error('could not lock %s (%s). Leaving it open: something is still using it, and forcing it closed '
            + 'would break whatever that is.', name, (stdout ?? '').trim() || `exit ${code}`);
        return;
    }

    log('locked %s', name);
}

// FORMAT. This DESTROYS the partition -- every caller must already have established that it is safe.
//
// aes-xts-plain64 with a 512-bit key (i.e. AES-256 in XTS, which splits the key in two) is the LUKS2 default
// and what the benchmark above measured.
export async function format(partitionPath: string, keyfile = DEFAULT_KEYFILE): Promise<void> {
    if (!await keyfileReadable(keyfile))
        throw new LuksError(
            `refusing to encrypt ${partitionPath}: the keyfile ${keyfile} does not exist. Encrypting a disk with a `
            + `key we cannot read afterwards is not encryption, it is destruction with extra steps.`,
            'no-key');

    const { code, stdout } = await spawnHelper('cryptsetup', [
        'luksFormat',
        '--type', 'luks2',
        '--cipher', 'aes-xts-plain64',
        '--key-size', '512',
        '--batch-mode',
        '--key-file', keyfile,
        partitionPath
    ]);

    if (code !== 0)
        throw new LuksError(`luksFormat of ${partitionPath} failed: ${(stdout ?? '').trim() || `exit ${code}`}`,
            'failed');

    log('%s is now a LUKS2 container', partitionPath);
}

// ADD THE RECOVERY PASSPHRASE -- the second keyslot, and the one that survives the host.
//
// The passphrase goes in on stdin, never on argv: a command line is world-readable in /proc for as long as the
// process lives, and this is the single secret that stands between a dead OS disk and 130TB of noise.
export async function addPassphrase(
    partitionPath: string, passphrase: string, keyfile = DEFAULT_KEYFILE
): Promise<void> {
    if (!passphrase)
        throw new LuksError('refusing to add an empty recovery passphrase', 'no-key');

    const { code, stdout } = await spawnHelper('cryptsetup', [
        'luksAddKey',
        '--batch-mode',
        '--key-file', keyfile,     // authenticate with the keyfile we just formatted with...
        partitionPath,
        '-'                        // ...and read the NEW key from stdin.
    ], { stdin: passphrase });

    if (code !== 0)
        throw new LuksError(
            `could not add the recovery passphrase to ${partitionPath}: ${(stdout ?? '').trim() || `exit ${code}`}`,
            'failed');

    log('recovery passphrase added to %s', partitionPath);
}

// DOES THIS PASSPHRASE OPEN THIS CONTAINER? Asks the disk, changes nothing.
//
// `--test-passphrase` unlocks nothing and creates no mapper: it derives the key, tries every keyslot, and
// reports whether one opened. It is the only way to answer "is this really the fleet's recovery passphrase"
// from the AUTHORITATIVE copy -- the LUKS header on the platter -- rather than from a verifier in a database
// that may have been rebuilt since.
export type PassphraseVerdict = 'opens' | 'rejected' | 'unreadable';

export async function testPassphrase(partitionPath: string, passphrase: string): Promise<PassphraseVerdict> {
    const { code, stdout } = await spawnHelper('cryptsetup', [
        'luksOpen',
        '--test-passphrase',
        '--key-file', '-',
        partitionPath
    ], { stdin: passphrase });

    // THREE ANSWERS, NOT TWO -- and collapsing them is the mistake this codebase keeps making.
    //
    // Measured against the real binary:
    //   0  the passphrase opens a keyslot.
    //   2  "No key available with this passphrase" -- a definitive NO from a header we read perfectly well.
    //   4  the device is absent, unreadable, or not a LUKS container at all. We learned NOTHING.
    //
    // Folding 4 into "rejected" would report a DYING DISK as a fleet split across two passphrases: the operator
    // goes hunting for a passphrase that never existed, while the actual fault is a drive falling off the bus.
    // A failure to LOOK, reported as a fact about the DATA -- the same costume, again.
    if (code === 0) return 'opens';
    if (code === 2) return 'rejected';

    log.error('could not test the passphrase against %s (%s): treating it as UNREADABLE, not as a rejection.',
        partitionPath, (stdout ?? '').trim() || `cryptsetup exit ${code}`);
    return 'unreadable';
}

// REMOVE A PASSPHRASE FROM A CONTAINER. Identified BY the passphrase -- `luksRemoveKey` kills the slot that the
// key you supply opens, so we never have to work out slot numbers (and never risk killing the wrong one).
//
// Used only when rotating: the new passphrase is already in place and proven on every disk before this runs, so
// the worst a failure here can do is leave a second, older, still-valid passphrase behind. Untidy; not dangerous.
export async function removePassphrase(partitionPath: string, passphrase: string): Promise<void> {
    const { code, stdout } = await spawnHelper('cryptsetup', [
        'luksRemoveKey',
        '--batch-mode',
        partitionPath,
        '-'                     // the key to remove, read from stdin -- never from argv
    ], { stdin: passphrase });

    if (code !== 0)
        throw new LuksError(
            `could not remove the old passphrase from ${partitionPath}: ${(stdout ?? '').trim() || `exit ${code}`}`,
            'failed');
}

// WHOSE HEADER IS THIS, RIGHT NOW? -- asked immediately before we write to it.
//
// A device PATH is not an identity. These are USB disks: /dev/sdf1 is whatever the kernel most recently decided
// to call the thing in that slot, and it gets reused. A rotation enumerates the disks, then spends seconds per
// disk deriving keys -- and in that window the disk it scanned can drop and a DIFFERENT one of ours can land on
// the same path. `cryptsetup luksAddKey /dev/sdf1` would then succeed, against the wrong header, and the volume
// we meant to rotate would never be reached at all.
//
// The container uuid is minted by luksFormat and is the identity of the HEADER. Ask for it, and refuse to touch
// a disk that is not the one we scanned.
export async function containerUuid(partitionPath: string): Promise<string | null> {
    const { code, stdout } = await spawnHelper('cryptsetup', ['luksUUID', partitionPath]);
    return code === 0 && stdout.trim() ? stdout.trim() : null;
}

// HOW MANY KEYSLOTS ARE IN USE.
//
// A LUKS keyslot IS a password-wrapped copy of the master key -- which is why no separate escrow partition is
// needed. Two slots is the design:
//
//   keyfile     -- unattended boot. Lives on the OS disk.
//   passphrase  -- disaster recovery. The OS disk is GONE; this is how you get back in.
//
// A KEYFILE-ONLY FLEET DIES WITH THE OS DISK. Every slice on every disk, unreadable, forever. So encryption is
// refused until a second slot exists -- see assertRecoverable().
export async function keyslotCount(partitionPath: string): Promise<number> {
    const { code, stdout } = await spawnHelper('cryptsetup', ['luksDump', partitionPath]);
    if (code !== 0) return -1;

    // LUKS2 dumps "Keyslots:" then "  0: luks2" / "  1: luks2".
    return (stdout.match(/^\s+\d+:\s+luks2/gim) ?? []).length;
}

// THE GUARD THAT STOPS US ENCRYPTING OURSELVES INTO A HOLE.
//
// Refuse to encrypt anything unless a SECOND keyslot exists. With only the keyfile, the day the OS disk dies is
// the day 130TB becomes noise -- and it will not announce itself, because the array will serve happily right up
// until the moment it cannot.
export async function assertRecoverable(partitionPath: string): Promise<void> {
    const slots = await keyslotCount(partitionPath);

    if (slots < 2)
        throw new LuksError(
            `refusing to bring ${partitionPath} into service encrypted: it has ${slots < 0 ? 'an unreadable' : slots} `
            + `keyslot(s), and a keyfile-only volume DIES WITH THE OS DISK. Add a recovery passphrase `
            + `(cryptsetup luksAddKey), write it down somewhere that is not this machine, and try again. There is `
            + `no undo for getting this wrong.`,
            'no-key');
}

// Back up the LUKS header (~16MB). A corrupt header costs one disk, which 4+2 already survives -- so this is
// insurance, not a critical path. Store it off-box.
export async function backupHeader(partitionPath: string, to: string): Promise<void> {
    const { code, stdout } = await spawnHelper('cryptsetup',
        ['luksHeaderBackup', partitionPath, '--header-backup-file', to]);

    if (code !== 0)
        throw new LuksError(`could not back up the LUKS header of ${partitionPath}: ${(stdout ?? '').trim()}`,
            'failed');
}

// ---------------------------------------------------------------------------------------------------------
// THE NAMEPLATE -- how a LOCKED disk says who it is.
//
// A LUKS volume's `.identity` and `.bootstrap.json` live INSIDE the encrypted filesystem, so a locked disk can
// tell you nothing. The answer is not a second partition -- it is 26 characters in a field that already exists
// and is already empty.
//
// The disks are GPT and the partition-NAME field is unused (it currently reads "primary", parted's default).
// It holds 36 characters, lives in the partition table OUTSIDE the LUKS container, and is readable with no
// mount, no unlock and no cryptsetup:
//
//     strubs-<first 16 hex of the instance identity>-<volume id>
//     strubs-3f9a1b2c5d6e7f80-13
//
// Verified on a loopback LUKS disk: sgdisk writes it, lsblk/blkid read it back, PARTUUID is unchanged, and the
// LUKS payload is intact. It is NON-DESTRUCTIVE and can be applied to the existing fleet in place -- no drain,
// no repartition, no data movement.
//
// ADVISORY, NEVER AUTHORITATIVE. `.identity` inside the filesystem remains the real check. A stale or wrong
// nameplate cannot corrupt anything: worst case it mis-advertises and the real validation rejects it. Same
// philosophy as the syslog watcher -- a hint that triggers a look, never a conclusion.
//
// Use HYPHENS, not colons: `sgdisk -c` takes `partnum:name`, so a colon in the name is eaten as a delimiter and
// the name is silently truncated.
// ---------------------------------------------------------------------------------------------------------

// NORMALISE FIRST. The instance identity on this array is a HYPHENATED UUID
// (`2fb05f23-1d5e-4c00-bb71-f3109b42476c`), and slicing the raw string would put hyphens in the middle of the
// nameplate -- `strubs-2fb05f23-1d5e-4-12` -- which parseNameplate() below then refuses, because it expects 16
// hex characters. The plate would be written to every encrypted disk and read back by nobody: the locked-disk
// identification this whole mechanism exists for, silently dead.
//
// Same normalisation the identity guard itself uses (config.normalizeIdentity): strip non-hex, lowercase.
export const nameplateFor = (instanceIdentity: string, volumeId: number): string =>
    `strubs-${instanceIdentity.replace(/[^0-9a-f]/gi, '').toLowerCase().slice(0, 16)}-${volumeId}`;

export function parseNameplate(label: string | null | undefined): { identity: string; volumeId: number } | null {
    const m = /^strubs-([0-9a-f]{16})-(\d+)$/i.exec((label ?? '').trim());
    return m ? { identity: m[1].toLowerCase(), volumeId: Number(m[2]) } : null;
}

// Stamp the nameplate onto a GPT partition. Non-destructive: it rewrites the partition NAME field and nothing
// else -- the payload, the PARTUUID and the LUKS header are untouched.
export async function writeNameplate(
    diskPath: string, partitionNumber: number, instanceIdentity: string, volumeId: number
): Promise<void> {
    const name = nameplateFor(instanceIdentity, volumeId);

    const { code, stdout } = await spawnHelper('sgdisk', ['-c', `${partitionNumber}:${name}`, diskPath]);

    if (code !== 0) {
        // A nameplate that will not write is a disk that will be harder to identify while locked. It is NOT a
        // reason to fail the volume: the nameplate is advisory, and `.identity` inside the filesystem is what
        // actually decides. Say so and carry on.
        log.error('could not write the nameplate "%s" to %s partition %d (%s). The volume still works -- the '
            + 'nameplate is only how a LOCKED disk announces itself -- but this one will not.',
            name, diskPath, partitionNumber, (stdout ?? '').trim() || `sgdisk exit ${code}`);
        return;
    }

    log('nameplate "%s" written to %s partition %d', name, diskPath, partitionNumber);
}

// Read the nameplate back off the partition table and confirm it is the one we meant to write. `sgdisk -c`
// can fail in ways that still exit 0, and on an encrypted volume the plate is load-bearing -- so we look,
// rather than trust.
export async function nameplateIsPresent(
    diskPath: string, partitionNumber: number, instanceIdentity: string, volumeId: number
): Promise<boolean> {
    const { code, stdout } = await spawnHelper('sgdisk', ['-i', String(partitionNumber), diskPath]);
    if (code !== 0)
        return false;

    // sgdisk -i prints: `Partition name: 'strubs-2fb05f231d5e4c00-57'`
    const match = /Partition name:\s*'([^']*)'/i.exec(stdout ?? '');
    const plate = parseNameplate(match?.[1]);
    const expected = parseNameplate(nameplateFor(instanceIdentity, volumeId));

    return Boolean(plate && expected
        && plate.identity === expected.identity
        && plate.volumeId === expected.volumeId);
}

// ---------------------------------------------------------------------------------------------------------
// WHICH ENCRYPTED DISKS DOES THIS ARRAY ACTUALLY HAVE? -- asked of the PLATTERS, not of the database.
//
// The fleet-passphrase guard has to check a new passphrase against every encrypted disk we already own. An
// earlier version got that list from `ioManager.getVolumeEntries()` -- i.e. from MONGO -- which quietly made
// the whole check conditional on the database being right:
//
//   restore an older snapshot, or a volume table that predates the conversion, and the encrypted disks in the
//   rack are simply INVISIBLE. The guard then sees "no encrypted volumes", takes the verifier-only path, and
//   happily records a brand-new passphrase -- splitting the fleet exactly as before, one layer further out.
//
// "The disks are authoritative" cannot mean "the disks are authoritative once Mongo admits they exist". So we
// enumerate them by walking the block devices and reading the NAMEPLATE off the partition table -- which needs
// no key, no mount, and no database.
//
// Three outcomes, and the third is the one that matters:
//   ours     -- nameplate names THIS instance. It must open with the fleet passphrase.
//   foreign  -- nameplate names a different STRUBS instance. Not ours; ignore it.
//   unknown  -- a LUKS container with no readable nameplate. We CANNOT TELL. It might be one of ours whose
//               plate never got written, and treating it as "not ours" is the fail-open that started all this.
//               So it is surfaced, and the caller refuses. (Encrypted provisioning REQUIRES the nameplate to
//               land, so one of ours should never be in this state.)
// ---------------------------------------------------------------------------------------------------------
// PATHS RENUMBER. VOLUME IDS DO NOT.
//
// These are USB disks: /dev/sdf1 becomes /dev/sdg1 when one drops and the bus re-enumerates -- that is the
// vol-57 case, and it has already bitten this system once. So anything we RECORD about a disk (an audit result,
// say, that a later encryption will rely on) must be keyed by something stable. The nameplate carries the
// volume id, so we carry it too.
export type EncryptedDisk = {
    path: string;
    volumeId: number;


    // THE LUKS CONTAINER'S OWN UUID -- and it is a different thing from the volume id, on purpose.
    //
    // The volume id survives a CONVERSION: drain volume 12, wipe it, re-encrypt it, and it is volume 12 again,
    // with a brand-new LUKS header and potentially a different passphrase. An audit keyed only on the id would
    // still claim to have "proven volume 12" -- vouching for a header it has never seen, and handing out the
    // one-disk shortcut on the strength of it.
    //
    // luksFormat mints a fresh container uuid every time, so this identifies the HEADER, which is the thing the
    // passphrase actually opens. (lsblk reports it as the partition's uuid on a crypto_LUKS partition.)
    luksUuid: string | null;
};

export type EncryptedDisks = {
    ours: EncryptedDisk[];
    unknown: string[];
};

export async function findEncryptedPartitions(
    instanceIdentity: string | null,
    list: typeof listRawBlockDevices = listRawBlockDevices
): Promise<EncryptedDisks> {
    const ours: EncryptedDisk[] = [];
    const unknown: string[] = [];
    const mine = normaliseIdentity(instanceIdentity ?? '');

    for (const device of await list()) {
        for (const child of device.children ?? []) {
            const path = child.path ?? `/dev/${child.name}`;

            if (!await isLuksPartition(child, path))
                continue;

            const plate = parseNameplate(child.partlabel);

            if (!plate) {
                unknown.push(path);
                continue;
            }

            // The plate carries only the first 16 hex characters of the identity, so compare on that.
            if (mine && plate.identity === mine.slice(0, 16))
                ours.push({ path, volumeId: plate.volumeId, luksUuid: child.uuid ?? null });
            // else: it names another STRUBS instance. Positively not ours.
        }
    }

    return { ours, unknown };
}

const normaliseIdentity = (identity: string): string => identity.replace(/[^0-9a-f]/gi, '').toLowerCase();

// IS THIS A LUKS CONTAINER? -- AND "lsblk DID NOT SAY" IS NOT "NO".
//
// Filtering on `fstype === 'crypto_LUKS'` alone reintroduces the oldest fail-open in this codebase, in the
// newest guard: lsblk reports fstype null for a genuinely blank partition AND for one whose superblock it
// could not read. One of our encrypted disks in that state would be neither `ours` nor `unknown` -- it would
// be INVISIBLE, and the next encryption would never test its passphrase against it.
//
// classifyPartition() is the one place that answers this question, for this guard, the wipe guard, and the
// bootstrap scan alike. An unreadable partition comes back as LUKS here -- i.e. it lands in `unknown` and
// blocks encryption -- because a disk we cannot read is not a disk we may assume is harmless.
async function isLuksPartition(child: RawBlockDeviceChild, path: string): Promise<boolean> {
    const kind = await classifyPartition(child.fstype, path);

    if (kind.kind === 'unreadable') {
        log.error('could not establish what is on %s (%s). Treating it as an unidentified LUKS container: a '
            + 'partition we cannot read is not a partition we may assume is harmless.', path, kind.reason);
        return true;
    }

    return kind.kind === 'luks';
}
