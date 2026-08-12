# HTTP API

STRUBS exposes **two** HTTP listeners on **separate origins**, plus an optional read-only FUSE mount:

| | Listener | Serves |
|---|---|---|
| **Object API** | HTTP on `STRUBS_HTTP_PORT` (**80**) | everything that isn't `/$/…` |
| **Admin surface** | **HTTPS** on `STRUBS_ADMIN_PORT` (**443**) | the management API (`/$/…`) and the UI |
| **Admin socket** | Unix socket `/run/strubs/admin.sock`, root-only | the management API, with no credential |

Routing is simple: any path starting with **`/$/`** is the management API; everything else is an object path.
Crossing between the two origins fails on purpose — an object path on the admin listener is a 404, and a `/$/`
path on the plain-HTTP object listener returns **421 Misdirected Request** naming the HTTPS URL (a top-level
browser navigation is redirected instead, so typing the bare hostname reaches the login page).

> ## Authentication: on for the admin API, off by default for objects
>
> **The management API and UI always authenticate** — an admin password session (cookie) or a bearer token,
> over HTTPS only. On first start STRUBS generates a random admin password and prints it to the log once.
>
> **The object API ships dark.** It has a full credential-and-grants system, but it is inert until an operator
> sets the `authEnforced` runtime flag; until then every object request is allowed and merely counted. Note
> also that the object listener is plain HTTP, so Basic credentials would cross the wire in cleartext — put TLS
> in front of it before relying on enforcement.
>
> See **[Access control](access-control.md)** for the whole story: TLS material, sessions, bearer tokens,
> credentials, bucket policy, and the lockout-recovery socket.

---

# Object API

Served over plain HTTP on port 80. When `authEnforced` is off (the default) no request needs a credential.
When it's on, present one with HTTP Basic — `curl -u <accessKeyId>:<secret>` — unless the bucket is marked
`publicRead`/`publicWrite`. A denied request is **401** (with `WWW-Authenticate: Basic`), **403** (credential
valid, not granted for that bucket), or **503** (authorization couldn't be evaluated — it fails closed).
See [Access control](access-control.md).

## Addressing

Objects live in a path namespace. Containers are implicit — `PUT /photos/2024/cat.jpg` creates the `photos` and `photos/2024` containers as needed.

Two ways to name an object:

| Form | Example |
|---|---|
| By path | `/photos/2024/cat.jpg` |
| By id | `/$65f0a1b2c3d4e5f60718293a` — a `$` followed by exactly 24 hex characters |

(The id form doesn't collide with the management API, which requires `/$/`.)

## `PUT /{path}` — store an object

```bash
curl -X PUT --data-binary @cat.jpg \
     -H 'Content-Type: image/jpeg' \
     http://strubs/photos/2024/cat.jpg
```

- **`Content-Length` is required.** Streaming uploads of unknown length are not supported.
- **`Content-MD5`** (hex) is optional. If given, it's checked against the received bytes.
- `Content-Type` is stored as the object's mime type.
- **Objects are immutable.** A `PUT` to an existing path returns **409 Conflict**. Delete it first.
- The path may not begin with `$`.

**201 Created** on success, with `X-Object-Id`, `X-Container-Id`, and `Content-MD5`.

Two non-standard failure codes, both of which delete the partial object:

| | |
|---|---|
| **455 Length Mismatch** | Bytes received ≠ `Content-Length`. Returns `X-Received-Bytes`, `X-Expected-Bytes`. |
| **456 MD5 Mismatch** | The supplied `Content-MD5` didn't match. Returns `X-Received-MD5`. |

## `GET /{path}` — read an object

```bash
curl http://strubs/photos/2024/cat.jpg
curl -H 'Range: bytes=0-1023' http://strubs/photos/2024/cat.jpg
curl 'http://strubs/photos/2024/cat.jpg?download_as=cat.jpg'
```

Ranges: **a single range only** — `bytes=start-end` (inclusive) or `bytes=start-`. Multi-range and suffix ranges (`bytes=-500`) are **not** supported and return **416**. A valid range returns **206** with `Content-Range`.

`?download_as=<name>` sets `Content-Disposition: attachment`.

Every response carries the object's identity and layout, which is genuinely useful for debugging:

```
X-Object-Id, X-Container-Id, Content-MD5, Content-Type,
X-Data-Slice-Count, X-Data-Slice-Volumes,      # e.g. 4  /  47,52,51,57
X-Parity-Slice-Count, X-Parity-Slice-Volumes,  # e.g. 2  /  50,30
X-Chunk-Size, Accept-Ranges: bytes
```

If a read cannot be satisfied — more slices bad than parity can cover — it fails. It does not return unverified bytes.

## `HEAD /{path}` — metadata only

Same headers as `GET`, no body.

## `DELETE /{path}` — destroy an object

**Immediate and irreversible.** Deletes every data and parity slice and the record. No soft delete, no confirmation.

If the object's bucket has **delete protection** enabled, the delete is refused with **403** (`bucket is delete-protected`) and nothing is touched — a per-bucket lock that blocks *every* object delete in the bucket. It's independent of the read/write auth flags (it still applies on a dark, unauthenticated array), though an unauthorized caller may hit the auth check first. Toggle it with the bucket policy endpoint (below).

## `OPTIONS /{path}`

Returns **204** with `Allow` and CORS headers. Note it requires the object to *exist* (a non-existent path 404s), and CORS headers are emitted **only** here — actual `GET`/`PUT` responses carry no `Access-Control-Allow-Origin`, so browser cross-origin use doesn't currently work.

## Not supported

- **`POST`** — returns 400.
- **Listing.** The *object* API cannot enumerate a container — `GET` on a container path returns 404. Listing lives on the authenticated management API instead (`GET /$/browse`), and the FUSE mount can list if you've enabled it.

---

# Management API

All under `/$/`, **on the HTTPS admin listener** (port 443) or the root-only Unix socket. Bodies are JSON; an
empty body is treated as `{}`.

Every endpoint below requires authentication except `GET /$/ui*`, `POST`/`DELETE /$/session`, and
`GET /$/auth/status` — the three that *are* how you authenticate. Mutating requests are also rejected if the
browser reports them as cross-site.

```bash
# session cookie
curl -k -c jar -X POST https://strubs/\$/session \
     -H 'Content-Type: application/json' -d '{"password":"…"}'
curl -k -b jar https://strubs/\$/status

# or a bearer token
curl -k -H 'Authorization: Bearer <selector>.<secret>' https://strubs/\$/status

# or, as root on the box, no credential at all
curl --unix-socket /run/strubs/admin.sock http://localhost/\$/status
```

## Authentication and access control

| | |
|---|---|
| `GET /$/auth/status` | `{authenticated, passwordSet}`. Auth-exempt — it's what the SPA reads to decide login-vs-dashboard. |
| `POST /$/session` | Log in. Body: `password`. Sets the `strubs_admin` cookie. **429** when throttled, **401** on a bad password. |
| `DELETE /$/session` | Log out — clears the cookie **and revokes every outstanding session**. |
| `PUT /$/admin/password` | Body: `currentPassword`, `newPassword` (≥8 chars). Invalidates all sessions. Over the admin socket, `currentPassword` is not required — that's the lockout-recovery path. |
| `GET /$/admin/tokens` | List bearer tokens (never the secrets). |
| `POST /$/admin/tokens` | Create one. Body: `name`. Returns `{token, selector}` — **the token is shown once**. |
| `DELETE /$/admin/tokens/{selector}` | Revoke one. |
| `DELETE /$/admin/tokens` | Revoke **all** of them. |
| `GET /$/credentials` | Object-API credentials with their grants (never the secrets). |
| `POST /$/credentials` | Create. Body: `name`, `grants` (`[{bucket, read, write}]`, `bucket` may be `*`). Returns `{accessKeyId, secret}` — **secret shown once**. |
| `PUT /$/credentials/{accessKeyId}` | Set `grants` and/or `enabled`. Effective immediately. |
| `POST /$/credentials/{accessKeyId}/rotate` | New secret, shown once; the old one stops working at once. |
| `DELETE /$/credentials/{accessKeyId}` | Remove it. |
| `GET /$/auth/settings` | `{authEnforced}`. |
| `PUT /$/auth/settings` | `{authEnforced: bool}` — the object-API switch. Off by default. |

## Fleet and status

| | |
|---|---|
| `GET /$/volumes` | Every volume: flags, capacity, SMART summary, bus group, labels. `?includeDeleted=true` to include tombstones. |
| `GET /$/volumes/{id}` | One volume, plus full SMART attribute detail. |
| `GET /$/status` | Volume ids by state, plus GB stored / capacity / free. |
| `GET /$/storage-stats` | Object and byte counters, system-wide and per volume. *(If no snapshot exists yet this triggers a full reconciliation scan — expensive.)* |
| `POST /$/storage-stats` | Force a full reconciliation from content aggregation, then return the fresh snapshot. Expensive; the scheduler does this every 6 hours anyway. |
| `GET /$/browse` | Walk the path namespace: `?path=`, `?after=` (cursor), `?limit=`. Returns `{path, entries, hasMore}`. This is what the UI's file browser uses — and the only way to *list* over HTTP, since the object API has no enumeration endpoint. |
| `GET /$/blockDevices` | Block devices as discovered, with their partitions and which volume each maps to. `?sort=name\|sysfsPath\|size\|volumeId\|volumeLabel`. |
| `POST /$/blockDevices/reload` | Rescan block devices. |
| `GET /$/faults` | Outstanding slice faults and their repair state. |
| `GET /$/debug` | Per-volume I/O priority stats and verify status. |
| `GET /$/fileinfo/{path}` | An object's slice layout **and the absolute on-disk path of every slice**. Accepts a path or the `$<id>` form. Very useful for forensics; note it exposes filesystem paths. |

## Volumes

| | |
|---|---|
| `POST /$/volumes` | **Provision a disk. This can destroy data.** See below. |
| `PUT /$/volumes/{id}` | Set `isEnabled`, `isReadOnly`, `isHealthy`, `isDraining`, `isDeleted`, `label`, `comment`. |
| `DELETE /$/volumes/{id}` | Soft-delete. Refused while the volume still holds live slices. |
| `POST /$/volumes/{id}/drain` | Mark read-only + draining and start relocating every slice off it. |
| `DELETE /$/volumes/{id}/drain` | Cancel the drain. **Leaves the volume read-only** — clear that separately. |
| `POST /$/volumes/{id}/identify` | Flash the drive's activity LED so you can find its bay. |
| `DELETE /$/volumes/{id}/identify` | Stop. |
| `POST /$/volumes/{id}/encrypt` | Convert a volume to LUKS in place — **this wipes it**, so it refuses unless the volume is already read-only *and* holds no slices (i.e. you drained it first). One conversion at a time, fleet-wide. Body: `recoveryPassphrase`, normally omitted since STRUBS holds it sealed. See [Encryption](encryption.md). |

### `POST /$/volumes` — the dangerous one

```json
{ "blockPath": "/dev/sdx", "wipe": 1783794000000, "encrypt": true }
```

`wipe` is **a timestamp in milliseconds, not a boolean**, and it must be within **10 seconds of now**. That freshness window is the only guard against a replayed request repartitioning a disk — there is no other confirmation step. Get the device path right.

`encrypt` is optional (defaults to the fleet's `encryptNewVolumes` setting); you do **not** pass the recovery passphrase — STRUBS holds it sealed. There is **no `replace` option**: a new disk gets a new id, re-provisioning a registered disk means deleting its volume first, and re-encrypting a volume in place goes through the drain → `POST /$/volumes/{id}/encrypt` → rebalance flow. Passing `replace` is rejected.

`DELETE` and soft-delete are **refused** while a volume still holds live object slices:

```
volume 13 still holds 41027 live object slice(s); drain it first: POST /$/volumes/13/drain
```

### Identify uses a heartbeat

`POST …/identify` starts continuous raw reads and sets a ~3 second deadline. The caller must keep re-POSTing (the UI does so about once a second) or the reads stop by themselves. So a closed browser tab or a lost cancel can't leave a drive spinning forever. `DELETE` stops it immediately.

## Verification

| | |
|---|---|
| `POST /$/verify-volumes` | Start a scrub. Body: `volumeIds` (array, optional — omit for the whole fleet), `mode` (`light` or `full`, default `full`). |
| `GET /$/verify-volumes` | Progress, error counts, scope, and whether it's `waiting` on a rebalance. |
| `DELETE /$/verify-volumes` | Stop. |
| `POST /$/verify-file/{objectId}` | Verify one object. Body: `mode`. Returns a per-slice result map. |
| `GET /$/verify-runs` | The **50 most recent** verify runs, newest first: `scope`, `mode`, `volumeIds`, `status` (`running`/`completed`/`stopped`), error counts, and the `trigger` that started each one (`manual`, `scheduled`, or `syslog-watcher` with the device and kernel detail). |

`POST /$/verify-volumes` returns `{startedAt, accepted, deferred?}`. Note the quiet cases:

- **`accepted: false`** — a maintenance freeze is active, or a run is already going that doesn't cover your request. This is a **200**, not an error.
- **`deferred: true`** — a rebalance is running. Your request is *persisted and queued*, and will start when the rebalance finishes.

## Rebalance

| | |
|---|---|
| `POST /$/rebalance` | Start. Body: `deadband` (0–0.5), `maxMoves`, `concurrency`. |
| `GET /$/rebalance` | Live progress — see below. |
| `PUT /$/rebalance` | Retune `concurrency` (integer 1–64) **on a running job**. Applied at the next batch. |
| `DELETE /$/rebalance` | Cancel. |

`GET /$/rebalance` returns everything you need to watch a multi-day job:

```json
{
  "running": true, "concurrency": 8,
  "targetFill": 0.474, "deadband": 0.05,
  "bytesToMove": 23410622879670, "bytesMoved": 47008182272,
  "bytesPerSec": 62914560, "etaSeconds": 372089,
  "sourceVolumeIds": [4, 10, 11, 13, 15, 23, 29, 36, 38, 40, 44, 45, 51],
  "currentSourceVolumeId": 4, "currentMinObjectSize": 268435456,
  "startedAt": "2026-07-11T19:58:11.163Z",
  "moves": 331, "copied": 160, "reconstructed": 171,
  "noDest": 0, "unrecoverable": 0, "sourceDeleteFailed": 0, "duplicateRefs": 0
}
```

`bytesToMove` is recomputed from live volume fills rather than remembered, so it stays honest across restarts and doubles as a progress denominator. `currentMinObjectSize` is the size tier being shed — the rebalance works biggest-objects-first.

## Buckets

A **bucket** is a top-level container (the first path segment). These endpoints manage its policy flags.

| | |
|---|---|
| `GET /$/buckets` | List buckets with policy (`publicRead`, `publicWrite`, `deleteProtected`) and request activity. Object counts are **not** here — they're a `$group` over millions of documents, so the UI fetches them separately from `/$/buckets/stats`. |
| `PUT /$/buckets/{id}/policy` | Set any of `publicRead`, `publicWrite`, `deleteProtected` (booleans). |
| `GET /$/buckets/stats` | Per-bucket object count and logical size (cached; the expensive aggregation). |

`deleteProtected: true` blocks **every** object delete in the bucket — a `DELETE /{path}` on a contained object returns 403 — independent of the read/write flags. There is no bucket-*delete* endpoint at all (delete acts on objects), so this protects the objects inside it. Like the public flags it rides the durability rails: it's journalled, snapshotted, and restored. On recovery the two paths differ — journal replay only ever *adds* protection (it refuses to clear a flag the live bucket has set), while a snapshot restore rewrites policy to match the snapshot exactly, so it can also clear it.

## Maintenance freeze

| | |
|---|---|
| `GET /$/maintenance-freeze` | `{ "frozen": bool }` |
| `PUT /$/maintenance-freeze` | `{ "frozen": true }` — the global kill switch for all background maintenance. |

Persisted, and enforced across restarts. See [Configuration](configuration.md#the-maintenance-freeze).

## Encryption

Covered in full by [Encryption](encryption.md); the endpoints are:

| | |
|---|---|
| `PUT /$/encryption/settings` | Set `encryptNewVolumes` — whether newly provisioned disks are LUKS. |
| `PUT /$/encryption/passphrase` | Set the fleet recovery passphrase. Writes it to every attached encrypted disk, so it **refuses to run with any disk missing**. |
| `POST /$/encryption/audit` | Prove the recovery passphrase against every encrypted disk and record the result. |
| `POST /$/encryption/seal` | Re-seal the recovery passphrase under the keyfile. |

## Namespace and disaster recovery

The bad-day endpoints. See [Operations](operations.md) for when and how to use them.

| | |
|---|---|
| `GET /$/snapshot` | The current namespace-snapshot pointer, and whether a snapshot job is running. |
| `POST /$/snapshot` | Take a namespace snapshot now and publish its pointer to every disk. **Refused while the namespace is unrestored** — it would publish an empty namespace over a good one. |
| `POST /$/recover-fleet` | Step one of a total database loss: read every disk, work out by majority which array this is, adopt that identity, and rebuild the volume table. Body: `force`, `recoveryPassphrase`. |
| `POST /$/restore` | Rebuild the namespace from the snapshot on the platters plus the journal. Body: `apply` (**false = dry run**, the default), `force`. |
| `POST /$/drift` | Scrub for drift between the database and what's actually on the disks. |

While the namespace is missing, the management API drops to an **allowlist** — these recovery routes, the auth
routes needed to reach them, and read-only status. Everything else returns 400 with an explanation, because
anything that asks an empty database a question ("how many objects are on this volume?") would get a
catastrophically wrong answer.

## Other

| | |
|---|---|
| `POST /$/notify/test` | Actually sends a notification. Body: `severity` (`info`/`warning`/`critical`, default `warning`), `title`, `body`. |
| `GET /$/ui`, `GET /$/ui/*` | The web UI bundle. Auth-exempt — it's the login page. |

---

# FUSE mount

**Off by default.** Set `STRUBS_FUSE_ENABLED=true` to mount it at **`/run/strubs/data`** (hardcoded), alongside
the HTTP listeners. It's opt-in for two reasons: it is a second, *unauthenticated* read path to every object,
and it needs the native `fuse-native` binding plus `/dev/fuse`. While it's off the binding is never even
loaded, so STRUBS runs on a host that has neither. The HTTP object API is unaffected either way.

**It is read-only.** Writes return `EROFS`; `create`, `unlink`, `mkdir`, `rename`, `truncate`, `chmod` and friends are not implemented. Supported: `getattr`, `readdir`, `open` (read-only), `read`, `release`.

The path namespace is the same as the object API, so:

```bash
ls  /run/strubs/data/photos/2024/
cp  /run/strubs/data/photos/2024/cat.jpg .
cat /run/strubs/data/\$65f0a1b2c3d4e5f60718293a     # by id
```

This is the practical way to *list* a container, since the HTTP API has no enumeration endpoint. It also means every ordinary tool — `rsync`, `find`, a media server — can read from STRUBS without knowing anything about it.

Timestamps are derived from the object id's embedded creation time. Access control is whatever the kernel enforces on the mount point; the FUSE layer checks nothing itself.
