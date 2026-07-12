import crypto from 'crypto';

import { database } from '../../database';
import type { Grant } from '../../database/credential-repository';
import { createLogger } from '../../log';
import { scryptVerify } from './secret-hash';

const log = createLogger('object-authz');

// Bucket-name grammar, pinned strict while there are only a handful of buckets and every one already
// conforms: lowercase ASCII letters/digits/hyphen, 3-63 chars, no leading/trailing hyphen. This closes
// unicode confusables, encoded-slash tricks, and the `$`-prefix collision with the id form in one rule.
const BUCKET_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
export function isValidBucketName(name: string): boolean {
    return BUCKET_NAME_RE.test(name);
}

// The object id form is exactly `/$` + 24 lowercase-or-upper hex chars (see helpers.ts getObjectMeta).
const ID_FORM_RE = /^\/\$[0-9a-f]{24}$/i;

export type AuthzDecision =
    | { allow: true }
    | { allow: false; status: 401 | 403 | 503; message: string };

type Identity = { accessKeyId: string; secret: string };

// --- authEnforced flag, cached briefly so the dark path doesn't hit Mongo on every object request ---
const AUTH_ENFORCED_KEY = 'authEnforced';
const ENFORCED_TTL_MS = 5000;
let enforcedCache: { value: boolean; at: number } | null = null;
let enforcedInFlight: Promise<boolean> | null = null;
// Bumped on every invalidateAuthEnforcedCache(). A refresh that started before an invalidation must not
// write its now-stale value into enforcedCache after it -- else flipping authEnforced=true could be
// masked by an old "false" read for a full TTL, silently bypassing enforcement.
let enforcedEpoch = 0;

async function isAuthEnforced(now: number): Promise<boolean> {
    if (enforcedCache && now - enforcedCache.at < ENFORCED_TTL_MS)
        return enforcedCache.value;
    // Single-flight: on cache expiry a burst of concurrent object requests must not each fire a
    // getRuntimeConfig read (and each block on it). The first refreshes; the rest await the same promise.
    if (enforcedInFlight)
        return enforcedInFlight;
    const epochAtStart = enforcedEpoch;
    enforcedInFlight = (async () => {
        let value = false;
        try {
            value = (await database.getRuntimeConfig(AUTH_ENFORCED_KEY)) === true;
        }
        catch (err) {
            // Fail to NOT-enforced (today's behaviour) rather than locking out the whole object API on a
            // transient DB blip. The enforced-path lookups below fail CLOSED; only this flag read fails open.
            log.error('could not read authEnforced flag, assuming disabled: %s', err);
            value = false;
        }
        // Only cache if no invalidation raced us; otherwise return the value to current awaiters without
        // persisting it, so the next request re-reads fresh.
        if (enforcedEpoch === epochAtStart)
            enforcedCache = { value, at: Date.now() };
        return value;
    })().finally(() => { enforcedInFlight = null; });
    return enforcedInFlight;
}

export function invalidateAuthEnforcedCache(): void {
    enforcedCache = null;
    enforcedInFlight = null;
    enforcedEpoch++;
}

// --- per-bucket request counters (in-memory; surfaced in the UI to confirm consumers have migrated) ---
// The key is the raw first path segment, which an anonymous client fully controls -- so the map MUST be
// bounded or a flood of distinct random paths (/aaa/x, /bbb/x, ...) would grow it without limit. Real
// deployments have a handful of buckets; once the cap is hit, further NEW keys fold into '(overflow)'
// rather than allocating, so memory stays bounded while existing buckets keep counting.
type BucketCounter = { anon: number; auth: number };
const counters = new Map<string, BucketCounter>();
const COUNTER_MAX_KEYS = 1024;
const OVERFLOW_KEY = '(overflow)';

function countRequest(bucketKey: string, hadCredential: boolean): void {
    let c = counters.get(bucketKey);
    if (!c) {
        if (counters.size >= COUNTER_MAX_KEYS) {
            // At the cap: fold this new key into a single shared overflow counter, creating that counter
            // once if needed (map settles at COUNTER_MAX_KEYS + 1 entries, never more).
            c = counters.get(OVERFLOW_KEY);
            if (!c) { c = { anon: 0, auth: 0 }; counters.set(OVERFLOW_KEY, c); }
        }
        else {
            c = { anon: 0, auth: 0 };
            counters.set(bucketKey, c);
        }
    }
    if (hadCredential) c.auth++; else c.anon++;
}

export function getBucketActivity(): Record<string, BucketCounter> {
    const out: Record<string, BucketCounter> = {};
    for (const [k, v] of counters) out[k] = { ...v };
    return out;
}

export function resetBucketActivity(): void {
    counters.clear();
}

// --- verified-credential cache (bounds scrypt: verify once per (accessKeyId, presented-secret), TTL) ---
const CRED_TTL_MS = 60_000;
const CRED_CACHE_MAX = 4096;
// Cap concurrent scrypt verifications. The cache bounds REPEATED (accessKeyId, secret) pairs, but an
// attacker varying the secret for a known key defeats it -- every unique secret is a cache miss and a
// fresh scrypt. This global in-flight cap keeps such a flood from pinning the CPU: once it is reached,
// further first-time verifications are refused (treated as an auth failure) rather than queued.
const VERIFY_MAX_CONCURRENT = 4;
let verifyInFlight = 0;
// Generation counter bumped on every clearCredentialCache(). A verification that STARTED before a
// revocation must not be allowed to repopulate the cache after it: we capture the epoch before the async
// work and refuse to write the result if it changed. Without this, an admin disabling/rotating a
// credential mid-verify could see the stale positive re-cached for the full TTL.
let credCacheEpoch = 0;
type CachedVerify = { ok: boolean; grants: Grant[]; expires: number };
const credCache = new Map<string, CachedVerify>();

function credCacheKey(accessKeyId: string, secret: string): string {
    // Hash the secret so it isn't held in plaintext in the cache key.
    return accessKeyId + ':' + crypto.createHash('sha256').update(secret).digest('base64');
}

// Verify a presented credential, caching BOTH positive and negative results for a short TTL. Caching the
// negative bounds scrypt work under a flood of REPEATED wrong secrets; the concurrency cap bounds it under
// a flood of UNIQUE secrets; caching the positive avoids scrypt on every legitimate request. Returns the
// grants on success, or null on any failure (unknown key, disabled, expired, bad secret, or throttled).
async function verifyCredential(identity: Identity, now: number): Promise<Grant[] | null> {
    const key = credCacheKey(identity.accessKeyId, identity.secret);
    const cached = credCache.get(key);
    if (cached && cached.expires > now)
        return cached.ok ? cached.grants : null;

    // Atomic check-then-increment (no await between) so a concurrent burst cannot all pass the cap.
    if (verifyInFlight >= VERIFY_MAX_CONCURRENT)
        return null;
    const epochAtStart = credCacheEpoch;
    verifyInFlight++;
    let ok = false;
    let grants: Grant[] = [];
    try {
        const record = await database.getCredentialByAccessKeyId(identity.accessKeyId);
        if (record && record.enabled
            && (!record.expiresAt || record.expiresAt.getTime() > now)
            && await scryptVerify(identity.secret, record.secretHash)) {
            ok = true;
            grants = record.grants ?? [];
        }
    }
    finally {
        verifyInFlight--;
    }

    // Only populate the cache if no revocation happened while we were verifying. If it did, this result
    // may reflect pre-revocation state -- serve it for THIS request, but never let it poison the cache;
    // subsequent requests re-verify against the now-empty cache and fresh DB state.
    if (credCacheEpoch === epochAtStart) {
        if (credCache.size >= CRED_CACHE_MAX)
            sweepCredCache(now);
        credCache.set(key, { ok, grants, expires: now + CRED_TTL_MS });
    }
    if (ok)
        void database.touchCredential(identity.accessKeyId, new Date(now)).catch(() => undefined);
    return ok ? grants : null;
}

function sweepCredCache(now: number): void {
    for (const [k, v] of credCache)
        if (v.expires <= now) credCache.delete(k);
    // If everything is still live and we're at the cap, drop the oldest-inserted (Map preserves order).
    if (credCache.size >= CRED_CACHE_MAX) {
        const excess = credCache.size - CRED_CACHE_MAX + 1;
        let i = 0;
        for (const k of credCache.keys()) { credCache.delete(k); if (++i >= excess) break; }
    }
}

export function clearCredentialCache(): void {
    credCache.clear();
    // Bump the epoch so any verification already in flight refuses to repopulate the cache after this.
    credCacheEpoch++;
}

// Parse HTTP Basic credentials. accessKeyId is the username, secret the password. The secret may itself
// contain ':' -- only the FIRST colon separates the two.
export function parseBasicAuth(header: string | undefined): Identity | null {
    if (!header) return null;
    const match = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(header.trim());
    if (!match) return null;
    let decoded: string;
    try { decoded = Buffer.from(match[1], 'base64').toString('utf8'); }
    catch { return null; }
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    const accessKeyId = decoded.slice(0, colon);
    const secret = decoded.slice(colon + 1);
    if (!accessKeyId || !secret) return null;
    return { accessKeyId, secret };
}

// The bucket a raw request path addresses, WITHOUT any decoding -- authorisation runs on the exact bytes
// that address storage (the server does not URL-decode before the DB lookup), so a confused-deputy split
// between "what auth checked" and "what got served" is impossible. Returns:
//   { form:'id' }              -> object addressed by id; the bucket needs a DB lookup (enforced path only)
//   { form:'path', bucket }    -> the first path component
//   { form:'none' }            -> no bucket in the path (root object / empty)
export function bucketRefFromPath(rawUrl: string): { form: 'id' } | { form: 'path'; bucket: string } | { form: 'none' } {
    const path = rawUrl.split('?')[0];
    if (ID_FORM_RE.test(path))
        return { form: 'id' };
    const first = path.replace(/^\/+/, '').split('/')[0];
    if (!first)
        return { form: 'none' };
    return { form: 'path', bucket: first };
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// The single object-API authorisation decision. While authEnforced is false (the default, and where the
// system ships) it ALWAYS allows -- behaviour, and cost, identical to today -- and only bumps a per-bucket
// counter so the UI can show whether anonymous traffic is still arriving. Flipping authEnforced activates
// the full policy check below. Enforcement failures are the ONLY denials; the dark path never blocks.
export async function authorizeObjectRequest(rawUrl: string, method: string, authHeader: string | undefined): Promise<AuthzDecision> {
    const now = Date.now();
    const isWrite = !READ_METHODS.has(method);
    const identity = parseBasicAuth(authHeader);
    const ref = bucketRefFromPath(rawUrl);
    const counterKey = ref.form === 'path' ? ref.bucket : (ref.form === 'id' ? '(by-id)' : '(root)');
    countRequest(counterKey, identity !== null);

    if (!await isAuthEnforced(now))
        return { allow: true };

    // --- enforcement path (dark until an operator flips authEnforced) ---
    // Wrapped so a DB error during bucket/credential resolution can NEVER reject out of the request path
    // (this runs before the handler's own try/catch): it fails CLOSED to a 503 deny instead.
    try {
        const bucket = await resolveBucket(ref, rawUrl);
        if (!bucket) {
            // We cannot tie this request to a known bucket. Storage can still serve root objects,
            // invalid-name trees, or id-form objects lacking bucketId, so "let the handler 404" would be a
            // read BYPASS. Fail closed for reads AND writes: 401 so an anonymous caller can present
            // credentials, 403 if it already did.
            return identity
                ? { allow: false, status: 403, message: 'unknown or unauthorized bucket' }
                : { allow: false, status: 401, message: 'authentication required' };
        }

        if (!identity) {
            const permitted = isWrite ? bucket.publicWrite === true : bucket.publicRead === true;
            return permitted
                ? { allow: true }
                : { allow: false, status: 401, message: 'authentication required' };
        }

        const grants = await verifyCredential(identity, now);
        if (!grants)
            return { allow: false, status: 401, message: 'invalid credentials' };
        const permitted = grants.some(g =>
            (g.bucket === bucket.name || g.bucket === '*') && (isWrite ? g.write : g.read));
        return permitted
            ? { allow: true }
            : { allow: false, status: 403, message: 'not permitted for this bucket' };
    }
    catch (err) {
        log.error('authorization error, failing closed: %s', err);
        return { allow: false, status: 503, message: 'authorization temporarily unavailable' };
    }
}

type ResolvedBucket = { name: string; publicRead?: boolean; publicWrite?: boolean };

async function resolveBucket(ref: ReturnType<typeof bucketRefFromPath>, rawUrl: string): Promise<ResolvedBucket | null> {
    if (ref.form === 'none')
        return null;
    if (ref.form === 'id') {
        // Object addressed by id: find its record, then its bucket via the denormalised bucketId. This
        // double lookup runs ONLY on the enforced path (never while dark), so it costs nothing today.
        const id = rawUrl.split('?')[0].slice(2);
        let bucketId: string | null = null;
        try {
            const record = await database.getObjectById(id);
            bucketId = record.bucketId ? String(record.bucketId) : null;
        }
        catch (err) {
            // A genuinely missing object -> unknown bucket (null). Any OTHER error (DB down, etc.) must
            // propagate so authorizeObjectRequest fails closed to a 503, not a misleading "unknown bucket".
            if ((err as { code?: string })?.code === 'ENOENT')
                return null;
            throw err;
        }
        if (!bucketId) return null;
        const bucketDoc = await database.getBucketById(bucketId);
        return bucketDoc ? toResolved(bucketDoc) : null;
    }
    if (!isValidBucketName(ref.bucket))
        return null;
    const doc = await database.getBucketByName(ref.bucket);
    return doc ? toResolved(doc) : null;
}

function toResolved(doc: { name: string; publicRead?: boolean; publicWrite?: boolean }): ResolvedBucket {
    return { name: doc.name, publicRead: doc.publicRead, publicWrite: doc.publicWrite };
}
