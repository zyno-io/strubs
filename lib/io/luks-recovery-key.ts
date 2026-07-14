import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'crypto';

import { config } from '../config';
import { database } from '../database';
import { HttpBadRequestError } from '../server/http/errors';
import { findEncryptedPartitions, testPassphrase, type EncryptedDisks } from './luks';
import { createLogger } from '../log';

const log = createLogger('luks-recovery-key');

// promisify() picks the 3-arg scrypt overload, so the options object (the cost parameters) would be dropped on
// the floor -- silently downgrading to scrypt's defaults. Wrap it by hand.
const scryptAsync = (passphrase: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> =>
    new Promise((resolve, reject) => {
        scrypt(passphrase, salt, keylen, options, (err, key) => err ? reject(err) : resolve(key));
    });

// THE FLEET RECOVERY PASSPHRASE -- and why we keep a verifier for it.
//
// Every encrypted volume gets two LUKS keyslots: the keyfile (unattended boot) and a passphrase (the OS disk is
// gone; this is how you get back in). Nothing forces the passphrase to be the SAME on every disk -- cryptsetup
// will happily take a different one each time. That failure is invisible: the array serves perfectly, and you
// find out on the worst day of the array's life that the passphrase in the safe opens eleven of thirty disks.
//
// So we keep a verifier -- a salted scrypt hash of the passphrase, in Mongo -- and check every subsequent
// encryption against it. The first encrypted volume sets it; every one after that must match.
//
// WHY THIS DOES NOT WEAKEN THE THREAT MODEL. What encryption defends against here is A DISK LEAVING THE
// BUILDING. The verifier lives in MongoDB on the OS disk, not on the platters -- someone holding a stolen STRUBS
// disk has the ciphertext and nothing else. And an attacker who has the OS disk already has the KEYFILE, which
// opens every volume outright without troubling the passphrase at all. The verifier gives an attacker nothing
// they did not already have, and it prevents a silent, unrecoverable operational error. That trade is not close.
//
// BUT THE VERIFIER IS NOT THE AUTHORITY. THE DISKS ARE.
//
// Mongo is a derived index -- that is the governing principle of this whole system, and it applies here with
// unusual force. Restore a snapshot, rebuild Mongo, lose the OS disk: the verifier is GONE, while eighteen
// encrypted disks are still sitting in the rack. A verifier-only check would then see "no verifier" and cheerfully
// let the next encryption establish a BRAND NEW passphrase -- splitting the fleet in exactly the way this file
// exists to prevent, at the exact moment recovery matters most.
//
// So when the verifier is absent but encrypted volumes EXIST, we do not trust it and we do not guess: we ask a
// disk. `cryptsetup --test-passphrase` puts the passphrase against a real LUKS header and reports whether a
// keyslot opens. The platter has the final word, as it does everywhere else in this system.
//
// The passphrase itself is NEVER stored, logged, journalled, or written to a nameplate. Only the verifier.
export const RECOVERY_VERIFIER_KEY = 'luksRecoveryVerifier';

type Verifier = { salt: string; hash: string; setAt: string };

const N = 16384, r = 8, p = 1, KEYLEN = 32;

const derive = (passphrase: string, salt: Buffer): Promise<Buffer> =>
    scryptAsync(passphrase, salt, KEYLEN, { N, r, p });

const isVerifier = (value: unknown): value is Verifier => {
    const v = value as Verifier | null;
    return Boolean(v && typeof v.salt === 'string' && typeof v.hash === 'string');
};

export type RecoveryKeyDeps = {
    database: Pick<typeof database,
        'getRuntimeConfig' | 'setRuntimeConfig' | 'setRuntimeConfigIfAbsent' | 'runtimeConfigKeyIsUnique'>;

    // THE ENCRYPTED DISKS IN THE RACK -- read off the PLATTERS (block devices + GPT nameplates), never from the
    // volume table. Asking Mongo which disks are encrypted would make this entire guard conditional on Mongo
    // being right, and a restored-from-last-week volume table would render the fleet's encrypted disks
    // invisible to it. Their LUKS headers are the authority; the nameplate is how a locked one says it is ours.
    findEncryptedPartitions: () => Promise<EncryptedDisks>;
    testPassphrase: typeof testPassphrase;
};

const defaultDeps: RecoveryKeyDeps = {
    database,
    findEncryptedPartitions: () => findEncryptedPartitions(config.identity),
    testPassphrase
};

async function getVerifier(deps: RecoveryKeyDeps): Promise<Verifier | null> {
    const stored = await deps.database.getRuntimeConfig(RECOVERY_VERIFIER_KEY);
    return isVerifier(stored) ? stored : null;
}

// Has an operator ever recorded a recovery passphrase for this fleet? The UI asks this to decide whether it is
// offering to SET the passphrase or to CONFIRM it.
export async function hasRecoveryPassphrase(deps: Partial<RecoveryKeyDeps> = {}): Promise<boolean> {
    return await getVerifier({ ...defaultDeps, ...deps }) !== null;
}

const matches = async (passphrase: string, verifier: Verifier): Promise<boolean> => {
    const expected = Buffer.from(verifier.hash, 'hex');
    const actual = await derive(passphrase, Buffer.from(verifier.salt, 'hex'));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
};

const MISMATCH =
    'that is not the recovery passphrase the rest of this fleet was encrypted with. Encrypting this volume '
    + 'with a different passphrase would leave you holding a key that opens some of your disks and not others '
    + '-- and you would not discover which until you needed them. Use the passphrase recorded when the first '
    + 'volume was encrypted.';

// Establish -- or re-assert -- the fleet recovery passphrase.
//
// Called on every encryption. Refusing here costs an operator one retry. Not refusing costs the array.
export async function assertFleetRecoveryPassphrase(
    passphrase: string, overrides: Partial<RecoveryKeyDeps> = {}
): Promise<void> {
    const deps = { ...defaultDeps, ...overrides };

    if (!passphrase || passphrase.length < 12)
        throw new HttpBadRequestError(
            'a recovery passphrase of at least 12 characters is required to encrypt a volume. This is the only '
            + 'thing that can open these disks if the OS disk dies -- it is not a formality.'
        );

    // IF THERE ARE DISKS TO ASK, ASK THE DISKS. ALWAYS. NOT ONLY WHEN MONGO HAS FORGOTTEN.
    //
    // An earlier version consulted the platters only when the verifier was MISSING, and short-circuited on the
    // stored hash whenever it was present. That is Mongo overruling the disks, in a system whose first
    // principle is the opposite -- and it fails in the one direction that matters:
    //
    //   - a STALE or WRONG verifier (restored from an old snapshot, hand-edited, or written by the loser of a
    //     race) would authorise a passphrase that opens nothing;
    //   - a fleet that is ALREADY SPLIT stays split, and each new disk is added under whichever passphrase
    //     Mongo happens to bless -- widening it, silently, with the array serving perfectly the whole time.
    //
    // The LUKS headers on the platters are the only copy of this fact that cannot be rebuilt, hand-edited, or
    // restored from last week. They are the authority. `--test-passphrase` opens nothing and writes nothing; it
    // just asks each header whether this key fits.
    const { ours: encrypted, unknown } = await deps.findEncryptedPartitions();

    // A LUKS CONTAINER WE CANNOT IDENTIFY IS NOT A CONTAINER WE GET TO IGNORE.
    //
    // It carries no nameplate, so it might be one of ours whose plate never landed -- and if it is, and we
    // shrug it off, the next encryption never checks the passphrase against it and the fleet splits. Encrypted
    // provisioning REFUSES to put a nameplate-less disk into service precisely so this state cannot arise from
    // our own hand; if we are looking at one anyway, something is wrong and it is not ours to guess about.
    if (unknown.length)
        throw new HttpBadRequestError(
            `refusing to encrypt anything: ${unknown.join(', ')} carries a LUKS container with no STRUBS `
            + `nameplate, so we cannot tell whether it is one of ours. An encrypted disk of ours that this `
            + `check cannot see is a disk the next encryption will not test its passphrase against -- which is `
            + `exactly how a fleet ends up split across two recovery passphrases. Identify it or detach it, and `
            + `try again.`
        );

    if (encrypted.length > 0) {
        // SEQUENTIAL, and it costs about 3 seconds per volume -- `--test-passphrase` runs the real argon2id
        // key derivation, which is memory-hard by design (that is the point of it). Thirty converted volumes
        // is therefore a minute and a half of preflight.
        //
        // That is the right trade, and it is not run in parallel: argon2 wants ~1GB of RAM per invocation, and
        // this host is serving 130TB of live traffic. A minute of checking, in front of an operation that
        // takes HOURS (drain, wipe, refill), on the one question whose wrong answer is unrecoverable.
        log('checking the passphrase against %d encrypted volume(s) -- about %d seconds; the LUKS headers are '
            + 'the only authority on this and they are deliberately slow to ask',
            encrypted.length, encrypted.length * 3);

        const refused: string[] = [];
        const unreadable: string[] = [];

        for (const partitionPath of encrypted) {
            const verdict = await deps.testPassphrase(partitionPath, passphrase);
            if (verdict === 'rejected') refused.push(partitionPath);
            else if (verdict === 'unreadable') unreadable.push(partitionPath);
        }

        // A DISK WE COULD NOT READ IS NOT A DISK THAT SAID NO. Its header might accept this passphrase
        // perfectly well; we simply could not ask it. Calling that a rejection would report a dying drive as a
        // fleet split, and calling it an acceptance would let an unchecked disk through. It is neither: refuse,
        // and say what actually happened.
        if (unreadable.length)
            throw new HttpBadRequestError(
                `refusing to encrypt: the LUKS header on ${unreadable.join(', ')} could not be read, so we `
                + `cannot tell whether this passphrase opens it. That is a disk problem, not a passphrase `
                + `problem -- check the drive before encrypting anything else.`
            );

        if (refused.length === encrypted.length)
            throw new HttpBadRequestError(
                `this array already has ${encrypted.length} encrypted volume(s), and the passphrase given opens `
                + `NONE of them. It is not this fleet's recovery passphrase. Encrypting another volume with it `
                + `would leave you holding a key that opens some of your disks and not others -- and you would `
                + `not find out which until you needed them.`
            );

        if (refused.length)
            throw new HttpBadRequestError(
                `this passphrase opens ${encrypted.length - refused.length} of this array's ${encrypted.length} `
                + `encrypted volumes, but NOT ${refused.join(', ')}. THE FLEET IS ALREADY SPLIT ACROSS TWO `
                + `PASSPHRASES -- those volumes were encrypted with a different one, and if the keyfile is ever `
                + `lost they will not open. Recording this passphrase as the fleet's would certify that as `
                + `normal. Find the passphrase those disks were built with, or drain and re-encrypt them, before `
                + `encrypting anything else.`
            );

        // Every disk opened. This IS the fleet passphrase -- whatever the database happens to think.
        const stored = await getVerifier(deps);
        if (stored && !await matches(passphrase, stored))
            log.error('the recovery verifier in the database did not match a passphrase that opens EVERY '
                + 'encrypted volume in the fleet. The disks are authoritative and the verifier was stale or '
                + 'wrong; replacing it with one that matches the platters.');

        if (!stored || !await matches(passphrase, stored))
            await deps.database.setRuntimeConfig(RECOVERY_VERIFIER_KEY, await buildVerifier(passphrase));

        return;
    }

    // --- NO ENCRYPTED DISK IS PRESENT TO ASK. ------------------------------------------------------------
    //
    // Either this is the first encryption this array has ever done, or every encrypted volume is currently
    // missing (their disks are unplugged). In both cases the verifier is all we have, so it is what we use.
    const existing = await getVerifier(deps);

    if (existing) {
        if (!await matches(passphrase, existing))
            throw new HttpBadRequestError(MISMATCH);
        return;
    }

    // THE FIRST ENCRYPTION EVER. Nothing to check it against, so this passphrase BECOMES the fleet's -- which
    // makes creating the record the one moment where a race is unrecoverable: two callers, two passphrases, two
    // disks, and only one of them written down.
    //
    // setIfAbsent() is atomic ONLY because of the unique index on runtimeConfig.key. If that index could not be
    // created, we do not have the guarantee, and we say so instead of pretending.
    if (!await deps.database.runtimeConfigKeyIsUnique())
        throw new HttpBadRequestError(
            'refusing to record the first recovery passphrase: the unique index on runtimeConfig.key is not in '
            + 'place, so two concurrent encryptions could each believe they were the first and split the fleet '
            + 'across two passphrases -- with only one of them recorded. The array is otherwise fine. Fix the '
            + 'index (look for duplicate keys in runtimeConfig) and try again.'
        );

    if (!await deps.database.setRuntimeConfigIfAbsent(RECOVERY_VERIFIER_KEY, await buildVerifier(passphrase))) {
        // Somebody else got there first, in the microseconds between our check and our write. Their passphrase
        // is now the fleet's, and ours had better be the same one.
        const winner = await getVerifier(deps);
        if (!winner || !await matches(passphrase, winner))
            throw new HttpBadRequestError(MISMATCH);
    }
}

async function buildVerifier(passphrase: string): Promise<Verifier> {
    const salt = randomBytes(16);
    return {
        salt: salt.toString('hex'),
        hash: (await derive(passphrase, salt)).toString('hex'),
        setAt: new Date().toISOString()
    };
}
