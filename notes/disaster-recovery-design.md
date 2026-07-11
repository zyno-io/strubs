# Design: metadata durability & disaster recovery

_Draft 2026-07-11. Covers the metadata snapshot, the out-of-band namespace journal, rebuild-from-disks, and the fresh-host recovery flow._

## The problem

Every object's bytes are protected by 4+2 erasure coding across independent disks. **Its metadata is protected by nothing.** MongoDB runs on the host OS disk, is not backed up, and has no replica. Lose it and every disk is perfectly healthy and the array is unusable.

There is also a smaller, sharper version of the same problem: `/var/lib/strubs/identity` is **16 bytes**, is read with a bare `fs.readFile` that throws if absent (`config.ts:158-166`), and nothing backs it up. Every volume validates its `.identity` against it (`volume.ts:305-345`). On a rebuilt host without that file, STRUBS won't start; with a *freshly generated* one, every disk is rejected as "not from this STRUBS instance". Sixteen bytes stand between us and an unrecoverable array.

## The governing principle

> **The disks are authoritative. Mongo is a derived index.**

This is the idea the whole design hangs off, and we are most of the way there already.

Each slice's 48-byte header carries the object id, size, `dataN`, `parityN`, slice index, and chunk size (`slice.ts:101-123`). The object id is a Mongo ObjectId, so it carries its own creation timestamp. And *which volume you found the file on* gives you that slice's placement.

Verified empirically against real slice files — from headers alone we recover:

| Recoverable from disk | Not on disk anywhere |
|---|---|
| `_id` | `name` |
| `size` | `containerId` (the path) |
| `chunkSize` | `mime` |
| `dataVolumes`, `parityVolumes` | `md5` |
| `dataN` / `parityN` | |
| creation time | |

So losing Mongo is **not** losing the array. It is losing *the namespace* and *the integrity gate*. That is a far smaller problem, and it names precisely what has to be protected: a record of `{_id, containerId, name, mime, md5}` — roughly 130 bytes per object, ~500 MB raw across 3.6M objects, far less compressed. (The entire database is only 450 MB on disk, so in practice we just back up all of it.)

Once Mongo is rebuildable from the disks, its loss is an **outage, not a data loss**. Snapshots become a speed optimisation rather than a safety requirement, and the choice of database stops being existential.

---

## Components

| | | Priority |
|---|---|---|
| **A** | Bootstrap manifest on every volume (incl. the instance identity) | **P0** |
| **B** | Rebuild-index tool — reconstruct Mongo from the disks | **P1** |
| **C** | Namespace journal — replicated, plaintext, out-of-band | P2 |
| **D** | Metadata snapshot as a STRUBS object, with validated rotation | P3 |
| **E** | Fresh-host recovery detection and restore flow | P4 |
| **F** | Metadata drift scrub | P5 |

A and B together already remove the worst outcome on the board. C and D reduce recovery from "a scan and a lost+found" to "a restore". E makes it usable by someone who isn't the author. F keeps it honest.

---

## A. Bootstrap manifest — `<mount>/strubs/.bootstrap.json`

Written to **every volume**, so any single surviving disk can bootstrap a recovery.

```json
{
  "version": 1,
  "instanceIdentity": "3f9a…",                 // hex of /var/lib/strubs/identity — THE critical field
  "geometry": { "dataSlices": 4, "paritySlices": 2 },
  "volumes": [                                  // so recovery knows what it is MISSING, and can BIND
    { "id": 4,  "uuid": "51787cb9-…", "partitionUuid": "cd1eca67-…", "diskSerial": "WD-WMC…", "label": "4.5" },
    { "id": 17, "uuid": "a37c48ff-…", "partitionUuid": "a328a681-…", "diskSerial": "WD-WCC…", "label": "5.3" }
  ],
  "journalVolumeIds": [4, 30, 49],
  "snapshot":         { "objectId": "…", "md5": "…", "startedAt": "…", "completedAt": "…", "objects": 3600126 },
  "previousSnapshot": { "objectId": "…", "md5": "…", "startedAt": "…", "completedAt": "…", "objects": 3598904 },
  "updatedAt": "2026-07-11T22:00:00Z"
}
```

**`partitionUuid` is not optional.** The fleet binds a volume to its device by partition UUID (`volume-fleet.ts:75`, `findPartitionByUuid`). Without it in the manifest, a restored `volumes` collection knows a volume exists but cannot find the disk it lives on. `uuid` is the *mount directory* name, not a device locator. (`diskSerial` is belt-and-braces for a human; do not rely on it — on USB/SAS enclosures it is often the bridge's serial, not the drive's.)

The manifest lives **inside** each volume's filesystem, so recovery must mount candidate partitions read-only to read it. That's fine and it's the point: no Mongo is required to find it.

**Manifests only refresh on writable volumes.** A read-only or draining disk keeps whatever copy it had. That's acceptable — recovery takes the newest `updatedAt` across all disks — but it means a fleet where *every* volume is read-only stops updating manifests. Worth an alert if the newest manifest is older than the newest snapshot.

**Deliberately absent: which volumes hold the snapshot's slices.** The rebalancer moves slices; any recorded placement goes stale and would send a recovery looking in the wrong place. Instead, recovery *scans* for `<shard>/<snapshotObjectId>.<n>` across the mounted volumes — the sharded path is deterministic from the id, and the slice headers describe their own geometry. The system is self-describing; lean on that.

The `volumes` array earns its place by telling recovery **what it can't see**: "the manifest lists 30 volumes, I found 28" is exactly the sentence you want at 3am.

- **Written:** on volume start; on any fleet change (provision, delete, drain, flag change); after every snapshot rotation.
- **Atomic:** write to `.bootstrap.json.tmp`, `fsync`, `rename()`.
- **Stale copies are fine.** Manifests will briefly disagree across volumes. Recovery takes the one with the newest `updatedAt`.
- New module `lib/io/bootstrap-manifest.ts`; hook the fleet-change writes where `state_updated_at` is already stamped (`volume-repository.ts`).

### Required change: `loadIdentity` must not throw

Today a missing `/var/lib/strubs/identity` kills startup — which means a rebuilt host **cannot even reach the UI that would offer to restore it**. Change `config.loadIdentity()` to tolerate absence and leave `identity = null`; `core.start()` then enters recovery mode (E) instead of crashing.

This must *not* become "generate a new identity if missing" — that is the footgun that permanently orphans every disk.

---

## B. Rebuild-index — `tools/rebuild-index.js`

The backstop that makes everything else optional rather than critical. **Build this second, because it is the only thing that proves the model.**

```
for each mounted volume:
    walk <mount>/strubs/<xx>/<xx>/<xx>/
    for each file matching ^[0-9a-f]{24}\.\d+$:
        read the 48-byte header
        → id, size, dataN, parityN, sliceIndex, chunkSize
        → placement: sliceIndex < dataN ? dataVolumes[i] = vol : parityVolumes[i-dataN] = vol

group by id → a candidate content record, missing {name, containerId, mime, md5}

fill the gaps, in order of preference:
    1. the metadata snapshot   (D)
    2. journal replay          (C)
    3. nothing → orphan
```

**Orphans** — objects on disk with no name and no md5 — go into a reserved `lost+found` container with `name = <id>`, and are **reported loudly**. They are readable (the bytes are all there) but:

> ⚠️ `md5: null` objects **skip the reconstruction md5 gate**. An orphan cannot be safely repaired until its md5 is known. Recompute it by reading the object end-to-end and stamping it — do this as part of adopting orphans, not later.

Modes:

| | |
|---|---|
| `--report` | Read-only. What's on disk, what Mongo says, and the diff. Doubles as F. |
| `--rebuild` | Write records into an empty/scratch database. |
| `--reconcile` | Adopt orphans into an existing database; never overwrite a record that already has a name. |

Also reports, for free: objects whose surviving slice count `< dataN` (below quorum), and slices whose header disagrees with their filename or location.

---

## C. Namespace journal

Covers the gap between snapshots.

**Path:** `<mount>/strubs/.journal/<seq>.jsonl` on **K volumes** (default 3), chosen across distinct bus groups, preferring healthy writable ones.

**Replicated, not erasure-coded — deliberately.** The whole value of a recovery artifact is that you can read it with `cat` and zero infrastructure. Erasure-coding it would mean needing a working decoder *before* you can read the thing that tells you how to recover. That is a bootstrapping trap. It's ~200 bytes per object; replicate it three times and stop thinking about it.

**Format** — newline-delimited JSON, one record per line:

```json
{"op":"put","ts":"…","id":"65f0…","cid":"5c2a…","name":"cat.jpg","mime":"image/jpeg","md5":"9f8e…","size":184320,"cs":16384,"dv":[4,17,23,30],"pv":[9,41]}
{"op":"del","ts":"…","id":"65f0…"}
{"op":"container","ts":"…","id":"5c2a…","cid":null,"name":"photos"}
```

`dv`/`pv` are derivable from a disk scan but included anyway — it makes a journal-only restore possible without one.

**Containers must be journaled.** Their names exist nowhere on disk. Hook `database.getOrCreateContainer` (`database.ts:199`).

### Hooks

`FileObject` already has the right dependency slots (`file-object.ts:48-49`):

| Event | Hook |
|---|---|
| create | `recordObjectCreated` (`file-object.ts:186`) |
| delete | `recordObjectDeleted` (`file-object.ts:~305`) |

### Ordering — this is the part to get right

**On create: journal → Mongo.**
Crash between them leaves the object on disk and in the journal but not in Mongo → the rebuild finds it, fully named. The reverse order would leave it in Mongo but not the journal → a snapshot+journal restore misses it entirely, and it degrades to a nameless orphan. Journal first.

**On delete: journal → unlink slices → Mongo.**
Crash after journaling but before unlinking leaves slices with no record → an **orphan**, which lands in lost+found and is recoverable. The reverse leaves a record with no slices → a **phantom**, which reads as data loss and will alarm you about an object that was deliberately deleted. Orphans are strictly better than phantoms.

### Cost, and how to keep it small

K appends + K fsyncs on the write path. For this workload (large media, writes measured in seconds, already doing 6 slice writes) that is noise. For a small-object workload it would not be.

- **Group commit:** a batching writer that accumulates for `STRUBS_JOURNAL_FLUSH_MS` (default 50) or N records, then one fsync per volume. A `put` waits on its own flush before Mongo insert.
- Configurable `STRUBS_JOURNAL_REPLICAS` (default 3), `STRUBS_JOURNAL_ENABLED` (default true).
- Journal write failure on *some* replicas: proceed if ≥1 succeeded, notify `warning`. Failure on **all**: fail the write. The journal is a durability guarantee; silently degrading it is how you discover it was empty when you needed it.

**Rotation:** new segment per 64 MB or per day. Segments are named by sequence and carry their time range in the first line.

### The journal must follow the fleet

A gap in the obvious design, and an easy one to miss: **journal files are not object slices.** The drain job relocates *slices* — it walks `content` and moves what the records reference. It knows nothing about `.journal/`. So draining and pulling a journal volume silently destroys one of the journal's replicas, and if you retire the wrong three disks over a year you can quietly reach zero.

So the journal replica set has to be maintained, not just chosen once:

- On startup, and on any fleet change, assert `journalVolumeIds` are all present, writable, healthy, and on distinct bus groups. If not, **elect a replacement and copy the existing segments to it**, then update the manifest.
- **Block volume removal** while a volume still holds the only surviving copy of any journal segment — the same shape as `assertVolumeRemovable` already refusing to delete a volume that still holds live slices (`mgmt.ts:542-546`). Reuse that guard.
- Drain should relocate the journal as part of its work, for the same reason it relocates slices.
- Alert `critical` if live replicas ever drop below 2.

### Nothing else may walk these files

`.bootstrap.json`, `.journal/` and the existing `.identity` and `.tmp/` all live in the same volume root. Every scanner must key on the slice filename pattern `^[0-9a-f]{24}\.\d+$` and ignore everything else. Today's scanners do, but it is now load-bearing rather than incidental, so it needs a test.

---

## D. Metadata snapshot, stored in STRUBS

### Do not use `mongodump`

The obvious design is `mongodump` → store the archive as an object. Don't. `mongodump` and `mongorestore` are not part of MongoDB — they ship in a separately-installed `mongodb-database-tools` package, **which is not installed on the production host today.** So the plan as originally drafted had an unmet prerequisite, and worse: it would make disaster recovery depend on an external, separately-versioned binary being present *on the rebuilt machine, at a version compatible with the server*, at exactly the moment you are least able to go shopping for it.

A recovery artifact that needs a specific third-party tool to read is not much of a recovery artifact.

**Instead: export it ourselves, in the same format as the journal.**

The snapshot is a gzipped, newline-delimited JSON stream **in exactly the record vocabulary the journal already uses** — a full set where the journal is a delta.

```jsonl
{"op":"begin","ts":"2026-07-11T22:00:00Z","instance":"3f9a…","version":1}
{"op":"container","ts":"…","id":"5c2a…","cid":null,"name":"photos"}
{"op":"put","ts":"…","id":"65f0…","cid":"5c2a…","name":"cat.jpg","mime":"image/jpeg","md5":"9f8e…","size":184320,"cs":16384,"dv":[4,17,23,30],"pv":[9,41]}
…
{"op":"volume","ts":"…","id":4,"uuid":"…","partitionUuid":"…","enabled":true,"readOnly":false,"label":"4.5"}
{"op":"runtimeConfig","ts":"…","key":"maintenanceFreeze","value":false}
{"op":"end","ts":"…","objects":3600126,"containers":812,"volumes":30}
```

**Plain hex strings, not Extended JSON.** EJSON (`{"$oid":…}`, `{"$binary":…}`) exists to round-trip *arbitrary* BSON. We don't have arbitrary BSON — we have a fixed, known schema, and every field in it maps cleanly to plain JSON: ObjectIds are 24 hex chars, `md5` is 32 hex chars, dates are ISO strings. The restore code constructs `new ObjectId(hex)` and `Buffer.from(hex,'hex')` explicitly.

That choice is worth being deliberate about, because the alternative quietly costs you the thing you're buying: `{"md5":"9f8e…"}` is legible to a human at 3am and `{"md5":{"$binary":{"base64":"n44…","subType":"00"}}}` is not. A recovery artifact's job is to be readable under duress.

Three things this buys, worth far more than the ~100 lines it costs:

1. **No external dependency.** Export and restore are our own code, shipped with the service. Nothing to install on the rebuilt machine, no version-matching, no shopping at the worst possible moment.
2. **The artifact is plaintext.** `zcat snapshot.jsonl.gz | jq` works. Same principle that makes the journal replicated-and-plaintext rather than erasure-coded.
3. **One replay engine, one format.** Restore = replay the snapshot, then replay the journal, through the same code. That path is exercised on **every single write** by the journal — rather than only in a disaster, which is the one place you cannot afford untested code.

Skip `faults` and `storageStats` entirely — derived and disposable; regenerate them.

### The job

`lib/jobs/snapshot-job.ts`, default daily, freeze-gated like every other job.

```
1. record startedAt, then stream `content` by _id cursor → gzipped EJSON JSONL → temp file
       (also: volumes, runtimeConfig; write the `end` trailer LAST)

2. PUT it into STRUBS as a normal object: /.strubs/snapshots/<iso-ts>.jsonl.gz
       → erasure-coded, scrubbed, repaired and rebalanced like anything else. Free redundancy.

3. VALIDATE  (below — not optional)

4. Update .bootstrap.json on EVERY writable volume:  previousSnapshot ← snapshot;  snapshot ← new

5. Delete the object that WAS previousSnapshot     → retention is exactly {current, previous}

6. Prune journal segments whose range ends before previousSnapshot.startedAt
```

Any step failing aborts the rotation, leaves the existing manifest and both snapshots untouched, and notifies `critical`.

### Validation is not checksumming

An MD5 proves the file didn't rot on disk. It proves **nothing** about whether the export was *complete* — a truncated export checksums perfectly.

Our own format makes real validation cheap, and it needs no scratch database and no external tool:

```
read the object back THROUGH STRUBS      → verifies every chunk md5 + the whole-object md5
gunzip + parse EVERY line                → catches truncation and corruption mid-stream
assert the `end` trailer is present      → THE check: a truncated export has no trailer
assert trailer counts == lines parsed    → catches a silently short export
sample 100 records → their slice files exist on disk
```

The `end` trailer is the whole trick: a partial export is structurally impossible to mistake for a complete one, which is exactly the property `mongodump` + MD5 fails to give you.

### Retention policy: current + previous. No history.

Mongo is an index of the *current* disk state, not a history of it. Deletes are immediate and destructive — the slices are unlinked — so there is no point-in-time to roll back to. Restoring an old snapshot would only resurrect records pointing at slices that no longer exist, and every one would surface as a phantom fault. **An older snapshot is never better than a newer one.**

So we keep two, and not for history — for the **swap**:

- **The manifest flip is not atomic.** It is one write per volume. Mid-flip, some disks point at the new snapshot and some at the old — which is fine *only if both still exist*.
- **A bad new snapshot must not destroy the good old one.** Never unlink the previous until the new one is validated.
- **Space is free.** ~200 MB compressed × 6 slices × 2 generations ≈ 700 MB physical on a 277 TB array. The argument for keeping one was never storage.

### Journal pruning is the same decision

Prune journal segments older than the **previous** validated snapshot, not the newest. If the newest later proves bad, you must not already have destroyed the journal coverage that bridges the gap.

And prune relative to the snapshot's **`startedAt`**, not its completion. The export is a long `_id`-ordered cursor walk, not a point-in-time read: objects created *during* it may or may not appear, depending on where they sorted. Let the journal overlap the entire export window.

### The snapshot is not a single point of failure

If the snapshot object is itself below quorum, or the export was never taken, recovery still works — it degrades to **B** (rebuild from disk headers) plus whatever journal survives. Bytes are never at risk; only names and md5s are, and only for objects the journal doesn't cover.

### Two quirks, written down so they don't cost anyone a night

1. **The snapshot object is invisible to itself.** Its `content` record is created *after* the export was taken, so it is not inside it. After a restore, its slices exist with no record and it looks like an orphan. Re-insert its record during restore — the manifest has everything needed.
2. `/.strubs/snapshots/` is a reserved container by convention only. Nothing enforces it today; an API caller could write there.

---

## E. Fresh-host recovery

**The rule: detect and refuse. Never adopt.**

Provisioning *formats disks*. The catastrophic version of this feature is the one that helpfully "recovers" the array by reinitialising it.

At startup, if the `volumes` collection is empty (fresh Mongo) **and** unclaimed block devices carry a `strubs/.identity`:

1. Enter **RECOVERY** mode. Do not provision. Do not adopt. Do not start the object API.
2. Read `.bootstrap.json` from the disks; take the newest `updatedAt`.
3. Surface it:

```
GET  /$/recovery
{ "state": "detected",
  "instanceIdentity": "3f9a…",
  "disksFound": 28, "disksExpected": 30, "missing": [{ "id": 34, "label": "3.3" }],
  "snapshot": { "objectId": "…", "completedAt": "…" },
  "journalSegments": 14 }
```

4. The UI shows a blocking banner: **"28 disks found carrying STRUBS instance 3f9a… — Restore, or Wipe?"** Provisioning of those devices is **blocked** until a human chooses.

`POST /$/recovery/restore`:

```
1. write /var/lib/strubs/identity from the manifest, and RELOAD it in-process
       ← without this no disk will mount; and writing the file is not enough,
         config.identityBuffer must be populated before volumes validate

2. seed the `volumes` collection from the manifest (id, uuid, partitionUuid, flags),
   then mount and start the fleet

3. locate the snapshot object: scan the shard paths for <snapshotObjectId>.<n>,
   read the slice headers to recover its size / chunkSize / dataN / parityN and derive
   its placement from WHERE each slice was found  ← this is B's header-scan applied to
   one object, which is exactly why the manifest doesn't record placement
   → decode → replay

4. replay journal segments with ts >= snapshot.startedAt   (idempotent: put/del keyed by id)

5. rebuild-index --reconcile → adopt any remaining orphans
6. report: objects restored / adopted / orphaned / below quorum
7. recommend a full verify before trusting the array
```

**Orphan md5 recomputation is a background pass, not part of the restore.** Recomputing an orphan's md5 means reading it end-to-end. If the snapshot and journal both survived there should be few or no orphans and it is trivial. In the worst case — neither survived — *every* object is an orphan, and stamping md5s means a full read of the array (weeks). Don't block the restore on it: bring the array up, serve reads, and grind the md5s in the background, loudest-first. Until an orphan has an md5 it cannot be safely repaired (see B).

**Guards:**
- More than one distinct `instanceIdentity` among the disks → **refuse**, list them. Two arrays' disks are in one box.
- Manifest `instanceIdentity` disagrees with an existing `/var/lib/strubs/identity` → **refuse**.
- Restore is refused if Mongo is non-empty (use the tools directly for a partial recovery; don't let a button merge two arrays).

---

## F. Metadata drift scrub

`rebuild-index --report` on a schedule (monthly). Diffs the disks against Mongo and notifies on drift:

- records referencing slices that are not on disk (phantoms)
- slices on disk with no record (orphans)
- placement disagreement (Mongo says vol 17, the file is on vol 23)

This is what keeps "the disks are authoritative" an actual property rather than an aspiration. It is nearly free once B exists.

---

## Config

| | Default | |
|---|---|---|
| `STRUBS_JOURNAL_ENABLED` | `true` | |
| `STRUBS_JOURNAL_REPLICAS` | `3` | across distinct bus groups |
| `STRUBS_JOURNAL_FLUSH_MS` | `50` | group-commit window |
| `STRUBS_SNAPSHOT_INTERVAL_MS` | `86400000` | daily; `0` disables |
| `STRUBS_SNAPSHOT_VALIDATE` | `true` | **do not turn this off** |

## Failure modes to test

| | Expect |
|---|---|
| Kill mid-write, after journal, before Mongo | rebuild finds the object, fully named |
| Kill mid-delete, after journal, before unlink | orphan → lost+found (not a phantom) |
| Snapshot validation fails | rotation aborts, old manifest and both snapshots intact, `critical` notification |
| Manifest flip half-completes | both snapshots still exist; recovery picks the newest `updatedAt` |
| Mongo wiped, disks intact | rebuild-index reconstructs; a full restore names everything |
| Mongo wiped, disks intact, **no snapshot and no journal** | every object recoverable as a nameless orphan in lost+found — bytes intact, md5s recomputed |
| Fresh host, no identity file | RECOVERY mode, not a crash and not a fresh identity |
| Two arrays' disks in one box | refuse, list both identities |
| A journal volume is drained | replicas re-elected and segments copied before it empties |
| Deleting a volume holding the last copy of a segment | refused, like a volume that still holds live slices |
| Snapshot object itself below quorum | recovery degrades to rebuild-from-disk + journal; bytes never at risk |
| Restore run against a non-empty Mongo | refused (do not let a button merge two arrays) |

## Sizing

| | |
|---|---|
| Manifest | < 10 KB per volume |
| Journal | ~200 B/object; pruned to the snapshot interval, so bounded by a day's writes |
| Snapshot | ~200 MB compressed × 6 slices × 2 generations ≈ 700 MB physical |

## Open questions

- **Should the journal also carry `sliceErrors` / `lastVerifiedAt`?** Leaning no: both are derivable by re-verifying, and it would bloat the hot path. A restored array should get a full verify anyway.
- **Group-commit window on the write path.** 50 ms is a guess. Measure against a small-object workload before committing to a default.
- **Mongo replica set** is orthogonal to all of this and largely covers "the host OS disk died" on its own. It composes; it does not substitute — a replica faithfully replicates a `dropDatabase`.
