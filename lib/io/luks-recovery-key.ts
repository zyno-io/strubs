import { argon2, createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'crypto';

import { config } from '../config';
import { database } from '../database';
import { HttpBadRequestError } from '../server/http/errors';
import { listRawBlockDevices } from './device-discovery';
import {
    addPassphrase,
    containerUuid,
    findEncryptedPartitions,
    readKeyfile,
    removePassphrase,
    testPassphrase,
    type EncryptedDisk
} from './luks';
import { ioManager } from './manager';
import { createLogger } from '../log';

const log = createLogger('luks-recovery-key');

// THE FLEET RECOVERY PASSPHRASE -- and who decides what it is.
//
// Every encrypted volume carries two LUKS keyslots: the KEYFILE (unattended boot; lives on the OS disk) and a
// PASSPHRASE (disaster recovery -- the OS disk is gone, and this is how you get back in).
//
// THE KEYFILE IS THE AUTHORITY, AND THAT CHANGES EVERYTHING.
//
// An earlier version of this file went to enormous lengths to DISCOVER the fleet passphrase from the platters:
// testing candidates against every LUKS header, fingerprinting keyslot areas to detect tampering, refusing to
// trust its own database. It was wrong, and wrong in an interesting way -- it treated the passphrase as a fact
// about the disks that we could only observe.
//
// It is not. We hold the keyfile, and the keyfile opens every disk in the fleet. So the passphrase is a fact we
// ENFORCE, not one we discover: to make it P, write P into every disk's second keyslot, authenticating with the
// keyfile. There is nothing to detect and nothing to reconcile, because there is nothing we cannot simply fix.
//
// That collapses the whole problem:
//
//   Validation  -- an argon2id hash in runtimeConfig. Local, ~350ms, no disk I/O at all.
//   Rotation    -- PUT /$/encryption/passphrase writes the new passphrase to EVERY encrypted disk, and does not
//                  finish until every one of them has it.
//   Drift       -- an admin who hand-runs `cryptsetup luksKillSlot` can equally `dd` over the header. We are no
//                  more immune to a hostile root than any other component of this system, and pretending
//                  otherwise bought nothing but complexity. If somebody does mangle a keyslot, the remedy is to
//                  re-run the rotation, which rewrites it from the keyfile.
//
// WHAT THE HASH DOES NOT WEAKEN. It lives in MongoDB on the OS disk, never on the platters. Someone holding a
// stolen STRUBS disk has ciphertext and nothing else. And anyone who has the OS disk already has the KEYFILE,
// which opens every volume outright without troubling the passphrase at all. The hash gives an attacker nothing
// they did not already have.
//
// The passphrase itself is NEVER stored, logged, journalled, or written to a nameplate. Only the hash.
export const RECOVERY_VERIFIER_KEY = 'luksRecoveryVerifier';

// The last time the passphrase was PROVEN against the platters (see auditRecoveryKey). Not load-bearing -- the
// keyfile is -- but it is how an operator knows the disks really do open, before the day they must.
export const RECOVERY_AUDIT_KEY = 'luksRecoveryAudit';

// ---------------------------------------------------------------------------------------------------------
// THE SEALED COPY -- why STRUBS keeps a passphrase it could otherwise merely verify.
//
// A hash proves a passphrase. It cannot PRODUCE one, and LUKS needs the actual bytes to write a keyslot. So an
// array whose only record of the passphrase is a hash must ask a human for it every single time it encrypts a
// disk -- which made `encryptNewVolumes` a lie: the setting says "encrypt disks added from now on", but the
// provisioner had nobody to ask, so an automatic provision with the setting ON simply failed.
//
// So we keep the passphrase, sealed with the keyfile (AES-256-GCM, key derived from the keyfile via HKDF).
//
// THIS GIVES AN ATTACKER NOTHING. To open the seal you need the keyfile -- and the keyfile ALREADY OPENS EVERY
// DISK IN THE FLEET, outright, without troubling the passphrase at all. Anyone who can read this blob can read
// `/var/lib/strubs/luks.key` sitting next to it, and would not bother with either: they would just mount the
// disks. The seal is strictly weaker than what it sits beside, so it widens nothing.
//
// What it costs is honesty about one thing: the recovery passphrase is now recoverable BY THE MACHINE while the
// machine is intact. That was already true -- the keyfile could always open everything. The passphrase exists
// for the case where the machine is NOT intact, and in that case the seal is gone with it, and you type the
// passphrase from your safe. Nothing about that changes.
//
// ⚠️ AND THE SEAL IS NEVER TRUSTED ON ITS OWN. Whatever comes out of it is checked against the argon2 hash --
// the authority -- before it is allowed near a disk. A seal that disagrees with the hash (a rotation that
// crashed between the two writes, a keyfile restored from a different backup) is REFUSED, not used. A stale
// passphrase written into a new disk's keyslot is exactly the split fleet this whole file exists to prevent.
export const RECOVERY_SEALED_KEY = 'luksRecoverySealed';

type Sealed = { v: 1; salt: string; iv: string; tag: string; ct: string };

const isSealed = (v: unknown): v is Sealed => {
    const s = v as Sealed | null;
    return Boolean(s && s.v === 1 && typeof s.salt === 'string' && typeof s.iv === 'string'
        && typeof s.tag === 'string' && typeof s.ct === 'string');
};

const sealKey = (keyfile: Buffer, salt: Buffer): Buffer =>
    Buffer.from(hkdfSync('sha256', keyfile, salt, 'strubs-luks-recovery-passphrase', 32));

function seal(passphrase: string, keyfile: Buffer): Sealed {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', sealKey(keyfile, salt), iv);
    const ct = Buffer.concat([cipher.update(passphrase, 'utf8'), cipher.final()]);
    return {
        v: 1,
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ct: ct.toString('base64')
    };
}

function unseal(sealed: Sealed, keyfile: Buffer): string | null {
    try {
        const decipher = createDecipheriv(
            'aes-256-gcm', sealKey(keyfile, Buffer.from(sealed.salt, 'base64')), Buffer.from(sealed.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
        return Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()]).toString('utf8');
    }
    catch {
        // A DIFFERENT KEYFILE. The tag did not verify, so this blob was sealed by a key we no longer hold --
        // an OS disk restored from a backup older than the last keyfile, most likely. Not an error to throw at
        // the caller: it means "we do not know the passphrase", which is a thing the caller must handle anyway.
        return null;
    }
}

// THE PASSPHRASE, IF WE HONESTLY KNOW IT. Null means "ask a human" -- never a guess.
//
// Every path out of here that returns a string has proven that string against the argon2 hash first.
export async function sealedRecoveryPassphrase(overrides: Partial<RecoveryKeyDeps> = {}): Promise<string | null> {
    const deps = { ...defaultDeps, ...overrides };

    const verifier = await getVerifier(deps);
    if (!verifier) return null;                       // no passphrase has ever been set

    const stored = await deps.database.getRuntimeConfig(RECOVERY_SEALED_KEY);
    if (!isSealed(stored)) return null;               // set before we kept a sealed copy, or never sealed

    const keyfile = await deps.readKeyfile();
    if (!keyfile) return null;                        // no keyfile: nothing to encrypt with anyway

    const passphrase = unseal(stored, keyfile);
    if (passphrase === null) {
        log.error('the sealed recovery passphrase does not open with this keyfile -- ignoring it. Set the '
            + 'recovery passphrase again to re-seal it.');
        return null;
    }

    // ⚠️ THE AUTHORITY IS THE HASH, NOT THE SEAL. If a rotation crashed between recording the hash and
    // re-sealing, this blob holds the PREVIOUS passphrase -- and writing that into a new disk's keyslot would
    // hand us a disk the recorded passphrase does not open. Refuse.
    if (!await verify(passphrase, verifier)) {
        log.error('the sealed recovery passphrase does not match the recorded one -- ignoring it. A passphrase '
            + 'change probably did not finish. Set the recovery passphrase again.');
        return null;
    }

    return passphrase;
}

// Keep the sealed copy in step with the hash. Best-effort by design: failing to seal must never fail the
// operation that set the passphrase, because the passphrase itself is already safely on the disks.
async function reseal(passphrase: string, deps: RecoveryKeyDeps): Promise<void> {
    try {
        const keyfile = await deps.readKeyfile();
        if (!keyfile) return;
        await deps.database.setRuntimeConfig(RECOVERY_SEALED_KEY, seal(passphrase, keyfile));
    }
    catch (err) {
        log.error('failed to seal the recovery passphrase: %s', err instanceof Error ? err.message : String(err));
    }
}


// argon2id, built into Node 24 -- no native dependency, which this codebase deliberately avoids. 64 MiB and
// three passes measures ~350ms on this host: slow enough that the hash is worth nobody's time to attack, fast
// enough to sit in front of a provision. (The rest of the system uses scrypt for the same no-native-deps reason;
// argon2 is available now and is the better primitive, so new code uses it.)
const ARGON2 = { memory: 65_536, passes: 3, parallelism: 1, tagLength: 32 } as const;

type Verifier = { algorithm: 'argon2id'; nonce: string; tag: string; setAt: string };

const isVerifier = (value: unknown): value is Verifier => {
    const v = value as Verifier | null;
    return Boolean(v && v.algorithm === 'argon2id' && typeof v.nonce === 'string' && typeof v.tag === 'string');
};

const derive = (passphrase: string, nonce: Buffer): Promise<Buffer> =>
    new Promise((resolve, reject) => {
        (argon2 as unknown as (
            algorithm: string,
            options: Record<string, unknown>,
            callback: (err: Error | null, tag: ArrayBuffer) => void
        ) => void)('argon2id', { message: passphrase, nonce, ...ARGON2 },
            (err, tag) => err ? reject(err) : resolve(Buffer.from(tag)));
    });

const hash = async (passphrase: string): Promise<Verifier> => {
    const nonce = randomBytes(16);
    return {
        algorithm: 'argon2id',
        nonce: nonce.toString('hex'),
        tag: (await derive(passphrase, nonce)).toString('hex'),
        setAt: new Date().toISOString()
    };
};

const verify = async (passphrase: string, verifier: Verifier): Promise<boolean> => {
    const expected = Buffer.from(verifier.tag, 'hex');
    const actual = await derive(passphrase, Buffer.from(verifier.nonce, 'hex'));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
};

export type RecoveryKeyDeps = {
    database: Pick<typeof database, 'getRuntimeConfig' | 'setRuntimeConfig' | 'setRuntimeConfigIfAbsent'
        | 'runtimeConfigKeyIsUnique'>;

    // ⚠️ ONE SNAPSHOT OF THE DISKS, ANSWERING ALL THREE QUESTIONS AT ONCE.
    //
    // Which encrypted disks are ours, which are unidentifiable, and which volumes are missing -- taken from a
    // SINGLE enumeration of the block devices. Two separate listings is a race, and on this array it is not a
    // theoretical one: these are USB disks and they flap.
    //
    // Encrypted volume 12 is absent during the first listing (so it is not in `ours`) and back before the second
    // (so it is not reported absent either). It falls through BOTH guards: the rotation rewrites every disk it
    // saw, records the new hash, and volume 12 keeps the old passphrase with nothing to say so.
    scanFleet: () => Promise<FleetScan>;
    instanceIdentity: () => string | null;
    addPassphrase: typeof addPassphrase;
    removePassphrase: typeof removePassphrase;
    testPassphrase: typeof testPassphrase;

    // The LUKS header's own uuid, read from whatever is at that path RIGHT NOW. A path is not an identity.
    containerUuid: typeof containerUuid;

    readKeyfile: typeof readKeyfile;
};

export type FleetScan = {
    ours: EncryptedDisk[];      // encrypted disks carrying THIS instance's nameplate
    unknown: string[];          // LUKS containers with no readable nameplate
    absent: number[];           // volumes the fleet knows about whose disk is not attached
};

const defaultDeps: RecoveryKeyDeps = {
    database,
    scanFleet: () => scanFleet(),
    instanceIdentity: () => config.identity,
    addPassphrase,
    removePassphrase,
    testPassphrase,
    containerUuid,
    readKeyfile
};

// IS THIS ONE VOLUME'S DISK IN THE MACHINE? -- asked directly, about a volume that may be soft-deleted.
//
// `scanFleet()` cannot answer this: `absentVolumeIds()` filters DELETED volumes out of its list (they are
// retired, and must not block a rotation). So asking it "is the deleted volume 12 absent?" always answers no --
// which made the undelete guard dead code, and a test that mocked `absent: [15]` was modelling a state the real
// code cannot produce. The test agreed with me instead of with the machine.
//
// So ask about the disk itself.
export async function volumeDiskIsAttached(
    partitionUuid: string | null,
    list: typeof listRawBlockDevices = listRawBlockDevices
): Promise<boolean> {
    if (!partitionUuid)
        return false;   // no way to look for it => we cannot say it is here

    for (const device of await list())
        for (const child of device.children ?? [])
            if (child.uuid === partitionUuid)
                return true;

    return false;
}

// The single enumeration. Everything that decides whether a rotation is safe comes out of THIS list -- so a disk
// cannot be absent for one question and present for the next.
export async function scanFleet(
    identity: string | null = config.identity,
    volumes: Array<{ id: number; partitionUuid: string | null; isDeleted: boolean }> =
        ioManager.getVolumeEntries().map(([id, volume]) => ({
            id, partitionUuid: volume.partitionUuid, isDeleted: volume.isDeleted
        })),
    list: typeof listRawBlockDevices = listRawBlockDevices
): Promise<FleetScan> {
    const devices = await list();
    const snapshot = async () => devices;   // ...and every question is asked of the SAME one

    const { ours, unknown } = await findEncryptedPartitions(identity, snapshot);
    const absent = await absentVolumeIds(volumes, snapshot);

    return { ours, unknown, absent };
}

const MIN_LENGTH = 12;

// NO IDENTITY MEANS WE CANNOT RECOGNISE OUR OWN DISKS -- SO WE MAY NOT TOUCH THE KEYS.
//
// In RECOVERY mode `config.identity` is null, and the whole encrypted-disk enumeration is keyed on it: a disk's
// nameplate is compared against our identity to decide whether it is ours. With no identity, our own encrypted
// disks are classified as NEITHER ours NOR unknown -- they simply vanish from the scan.
//
// A passphrase operation would then see an empty fleet, take the "nothing is encrypted yet" branch, and write a
// verifier into Mongo that no disk in the rack has ever heard of. After the fleet is recovered, encryption would
// trust that verifier -- locally, by design -- and happily build new disks on a passphrase that opens none of
// the old ones.
//
// Provisioning is already refused during recovery for the same class of reason. So is this.
function assertIdentity(deps: RecoveryKeyDeps): void {
    if (deps.instanceIdentity() === null)
        throw new HttpBadRequestError(
            'the recovery passphrase cannot be set, changed, or audited while this array has no instance identity '
            + '(it is in RECOVERY mode). Without it we cannot tell our own encrypted disks from a stranger\'s, so '
            + 'anything we recorded now could be a passphrase that opens none of them. Restore the instance '
            + 'identity first.'
        );
}

// WHICH VOLUMES EXIST BUT ARE NOT PLUGGED IN? -- ASKED OF THE PLATTERS, NOT OF A CACHED FLAG.
//
// This decides whether a passphrase rotation is safe to run, so it has to be right: a volume it fails to report
// as absent is a volume that misses the rotation and keeps the OLD passphrase, silently, discoverable only on
// the day the keyfile is gone.
//
// The obvious implementation -- `volume.isPresent` -- is WRONG, and wrong in a way that only shows up on the
// paths that matter. `isPresent` is a belief maintained by VolumeFleet.reconcile(), and reconcile deliberately
// SKIPS volumes that are deleted, disabled, or DRAINING before it can mark them missing. So an encrypted volume
// that was bound, then pulled while draining -- which is precisely the sequence an operator follows to retire a
// disk -- keeps `isPresent: true` forever. Rotation would look straight at it and see nothing wrong.
//
// So we do what the rest of this system does when the answer matters: we look at the disks. A volume is present
// if a partition carrying its uuid is attached to this machine, and absent otherwise. No cache, no flag, no
// belief.
//
// Fails CLOSED. If we cannot enumerate the block devices at all, we cannot say which volumes are missing -- and
// "I could not tell" is not permission to rewrite the keys of a 130TB array.
export async function absentVolumeIds(
    volumes: Array<{ id: number; partitionUuid: string | null; isDeleted: boolean }>,
    list: typeof listRawBlockDevices = listRawBlockDevices
): Promise<number[]> {
    const devices = await list();

    const attached = new Set<string>();
    for (const device of devices)
        for (const child of device.children ?? [])
            if (child.uuid)
                attached.add(child.uuid);

    return volumes
        .filter(volume => !volume.isDeleted)
        // No partition uuid at all means we have no way to look for its disk -- so we cannot say it is here.
        .filter(volume => !volume.partitionUuid || !attached.has(volume.partitionUuid))
        .map(volume => volume.id);
}

// ---------------------------------------------------------------------------------------------------------
// ROTATION AND ENCRYPTION MUST NOT OVERLAP.
//
// The two operations disagree about what the fleet passphrase IS, and each is right for a moment:
//
//   A rotation reads the fleet, writes NEW to every disk it saw, then records NEW.
//   An encryption reads the recorded passphrase (still OLD), formats a disk, and writes OLD into it.
//
// Interleave them and the new disk is created with OLD -- after the rotation has finished and recorded NEW.
// Nothing is wrong on the disk; nothing is wrong in the database; and the volume is simply not openable with the
// passphrase in the safe. It would surface on the day the OS disk dies, which is the only day it must not.
//
// STRUBS is one process on one host, so a plain in-process gate is the whole answer -- no distributed anything.
// Rotation waits for encryptions in flight and blocks new ones; an encryption during a rotation is refused
// rather than queued, because a provision takes minutes and the operator would rather be told.
// ---------------------------------------------------------------------------------------------------------
let rotating = false;
let encryptionsInFlight = 0;

// Wraps anything that CHANGES WHICH DISKS THE FLEET EXPECTS TO BE ENCRYPTED, and therefore must not straddle a
// rotation:
//
//   - an encrypted PROVISION or CONVERSION (the keyslot is written long after the passphrase check, and it is
//     the WRITE that must not straddle a rotation);
//   - a DELETE or UNDELETE of a volume (rotation only walks volumes that are not deleted -- so a volume that
//     changes deleted-ness mid-rotation is one the rotation may reach, or may skip, depending on nothing more
//     than timing).
//
// That second case is subtle and it is real: `scanFleet()` snapshots the volume list, then enumerates the disks.
// An undelete landing in that window makes volume 12 active again while the rotation's snapshot still says it is
// deleted -- so the rotation skips it, records the new passphrase, and volume 12 is back in service holding a
// key nobody has. Nothing in normal service would notice, because STRUBS mounts with the keyfile.
export async function withEncryptionSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (rotating)
        throw new HttpBadRequestError(
            'the fleet recovery passphrase is being changed right now. Encrypting a volume during a rotation '
            + 'would write the OLD passphrase into a disk the rotation has already passed by. Try again in a '
            + 'moment.'
        );

    encryptionsInFlight++;
    try {
        return await fn();
    }
    finally {
        encryptionsInFlight--;
    }
}

async function withRotationSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (rotating)
        throw new HttpBadRequestError('a recovery passphrase change is already in progress.');

    if (encryptionsInFlight > 0)
        throw new HttpBadRequestError(
            `refusing to change the recovery passphrase while ${encryptionsInFlight} volume(s) are being `
            + `encrypted: the new disk would be written with the OLD passphrase and then left behind. Wait for `
            + `them to finish and try again.`
        );

    rotating = true;
    try {
        return await fn();
    }
    finally {
        rotating = false;
    }
}

async function getVerifier(deps: RecoveryKeyDeps): Promise<Verifier | null> {
    const stored = await deps.database.getRuntimeConfig(RECOVERY_VERIFIER_KEY);
    return isVerifier(stored) ? stored : null;
}

export async function hasRecoveryPassphrase(overrides: Partial<RecoveryKeyDeps> = {}): Promise<boolean> {
    return await getVerifier({ ...defaultDeps, ...overrides }) !== null;
}

// THE CHECK THAT GATES AN ENCRYPTION. Local, and that is the entire point.
//
// The passphrase we are given must be the one we recorded. It does not need to be re-derived from the disks,
// because the disks were WRITTEN with it -- by us, using the keyfile -- and they cannot be carrying a different
// one unless somebody with root went behind our back, which is not a threat model anything here can defend.
export async function assertFleetRecoveryPassphrase(
    passphrase: string, overrides: Partial<RecoveryKeyDeps> = {}
): Promise<void> {
    const deps = { ...defaultDeps, ...overrides };
    assertIdentity(deps);

    if (!passphrase || passphrase.length < MIN_LENGTH)
        throw new HttpBadRequestError(
            `a recovery passphrase of at least ${MIN_LENGTH} characters is required to encrypt a volume. This is `
            + `the only thing that can open these disks if the OS disk dies -- it is not a formality.`
        );

    const existing = await getVerifier(deps);

    if (existing) {
        if (!await verify(passphrase, existing))
            throw new HttpBadRequestError(
                'that is not this fleet\'s recovery passphrase. Encrypting a volume with a different one would '
                + 'leave you holding a key that opens some of your disks and not others -- and you would not find '
                + 'out which until you needed them. (To CHANGE the passphrase, use PUT /$/encryption/passphrase, '
                + 'which rewrites it on every disk.)'
            );

        // Proven correct against the hash, so it is safe to seal -- and this is the only moment an array that
        // predates the seal (or whose keyfile was restored under it) can get one without bothering anybody.
        if (await sealedRecoveryPassphrase(overrides) === null)
            await reseal(passphrase, deps);
        return;
    }

    // --- NO VERIFIER. Either this is the first encryption ever, or the database lost it. ---
    //
    // THOSE ARE NOT THE SAME THING, and treating them as one is how the fleet splits.
    //
    // Restore an older snapshot, rebuild Mongo, hand-delete the key: the verifier is gone while the encrypted
    // disks are still in the rack, all opening with a passphrase we no longer have a record of. If we let this
    // be "the first encryption" we would record a BRAND NEW passphrase, write it to the ONE new disk, and leave
    // every existing disk on the old one -- which nothing then knows.
    //
    // The keyfile makes the remedy easy, so we insist on it: rotate. `PUT /$/encryption/passphrase` writes the
    // passphrase to EVERY disk, which is exactly what makes the fleet consistent again.
    const { ours, unknown, absent } = await deps.scanFleet();

    // An unidentifiable LUKS container might be OURS, with a nameplate that never landed. Treating "no verifier"
    // as "first encryption ever" while one of those is attached would record a brand-new passphrase and leave
    // that disk behind on whatever it already has. Fail closed, exactly as the rotation does.
    if (unknown.length)
        throw new HttpBadRequestError(
            `refusing to encrypt: ${unknown.join(', ')} carries a LUKS container with no STRUBS nameplate, so we `
            + `cannot tell whether it is one of ours -- and there is no recovery passphrase on record to check it `
            + `against. Identify or detach it first.`
        );

    if (ours.length)
        throw new HttpBadRequestError(
            `this array already has ${ours.length} encrypted volume(s), but there is no recovery passphrase on `
            + `record -- the database has most likely been restored or rebuilt. Refusing to encrypt: recording a `
            + `new passphrase now would put it on the new disk alone and leave the existing ones on a passphrase `
            + `nothing knows. Set the passphrase first (PUT /$/encryption/passphrase), which writes it to EVERY `
            + `disk, and then encrypt.`
        );

    // ...AND AN ENCRYPTED DISK WE CANNOT SEE IS STILL AN ENCRYPTED DISK.
    //
    // The check above only looks at the disks that are ATTACHED. With no verifier, the record of which volumes
    // are encrypted is very likely gone too (they live in the same database and share its fate) -- so a volume
    // sitting unplugged in a drawer could be encrypted, and nothing left on this machine can tell us.
    //
    // Recording a brand-new passphrase now would establish it for the new disk alone, and that absent one would
    // come back later still holding the old key, with nothing to say so. Rotation already refuses this exact
    // situation; encryption must too, or the hole simply moves next door -- which is what happened when I fixed
    // it in only one of the two places.
    if (absent.length)
        throw new HttpBadRequestError(
            `refusing to encrypt: there is no recovery passphrase on record (the database was most likely restored `
            + `or rebuilt), and volume(s) ${absent.join(', ')} are not attached. Any one of them could already be `
            + `encrypted, and would be left behind on a passphrase nothing knows. Attach every disk, set the `
            + `passphrase (PUT /$/encryption/passphrase, which writes it to EVERY disk), and then encrypt.`
        );

    // THE FIRST ENCRYPTION EVER. This passphrase becomes the fleet's, which makes recording it the one moment a
    // race is unrecoverable: two callers, two passphrases, two disks, and only one of them written down.
    //
    // setIfAbsent is atomic ONLY because of the unique index on runtimeConfig.key. If that index could not be
    // created we do not have the guarantee, and we say so rather than pretending.
    if (!await deps.database.runtimeConfigKeyIsUnique())
        throw new HttpBadRequestError(
            'refusing to record the first recovery passphrase: the unique index on runtimeConfig.key is not in '
            + 'place, so two concurrent encryptions could each believe they were the first. The array is fine; '
            + 'fix the index (look for duplicate keys in runtimeConfig) and try again.'
        );

    if (!await deps.database.setRuntimeConfigIfAbsent(RECOVERY_VERIFIER_KEY, await hash(passphrase))) {
        // Somebody got there first, in the microseconds between our check and our write. Theirs is the fleet's.
        const winner = await getVerifier(deps);
        if (!winner || !await verify(passphrase, winner))
            throw new HttpBadRequestError('that is not this fleet\'s recovery passphrase.');
    }

    // Ours or theirs, this passphrase is now the fleet's and has been proven against the hash. Seal it, so the
    // NEXT disk does not have to ask a human -- which is the entire point of `encryptNewVolumes`.
    await reseal(passphrase, deps);
}

// ---------------------------------------------------------------------------------------------------------
// CHANGING THE PASSPHRASE -- possible precisely BECAUSE we hold the keyfile.
//
// Every disk's passphrase keyslot is rewritten. The ORDERING is the design, because a crash must never leave a
// disk that no known passphrase opens:
//
//   1. ADD the new passphrase to every disk (authenticating with the keyfile). Now both open everything.
//   2. Only once EVERY disk has it, record the new hash. Before this line the old passphrase is still the
//      fleet's; after it, the new one is. There is no instant at which the recorded passphrase opens nothing.
//   3. REMOVE the old passphrase from every disk.
//
// Crash at any point and at least one passphrase still opens every disk, and re-running the rotation finishes
// the job. The one outcome we will not risk is a disk whose keyslots we cannot open.
// ---------------------------------------------------------------------------------------------------------
export type PassphraseRotation = {
    volumes: number[];
    rotatedAt: string;
};

export async function setFleetRecoveryPassphrase(
    next: string, current: string | undefined, overrides: Partial<RecoveryKeyDeps> = {}
): Promise<PassphraseRotation> {
    return withRotationSlot(() => rotate(next, current, overrides));
}

async function rotate(
    next: string, current: string | undefined, overrides: Partial<RecoveryKeyDeps>
): Promise<PassphraseRotation> {
    const deps = { ...defaultDeps, ...overrides };
    assertIdentity(deps);

    if (!next || next.length < MIN_LENGTH)
        throw new HttpBadRequestError(`the new recovery passphrase must be at least ${MIN_LENGTH} characters.`);

    // ⚠️ ROTATING TO THE SAME PASSPHRASE WOULD STRIP IT FROM EVERY DISK.
    //
    // The add is idempotent (it skips a disk that already opens with `next`), and the retire step then removes
    // the slot that `current` opens. If next === current those are THE SAME KEYSLOT: nothing is added, and the
    // one recovery keyslot on every disk in the fleet is deleted. The array would be left KEYFILE-ONLY -- which
    // is the precise unrecoverable state that the two-keyslot rule, assertRecoverable(), and half this file
    // exist to make impossible.
    //
    // It is also a no-op the operator plainly did not intend. Refuse it before a single disk is touched.
    if (current && next === current)
        throw new HttpBadRequestError(
            'the new recovery passphrase is the same as the current one. Nothing to do -- and doing it would '
            + 'remove the passphrase keyslot from every disk in the fleet, leaving them openable only by the '
            + 'keyfile.'
        );

    const existing = await getVerifier(deps);

    // Changing it requires knowing it -- not because the disks demand that (the keyfile would let us rewrite
    // them regardless) but because an operator who cannot produce the current passphrase is an operator who is
    // about to discover that the one in the safe is worthless. Better they discover it now.
    if (existing) {
        if (!current)
            throw new HttpBadRequestError('the current recovery passphrase is required to change it.');
        if (!await verify(current, existing))
            throw new HttpBadRequestError('the current recovery passphrase is not correct.');
    }

    // ONE SNAPSHOT, THREE ANSWERS. `ours`, `unknown` and `absent` all come from the SAME enumeration of the block
    // devices -- because two listings is a race, and these are USB disks that flap. A volume absent during the
    // first listing and back before the second would fall through BOTH guards: not in `ours`, so never rotated;
    // not reported absent, so never refused. It would keep the old passphrase with nothing left to say so.
    const { ours, unknown, absent: notHere } = await deps.scanFleet();

    if (unknown.length)
        throw new HttpBadRequestError(
            `refusing to change the passphrase while ${unknown.join(', ')} carries a LUKS container with no STRUBS `
            + `nameplate: we cannot tell whether it is one of ours, and so cannot say whether it would be left `
            + `behind on the old passphrase.`
        );

    // EVERY DISK MUST BE HERE. NOT "every disk we believe is encrypted" -- EVERY DISK.
    //
    // A rotation changes the passphrase. A volume whose disk is not attached cannot be rotated, so it keeps the
    // OLD one -- silently, because STRUBS mounts with the keyfile and never touches that slot, and you find out
    // on the single day it matters.
    //
    // The clever version of this rule consulted `luksEncryptedVolumes` and refused only for the volumes it
    // believed were encrypted. It produced a defect in every review round, and the reason is structural: THAT
    // RECORD LIVES IN THE SAME DATABASE AS EVERYTHING ELSE WE LOST. Restore an old snapshot and it is gone or
    // partial; let an audit repopulate it from the disks that happen to be plugged in and it is CONFIDENTLY
    // partial, which is worse. Every fix moved the hole somewhere else.
    //
    // So: no record, no inference, no cleverness. If a volume of this fleet is not in front of us, we cannot
    // rotate its keys, and we will not rewrite the fleet's passphrase behind its back. Attach every disk.
    //
    // The cost is an operator plugging their drives in before changing a passphrase -- which they must do for
    // the operation to be CORRECT anyway. The benefit is that this entire class of bug stops existing.
    if (notHere.length)
        throw new HttpBadRequestError(
            `refusing to change the recovery passphrase: volume(s) ${notHere.join(', ')} are not attached. A disk `
            + `that is not here cannot be rotated, so it would keep the OLD passphrase -- and nothing in normal `
            + `service would ever tell you, because STRUBS unlocks with the keyfile. Attach every disk and try `
            + `again. (We do not try to guess which of them are encrypted: that guess has been wrong every time.)`
        );

    if (!ours.length) {
        // Nothing is encrypted yet, so there is no keyslot to rewrite: this simply records the passphrase that
        // the next encryption will use.
        await deps.database.setRuntimeConfig(RECOVERY_VERIFIER_KEY, await hash(next));
        await reseal(next, deps);
        log('the fleet recovery passphrase was set. No volume is encrypted yet, so no keyslot was changed.');
        return { volumes: [], rotatedAt: new Date().toISOString() };
    }

    // ⚠️ A PATH IS NOT AN IDENTITY. Prove each disk is still the one we scanned, immediately before writing.
    //
    // These are USB disks: /dev/sdf1 is whatever the kernel most recently decided to call the thing in that
    // slot, and it gets reused. We scanned the fleet, and we now spend ~3 seconds per disk deriving keys. In
    // that window the disk we scanned can drop and ANOTHER of our own encrypted disks can land on the same
    // path -- at which point `luksAddKey /dev/sdf1` succeeds, against the wrong header, the proof tests the
    // wrong header, and the volume we meant to rotate is never reached. It keeps the old passphrase, and the
    // verifier says otherwise.
    //
    // The container uuid is the identity of the HEADER. Check it, every time, right before we touch the keys.
    const assertStillTheSameDisk = async (disk: EncryptedDisk): Promise<void> => {
        const uuid = await deps.containerUuid(disk.path);

        if (!disk.luksUuid || uuid !== disk.luksUuid)
            throw new HttpBadRequestError(
                `refusing to touch the keys of ${disk.path}: it is no longer the disk we scanned (expected LUKS `
                + `container ${disk.luksUuid ?? 'unknown'}, found ${uuid ?? 'nothing readable'}). A disk moved `
                + `underneath this rotation. Nothing further has been changed -- the old passphrase still opens `
                + `every disk. Try again with the fleet settled.`
            );
    };

    // --- 1. ADD the new passphrase everywhere, authenticating with the keyfile. ---
    for (const disk of ours) {
        // BEFORE...
        await assertStillTheSameDisk(disk);

        // IDEMPOTENT, because a rotation that failed half-way WILL be re-run.
        //
        // `luksAddKey` does not de-duplicate: handing it a passphrase the disk already takes gives you a SECOND
        // keyslot holding the same key. A LUKS2 header has 32 of them, and a few failed rotations that each got
        // part-way through the fleet would quietly eat into that -- for no benefit, since the disk already
        // opens. So ask first, and only write when there is something to write.
        const alreadyOpens = await deps.testPassphrase(disk.path, next) === 'opens';

        // ...AND AFTER *EVERY* SLOW STEP -- including this one, and including the branch that does NOTHING.
        //
        // `testPassphrase` is argon2: about three seconds, during which the disk at this path can be swapped for
        // another of ours. If that replacement happens to already open with `next`, the idempotent skip below
        // fires -- and we `continue`, believing we have dealt with the disk we scanned, when we have not touched
        // it at all. It keeps the old passphrase; the rotation records the new one; and nothing says otherwise.
        //
        // The "do nothing" path needs the guard MORE than the write path does, not less: a write that lands on
        // the wrong disk at least leaves evidence. A skip leaves none.
        await assertStillTheSameDisk(disk);

        if (alreadyOpens) {
            log('volume%d: already opens with the new passphrase; nothing to do', disk.volumeId);
            continue;
        }

        await deps.addPassphrase(disk.path, next);

        // The uuid check is not atomic with the write -- the disk could swap in the microseconds between them.
        // Checking again afterwards does not make it atomic either, but it turns "we wrote a key into the wrong
        // disk and never noticed" into "we wrote a key into the wrong disk and stopped dead", which is the
        // difference between a silent split and a loud one. Closing the last of the window needs an open device
        // handle rather than a re-opened path, and is not worth that here.
        await assertStillTheSameDisk(disk);

        // Prove it took, on this disk, before moving on. `luksAddKey` returning success is not the same thing as
        // the passphrase opening the header, and the difference matters on the one key that has no undo.
        if (await deps.testPassphrase(disk.path, next) !== 'opens')
            throw new HttpBadRequestError(
                `the new passphrase was written to volume ${disk.volumeId} (${disk.path}) but does not open it. `
                + `Stopping here. The OLD passphrase still opens every disk in this fleet and nothing has been `
                + `recorded, so nothing is lost -- but investigate that disk.`
            );

        log('volume%d: the new recovery passphrase was added', disk.volumeId);
    }

    // --- 2. Every disk has it. NOW it is the fleet's passphrase. ---
    await deps.database.setRuntimeConfig(RECOVERY_VERIFIER_KEY, await hash(next));

    // Re-seal straight away. Crash in the gap between these two writes and the seal still holds the OLD
    // passphrase -- which is why nothing is ever allowed to USE the seal without checking it against the hash
    // first. It fails closed: STRUBS asks a human instead of writing a stale passphrase onto a fresh disk.
    await reseal(next, deps);
    log('all %d encrypted volume(s) now open with the new recovery passphrase; it is recorded', ours.length);

    // --- 3. Retire the old one. Best-effort, deliberately. ---
    //
    // By this point the fleet is already correct: the new passphrase opens everything and is recorded. A stale
    // keyslot that will not die is untidy, not dangerous -- it is a second valid passphrase, which the operator
    // knows, on disks that already accept the one they will actually use. Failing the whole rotation over it
    // would be worse than saying so plainly.
    if (current) {
        for (const disk of ours) {
            await assertStillTheSameDisk(disk);

            try {
                await deps.removePassphrase(disk.path, current);
                log('volume%d: the old recovery passphrase was removed', disk.volumeId);
            }
            catch (err) {
                log.error('volume%d: the OLD recovery passphrase could not be removed (%s). The new one works and '
                    + 'is recorded, but the old one still opens this disk. Remove it by hand: '
                    + 'cryptsetup luksRemoveKey %s', disk.volumeId, err, disk.path);
            }

            // The removal was another slow step against a path. Prove the disk is still the one we scanned before
            // we draw any conclusion from what it now says.
            await assertStillTheSameDisk(disk);

            // AND CHECK WE DID NOT JUST DISARM THE DISK -- OUTSIDE the catch above, which exists to TOLERATE a
            // failed removal (a stale keyslot is untidy, not dangerous) and must not also swallow this.
            //
            // The same-passphrase guard should make this impossible. But "should" is not a word that belongs
            // anywhere near the only key that opens 130TB: if the disk no longer takes the new passphrase, the
            // removal took the wrong slot. Stop, loudly, while the rest of the fleet still has both keys.
            if (await deps.testPassphrase(disk.path, next) !== 'opens')
                throw new HttpBadRequestError(
                    `volume ${disk.volumeId} (${disk.path}) no longer opens with the new recovery passphrase after `
                    + `retiring the old one. Its keyslots are not what we think they are. STOP: no further keyslots `
                    + `have been touched, and the rest of the fleet still opens -- but check that disk, because it `
                    + `may now open only with the keyfile.`
                );
        }
    }

    return { volumes: ours.map(disk => disk.volumeId), rotatedAt: new Date().toISOString() };
}


// ---------------------------------------------------------------------------------------------------------
// THE AUDIT -- prove it, rather than believe it.
//
// The keyfile makes the passphrase enforceable, so this is no longer the authority it briefly tried to be. It
// remains the only thing that ever ASKS the platters whether the recovery passphrase really opens them -- and
// there is exactly one way for the answer to be no that no amount of enforcement prevents: A DISK THAT WAS
// ABSENT WHEN THE PASSPHRASE WAS ROTATED, and came back afterwards. It keeps the old passphrase, and nothing
// else in the system will ever notice, because STRUBS mounts with the keyfile and never touches that slot.
//
// So run it before you need it. It needs the passphrase, so it cannot run unattended: we will not keep the
// recovery passphrase on the machine it exists to recover.
// ---------------------------------------------------------------------------------------------------------
export type RecoveryAudit = {
    checkedAt: string;
    total: number;
    opened: EncryptedDisk[];
    refused: EncryptedDisk[];      // ⚠️ does not open. Almost certainly missed a rotation.
    unreadable: EncryptedDisk[];   // could not ask. A disk problem, not a passphrase problem.
    unidentified: string[];        // a LUKS container carrying no STRUBS nameplate
    notChecked: number[];          // ⚠️ volumes whose disks are not attached: NOT asked, and the likeliest to be wrong
    healthy: boolean;
};

export async function auditRecoveryKey(
    passphrase: string, overrides: Partial<RecoveryKeyDeps> = {}
): Promise<RecoveryAudit> {
    const deps = { ...defaultDeps, ...overrides };
    assertIdentity(deps);

    if (!passphrase)
        throw new HttpBadRequestError('the recovery passphrase is required to audit it against the disks');

    const { ours, unknown, absent } = await deps.scanFleet();

    const opened: EncryptedDisk[] = [];
    const refused: EncryptedDisk[] = [];
    const unreadable: EncryptedDisk[] = [];

    for (const disk of ours) {
        const verdict = await deps.testPassphrase(disk.path, passphrase);
        if (verdict === 'opens') opened.push(disk);
        else if (verdict === 'rejected') refused.push(disk);
        else unreadable.push(disk);
    }

    // A TYPO IS NOT A BROKEN FLEET. A passphrase that opens NOTHING is overwhelmingly likely to be the wrong
    // passphrase -- and recording that as "none of your disks open" would leave a false four-alarm banner,
    // making the real alarm indistinguishable from a fat finger.
    if (ours.length && !opened.length)
        throw new HttpBadRequestError(
            refused.length
                ? `that passphrase opens NONE of this array's ${ours.length} encrypted volume(s), which almost `
                    + `certainly means it is not the fleet recovery passphrase. Nothing has been recorded.`
                : `none of this array's ${ours.length} encrypted volume(s) could be read, so the passphrase could `
                    + `not be tested against anything. That is a disk problem. Nothing has been recorded.`
        );

    // ⚠️ AN AUDIT THAT DID NOT SEE EVERY DISK CANNOT SAY THE FLEET IS RECOVERABLE.
    //
    // It asks the platters in front of it whether the passphrase opens them. A volume whose disk is unplugged is
    // not asked at ALL -- and it is the likeliest one to be wrong, because it is the one a rotation could not
    // reach. Reporting "healthy: all encrypted volumes open" on the strength of the disks that happened to be
    // plugged in is precisely the false reassurance this audit exists to prevent.
    const healthy = !refused.length && !unreadable.length && !unknown.length && !absent.length;

    if (absent.length)
        log.error('the recovery passphrase was NOT tested against volume(s) %s -- their disks are not attached. '
            + 'This audit cannot vouch for them, and they are the volumes most likely to have missed a rotation. '
            + 'Attach every disk and audit again.', absent.join(', '));

    if (refused.length)
        log.error('RECOVERY PASSPHRASE AUDIT FAILED: volume(s) %s do NOT open with the fleet recovery passphrase. '
            + 'The overwhelmingly likely cause is a disk that was absent when the passphrase was last changed. '
            + 'Re-run PUT /$/encryption/passphrase with every disk attached, and it will rewrite them.',
            refused.map(disk => disk.volumeId).join(', '));

    if (unreadable.length)
        log.error('the recovery passphrase could not be tested against %s -- their LUKS headers would not read. '
            + 'That is a disk fault, and it means these volumes\' recoverability is UNKNOWN.',
            unreadable.map(disk => disk.path).join(', '));

    if (healthy)
        log('recovery passphrase audit: all %d encrypted volume(s) open. The fleet is recoverable.', ours.length);

    const audit: RecoveryAudit = {
        checkedAt: new Date().toISOString(),
        total: ours.length,
        opened,
        refused,
        unreadable,
        unidentified: unknown,
        notChecked: absent,
        healthy
    };

    // The RESULT, never the passphrase.
    await deps.database.setRuntimeConfig(RECOVERY_AUDIT_KEY, audit);


    return audit;
}

export async function lastRecoveryAudit(
    overrides: Partial<RecoveryKeyDeps> = {}
): Promise<RecoveryAudit | null> {
    const deps = { ...defaultDeps, ...overrides };
    const stored = await deps.database.getRuntimeConfig(RECOVERY_AUDIT_KEY);
    return stored && typeof stored === 'object' ? stored as RecoveryAudit : null;
}
