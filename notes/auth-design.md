# Design: authentication, buckets, and access control

_Draft 2026-07-12. Reviewed against the code by an independent model (xhigh); its blocking findings — a same-origin stored-XSS path to admin compromise, root-object creation, and FUSE modes — are folded in below._

## Scope

- **Admin auth on the management API and UI — mandatory, no toggle.** Single password, no usernames yet. Three ways in: a **session cookie** (UI), **bearer tokens** (automation), and a **root-only Unix socket** (local ops, lockout recovery). Explicitly *not* a localhost bypass — see below.
- **Buckets** = top-level containers. Read and write each independently **public** or **private**.
- **Credentials** granting read/write on any set of buckets, including `*`. HTTP **Basic**.
- **UI** for buckets (object count, size), credentials, and permissions.
- **HTTP and HTTPS both served** for objects. Management API + UI live on a **separate admin origin** (own port, HTTPS-only), a self-issued cert (local CA + leaf, SANs from the host). The separate origin is a **security boundary**, not cosmetics — see the XSS blocker.

**Explicitly out of scope for now:** the S3-compatible API and SigV4. Recorded at the end with what it would cost, so the decision stays visible rather than becoming an accident.

## Where we're starting from

There is **no authentication anywhere.** Anyone who can reach port 80 can read, overwrite and delete every object — and can call `POST /$/volumes {blockPath, wipe}` and **repartition a disk**.

Current fleet: **7 buckets** (`photo`, `video`, `test`, `call-recordings`, `platform-tests`, `tunnel`, `sean`), 55,168 containers, 3.54M objects, and **zero objects at the root** — so "bucket = first path component" already holds universally, with no legacy exceptions.

---

## Dropping S3 removes most of the hard part

Worth stating explicitly, because it changes the shape of the work:

| Problem S3 would have created | Status |
|---|---|
| **`PUT` must overwrite.** S3 clients require it; STRUBS returns 409. Reusing an object id risks a **mixed-generation object** — every slice passing its own checksums while the object as a whole is garbage. The atomic reference swap it needs is impossible on standalone Mongo (no multi-document transactions; verified `hello.setName` unset), so it would have forced a replica-set conversion. | **Gone.** `PUT` stays immutable. |
| **SigV4 needs the raw secret** to HMAC each request, so credentials could not be hashed — only encrypted-at-rest, recoverable by anyone with root. | **Gone — and this is a security upgrade.** Basic only needs to *verify* a password, so secrets are **argon2id-hashed**. Root cannot recover them. |
| **Multipart upload.** `aws s3 cp` switches to multipart above 8 MB by default, and this is a media store full of multi-GB files — so it was not optional. Comparable in size to everything else here. | **Gone.** |
| **ListObjectsV2** — no HTTP listing endpoint exists at all; would need XML, prefix/delimiter translated onto the real container tree. | **Gone.** |

What survives is one genuine piece of groundwork:

### `bucketId` must be denormalised onto every object

Authorising a request means knowing its bucket. The path form is easy — first component of `/photo/2024/cat.jpg`. But an object is **also addressable by id** — `GET /$65f0a1b2c3d4e5f60718293a` (`helpers.ts:5`) — and a record only stores `containerId`, its *immediate* parent. Finding the bucket would mean walking up to the root, one lookup per level, on every request.

So: **store `bucketId` on every content document.**

- Set at creation from the container chain. Note `getOrCreateContainer` returns only the *final* container id (`content-repository.ts:612`), so it (or a companion) must also return the **top-level** id — resolving the bucket is a small addition, not free.
- **Backfill** the existing 3.54M objects and 55k containers — a one-off batched walk.
- Index it.

This is not only an auth fix. It is also what makes **per-bucket object counts and sizes a single `$group`** — which is exactly what the UI needs. Otherwise "how big is `photo`?" is a recursive walk of tens of thousands of containers. **The auth requirement and the UI requirement are the same problem.**

---

# Admin authentication

**Mandatory. No enable/disable toggle.** An unauthenticated `POST /$/volumes {wipe}` is a bigger hole than an unauthenticated `GET`, and it is a fraction of the work — so this ships **first**.

## ⚠️ BLOCKER: object content and the admin UI must not share an origin

The single most important finding of the review, and it changes the architecture. **The admin UI cannot live on the same origin as object content**, or a public-write bucket is a direct path to full admin compromise.

The chain is all present in today's code:

- `PUT` stores the caller's `Content-Type` verbatim (`object-put-request.ts:164`);
- `GET` serves it straight back (`object-response-headers.ts:15`);
- there is **no CSP, no `X-Content-Type-Options: nosniff`, no forced `Content-Disposition`** anywhere;
- object content, the management API, and the UI **all share one origin** (`server.ts:158`).

So: an anonymous writer to any `publicWrite` bucket uploads `evil.html` with `Content-Type: text/html`. An admin — already logged in, session cookie in the browser — opens `https://host/somebucket/evil.html`. The page is **same-origin** with the UI, so its JavaScript runs with the admin's cookie and does:

```js
fetch('/$/volumes', { method: 'POST', body: '{"blockPath":"/dev/sda","wipe":…}' })
```

**A CSRF token does not help** — same-origin script can simply read the token out of the page. `SameSite=Strict` does not help — the request *is* same-site. This is stored XSS with a disk-wipe as the payload.

Two ways to close it; do **both**, belt and braces:

1. **Separate origin for admin.** The UI and `/$/` on a **different port** (or host) from object content. A different port is a different origin, so object-hosted script cannot reach the admin cookie. This is the real fix; everything else is defence in depth.
2. **Neuter object responses.** On every object `GET`, regardless of origin: `X-Content-Type-Options: nosniff`, a restrictive `Content-Security-Policy` (`default-src 'none'`), and — for anything not on a short allowlist of genuinely-inert types (images, video, audio, `application/octet-stream`) — force `Content-Disposition: attachment` so the browser downloads rather than renders. HTML uploaded to a bucket should never *execute*; at most it should download.

This reshapes the listener table below: admin is not merely "HTTPS-only", it is **its own origin**.

## Login page + session, not HTTP Digest

Digest's only real advantage is avoiding a cleartext password on plaintext HTTP. But **object clients authenticate with Basic**, so credentials with `*` write are already going over the wire in the clear — and a `*`-write credential is worth more than the admin password. Protecting only the admin password with Digest is inconsistent, and it costs real things:

- **Its storage is worse.** Digest needs `HA1 = MD5(user:realm:pass)`, which is **password-equivalent** — steal it and you can authenticate. A login page stores an **argon2id** hash, which is not.
- **No logout.** There is no clean logout in HTTP auth. For a UI that can repartition disks, that matters.
- Browsers reliably support only the **MD5** variant; the native dialog is unstyled, with no session expiry and no lockout.

**Design:**

| | |
|---|---|
| **Password** | Single, no username. Hashed with **scrypt** (built into Node — no native dependency; argon2id's marginal edge is not worth the build cost in a codebase that fights native modules) in `runtimeConfig`. Never logged, never returned by any endpoint. |
| **UI login** | `POST /$/session {password}` → httpOnly, `SameSite=Strict`, `Secure`-when-TLS session cookie. `DELETE /$/session` = logout. Idle + absolute expiry. |
| **Lockout** | Rate-limit and back off on repeated failures — a single password with no username is a small keyspace to guess at. |
| **Bootstrap** | On first start with no password set, **generate a random one and print it to the log**. Never a default password, and **never an unauthenticated "set the password" endpoint** — that path would itself be the hole we are closing. Force a change on first login. |

---

# TLS

Three listeners, and **admin is its own origin** (see the blocker above — a different port *and* scheme, so object-hosted script cannot reach the admin cookie).

| Listener | Serves | Auth |
|---|---|---|
| **HTTP :80** | Object API **only** | Basic / anonymous |
| **HTTPS :443** | Management API + UI **only** | admin session / bearer |
| **Unix socket** | Management API | none — filesystem boundary (`0600 root:root`) |

The object API is on **:80 (HTTP)** and admin is on **:443 (HTTPS)** — chosen so the two are hard-separated by both port and scheme. `http://host/bucket/evil.html` is origin `http://host:80`, which has no `/$/` routes, so object-hosted script physically cannot reach the admin API; a stray request across the boundary is a **404**, never a redirect.

- **The object API is HTTP-only for now.** Basic credentials on :80 are in the clear — the documented, trusted-network compatibility trade. Object-over-TLS, if ever wanted, goes on a *third* port so it can never re-merge with the admin origin.
- The admin port is **HTTPS-only**, so the session cookie is unconditionally `Secure` and bearer tokens are never sniffable.
- `GET /` on :443 serves the login page. No HTTP→HTTPS redirect to reason about — the admin listener has no HTTP.

Ports are configurable (`STRUBS_HTTP_PORT` / `STRUBS_ADMIN_PORT`), defaulting to 80 / 443; today `80` is hardcoded at `server.ts:56`.

## Self-issued certificate

Generated on first start with `openssl` (3.0.13 is on the host; shelling out is consistent with `lsblk`/`parted`/`cryptsetup` and adds no dependency). Stored in `/var/lib/strubs/tls/`, mode `0600`.

**Issue a local CA and a leaf, not a bare self-signed certificate.** A bare self-signed cert means a browser warning *every time*, forever, and an admin who reflexively clicks through a TLS warning is an admin who will click through a real one. With a small CA, you install it once on the machines that administer the box and get a clean padlock.

```
/var/lib/strubs/tls/
├── ca.crt   ca.key    CN=STRUBS Local CA, 10 years, install once on admin machines
└── tls.crt  tls.key   398 days, auto-renewed, SANs derived from the host
```

### Don't invent a hostname — derive the SANs from the machine

An earlier draft baked in `strubs.local`. Don't. Nothing resolves it (no mDNS, no DNS entry), so it would be a name that exists only inside a certificate — the padlock would work by IP and the name would be decoration.

**The SAN list is what matters; browsers ignore CN entirely.** So generate it from what the machine actually *is*, at issue time:

| | |
|---|---|
| `localhost`, `127.0.0.1`, `::1` | always |
| the machine's **hostname** and FQDN | e.g. `objectstorage` — whatever it already answers to |
| `<hostname>.local` | free, and correct the moment anyone installs `avahi-daemon` |
| **every non-loopback IP** on the host | discovered at startup |
| `STRUBS_TLS_HOSTS=…` | anything else — a real DNS name, a VIP, a reverse-proxy name |

**Reissue automatically when that set changes.** An IP move (DHCP, a re-cabled network) otherwise silently breaks the padlock and nobody notices until they need the UI. Comparing the computed SAN set against the current certificate at startup, and reissuing on a mismatch, makes the whole question self-healing — and costs a few milliseconds of `openssl` a year.

This means **no naming decision is required to ship**, and no dependency on mDNS or DNS. If a stable name is wanted later, add it to `STRUBS_TLS_HOSTS` (and install `avahi-daemon` if `.local` is the flavour preferred); the cert picks it up on the next start.

Verified end-to-end on this host: CA + leaf, chain validates, HTTPS serves with it, and plain HTTP refuses `/$/`.

**Print the CA fingerprint to the log on first generation**, so whoever installs it can verify what they are trusting rather than blindly importing a file off a box.

**Installing this CA makes the STRUBS box a trusted certificate authority on every admin machine** — it can then mint a valid cert for *any* site, not just STRUBS. So: `ca.key` is `0600 root`, never leaves the box, and is a candidate to encrypt at rest alongside the instance identity. Where the platform supports it, add a **name constraint** to the CA limiting it to the STRUBS SANs, so a stolen `ca.key` cannot impersonate `google.com` to those machines. This is the real cost of the clean-padlock convenience, and it should be a conscious choice.

**Leaf validity 398 days, auto-renewed** when fewer than 30 days remain. 398 is not arbitrary — it is the maximum modern browsers accept, and a longer cert is silently rejected by Safari and Chrome. Auto-renewal on startup means the question never comes up.

**Bring-your-own certificate** is supported: config paths for a cert and key override the self-issued pair, for anyone with real internal PKI.

### ⚠️ Do not enable HSTS

With a self-signed CA this would be a **lockout trap**. HSTS forbids the browser's click-through bypass — so if the certificate expires, the CA is not installed on a given machine, or anything else goes wrong with TLS, you cannot reach your own admin UI at all, from that browser, until the HSTS entry expires. The safety it buys is redundant here (the admin API is HTTPS-only anyway); the failure mode is losing access to the thing that fixes it.

### On reaching it by name

Optional, and deliberately not a dependency. Today the host answers to `objectstorage` only via its own `/etc/hosts` (`127.0.1.1`) — nothing on the LAN resolves it, and there is no mDNS responder.

Since the certificate covers the host's IPs, `https://<ip>/` works the moment the CA is installed. If a name is wanted:

- install **`avahi-daemon`** → `<hostname>.local` resolves across the LAN with no client config (this is what `.local` exists for);
- or add a DNS/hosts entry and list it in `STRUBS_TLS_HOSTS`.

Either way the certificate already covers it, and nothing breaks if neither happens.

> Note the residual honesty: HTTP object traffic still carries Basic credentials in the clear. That is a deliberate compatibility choice, not an oversight. Clients that care should use HTTPS — it is available on the same host, with the same credentials, and the CA is right there.

## Three ways in, and none of them is "trust the network"

An admin API you cannot easily `curl` will be worked around, and the workaround will be worse than anything designed here. So there must be an easy path — just not a *loose* one.

### ❌ NOT a localhost bypass

The tempting answer is "requests from 127.0.0.1 skip auth". **Do not.** It is the classic catastrophic misconfiguration, and this project is on a direct path to triggering it:

> **We intend to put TLS in front of this.** The moment a reverse proxy exists — nginx, Caddy, anything — it connects to STRUBS *from localhost*. Every request from the entire internet then arrives with a loopback peer address, and the management API is open to the world. **Silently.**

Inspecting `socket.remoteAddress` rather than `X-Forwarded-For` does not save you: the proxy genuinely *is* on localhost. And secondarily, any SSRF in any other service on the box becomes "repartition a disk", while "local user == trusted" is an assumption that ages badly.

The boundary must be one that cannot silently erode. A network boundary can. A filesystem boundary cannot.

### ✅ 1. A root-only Unix domain socket — local ops and lockout recovery

`/run/strubs/admin.sock`, mode **`0600 root:root`**. Serves the same `/$/` routes with **no credential at all** — the boundary is the *filesystem*, not the network.

```bash
curl --unix-socket /run/strubs/admin.sock http://localhost/\$/volumes
```

Structurally safe in a way a localhost TCP bypass is not: a reverse proxy forwards to a **TCP port**, so it cannot accidentally inherit this. URL-based SSRF cannot reach a Unix socket either. Node's `server.listen(path)` supports it directly, so it is a second listener over the same router — not a second implementation.

It is also the **lockout recovery path**: forget the admin password and you reset it over the socket, rather than hand-editing Mongo at 2am.

*(Granting root full admin concedes nothing: root can already read every slice off the disks and stop the service.)*

### ✅ 2. Admin API tokens — scripted and remote automation

Bearer tokens, issued from the UI, **argon2-hashed at rest**, individually revocable, with `lastUsedAt` surfaced.

```bash
curl -H "Authorization: Bearer $STRUBS_ADMIN_TOKEN" https://strubs/\$/rebalance
```

This reuses the exact machinery being built for bucket credentials — a hash and a lookup — so it is close to free.

**Deliberately *not* Basic-with-the-admin-password.** Tokens beat it on every axis: revocable per consumer, never sitting in shell history or a CI environment variable, and rotating one does not log every admin out of the UI.

### ✅ 3. Session cookie — the UI

As above.

## Everything under `/$/` requires admin

All management routes, and the UI bundle itself. One exception worth considering: a minimal `GET /$/health` for monitoring — keep it boring, and leak nothing.

---

# Buckets

A bucket **is** a top-level container (`containerId: null, isContainer: true`). No new collection; extend the document:

```js
{ _id, name: "photo", isContainer: true, containerId: null,
  publicRead:  false,      // anonymous GET/HEAD allowed
  publicWrite: false,      // anonymous PUT/DELETE allowed
  createdAt, updatedAt }
```

Two independent booleans, as asked. `publicRead` without `publicWrite` is the common case (a public photo bucket); `publicWrite` without `publicRead` is a legitimate drop-box.

> **`publicWrite` means anonymous DELETE.** The UI must say that in those words, not hide it behind a toggle labelled "write".

**Bucket creation becomes explicit, and root objects are refused outright.** Two current behaviours have to change (both are in code, not just convention):

- `PUT /newthing/x.jpg` silently creates the `newthing` bucket (`object-put-request.ts:174`). Once buckets carry policy, an implicit bucket has *no considered policy* — so creating a **top-level** container is refused unless the credential holds an explicit `createBucket` grant (or is admin). Nested containers still create implicitly; only the top level is special.
- `PUT /file.bin` — a **single-component path** — creates an object *at the root*, with no bucket at all (`object-put-request.ts:174`; there is a test asserting exactly this, `object-requests.test.ts:436`). A root object has no bucket, so it has no policy, so it cannot be authorised. **Reject single-component object paths** (`400`, "objects must live in a bucket"). This is safe today precisely because production has **zero** root objects — but the code allows it, so auth must close it explicitly rather than assume.

---

# Credentials

```js
{ _id, name: "photo-app",
  accessKeyId: "…",                 // opaque, unique, indexed
  secretHash: <argon2id>,           // HASHED -- we only ever verify, never reproduce
  grants: [
    { bucket: "photo", read: true,  write: true  },
    { bucket: "video", read: true,  write: false },
    { bucket: "*",     read: true,  write: false }
  ],
  enabled: true,
  createdAt, lastUsedAt, expiresAt? }
```

**The secret is shown once, at creation, and never again** — there is nothing to show, because we only keep a hash. Rotation issues a new secret.

**Resolution:** the effective permission on a bucket is the **union** of every matching grant (explicit and `*`). There are no deny rules — so union is unambiguous and there is nothing to reason about at 3am. If deny is ever wanted, that should be a deliberate decision, not an accident of precedence.

**Two implementation traps, flagged by review:**

- **Argon2 on every object request is a CPU DoS.** Argon2id is deliberately expensive (that is the point for a login); running it per `GET` lets an attacker pin the CPU with a flood of Basic requests. So: look the credential up by its **access-key id** (indexed), argon2-verify **once**, then cache the *verified* result for a short TTL keyed by `(accessKeyId, secretHash-of-presented)`. Bounded argon2 parameters, and never argon2 on the anonymous path at all.
- **A bearer token must be look-up-able without a table scan.** A purely opaque, fully-hashed token can only be found by argon2-ing it against every row. Give tokens a `selector.secret` shape — the `selector` is stored plaintext and indexed for the lookup; only the `secret` half is argon2-hashed and verified. Same pattern applies to admin bearer tokens and, if ever needed, to a fast credential lookup.

---

# The decision, in exactly one place

```
authorize(request) -> allow | deny

1. Which bucket?
     /photo/2024/cat.jpg   -> first path component
     /$65f0a1b2…           -> the record's denormalised bucketId
2. Who?
     Authorization: Basic … -> look up accessKeyId, argon2-verify the secret
     (none)                 -> anonymous
3. Decide.
     anonymous  -> allowed only if bucket.publicRead (read) / publicWrite (write)
     credential -> allowed iff some grant matches the bucket (or *) with the action bit
4. Deny:
     401 + WWW-Authenticate: Basic realm="strubs"   if anonymous
          (so a browser prompts, and a public-read bucket still works from <img src>)
     403                                            if authenticated but not permitted
```

`GET`/`HEAD`/`OPTIONS` are reads; `PUT`/`DELETE` are writes.

**Authorise on the SAME bytes that address storage.** The server does not URL-decode path components before the DB lookup (`server.ts:142`, `content-repository.ts:45`) — the raw path *is* the key. So authz must run on the raw path too. If auth decodes `%2F`/`%2e`, normalises unicode, or lowercases while storage does not, then `photo` and `Photo` and `pho%74o` can mean one bucket to the permission check and another to the lookup — a classic confused-deputy bypass. One parse, shared by both.

**Pin a strict bucket-name grammar now, while there are only seven.** Lowercase ASCII letters, digits, and hyphen; 3–63 chars; no leading/trailing hyphen. This closes unicode confusables, encoded-slash tricks, the `$`-prefix collision with the id form, and case-policy surprises in a single rule — and it costs nothing today because every existing bucket already conforms.

**One enforcement point**, in `HttpServer._handleHttpRequest` (`server.ts:101`), *before* `_resolveRoute` — not sprinkled through the five `object-*-request.ts` handlers. A permission check that must be remembered in five places is one that will be forgotten in one.

## FUSE bypasses all of it

**FUSE is now opt-in (`STRUBS_FUSE_ENABLED`, default off).** Shipped this session: when disabled the manager skips the mount entirely and never loads the native binding, so a host without `/dev/fuse` runs fine; our deployment enables it via a systemd drop-in. Its security caveats below apply only when it is turned on.

The mount at `/run/strubs/data` has no notion of credentials — no bucket policy, no login, nothing. It is a second, unauthenticated read path to **every** object, and it needs more than a `0700` mount directory:

- The FUSE layer itself presents directories as `0755` and files as `0644` (`fuse/server.ts:152`, `:166`), and supports `readdir` + `read` (`:192`, `:255`). So if it is ever mounted with `allow_other` (or the kernel is configured to permit it), **any local user reads the whole array**, mount-dir permissions notwithstanding.
- So: mount with `default_permissions` and **without** `allow_other`, present restrictive modes, own the mount `0700 root`, AND document that FUSE is a policy bypass by design. It is acceptable *because* it is local and root-only — but that has to be a stated, enforced property, not an accident of defaults.

This is fine for the current single-root-user box. It becomes a hole the instant someone adds a second local user or an `allow_other` for convenience.

---

# UI

- **Buckets**: each with **object count and total size** (a single `$group` on `bucketId`, refreshed like `storageStats` rather than computed per page load), public-read / public-write toggles with the DELETE warning spelled out, and a create-bucket action.
- **Credentials**: create (secret shown **once**, copy-to-clipboard, then gone forever), list (name, access key id, grants, last used, enabled), edit grants, disable, delete, rotate.
- **Login page**, session, logout, and a forced password change on first login.
- A prominent banner while `authEnforced = false`: **"the object API is unauthenticated"**. A half-configured system that *looks* secure is worse than one that is obviously open.

---

# Rollout

The pipeline is entirely under our control, so there is no need to discover unknown consumers — we know who talks to this and when to flip the switch.

```
1. Ship admin auth. Mandatory from day one. This alone closes the wipe-a-disk hole.
2. Ship the bucket/credential model with  authEnforced = false.
     Buckets default to publicRead = publicWrite = true -> behaviour identical to today.
3. Provision credentials; update the consumers.
4. Flip authEnforced = true, and tighten each bucket's public flags.
```

Keep an **anonymous-request counter per bucket** anyway, surfaced in the UI. Not because we don't know who the consumers are — but because it turns "we've updated everything" into *knowing* we have, and it costs almost nothing at the choke point we're already building.

---

# Phasing

| | | |
|---|---|---|
| **0** | **Listener split + TLS**: object listeners (HTTP/HTTPS) and a **separate admin origin** (own HTTPS port); self-issued CA + leaf, SANs from the host, auto-reissued on change; configurable ports; **harden object responses** (`nosniff`, `Content-Security-Policy`, forced `Content-Disposition` off the inert-type allowlist) | The origin split is a security boundary, not cosmetics — it must exist before any admin cookie does |
| **1** | **Admin auth**: argon2 password, session + login page, **admin bearer tokens** (selector.secret), **root-only Unix socket**, everything on the admin origin gated, bootstrap password to the log | **Closes the disk-wipe hole. Ships first.** |
| **2** | `bucketId` denormalisation + backfill; bucket policy fields; per-bucket stats aggregation | Unblocks everything else; breaks nothing; immediately gives the UI real numbers |
| **3** | Credentials collection; the single `authorize()` choke point; Basic auth on the object API; anonymous-request counters — all with `authEnforced = false` | The whole model, dark |
| **4** | UI: login, buckets, credentials, settings | Makes it operable |
| **5** | Provision credentials, update consumers, `authEnforced = true` | The actual security win |

---

# Deferred: the S3-compatible API

Not being built now. Recorded so the decision stays visible.

If it is ever wanted, it drags in **all four** of the problems listed at the top: overwrite semantics (and therefore a Mongo replica set for atomic swaps, or a mixed-generation corruption risk), recoverable — not hashed — secrets for SigV4, multipart upload, and ListObjectsV2 with prefix/delimiter mapped onto the real container tree. Roughly doubles this project.

If it becomes a requirement, the sane order is **S3 read first** (SigV4, GET/HEAD, ListBuckets, ListObjectsV2, XML errors) — high value, cannot corrupt anything — and S3 *write* only after. Shipping half of S3 write is worse than none: a client that PUTs small objects but dies on multipart fails silently and late.

---

# Open questions

- **Per-prefix permissions** (`photo/2024/*` but not `photo/2023/*`)? Not asked for. Bucket-level is a clean, comprehensible boundary; prefix ACLs are where object stores become incomprehensible. Recommend staying at bucket level until there is a concrete need.
- **Audit log** — who deleted that object? Cheap to add at the choke point we're already building; expensive to retrofit later.
- **Rate limiting.** A `publicWrite` bucket on a reachable network is an open drop-box with 130 TB behind it.
