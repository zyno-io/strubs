import crypto from 'crypto';

import { database } from '../../database';
import { createLogger } from '../../log';
import { scryptHash, scryptVerify } from './secret-hash';

const log = createLogger('admin-auth');

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

type SessionEntry = { createdAt: number; lastSeen: number };

// Login throttle: a single password with no username is a small keyspace, and scrypt-per-attempt is
// expensive, so cap the rate of failed attempts. Global (one admin) rather than per-IP, since a LAN
// attacker can rotate source addresses.
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCKOUT_MS = 30 * 1000;
// Cap password verifications running at once. scrypt is deliberately expensive, and the failure counter
// only updates AFTER a verify resolves -- so without this a parallel burst slips past isLoginLocked()
// and schedules many scrypts (threadpool/CPU exhaustion). Bounds concurrent work regardless of timing.
const LOGIN_MAX_CONCURRENT = 3;

export class AdminAuth {
    private readonly sessions = new Map<string, SessionEntry>();
    private loginFailures = 0;
    private loginLockedUntil = 0;
    private loginInFlight = 0;

    // Reject BEFORE running scrypt when the throttle is engaged or too many verifications are already
    // in flight. Callers return 429.
    isLoginLocked(): boolean {
        return Date.now() < this.loginLockedUntil || this.loginInFlight >= LOGIN_MAX_CONCURRENT;
    }

    // Verify a login password. This is the ONLY entry point login should use (verifyPassword is for
    // password-change re-auth). The slot is acquired ATOMICALLY here: the lock/cap test and the
    // increment run with no `await` between them, so in single-threaded JS a burst that all cleared the
    // handler's pre-check still cannot schedule more than LOGIN_MAX_CONCURRENT scrypts -- the excess get
    // 'throttled' at the point of acquisition, before any scrypt runs.
    async verifyLoginPassword(password: string): Promise<'ok' | 'invalid' | 'throttled'> {
        if (Date.now() < this.loginLockedUntil || this.loginInFlight >= LOGIN_MAX_CONCURRENT)
            return 'throttled';
        this.loginInFlight++;
        try {
            const ok = await this.verifyPassword(password);
            this.recordLoginResult(ok);
            return ok ? 'ok' : 'invalid';
        }
        finally {
            this.loginInFlight--;
        }
    }

    private recordLoginResult(ok: boolean): void {
        if (ok) {
            this.loginFailures = 0;
            this.loginLockedUntil = 0;
            return;
        }
        this.loginFailures++;
        if (this.loginFailures >= LOGIN_MAX_FAILURES) {
            this.loginLockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
            this.loginFailures = 0;
            log.error('admin login locked for %ds after repeated failures', LOGIN_LOCKOUT_MS / 1000);
        }
    }

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
