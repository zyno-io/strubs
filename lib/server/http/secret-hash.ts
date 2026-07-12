import crypto from 'crypto';

import { createLogger } from '../../log';

const log = createLogger('secret-hash');

// Shared scrypt secret hashing, used for the admin password, admin bearer tokens, and object-API
// credentials. Node's built-in scrypt is memory-hard with no native dependency (this codebase fights
// native modules; a pure-stdlib primitive is worth more here than argon2id's marginal edge). Format:
// scrypt$N$r$p$saltB64$hashB64 -- self-describing so parameters could change over time.
export const SCRYPT_N = 16384;
export const SCRYPT_r = 8;
export const SCRYPT_p = 1;
export const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;

export function scryptHash(secret: string): Promise<string> {
    const salt = crypto.randomBytes(SALT_BYTES);
    return new Promise((resolve, reject) => {
        crypto.scrypt(secret, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p }, (err, key) => {
            if (err) return reject(err);
            resolve(`scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('base64')}$${key.toString('base64')}`);
        });
    });
}

export function scryptVerify(secret: string, stored: string): Promise<boolean> {
    return new Promise(resolve => {
        const parts = stored.split('$');
        if (parts.length !== 6 || parts[0] !== 'scrypt')
            return resolve(false);
        const [, n, r, p, saltB64, hashB64] = parts;
        const salt = Buffer.from(saltB64, 'base64');
        const expected = Buffer.from(hashB64, 'base64');
        // FAIL CLOSED against a malformed/corrupt stored hash. Pin EVERY field to exactly what we write:
        //   - empty/short `expected` would make scrypt(keylen=0) + timingSafeEqual(empty,empty) return
        //     TRUE (any password verifies);
        //   - N/r/p of 0 are accepted by Node as "use defaults", so a zeroed param field must be rejected
        //     rather than silently re-deriving under different work factors.
        if (expected.length !== SCRYPT_KEYLEN || salt.length !== SALT_BYTES
            || Number(n) !== SCRYPT_N || Number(r) !== SCRYPT_r || Number(p) !== SCRYPT_p) {
            log.error('refusing to verify against a malformed stored hash');
            return resolve(false);
        }
        try {
            crypto.scrypt(secret, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p }, (err, key) => {
                if (err || key.length !== expected.length) return resolve(false);
                resolve(crypto.timingSafeEqual(key, expected));
            });
        }
        catch {
            resolve(false);
        }
    });
}
