import crypto from 'crypto';

import { database } from '../../database';
import { createLogger } from '../../log';

const log = createLogger('admin-auth');

// Password/secret hashing uses Node's built-in scrypt -- memory-hard, no native dependency (this
// codebase fights native modules; a pure-stdlib primitive is worth more here than argon2id's marginal
// edge). Format: scrypt$N$r$p$saltB64$hashB64, self-describing so parameters can change over time.
const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const SCRYPT_KEYLEN = 32;

const PASSWORD_KEY = 'adminPasswordHash';

// Sessions live in memory: one process, and losing them on restart just means re-login. Idle timeout
// bounds an abandoned session; the absolute cap bounds a stolen cookie.
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'strubs_admin';

export function parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return out;
}

// The admin listener is HTTPS-only, so Secure is unconditional. HttpOnly keeps JS from reading it;
// SameSite=Strict means it is never attached to a cross-site request.
export function sessionSetCookie(token: string): string {
    return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_ABSOLUTE_MS / 1000)}`;
}
export function sessionClearCookie(): string {
    return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function scryptHash(secret: string): Promise<string> {
    const salt = crypto.randomBytes(16);
    return new Promise((resolve, reject) => {
        crypto.scrypt(secret, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p }, (err, key) => {
            if (err) return reject(err);
            resolve(`scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('base64')}$${key.toString('base64')}`);
        });
    });
}

function scryptVerify(secret: string, stored: string): Promise<boolean> {
    return new Promise(resolve => {
        const parts = stored.split('$');
        if (parts.length !== 6 || parts[0] !== 'scrypt')
            return resolve(false);
        const [, n, r, p, saltB64, hashB64] = parts;
        const salt = Buffer.from(saltB64, 'base64');
        const expected = Buffer.from(hashB64, 'base64');
        crypto.scrypt(secret, salt, expected.length, { N: Number(n), r: Number(r), p: Number(p) }, (err, key) => {
            // timingSafeEqual needs equal lengths; a scrypt of the right keylen guarantees it.
            if (err || key.length !== expected.length) return resolve(false);
            resolve(crypto.timingSafeEqual(key, expected));
        });
    });
}

type SessionEntry = { createdAt: number; lastSeen: number };

export class AdminAuth {
    private readonly sessions = new Map<string, SessionEntry>();

    // --- password ---

    async isPasswordSet(): Promise<boolean> {
        return typeof await database.getRuntimeConfig(PASSWORD_KEY) === 'string';
    }

    async setPassword(password: string): Promise<void> {
        if (password.length < 8)
            throw new Error('password must be at least 8 characters');
        await database.setRuntimeConfig(PASSWORD_KEY, await scryptHash(password));
    }

    async verifyPassword(password: string): Promise<boolean> {
        const stored = await database.getRuntimeConfig(PASSWORD_KEY);
        if (typeof stored !== 'string')
            return false;
        return scryptVerify(password, stored);
    }

    // On first start with no password, generate a random one and print it ONCE. Never a default
    // password, and never an unauthenticated "set password" endpoint -- that would be the hole itself.
    async bootstrap(): Promise<void> {
        if (await this.isPasswordSet())
            return;
        const generated = crypto.randomBytes(18).toString('base64url');
        await this.setPassword(generated);
        log.error('=================================================================');
        log.error('  NO ADMIN PASSWORD SET -- generated one. Change it after login.');
        log.error('  admin password: %s', generated);
        log.error('=================================================================');
    }

    // --- sessions ---

    createSession(): string {
        const token = crypto.randomBytes(32).toString('base64url');
        const now = Date.now();
        this.sessions.set(token, { createdAt: now, lastSeen: now });
        return token;
    }

    verifySession(token: string | undefined): boolean {
        if (!token) return false;
        const s = this.sessions.get(token);
        if (!s) return false;
        const now = Date.now();
        if (now - s.lastSeen > SESSION_IDLE_MS || now - s.createdAt > SESSION_ABSOLUTE_MS) {
            this.sessions.delete(token);
            return false;
        }
        s.lastSeen = now;
        return true;
    }

    destroySession(token: string | undefined): void {
        if (token) this.sessions.delete(token);
    }

    // Invalidate every session -- used after a password change so old cookies stop working.
    destroyAllSessions(): void {
        this.sessions.clear();
    }

    // --- bearer tokens (selector.secret; selector indexed plaintext, secret hashed) ---

    async verifyBearer(presented: string | undefined): Promise<boolean> {
        if (!presented) return false;
        const dot = presented.indexOf('.');
        if (dot < 1) return false;
        const selector = presented.slice(0, dot);
        const secret = presented.slice(dot + 1);
        const record = await database.getAdminTokenBySelector(selector);
        if (!record || record.disabled)
            return false;
        if (!await scryptVerify(secret, record.secretHash))
            return false;
        void database.touchAdminToken(selector).catch(() => undefined);
        return true;
    }

    async createToken(name: string): Promise<{ token: string; selector: string }> {
        const selector = crypto.randomBytes(9).toString('base64url'); // 12 chars
        const secret = crypto.randomBytes(24).toString('base64url');
        await database.createAdminToken({ selector, secretHash: await scryptHash(secret), name });
        return { token: `${selector}.${secret}`, selector };
    }
}

export const adminAuth = new AdminAuth();
