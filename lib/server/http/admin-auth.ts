import crypto from 'crypto';

import { database } from '../../database';
import { createLogger } from '../../log';
import { scryptHash, scryptVerify } from './secret-hash';

const log = createLogger('admin-auth');

const PASSWORD_KEY = 'adminPasswordHash';
const SESSION_SECRET_KEY = 'adminSessionSecret';
const SESSION_EPOCH_KEY = 'adminSessionEpoch';

// Idle timeout bounds an abandoned session; the absolute cap bounds a stolen cookie. A session is
// re-issued (its idle clock reset) once it is older than SESSION_REFRESH_AFTER_MS, so an actively-used
// session slides forward without ever moving the absolute anchor.
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_REFRESH_AFTER_MS = 60 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
export const SESSION_COOKIE = 'strubs_admin';

type SessionPayload = {
    iat: number;     // issued-at of the SESSION (fixed; anchors the absolute cap)
    sat: number;     // issued-at of THIS token (moves on refresh; anchors the idle timeout)
    epoch: number;   // revocation generation; a mismatch invalidates the token
};

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
    private sessionSecret: Buffer | null = null;
    private sessionEpoch = 0;
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
        await this.loadSessionKeys();
        if (await this.isPasswordSet())
            return;
        const generated = crypto.randomBytes(18).toString('base64url');
        await this.setPassword(generated);
        log.error('=================================================================');
        log.error('  NO ADMIN PASSWORD SET -- generated one. Change it after login.');
        log.error('  admin password: %s', generated);
        log.error('=================================================================');
    }

    // --- sessions (STATELESS, signed) ---
    //
    // Sessions used to be an in-memory Map, which meant every deploy silently logged the operator out.
    // They are now a signed token carrying their own state, so nothing is kept server-side and a restart
    // is invisible. The signing key lives in runtimeConfig, so it survives the restart too -- a key
    // regenerated on boot would have exactly the bug we are fixing.
    //
    // The cost of statelessness is that you cannot revoke one token by forgetting it. So revocation is an
    // EPOCH, also persisted: every token carries the epoch it was minted under, and bumping the epoch
    // invalidates every outstanding token at once. Logout and password-change both bump it. On a
    // single-admin system "log out" therefore means "log out everywhere", which is the safe reading --
    // and, unlike a server-side denylist, it cannot be undone by a restart.

    private async loadSessionKeys(): Promise<void> {
        const stored = await database.getRuntimeConfig(SESSION_SECRET_KEY);
        // 32 bytes of hex = 64 chars. Anything shorter/absent is not a key we are willing to sign with.
        let secret: string;
        if (typeof stored === 'string' && stored.length >= 64) {
            secret = stored;
        }
        else {
            secret = crypto.randomBytes(32).toString('hex');
            await database.setRuntimeConfig(SESSION_SECRET_KEY, secret);
            log('generated a new admin session signing key');
        }
        this.sessionSecret = Buffer.from(secret, 'hex');

        const epoch = await database.getRuntimeConfig(SESSION_EPOCH_KEY);
        this.sessionEpoch = typeof epoch === 'number' ? epoch : 0;
    }

    private sign(body: string): string {
        if (!this.sessionSecret)
            throw new Error('session signing key is not loaded');
        return crypto.createHmac('sha256', this.sessionSecret).update(body).digest('base64url');
    }

    private mintToken(payload: SessionPayload): string {
        const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
        return `${body}.${this.sign(body)}`;
    }

    // Returns the payload if the signature and all time/epoch bounds hold, else null. FAILS CLOSED: an
    // unloaded key, a bad signature, a stale epoch, or a malformed token are all simply "not a session".
    private readToken(token: string | undefined): SessionPayload | null {
        if (!token || !this.sessionSecret) return null;
        const dot = token.indexOf('.');
        if (dot < 1) return null;
        const body = token.slice(0, dot);
        const presented = token.slice(dot + 1);

        let expected: string;
        try { expected = this.sign(body); }
        catch { return null; }
        const a = Buffer.from(presented);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
            return null;

        let payload: SessionPayload;
        try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
        catch { return null; }
        if (typeof payload?.iat !== 'number' || typeof payload?.sat !== 'number' || typeof payload?.epoch !== 'number')
            return null;

        // Revoked wholesale (logout / password change).
        if (payload.epoch !== this.sessionEpoch) return null;

        const now = Date.now();
        if (now - payload.iat > SESSION_ABSOLUTE_MS) return null;   // absolute cap on a stolen cookie
        if (now - payload.sat > SESSION_IDLE_MS) return null;       // idle timeout
        // Reject a token minted in the future (clock skew / forged iat beyond our signing).
        if (payload.iat > now + CLOCK_SKEW_MS || payload.sat > now + CLOCK_SKEW_MS) return null;
        return payload;
    }

    createSession(): string {
        const now = Date.now();
        return this.mintToken({ iat: now, sat: now, epoch: this.sessionEpoch });
    }

    verifySession(token: string | undefined): boolean {
        return this.readToken(token) !== null;
    }

    // Sliding expiry: the idle timeout is measured from `sat` (session activity time), which only moves
    // when we re-issue the cookie. Re-mint once the token is past a fraction of the idle window, so an
    // actively-used session never expires while keeping the absolute cap anchored at the original `iat`.
    // Returns null when the token is still fresh enough to leave alone.
    refreshSession(token: string | undefined): string | null {
        const payload = this.readToken(token);
        if (!payload) return null;
        if (Date.now() - payload.sat < SESSION_REFRESH_AFTER_MS) return null;
        return this.mintToken({ iat: payload.iat, sat: Date.now(), epoch: payload.epoch });
    }

    // Revoke every outstanding session. Used by logout and by a password change. Persisted, so it also
    // holds across a restart (a server-side denylist would not).
    async destroyAllSessions(): Promise<void> {
        this.sessionEpoch++;
        await database.setRuntimeConfig(SESSION_EPOCH_KEY, this.sessionEpoch);
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
