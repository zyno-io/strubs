# Access control

STRUBS has two HTTP surfaces, and they are deliberately not the same thing:

| | Object API | Admin surface (management API + UI) |
|---|---|---|
| Listener | HTTP on `STRUBS_HTTP_PORT` (**80**) | **HTTPS only**, on `STRUBS_ADMIN_PORT` (**443**) |
| Paths | everything except `/$/…` | only `/$/…` |
| Authentication | **off by default** (see [below](#the-object-api-is-dark-by-default)) | **always on** — password session or bearer token |

They are separate **origins** — different port *and* different scheme — and that separation is a security
boundary, not tidiness. Object content is attacker-supplied bytes served from the object origin; if the admin
API lived on the same origin, one stored-XSS in an uploaded HTML file could call `POST /$/volumes` and
reformat a disk. A browser cannot reach across an origin, so it can't.

The boundary is enforced as a hard failure in both directions: an object path on the admin listener is a flat
**404**, and a `/$/` path on the plain-HTTP object listener gets **421 Misdirected Request** pointing at the
HTTPS URL. Only a genuine top-level browser navigation (`Sec-Fetch-Mode: navigate`) is redirected, so that
typing the bare hostname still lands on the login page. A script fetch never gets a redirect — cookies are not
port-scoped, so 308-ing a `POST` would re-send the admin cookie to the admin origin and reopen the exact hole
the split closes.

## The admin surface

### It is HTTPS, with a certificate it issues itself

On first start STRUBS generates a local CA and a leaf certificate for the admin listener, in
`STRUBS_TLS_DIR` (`/var/lib/strubs/tls`):

```
ca.key  ca.crt        the local CA — ca.key must never leave the box
tls.key tls.crt       the leaf, auto-renewed 30 days before it expires
tls.sans              what the leaf was issued for
```

The SAN list is derived from what the machine actually *is* at issue time: `localhost`, `127.0.0.1`, `::1`,
the hostname (plus `<hostname>.local`), and every non-internal IP on the box. Add anything else — a real DNS
name, a VIP — with `STRUBS_TLS_HOSTS`. Change the machine's addresses and the leaf is reissued, because
browsers authenticate on SANs alone and an IP move otherwise silently breaks trust. Leaves are valid for 398
days, the browser maximum.

To stop the browser warning, install `ca.crt` as a trusted root on your workstation — but check what you're
trusting first, because installing it makes this host a certificate authority on that machine. STRUBS logs the
fingerprint when it generates the CA, exactly so you can compare:

```bash
openssl x509 -in /var/lib/strubs/tls/ca.crt -noout -fingerprint -sha256
```

To use your own certificate instead, set **both** `STRUBS_TLS_CERT` and `STRUBS_TLS_KEY` — that
short-circuits everything self-issued and STRUBS generates nothing.

For `curl`, either point it at the CA or skip verification:

```bash
curl --cacert /var/lib/strubs/tls/ca.crt https://strubs/\$/status
curl -k https://strubs/\$/status
```

### There is a password, and you did not choose it

On first start with no password set, STRUBS **generates a random one and prints it to the log, once**:

```
=================================================================
  NO ADMIN PASSWORD SET -- generated one. Change it after login.
  admin password: kJ8x2mQvR7pN4sT1wY
=================================================================
```

`journalctl -u strubs | grep -A2 'NO ADMIN PASSWORD'` will find it. There is deliberately no default password
and no unauthenticated "set the password" endpoint — that endpoint *would be* the hole. Change it after you
log in (`PUT /$/admin/password`, which requires the current one and logs every session out).

The password is stored as an scrypt hash in `runtimeConfig`. Failed logins are throttled globally — 5 failures
buys a 30-second lockout, and no more than 3 password verifications run at once — so a small keyspace behind an
expensive hash can't be ground down, and can't be used to pin the CPU. Both return **429**.

### Sessions

`POST /$/session` with `{"password":"…"}` sets the `strubs_admin` cookie: `HttpOnly`, `Secure`,
`SameSite=Strict`.

The cookie is a **stateless signed token** — an HMAC over `{issued-at, token-issued-at, epoch}` — not a key
into a server-side map. Sessions used to be that map, which meant every deploy silently logged the operator
out; now nothing is held server-side and a restart is invisible (the signing key lives in `runtimeConfig`, so
it survives too).

| | |
|---|---|
| Idle timeout | 12 hours, sliding — the token is re-issued once it's over an hour old, so an active session never expires |
| Absolute cap | 7 days from first login, and refreshing does **not** move it |
| Revocation | an **epoch** counter, also persisted |

Statelessness costs you the ability to forget one token, so revocation is wholesale: logout and password
change both bump the epoch, invalidating every outstanding token at once. On a single-admin system "log out"
therefore means "log out everywhere" — the safe reading, and unlike an in-memory denylist it can't be undone by
a restart.

### Bearer tokens, for automation

A script shouldn't hold the admin password. Issue it a token instead:

```bash
curl -X POST https://strubs/\$/admin/tokens \
     -H 'Content-Type: application/json' -d '{"name":"backup-cron"}'
# -> {"token":"AbCdEf123456.9x8y7z…","selector":"AbCdEf123456"}

curl -H 'Authorization: Bearer AbCdEf123456.9x8y7z…' https://strubs/\$/status
```

The token is `selector.secret`: the selector is stored in plaintext and indexed, the secret only as an scrypt
hash. **It is shown once and never again.** Tokens are independent credentials, like SSH keys — a password
rotation deliberately does *not* revoke them, so rotating your password doesn't silently break CI. When you
do need to lock everything out, `DELETE /$/admin/tokens` purges all of them at once.

### CSRF

Mutating `/$/` requests are rejected when the browser says they came from another site
(`Sec-Fetch-Site` is present and not `same-origin`/`none`). Browsers set that header unforgeably; non-browser
clients omit it and are unaffected. It applies to `POST /$/session` too, so a cross-site page can't drive login
attempts. This is belt-and-braces over `SameSite=Strict` and the origin split.

### The root-only Unix socket

The admin API is also served on `/run/strubs/admin.sock` (`STRUBS_ADMIN_SOCKET`) with **no credential check
at all**. The boundary here is filesystem permissions — the socket is chmod `0600` root, and if STRUBS cannot
secure it, it **exits rather than run**. That's a stronger boundary than a localhost TCP port, which a reverse
proxy or an SSRF bug can reach and a file mode can't be tricked into.

It's the local-ops path, and the way out of a lockout:

```bash
# from a root shell on the box — no password needed
curl --unix-socket /run/strubs/admin.sock http://localhost/\$/status

# forgot the admin password: set a new one with no current one
curl --unix-socket /run/strubs/admin.sock -X PUT http://localhost/\$/admin/password \
     -H 'Content-Type: application/json' -d '{"newPassword":"something-long"}'
```

Over the network that same endpoint requires `currentPassword`; you're using the socket precisely because you
no longer have it.

### What is reachable without logging in

Only the things that are *how* you log in: the UI bundle (`/$/ui*` — it's the login page), `/$/session`
(login and logout), and `/$/auth/status`, which is how the SPA decides whether to render a login form or the
dashboard. Everything else under `/$/` requires a session or a bearer token.

Separately, when the namespace is missing (a restore is pending), the management API drops to a small
**allowlist** — restore, recover-fleet, enough auth to reach them, and read-only status routes. See
[Operations](operations.md).

## The object API is dark by default

The object API has a complete authorization system — credentials, per-bucket grants, public-read flags — and
**it is switched off unless you turn it on.** The switch is the `authEnforced` runtime setting:

```bash
curl -s https://strubs/\$/auth/settings                    # {"authEnforced":false}
curl -X PUT https://strubs/\$/auth/settings \
     -H 'Content-Type: application/json' -d '{"authEnforced":true}'
```

While it's off, every object request is allowed exactly as before, and the only thing that happens is a
per-bucket counter of anonymous-vs-credentialed requests — visible in the UI and in `GET /$/buckets`, so you
can confirm every consumer has migrated to credentials **before** you flip the switch and break the ones that
haven't.

::: danger Basic credentials cross the wire in cleartext
The object listener is plain HTTP. Enabling `authEnforced` today means HTTP Basic secrets are sent
unencrypted — STRUBS logs a warning to that effect when you enable it. Put the object API behind a TLS
terminator, or keep it on a trusted network, before relying on this for anything more than tidiness.
:::

### How a request is decided, once enforced

1. **Resolve the bucket** — the first path segment, or, for the `/$<id>` form, the object's record and its
   `bucketId`. Authorization runs on the raw, undecoded path — the exact bytes that address storage — so
   "what auth checked" and "what got served" cannot diverge.
2. **No bucket resolved → deny.** Not "let the handler 404": storage can still serve root objects and
   id-form objects that lack a `bucketId`, so falling through would be a read bypass. 401 if no credential was
   presented, 403 if one was.
3. **No credential** → allowed only if the bucket is `publicRead` (for `GET`/`HEAD`/`OPTIONS`) or
   `publicWrite` (for everything else). Otherwise **401** with `WWW-Authenticate: Basic`, so a browser
   prompts and a public-read bucket keeps working from an `<img src>`.
4. **Credential presented** → verified, then checked against its grants: each grant is
   `{bucket, read, write}`, where `bucket` may be `*`. No matching grant is a **403**.

Any error while deciding — Mongo down mid-lookup — **fails closed to a 503**, never to a served object. The
one exception is the read of the `authEnforced` flag itself, which fails to *not enforced*: a transient DB
blip shouldn't lock the whole object API out of an array that isn't enforcing anything anyway.

### Credentials

```bash
curl -X POST https://strubs/\$/credentials -H 'Content-Type: application/json' -d '{
  "name": "media-server",
  "grants": [{"bucket": "photos", "read": true, "write": false}]
}'
# -> {"accessKeyId":"7fQ2xR9mK1pL4vN8","secret":"…"}

curl -u 7fQ2xR9mK1pL4vN8:the-secret http://strubs/photos/2024/cat.jpg
```

The secret is scrypt-hashed and **shown once**. `POST /$/credentials/{accessKeyId}/rotate` issues a new one;
`PUT` changes grants or disables it; `DELETE` removes it. All three take effect immediately — the verified-
credential cache is cleared on every change, and a verification already in flight is forbidden from
repopulating it afterwards, so a revocation can't be undone by a race.

Verification is cached for 60 seconds per (key, presented secret) — positive *and* negative — with a cap of 4
concurrent scrypt verifications, so neither a flood of repeated wrong secrets nor a flood of unique ones can
pin the CPU.

### Bucket policy

A **bucket** is a top-level container. `PUT /$/buckets/{id}/policy` sets three flags:

| | |
|---|---|
| `publicRead` | anonymous reads allowed (only consulted when enforcing) |
| `publicWrite` | anonymous writes allowed |
| `deleteProtected` | blocks **every** object delete in the bucket — **always**, enforced independently of auth |

`deleteProtected` is the one that works on a dark array, because it isn't an authorization rule: it's a lock
at the single choke point every `DELETE` passes through.

## Two things that are still open by design

- **FUSE is an unauthenticated read path to every object.** Access control is whatever the kernel enforces on
  the mount point; the FUSE layer itself checks nothing. This is why it is now **opt-in** and off unless you
  set `STRUBS_FUSE_ENABLED=true`.
- **The object API has no TLS of its own.** See the warning above.

## Checklist for exposing this beyond a trusted LAN

1. Install `ca.crt` on the machines that administer it, or bring your own certificate.
2. Log in, change the generated password, and issue bearer tokens for anything automated.
3. Leave `STRUBS_FUSE_ENABLED` off unless something local needs the mount.
4. Put TLS in front of the object API before enabling `authEnforced`.
5. Watch the per-bucket anon/auth counters until the anonymous column stops moving, *then* enforce.
