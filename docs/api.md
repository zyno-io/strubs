# HTTP API

STRUBS exposes one HTTP server on **port 80, on all interfaces** (not configurable), plus a read-only FUSE mount.

> ## There is no authentication
>
> Not on the object API, not on the management API, not on the UI. Anyone who can reach port 80 can read, overwrite, and delete your data — and can also call `POST /$/volumes` to **repartition and format a disk**. The only protection is where you put it on the network. Put it behind a reverse proxy that authenticates, or on a network where everything is trusted, and never on the public internet.

Routing is simple: any path starting with **`/$/`** is the management API; everything else is an object path.

---

# Object API

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

## `OPTIONS /{path}`

Returns **204** with `Allow` and CORS headers. Note it requires the object to *exist* (a non-existent path 404s), and CORS headers are emitted **only** here — actual `GET`/`PUT` responses carry no `Access-Control-Allow-Origin`, so browser cross-origin use doesn't currently work.

## Not supported

- **`POST`** — returns 400.
- **Listing.** There is no HTTP endpoint that enumerates a container. `GET` on a container path returns 404. (The FUSE mount *can* list — see below.)

---

# Management API

All under `/$/`. Bodies are JSON; an empty body is treated as `{}`.

## Fleet and status

| | |
|---|---|
| `GET /$/volumes` | Every volume: flags, capacity, SMART summary, bus group, labels. `?includeDeleted=true` to include tombstones. |
| `GET /$/volumes/{id}` | One volume, plus full SMART attribute detail. |
| `GET /$/status` | Volume ids by state, plus GB stored / capacity / free. |
| `GET /$/storage-stats` | Object and byte counters, system-wide and per volume. *(If no snapshot exists yet this triggers a full reconciliation scan — expensive.)* |
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

### `POST /$/volumes` — the dangerous one

```json
{ "blockPath": "/dev/sdx", "wipe": 1783794000000, "replace": false }
```

`wipe` is **a timestamp in milliseconds, not a boolean**, and it must be within **10 seconds of now**. That freshness window is the only guard against a replayed request repartitioning a disk — there is no other confirmation step. Get the device path right.

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

## Maintenance freeze

| | |
|---|---|
| `GET /$/maintenance-freeze` | `{ "frozen": bool }` |
| `PUT /$/maintenance-freeze` | `{ "frozen": true }` — the global kill switch for all background maintenance. |

Persisted, and enforced across restarts. See [Configuration](configuration.md#the-maintenance-freeze).

## Other

| | |
|---|---|
| `POST /$/notify/test` | Actually sends a notification. Body: `severity` (`info`/`warning`/`critical`, default `warning`), `title`, `body`. |
| `GET /$/ui`, `GET /$/ui/*` | The web UI bundle. |

---

# FUSE mount

Mounted at **`/run/strubs/data`** (hardcoded), started alongside the HTTP server.

**It is read-only.** Writes return `EROFS`; `create`, `unlink`, `mkdir`, `rename`, `truncate`, `chmod` and friends are not implemented. Supported: `getattr`, `readdir`, `open` (read-only), `read`, `release`.

The path namespace is the same as the object API, so:

```bash
ls  /run/strubs/data/photos/2024/
cp  /run/strubs/data/photos/2024/cat.jpg .
cat /run/strubs/data/\$65f0a1b2c3d4e5f60718293a     # by id
```

This is the practical way to *list* a container, since the HTTP API has no enumeration endpoint. It also means every ordinary tool — `rsync`, `find`, a media server — can read from STRUBS without knowing anything about it.

Timestamps are derived from the object id's embedded creation time. Access control is whatever the kernel enforces on the mount point; the FUSE layer checks nothing itself.
