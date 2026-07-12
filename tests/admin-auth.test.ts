import { beforeEach, describe, expect, it, vi } from 'vitest';

// The password + token stores go through the database facade; mock it with an in-memory map.
const store = new Map<string, unknown>();
const tokens = new Map<string, { selector: string; secretHash: string; name: string; disabled?: boolean }>();

vi.mock('../lib/database', () => ({
    database: {
        getRuntimeConfig: vi.fn(async (k: string) => store.has(k) ? store.get(k) : null),
        setRuntimeConfig: vi.fn(async (k: string, v: unknown) => { store.set(k, v); }),
        createAdminToken: vi.fn(async (d: any) => { tokens.set(d.selector, d); }),
        getAdminTokenBySelector: vi.fn(async (s: string) => tokens.get(s) ?? null),
        touchAdminToken: vi.fn(async () => undefined),
    },
}));

import { AdminAuth } from '../lib/server/http/admin-auth';

describe('AdminAuth', () => {
    let auth: AdminAuth;

    beforeEach(() => {
        store.clear();
        tokens.clear();
        auth = new AdminAuth();
    });

    describe('password', () => {
        it('is not set initially, then verifies a correct password and rejects a wrong one', async () => {
            expect(await auth.isPasswordSet()).toBe(false);
            await auth.setPassword('correct horse');
            expect(await auth.isPasswordSet()).toBe(true);
            expect(await auth.verifyPassword('correct horse')).toBe(true);
            expect(await auth.verifyPassword('wrong')).toBe(false);
        });

        it('stores a hash, never the plaintext', async () => {
            await auth.setPassword('super secret pw');
            const stored = store.get('adminPasswordHash') as string;
            expect(stored).toMatch(/^scrypt\$/);
            expect(stored).not.toContain('super secret pw');
        });

        it('rejects a too-short password', async () => {
            await expect(auth.setPassword('short')).rejects.toThrow(/at least 8/);
        });

        it('bootstrap generates a password only when none is set', async () => {
            await auth.bootstrap();
            const first = store.get('adminPasswordHash');
            expect(first).toBeTruthy();
            await auth.bootstrap();                 // must NOT overwrite
            expect(store.get('adminPasswordHash')).toBe(first);
        });
    });

    describe('sessions', () => {
        it('creates a session that verifies, and rejects unknown/empty tokens', () => {
            const token = auth.createSession();
            expect(auth.verifySession(token)).toBe(true);
            expect(auth.verifySession('nope')).toBe(false);
            expect(auth.verifySession(undefined)).toBe(false);
        });

        it('destroy invalidates a single session; destroyAll invalidates every session', () => {
            const a = auth.createSession();
            const b = auth.createSession();
            auth.destroySession(a);
            expect(auth.verifySession(a)).toBe(false);
            expect(auth.verifySession(b)).toBe(true);
            auth.destroyAllSessions();
            expect(auth.verifySession(b)).toBe(false);
        });
    });

    describe('bearer tokens', () => {
        it('mints a selector.secret token that verifies, and rejects a tampered secret', async () => {
            const { token, selector } = await auth.createToken('ci');
            expect(token.startsWith(selector + '.')).toBe(true);
            expect(await auth.verifyBearer(token)).toBe(true);
            expect(await auth.verifyBearer(`${selector}.wrongsecret`)).toBe(false);
            expect(await auth.verifyBearer('no-dot')).toBe(false);
            expect(await auth.verifyBearer(undefined)).toBe(false);
        });

        it('rejects a disabled token', async () => {
            const { token, selector } = await auth.createToken('revoked');
            tokens.get(selector)!.disabled = true;
            expect(await auth.verifyBearer(token)).toBe(false);
        });
    });

    describe('fail-closed on a malformed hash', () => {
        it('does NOT verify any password against a corrupt stored hash (empty key)', async () => {
            // Regression: a 0-length expected key made scrypt(keylen=0) + timingSafeEqual(empty,empty)
            // return true -- any password would verify. Must be rejected.
            store.set('adminPasswordHash', 'scrypt$16384$8$1$c2FsdA==$');   // empty hash segment
            expect(await auth.verifyPassword('anything')).toBe(false);
            expect(await auth.verifyPassword('')).toBe(false);
        });

        it('does not verify a bearer token against a corrupt secretHash', async () => {
            tokens.set('sel', { selector: 'sel', secretHash: 'scrypt$16384$8$1$c2FsdA==$', name: 'x' });
            expect(await auth.verifyBearer('sel.whatever')).toBe(false);
        });
    });

    describe('login throttle', () => {
        it('locks out after 5 failed verifyLoginPassword calls', async () => {
            await auth.setPassword('the-real-password');
            expect(auth.isLoginLocked()).toBe(false);
            for (let i = 0; i < 5; i++)
                expect(await auth.verifyLoginPassword('wrong')).toBe('invalid');
            expect(auth.isLoginLocked()).toBe(true);
        });

        it('a correct login resets the failure counter', async () => {
            await auth.setPassword('the-real-password');
            for (let i = 0; i < 4; i++) await auth.verifyLoginPassword('wrong');   // 4 < 5, not yet locked
            expect(auth.isLoginLocked()).toBe(false);
            expect(await auth.verifyLoginPassword('the-real-password')).toBe('ok');
            // counter reset: it now takes another full burst of 5 to lock
            for (let i = 0; i < 4; i++) await auth.verifyLoginPassword('wrong');
            expect(auth.isLoginLocked()).toBe(false);
        });

        it('throttles a concurrent burst beyond the in-flight cap (bounds scrypt work)', async () => {
            await auth.setPassword('the-real-password');
            // Fire more than the cap at once. The excess must be 'throttled' (rejected before scrypt),
            // never all scheduled -- this is the burst-bypass the review flagged.
            const results = await Promise.all(
                Array.from({ length: 10 }, () => auth.verifyLoginPassword('wrong'))
            );
            expect(results.filter(r => r === 'throttled').length).toBeGreaterThan(0);
        });
    });
});
