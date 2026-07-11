# On-disk format

This document exists so that you can get your data back **without STRUBS**. If the service is gone but the disks and the Mongo database survive, everything here is enough to reconstruct any object with a short script.

Constants: file header **48 bytes**, chunk header **16 bytes** (MD5), default chunk size **16384**.

## Where a slice lives

Each volume is mounted at `/run/strubs/mounts/<volume-uuid>/`, and STRUBS owns the `strubs/` subtree:

```
/run/strubs/mounts/<uuid>/strubs/
├── .identity                 # 41-byte volume identity file
├── .tmp/                     # in-flight writes, renamed into place on commit
└── 65/f3/a1/65f3a1b2c3d4e5f60718293a.3
    └── ▲  ▲  ▲  ▲            └── slice index (0..dataN-1 data, dataN.. parity)
        │  │  │  └── the object id, 24 hex chars
        └──┴──┴───── sharded by the first 6 hex chars of the id, 2 at a time
```

So slice *i* of object `<id>` on volume *v* is at:

```
/run/strubs/mounts/<uuid-of-v>/strubs/<id[0:2]>/<id[2:4]>/<id[4:6]>/<id>.<i>
```

A write goes to `.tmp/<name>` and is `rename()`d into the sharded path — so a committed slice file is always complete.

## Slice file layout

```
┌──────────────────────────── 48 bytes ────────────────────────────┐
│ file header                                                      │
├─────────┬────────────────────────────────────────────────────────┤
│ 16 B    │ chunk 0 data  (S0 bytes — SHORT, see below)            │  ← first 16384 slot
├─────────┼────────────────────────────────────────────────────────┤
│ 16 B    │ chunk 1 data  (Sstd bytes)                             │
├─────────┼────────────────────────────────────────────────────────┤
│ 16 B    │ chunk 2 data  (Sstd bytes)                             │
│  ...    │  ...                                                   │
├─────────┼────────────────────────────────────────────────────────┤
│ 16 B    │ final chunk   (Send bytes, zero-padded)                │
└─────────┴────────────────────────────────────────────────────────┘
   MD5 of that chunk's data bytes only
```

**Chunk 0 is shorter than the rest**, and this trips people up. The 48-byte file header shares the first `chunkSize` slot with chunk 0, so:

```
S0   = chunkSize − 16 − 48   = 16320   (at the default 16384)
Sstd = chunkSize − 16        = 16368
```

`48 + 16 + 16320 = 16384`. Every subsequent chunk is a clean `16 + 16368 = 16384`.

Offsets:

```
chunkStart(0) = 48
chunkStart(k) = 48 + (16 + S0) + (k − 1) × (16 + Sstd)      for k ≥ 1
dataStart(k)  = chunkStart(k) + 16
dataLen(k)    = S0    for k = 0
                Sstd  for the middle chunks
                Send  for the final chunk (zero-padded; truncate using the object size)
```

> **Use the object's own `chunkSize` from Mongo, and the real file size on disk.** Hardcoding 16384, or trusting `content.sliceSize`, will over-read small objects and produce checksum failures that aren't real. `sliceSize` is a *planning estimate* used for space reservation and stats — it is **not** the exact on-disk length.

### File header — 48 bytes

| Offset | Len | Field | Notes |
|---|---|---|---|
| 0–3 | 4 | magic `01 FB 02 FB` | |
| 4 | 1 | version (`1`) | |
| 5–6 | 2 | header length (48), uint16 LE | |
| 7–22 | 16 | header MD5 | covers bytes 23–47 |
| **23–34** | **12** | **object id** | raw 12-byte Mongo ObjectId; hex form is the 24-char id |
| 35–39 | 5 | file size, int LE | so ~512 GiB max per object |
| 40 | 1 | dataN | |
| 41 | 1 | parityN | |
| 42 | 1 | sliceIndex | `0..dataN-1` = data, `dataN..` = parity |
| 43–45 | 3 | chunkSize, int LE | |
| 46–47 | 2 | zero padding | inside the hashed range |

On open, STRUBS compares the object id, `dataN`, `parityN`, `sliceIndex` and `chunkSize` against the Mongo record. A mismatch is `EHEADER` — the slice is on the wrong disk, or was mis-stamped at write time. It's a real failure mode, and it's why a "light" verify (header-only) is worth running: it's cheap and catches misfiled slices without reading a byte of data.

> **Known gap:** the magic bytes, version, and the header's own MD5 (7–22) are written but **never verified** when reading a slice — only the identity fields are compared. A corrupt header would be caught by the field comparison, not by its checksum.

### Chunk header — 16 bytes

An MD5 over **that chunk's data bytes only** — not the chunk header, not the file header. Recomputed and compared on every read; a mismatch is `ECHECKSUM`. A short read is also an error, deliberately, so leftover buffer bytes can never pass the check.

## The erasure code

Reed–Solomon, **systematic**: the data slices contain your plaintext verbatim. Parity is only consulted when a data slice is missing or bad.

Plaintext is consumed into a **chunk set** — a buffer of `dataN × chunkDataSize` — and slice *i* takes the contiguous run at offset `i × chunkDataSize`. So for chunk index *k*, the plaintext is simply data-slice chunks `0, 1, … dataN−1` concatenated in slice-index order.

**To reconstruct an object from its data slices:**

```
for k = 0, 1, 2, …:
    for i = 0 .. dataN-1:
        append dataLen(k) bytes at dataStart(k) of slice i
truncate to content.size
```

That's it. The concatenation *is* the plaintext. (If a data slice is missing, you need an RS decode using parity — 4 of any 6 slices suffice.)

**Quorum:** any `dataN` of the `dataN + parityN` slices, evaluated per chunk set. With 4+2, up to 2 slices can be lost. Below that, the read throws `EQUORUM`.

## Volume identity — 41 bytes

`<mount>/strubs/.identity`:

| Offset | Len | Field |
|---|---|---|
| 0–3 | 4 | magic `1F FB 01 FB` |
| 4 | 1 | version (`1`) |
| 5–20 | 16 | **instance** identity (from `/var/lib/strubs/identity`) |
| 21–36 | 16 | volume uuid |
| **37** | **1** | **volume id** (so ids are capped at 255) |
| 38 | 1 | status byte (`'O'`; written, never read) |
| 39–40 | 2 | trailing magic `19 FB` |

A volume refuses to start if any of this disagrees with what's expected. This is how a disk proves it belongs here — which is why physically moving drives between bays and enclosures is safe, and why kernel names like `sdf` are never trusted as identity.

**This is also how you identify a disk out-of-band**, which matters more than it sounds: on USB/SAS enclosures, `lsblk` and `smartctl` often report the *enclosure bridge's* serial rather than the drive's, so two bays can look like the same device. The `.identity` file is the ground truth:

```bash
debugfs -R 'dump /strubs/.identity /tmp/id' /dev/sdX 2>/dev/null && xxd /tmp/id
# byte 37 (0x25) = volume id;  bytes 21-36 = volume uuid
```

## MongoDB schema

Database `strubs`. Collections: `content`, `volumes`, `faults`, `runtimeConfig`, `storageStats`.

### `content`

One document per file **and** per container (containers have `isContainer: true`; there is no separate collection).

| Field | |
|---|---|
| `_id` | ObjectId. **Its 12-byte binary form is the id stamped into the slice header.** |
| `containerId` | Parent container, or `null` at root. |
| `name`, `mime`, `size` | `size` is plaintext bytes. |
| `dataVolumes: number[]` | Volume id holding data slice *i*, at index *i*. |
| `parityVolumes: number[]` | Volume id holding parity slice *j* — global slice index `dataN + j`. |
| `chunkSize` | The chunk size **this object** was written with. Use it, don't assume. |
| `sliceSize` | Planning **estimate**, not the exact on-disk length. |
| `md5` | MD5 of the whole plaintext. Not checked on normal reads — it is the gate that stops a bad reconstruction from being committed. |
| `sliceErrors` | Map keyed by **global slice index as a string** → `{code, category, err, type, checksum}`. |
| `sliceVerificationTimes` | Per-slice last-verified timestamps. |
| `lastVerifiedAt` | The **minimum** across all per-slice times. This is the scrub's cursor. |
| `unavailableSlices`, `damagedSlices` | Slice indexes excluded from reads up front. |
| `recoveryComment` | Operator marker: "documented unrecoverable, accepted loss". Nothing in the service writes it; it's set out-of-band. Repair skips these objects, and drain ignores them when counting what's left on a volume. |

Error categories: `checksum`, `header-mismatch`, `volume-unavailable`, `missing`, `io`, `timeout`, `parity-mismatch`, `unknown`.

Indexes: unique `{containerId, name}`, plus `{lastVerifiedAt}` and sparse indexes on `{sliceErrors}`, `{dataVolumes}`, `{parityVolumes}`.

### `volumes`

Snake_case. `id` (matches byte 37 of `.identity`), `uuid` (the mount directory name), `enabled`, `healthy`, `read_only`, `is_deleted`, `is_draining`, `state_updated_at`, `disk_serial`, `partition_uuid`, `partition_size`, `data_size`, `parity_size`, `pending_sector_high_water`, `verifyErrors: {checksum, total}`, `label`, `comment`.

> `verifyErrors` is a **cumulative** counter that only ever increments — nothing resets it automatically. It's worth knowing that a nonzero count permanently excludes a volume as a *rebalance target* until an operator clears it.

### `faults`

`_id` is `{volumeId}:{objectId}:{sliceIndex}`, so re-observing a fault upserts and increments rather than duplicating. Carries `source` (`read`/`verify`/`syslog`/`smart`), `code`, `count`, `firstSeen`/`lastSeen`, and repair state: `repairStatus` (`pending`/`blocked`), `repairBlockedReason` (`insufficient-slices`, `target-unwritable`, `unrecoverable`, `reconstruction-mismatch`).

### `runtimeConfig`

Plain key/value. Holds operator settings that must be changeable while a job runs (`maintenanceFreeze`, `rebalanceConcurrency`) and job checkpoints so work survives a restart (`verifyStartedAt`, `verifyCursorId`, `drainVolumeId`, `rebalanceActive`, …). Don't hand-edit the checkpoints — use the cancel endpoints.

### `storageStats`

A single `_id: 'current'` document with cached system-wide and per-volume counters, maintained incrementally and reconciled periodically.

---

## Reading an object without STRUBS

The recipe, given the Mongo record:

1. Read `dataVolumes`, `chunkSize`, `size`, `md5` from `content`.
2. Map each volume id → uuid via the `volumes` collection → `/run/strubs/mounts/<uuid>/strubs/`.
3. Open slice files `<id>.0` … `<id>.{dataN-1}` at their sharded paths.
4. For each chunk index *k*, pull `dataLen(k)` bytes from `dataStart(k)` of each data slice, in slice order, and concatenate.
5. Truncate to `size`, and check the MD5 against `content.md5`.

If a data slice is missing, you'll need a Reed–Solomon decode with the parity slices — `@ronomon/reed-solomon`, `create(dataN, parityN)`, same library STRUBS uses. Any 4 of the 6 slices are enough.
