import { beforeEach, describe, expect, it, vi } from 'vitest';

// Controllable in-memory database mock. Individual tests set what the lookups return.
const state: {
    authEnforced: boolean;
    buckets: Record<string, { id: string; name: string; publicRead?: boolean; publicWrite?: boolean }>;
    bucketsById: Record<string, { id: string; name: string; publicRead?: boolean; publicWrite?: boolean }>;
    objects: Record<string, { bucketId?: string | null }>;
    credentials: Record<string, { secretHash: string; grants: any[]; enabled: boolean; expiresAt?: Date | null }>;
} = { authEnforced: false, buckets: {}, bucketsById: {}, objects: {}, credentials: {} };

const touchSpy = vi.fn();

vi.mock('../lib/database', () => ({
    database: {
        getRuntimeConfig: vi.fn(async (k: string) => (k === 'authEnforced' ? state.authEnforced : null)),
        getBucketByName: vi.fn(async (name: string) => state.buckets[name] ?? null),
        getBucketById: vi.fn(async (id: string) => state.bucketsById[id] ?? null),
        getObjectById: vi.fn(async (id: string) => {
            const o = state.objects[id];
            if (!o) { const e: any = new Error('not found'); e.code = 'ENOENT'; throw e; }
            return o;
        }),
        getCredentialByAccessKeyId: vi.fn(async (k: string) => state.credentials[k] ?? null),
        touchCredential: vi.fn(async (...args: any[]) => { touchSpy(...args); }),
    }
}));

import {
    authorizeObjectRequest,
    isValidBucketName,
    parseBasicAuth,
    bucketRefFromPath,
    invalidateAuthEnforcedCache,
    resetBucketActivity,
    getBucketActivity,
    clearCredentialCache
} from '../lib/server/http/object-authz';
import { scryptHash } from '../lib/server/http/secret-hash';

function basic(user: string, pass: string): string {
    return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

describe('object-authz', () => {
    beforeEach(() => {
        state.authEnforced = false;
        state.buckets = {};
        state.bucketsById = {};
        state.objects = {};
        state.credentials = {};
        invalidateAuthEnforcedCache();
        resetBucketActivity();
        clearCredentialCache();
        touchSpy.mockClear();
    });

    describe('bucket name grammar', () => {
        it('accepts the production bucket names, rejects confusables and bad shapes', () => {
            for (const ok of ['photo', 'call-recordings', 'platform-tests', 'a12', 'x'.repeat(63)])
                expect(isValidBucketName(ok)).toBe(true);
            for (const bad of ['ab', 'Photo', 'pho to', '-lead', 'trail-', 'x'.repeat(64), 'ünïcode', 'a/b', '$photo', ''])
                expect(isValidBucketName(bad)).toBe(false);
        });
    });

    describe('parseBasicAuth', () => {
        it('splits on the first colon and rejects malformed headers', () => {
            expect(parseBasicAuth(basic('key', 'sec:ret'))).toEqual({ accessKeyId: 'key', secret: 'sec:ret' });
            expect(parseBasicAuth(undefined)).toBeNull();
            expect(parseBasicAuth('Bearer abc')).toBeNull();
            expect(parseBasicAuth('Basic ' + Buffer.from('nocolon').toString('base64'))).toBeNull();
            expect(parseBasicAuth('Basic ' + Buffer.from(':nokey').toString('base64'))).toBeNull();
        });
    });

    describe('bucketRefFromPath (raw bytes, no decode)', () => {
        it('distinguishes id form, path form, and root', () => {
            expect(bucketRefFromPath('/$0123456789abcdef01234567')).toEqual({ form: 'id' });
            expect(bucketRefFromPath('/photo/2024/cat.jpg')).toEqual({ form: 'path', bucket: 'photo' });
            expect(bucketRefFromPath('/photo/2024/cat.jpg?downloadAs=x')).toEqual({ form: 'path', bucket: 'photo' });
            expect(bucketRefFromPath('/file.bin')).toEqual({ form: 'path', bucket: 'file.bin' });
            expect(bucketRefFromPath('/')).toEqual({ form: 'none' });
        });
    });

    describe('dark (authEnforced = false)', () => {
        it('allows every request and counts anonymous vs credentialed per bucket', async () => {
            expect(await authorizeObjectRequest('/photo/a.jpg', 'GET', undefined)).toEqual({ allow: true });
            expect(await authorizeObjectRequest('/photo/a.jpg', 'PUT', basic('k', 's'))).toEqual({ allow: true });
            expect(await authorizeObjectRequest('/video/a.mp4', 'DELETE', undefined)).toEqual({ allow: true });
            const activity = getBucketActivity();
            expect(activity.photo).toEqual({ anon: 1, auth: 1 });
            expect(activity.video).toEqual({ anon: 1, auth: 0 });
        });

        it('bounds the counter map against a flood of attacker-controlled path segments', async () => {
            for (let i = 0; i < 3000; i++)
                await authorizeObjectRequest(`/flood${i}/x`, 'GET', undefined);
            const activity = getBucketActivity();
            // Bounded to the cap (+ the shared overflow bucket), not one entry per distinct path.
            expect(Object.keys(activity).length).toBeLessThanOrEqual(1025);
            expect(activity['(overflow)'].anon).toBeGreaterThan(0);
        });

        it('never touches bucket/credential lookups while dark', async () => {
            const { database } = await import('../lib/database');
            await authorizeObjectRequest('/photo/a.jpg', 'GET', basic('k', 's'));
            expect(database.getBucketByName).not.toHaveBeenCalled();
            expect(database.getCredentialByAccessKeyId).not.toHaveBeenCalled();
        });
    });

    describe('enforced (authEnforced = true)', () => {
        beforeEach(() => { state.authEnforced = true; });

        it('anonymous read: allowed only on a publicRead bucket', async () => {
            state.buckets.pub = { id: 'b1', name: 'pub', publicRead: true };
            state.buckets.priv = { id: 'b2', name: 'priv', publicRead: false };
            expect(await authorizeObjectRequest('/pub/x', 'GET', undefined)).toEqual({ allow: true });
            const denied = await authorizeObjectRequest('/priv/x', 'GET', undefined);
            expect(denied).toMatchObject({ allow: false, status: 401 });
        });

        it('anonymous write: allowed only on a publicWrite bucket; unset policy is closed', async () => {
            state.buckets.drop = { id: 'b1', name: 'drop', publicWrite: true };
            state.buckets.readonly = { id: 'b2', name: 'readonly', publicRead: true };   // publicWrite unset -> closed
            expect(await authorizeObjectRequest('/drop/x', 'PUT', undefined)).toEqual({ allow: true });
            expect(await authorizeObjectRequest('/readonly/x', 'PUT', undefined)).toMatchObject({ allow: false, status: 401 });
        });

        it('credential: allowed iff a grant matches the bucket (or *) with the action bit', async () => {
            state.buckets.photo = { id: 'b1', name: 'photo' };
            state.buckets.video = { id: 'b2', name: 'video' };
            state.credentials.app = {
                secretHash: await scryptHash('s3cret'),
                enabled: true,
                grants: [{ bucket: 'photo', read: true, write: true }, { bucket: '*', read: true, write: false }]
            };
            // photo: explicit rw
            expect(await authorizeObjectRequest('/photo/x', 'PUT', basic('app', 's3cret'))).toEqual({ allow: true });
            // video: only the '*' read grant -> read ok, write denied 403
            expect(await authorizeObjectRequest('/video/x', 'GET', basic('app', 's3cret'))).toEqual({ allow: true });
            expect(await authorizeObjectRequest('/video/x', 'PUT', basic('app', 's3cret'))).toMatchObject({ allow: false, status: 403 });
        });

        it('a bad secret or disabled/expired credential is 401', async () => {
            state.buckets.photo = { id: 'b1', name: 'photo' };
            state.credentials.app = { secretHash: await scryptHash('right'), enabled: true, grants: [{ bucket: 'photo', read: true, write: true }] };
            expect(await authorizeObjectRequest('/photo/x', 'GET', basic('app', 'wrong'))).toMatchObject({ allow: false, status: 401 });
            state.credentials.dis = { secretHash: await scryptHash('right'), enabled: false, grants: [{ bucket: 'photo', read: true, write: true }] };
            expect(await authorizeObjectRequest('/photo/x', 'GET', basic('dis', 'right'))).toMatchObject({ allow: false, status: 401 });
        });

        it('unknown/unresolvable bucket fails CLOSED for reads and writes (no fall-through bypass)', async () => {
            // Anonymous -> 401 (can present credentials); reads and writes alike are denied, so root
            // objects, invalid-name trees, and id-form objects lacking bucketId cannot be read unchecked.
            expect(await authorizeObjectRequest('/ghost/x', 'GET', undefined)).toMatchObject({ allow: false, status: 401 });
            expect(await authorizeObjectRequest('/ghost/x', 'PUT', undefined)).toMatchObject({ allow: false, status: 401 });
            expect(await authorizeObjectRequest('/file.bin', 'GET', undefined)).toMatchObject({ allow: false, status: 401 });   // root object
            // Authenticated but bucket unknown -> 403.
            state.credentials.app = { secretHash: await scryptHash('s'), enabled: true, grants: [{ bucket: '*', read: true, write: true }] };
            expect(await authorizeObjectRequest('/ghost/x', 'GET', basic('app', 's'))).toMatchObject({ allow: false, status: 403 });
        });

        it('an id-form object with no bucketId fails closed (not served unchecked)', async () => {
            state.objects['0123456789abcdef01234567'] = { bucketId: null };
            expect(await authorizeObjectRequest('/$0123456789abcdef01234567', 'GET', undefined))
                .toMatchObject({ allow: false, status: 401 });
        });

        it('a DB error during authorization fails closed to 503, never throwing out of the request path', async () => {
            const { database } = await import('../lib/database');
            (database.getBucketByName as any).mockRejectedValueOnce(new Error('mongo down'));
            const decision = await authorizeObjectRequest('/photo/x', 'GET', undefined);
            expect(decision).toMatchObject({ allow: false, status: 503 });
        });

        it('bounds concurrent scrypt verifications under a unique-secret flood', async () => {
            state.buckets.photo = { id: 'b1', name: 'photo' };
            state.credentials.app = { secretHash: await scryptHash('right'), enabled: true, grants: [{ bucket: 'photo', read: true, write: true }] };
            // Fire many DISTINCT wrong secrets at once (each a cache miss -> would each scrypt). The
            // concurrency cap must reject the excess (401) rather than schedule unbounded scrypt work.
            const results = await Promise.all(
                Array.from({ length: 30 }, (_, i) => authorizeObjectRequest('/photo/x', 'GET', basic('app', `wrong-${i}`)))
            );
            expect(results.every(r => r.allow === false)).toBe(true);
        });

        it('resolves the bucket of an id-form request via the object record', async () => {
            state.objects['0123456789abcdef01234567'] = { bucketId: 'b1' };
            state.bucketsById.b1 = { id: 'b1', name: 'photo', publicRead: true };
            expect(await authorizeObjectRequest('/$0123456789abcdef01234567', 'GET', undefined)).toEqual({ allow: true });
        });

        it('a revocation DURING an in-flight verify does not repopulate the cache', async () => {
            const { database } = await import('../lib/database');
            state.buckets.photo = { id: 'b1', name: 'photo' };
            const hash = await scryptHash('s3cret');
            const record = { secretHash: hash, enabled: true, grants: [{ bucket: 'photo', read: true, write: true }] };
            // Control the credential lookup so we can revoke while it is in flight.
            let release: (v: any) => void = () => {};
            (database.getCredentialByAccessKeyId as any).mockReturnValueOnce(new Promise(res => { release = res; }));
            const inflight = authorizeObjectRequest('/photo/x', 'GET', basic('app', 's3cret'));
            // Let the request progress PAST isAuthEnforced/resolveBucket and park on the credential lookup.
            await new Promise(res => setTimeout(res, 0));
            clearCredentialCache();               // admin revokes mid-verify
            release(record);                      // the in-flight lookup now resolves (pre-revocation state)
            await inflight;                       // this request may be honored, but MUST NOT cache

            // A subsequent request must RE-FETCH from the DB, not serve the stale positive from cache.
            (database.getCredentialByAccessKeyId as any).mockClear();
            (database.getCredentialByAccessKeyId as any).mockResolvedValue(record);
            await authorizeObjectRequest('/photo/x', 'GET', basic('app', 's3cret'));
            expect((database.getCredentialByAccessKeyId as any).mock.calls.length).toBe(1);
        });

        it('an authEnforced flip during an in-flight refresh is not masked by a stale cache write', async () => {
            const { database } = await import('../lib/database');
            // Empty cache (beforeEach invalidated). Control the flag read to race an invalidation against it.
            let release: (v: any) => void = () => {};
            (database.getRuntimeConfig as any).mockReturnValueOnce(new Promise(res => { release = res; }));
            const inflight = authorizeObjectRequest('/photo/a', 'GET', undefined);
            invalidateAuthEnforcedCache();        // admin flips + invalidates while the refresh is in flight
            release(false);                       // the in-flight read resolves with the now-stale 'false'
            await inflight;

            // The stale 'false' must not have been cached, so the next request re-reads -> now enforced.
            (database.getRuntimeConfig as any).mockResolvedValue(true);
            state.buckets = {};                   // unknown bucket under enforcement -> fail closed
            const decision = await authorizeObjectRequest('/photo/a', 'GET', undefined);
            expect(decision.allow).toBe(false);
        });

        it('caches a verified credential so scrypt does not run on every request', async () => {
            const { database } = await import('../lib/database');
            state.buckets.photo = { id: 'b1', name: 'photo' };
            state.credentials.app = { secretHash: await scryptHash('s3cret'), enabled: true, grants: [{ bucket: 'photo', read: true, write: true }] };
            (database.getCredentialByAccessKeyId as any).mockClear();
            for (let i = 0; i < 5; i++)
                expect(await authorizeObjectRequest('/photo/x', 'GET', basic('app', 's3cret'))).toEqual({ allow: true });
            // The credential row (and thus scrypt) is fetched once, then served from the verified cache.
            expect((database.getCredentialByAccessKeyId as any).mock.calls.length).toBe(1);
        });
    });
});
