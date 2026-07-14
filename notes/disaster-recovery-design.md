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
| **G** | Encryption at rest (LUKS, optional, per-volume) | P5 |

A and B together already remove the worst outcome on the board. C and D reduce recovery from "a scan and a lost+found" to "a restore". E makes it usable by someone who isn't the author. F keeps it honest. G is independent of the rest, but it **depends on A–E existing first** — encryption turns "we lost the metadata" into "we lost everything", so it must not be switched on before the recovery story is real.

---

## A. Bootstrap manifest — `<mount>/strubs/.bootstrap.json`

Written to **every volume**, so any single surviving disk can bootstrap a recovery.

```json
{
  "version": 1,
  "instanceIdentity": "3f9a…",                 // hex of /var/lib/strubs/identity — THE critical field
  "geometry": { "dataSlices": 4, "paritySlices": 2 },
  "volumes": [                                  // so recovery knows what it is MISSING, and can BIND
    { "id": 4, "uuid": "51787cb9-…", "partitionUuid": "cd1eca67-…", "partitionSize": 3000591916544,
      "enabled": true, "healthy": true, "readOnly": false, "isDeleted": false,
      "diskSerial": "WD-WMC…", "label": "4.5" }
  ],
  "journalVolumeIds": [4, 30, 49],
  "snapshot":         { "objectId": "…", "md5": "…", "startedAt": "…", "completedAt": "…", "objects": 3600126 },
  "previousSnapshot": { "objectId": "…", "md5": "…", "startedAt": "…", "completedAt": "…", "objects": 3598904 },
  "updatedAt": "2026-07-11T22:00:00Z"
}
```

**The volume record must carry everything `Volume` needs to actually mount**, not just enough to name it — `VolumeConfig` (`volume.ts:20`) wants `enabled`, `healthy`, `read_only`, `partition_uuid`, `partition_size`, and friends. And binding **rejects a partition whose discovered size differs from `bytesTotal`** (`volume-fleet.ts:86`), so `partitionSize` is mandatory, not decorative. A manifest that omits it produces a fleet that knows its volumes exist and refuses to mount any of them.

> ### ⚠️ `partitionUuid` is NOT the GPT PARTUUID
>
> It is the **filesystem UUID** as reported by `lsblk`'s `UUID` column: discovery maps `child.uuid` and discards `partuuid` entirely (`device-discovery.ts:348`), and `findPartitionByUuid` matches on that (`volume-fleet.ts:75`).
>
> This matters enormously for (G). On a LUKS volume, `lsblk`'s `UUID` for the partition becomes the **LUKS container UUID**, and the ext4 filesystem moves to a `crypt`-type child — which `sanitizeRawBlockDevice` **filters out**, because it keeps only `type === 'part'` (`device-discovery.ts:345`). So today's discovery would not see an encrypted volume's filesystem *at all*.
>
> Any claim that "the GPT PARTUUID is stable under LUKS" is true and **irrelevant** — nothing binds on PARTUUID. Encryption requires deliberate device-discovery work; see G.

(`diskSerial` is belt-and-braces for a human; do not rely on it — on USB/SAS enclosures it is often the bridge's serial, not the drive's.)

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
        read the 48-byte header, and VALIDATE IT (see below)
        → id, size, dataN, parityN, sliceIndex, chunkSize
        → placement: sliceIndex < dataN ? dataVolumes[i] = vol : parityVolumes[i-dataN] = vol

group by id → a candidate content record, missing {name, containerId, mime, md5}

fill ONLY those four fields, in order of preference:
    1. the metadata snapshot   (D)
    2. journal replay          (C)
    3. nothing → orphan
```

### Placement comes from the disk. Always. Never from the journal or the snapshot.

**This is a load-bearing rule, and getting it wrong produces phantoms.**

Drain and rebalance rewrite `dataVolumes`/`parityVolumes` (`content-repository.ts:366`, `replaceObjectVolumeRef`) and rebalance then **deletes the source slice** (`rebalance-job.ts:403`). Neither journals the move. So a journal entry or a snapshot row written before a relocation records placement that is now **wrong, and the slice it names has been deleted**. Trusting it would restore records pointing at nothing — phantoms, which read as data loss.

So the split is absolute:

| From the disk (authoritative) | From snapshot/journal (only these) |
|---|---|
| `dataVolumes`, `parityVolumes` | `name` |
| `size`, `chunkSize`, `dataN`, `parityN` | `containerId` |
| | `mime` |
| | `md5` |

The `dv`/`pv` fields still appear in the journal and snapshot, but as a **diagnostic hint only** — a restore must never use them. A rebuild pass over the disks always runs, and it is what sets placement.

This is not a workaround; it is the governing principle applied consistently. The disks are authoritative.

### Duplicate slices: a scan WILL find two files for the same slice index

Both relocation jobs leave duplicates behind by design:

- **rebalance** flips the DB ref, then deletes the source — and explicitly documents that a crash in between "leaves a harmless duplicate" (`rebalance-job.ts:396`);
- **drain** flips refs but **keeps the source slice** until the disk is physically removed (`drain-volume-job.ts:307`).

Harmless while Mongo is the index — it knows which one is live. **Not harmless to a disk scan**, which sees two files named `<id>.<n>` on two volumes and has no idea which is current. Pick the stale one and you have restored a record pointing at an old slice, possibly with stale parity, and thrown the good one away.

**Recorded `dv`/`pv` must NOT be the tie-breaker.** It is tempting — it is right there, and it names a volume. But relocations are deliberately not journaled, so that hint can *predate* the very drain or rebalance that created the duplicate, and it would then point confidently at the stale copy. A hint that is wrong exactly when it matters is worse than no hint.

Arbitration rule, in order, on evidence from the disk alone:

1. Prefer the candidate that **verifies**: header valid (magic, version, length, header md5, identity fields) and every chunk checksum passes. Usually decisive — the stale copy is often the one that was mid-relocation.
2. If both verify, prefer the one on a **writable, healthy, non-draining** volume. A slice still sitting on a drained or draining disk is by construction the copy that was left behind.
3. If still ambiguous: **do not guess.** Mark the object **conflicted**, keep both files, report it, and leave it frozen for an operator.

Collect duplicates during the scan; do not arbitrate prematurely. Report every one regardless of outcome — a duplicate is evidence of an interrupted relocation, and the count is a useful health signal in its own right.

### Missing disks leave HOLES in the placement arrays — and holes are not short arrays

If a volume is absent at rebuild time, the slices it held are simply not found, and nothing in the header tells you which volume they lived on. So placement has a **hole**.

This is not a detail to be parked in "open questions", because the read path cannot express it: `loadFromRecord()` derives `dataSliceCount` from `dataVolumes.length` (`file-object.ts:210`), and `Slice` resolves every index to a volume immediately (`slice.ts:62`). **A short array does not mean "a slice is missing" — it silently redefines the object's erasure-coding geometry.** A 4+2 object rebuilt with three found data slices becomes, as far as the code is concerned, a 3+2 object. It would then "reconstruct" garbage with total confidence.

So the rebuild must emit **full-length arrays with an explicit placeholder**, and the geometry must come from the **header** (`dataN`/`parityN`), never from the length of a rebuilt array.

A `null` in the array is not enough on its own: `Slice` resolves its volume id immediately on construction (`slice.ts:62`) and `_instantiateSlices()` builds every index (`base.ts:146`). So this is a **read-path change, not just a data change**:

| | |
|---|---|
| **Schema** | `dataVolumes[i] = null` for an unknown volume. Arrays stay full length, so `dataSliceCount` stays correct. |
| **`loadFromRecord`** | Add every `null` index to `unavailableSlices` — the state the reader *already* understands (`file-object.ts:214`, `slice.ts:167`). |
| **`_instantiateSlices`** | Skip construction for a null volume rather than resolving it. |

The reader then treats the slice as unavailable and reconstructs from parity, which is exactly right — the slice genuinely is unavailable. Objects that fall below quorum this way are reported and frozen, not silently reconstructed.

Objects that end up below quorum this way are reported and frozen, not silently reconstructed.

### Header validation is the rebuild tool's job

`Slice._validateHeader()` (`slice.ts:536`) checks only the identity fields — it does **not** verify the magic bytes, the version, the header length, or the header's own MD5, all of which the writer stores (`slice.ts:101-113`). The live read path gets away with this because it already knows what it expects.

A disk scanner knows nothing. It must validate magic, version, header length, and the header MD5 itself before trusting a single byte of what it reads — otherwise a corrupt or foreign file in the tree becomes a fabricated `content` record.

### Orphans are FROZEN until their md5 is known

**Orphans** — objects on disk with no name and no md5 — go into a reserved `lost+found` container with `name = <id>`, and are reported loudly.

> ### ⚠️ An `md5: null` object must not be repaired, drained, or rebalanced.
>
> `SliceRepairer` only builds the verification hash `if (expectedMd5)` (`slice-repairer.ts:63`), and the commit refusal is inside that branch (`slice-repairer.ts:94`). There is an explicit test for it: *"commits without a gate when the object has no stored md5"* (`slice-repairer.test.ts:81`).
>
> And `repairSlice` is not only the repair worker's — **drain calls it** (`drain-volume-job.ts:297`) **and so does rebalance** (`rebalance-job.ts:63`). So an adopted orphan sitting quietly in `lost+found` could be silently corrupted by a routine rebalance, with no gate, no error, and no way to notice.
>
> Therefore: an md5-null object must be **frozen** — repair skips it, drain skips it, rebalance skips it — and it thaws only once its md5 has been recomputed and stamped.
>
> **This freeze does not exist today and cannot simply be inherited.** An earlier draft claimed the existing `recoveryComment` guard "already teaches all three jobs to leave an object alone". It does not:
>
> | | `recoveryComment` guard | `md5 == null` guard |
> |---|---|---|
> | repair worker | ✅ `repair-worker.ts:362` | ❌ none |
> | drain | ✅ `drain-volume-job.ts:260` | ❌ none |
> | **rebalance** | ❌ **none** (`rebalance-job.ts:333`) | ❌ none |
>
> **Update (fixed):** the missing `recoveryComment` guard in rebalance has since been closed, and "documented dead" is now a single predicate — `isDocumentedDead()` (`database/types.ts`) — shared by repair, drain and rebalance. It had drifted into three different tests, and one combination was a data-loss path: an object with an *empty* `recoveryComment` was skipped by the drain (its slice stayed on the volume) yet excluded from `countObjectsOnVolume({excludeDead})` (so the volume reported itself fully drained, unblocking removal of a disk that still held the slice).
>
> **The `md5 == null` guard still does not exist in any of the three jobs.** It must be built before a single orphan is adopted.

### Recomputing an orphan's md5 must not bless a bad reconstruction

The obvious implementation — read the object end to end and hash what comes out — is **wrong, and it is the kind of wrong that permanently launders corruption into truth.**

The reader reconstructs missing data from parity *without any whole-object gate* (`reader.ts:224`). So if a slice is missing or bad, a naive md5-stamping pass would hash **the reconstruction** and record it as the object's canonical md5 — permanently blessing whatever the parity produced, and destroying the only evidence that anything was ever wrong. The repair gate would then happily "verify" against it forever.

So the stamping job must:

1. read **only directly-read, per-chunk-checksum-verified data slices** — no parity, no reconstruction;
2. **refuse to stamp** any object where a data slice was missing, unreadable, or had to be rebuilt, and report it instead;
3. leave such objects frozen. They are readable, immovable, and honestly labelled as unverifiable — which is the correct state, not a failure.

Recomputing is otherwise a full read of the object, so it is a **background pass**, never part of the restore. If the snapshot and journal survived there will be few orphans and it is trivial. If neither survived, *every* object is an orphan and stamping is a full read of the array (weeks). Bring the array up, serve reads, grind through them in the background. Until then they are readable but immovable — exactly the safe state.

### Modes

| | |
|---|---|
| `--report` | Read-only. What's on disk, what Mongo says, and the diff. Doubles as F. |
| `--rebuild` | Write records into an empty/scratch database. |
| `--reconcile` | Adopt orphans into an existing database; never overwrite a record that already has a name. **Recovery/offline only — see below.** |

> **`--reconcile` must not run against a live, serving array — and the maintenance freeze is NOT sufficient.** A `PUT` commits its slice files to disk *before* inserting the Mongo record (`file-object.ts:166` then `:185`). An orphan adopter racing that window sees committed slices with no record and files a perfectly healthy, in-flight object into `lost+found`.
>
> The freeze only stops verify/repair/drain/rebalance (`mgmt.ts:402`). **It does not stop the object API**, and `PUT` keeps committing normally (`object-put-request.ts:179`). So reconcile requires the **object API stopped** (recovery mode already does this), or a real settle protocol: two passes with an age cutoff, adopting only slices whose mtime is older than the longest plausible in-flight `PUT`.

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

`dv`/`pv` are a **diagnostic hint only**. A restore must never trust them — placement always comes from the disk scan (see B). They are in the record because they are free and they make a journal readable by a human, not because anything reads them back.

**Containers must be journaled, with the same ordering discipline as objects.** Their names exist nowhere on disk, so an unjournaled container turns every object beneath it into an orphan — one lost row can cost you a whole subtree of the namespace.

`PUT` creates containers *before* it commits the object (`object-put-request.ts:174`), and the row is inserted deep inside `resolveContainer` (`content-repository.ts:634`). So it is not enough to "hook `getOrCreateContainer`":

- the container's journal record must be **fsynced before its Mongo insert**, exactly as for objects;
- a child object's journal record must not be acknowledged until **its parent chain is durable in the journal**. Otherwise a crash can leave a journaled object whose `cid` names a container that was never journaled — and the replay has an object with no path to hang it from.

Replay must also be **parent-first**, and tolerant of a container it has already seen (containers are created idempotently by many concurrent writers).

### Hooks — these do NOT exist yet

An earlier draft claimed `FileObject`'s existing `recordObjectCreated` / `recordObjectDeleted` dependency slots were the natural place for this. **They are not.** They are synchronous, fire-and-forget `void` callbacks (`file-object.ts:43`) used for storage stats, and — fatally — they fire in the wrong position:

| | What the code does today | What the journal needs |
|---|---|---|
| **create** | `writer.commit()` → **Mongo insert** (`:166`) → hook (`:185`) | slices committed → **journal fsync** → Mongo insert |
| **delete** | **unlink slices** (`:293`) → Mongo delete → hook (`:303`) | **journal fsync** → unlink slices → Mongo delete |

So the journal needs **new, awaited calls** placed inside `FileObject.commit()` and `FileObject.delete()`. The existing hooks cannot be reused: they run too late to guarantee anything, and a `void` callback cannot be awaited for durability.

### Ordering — this is the part to get right

**On create: slices committed → journal → Mongo.**
Crash between the journal and Mongo leaves the object on disk and in the journal but not in Mongo → the rebuild finds it, fully named. The reverse order would leave it in Mongo but not the journal → a snapshot+journal restore misses it entirely, and it degrades to a nameless orphan. Journal first.

**On delete: journal → unlink slices → Mongo.**
Crash after journaling but before unlinking leaves slices with no record → an **orphan**, which lands in lost+found and is recoverable. The reverse leaves a record with no slices → a **phantom**, which reads as data loss and will alarm you about an object that was deliberately deleted. Orphans are strictly better than phantoms.

**Relocations are not journaled, and must not be.** Drain and rebalance move slices constantly; journaling every move would swamp the log to record something the disk already knows. This is safe precisely *because* placement is re-derived from disk on restore (B). It is also the reason it must be.

### Cost, and how to keep it small

K appends + K fsyncs on the write path. For this workload (large media, writes measured in seconds, already doing 6 slice writes) that is noise. For a small-object workload it would not be.

- **Group commit:** a batching writer that accumulates for `STRUBS_JOURNAL_FLUSH_MS` (default 50) or N records, then one fsync per volume. A `put` waits on its own flush before Mongo insert.
- Configurable `STRUBS_JOURNAL_REPLICAS` (default 3), `STRUBS_JOURNAL_ENABLED` (default true).
- Journal write failure on *some* replicas: proceed if ≥1 succeeded, notify `warning`. Failure on **all**: fail the write. The journal is a durability guarantee; silently degrading it is how you discover it was empty when you needed it.

**Rotation:** new segment per 64 MB or per day. Segments are named by sequence and carry their time range in the first line.

### Prerequisite bug: drain can orphan a slice the way rebalance used to

Not strictly part of this plan, but it corrupts the ground this plan stands on, and the rebuild tool would inherit the mess.

`replaceObjectVolumeRef()` rewrites **every** array element matching the source volume (`content-repository.ts:366`), while a relocation copies exactly **one** file. So an object holding two slices on one volume would have *both* refs repointed at the single copy, orphaning the other — turning a recoverable slice into a lost one, while making the volume look safely drained.

**Fixed:** both rebalance and drain now refuse such an object and count it (`duplicateRefs`). It is recorded here because the rebuild tool must still expect duplicates *already on disk* from before the fix, and because `replaceObjectVolumeRef` remains a footgun for any future caller.

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
1. record startedAt, then stream `content` by _id cursor → gzipped JSONL (plain hex, see above) → temp file
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

If the snapshot object is itself below quorum, recovery falls back to the **previous** snapshot plus the journal — which is precisely why two are kept, and why the journal is pruned only to the *previous* one. Only if both are unusable does it degrade to **B** (rebuild from disk headers) plus whatever journal survives. Bytes are never at risk at any point; only names and md5s are, and only for objects the journal doesn't cover.

### Two quirks, written down so they don't cost anyone a night

1. **The snapshot object is invisible to itself.** Its `content` record is created *after* the export was taken, so it is not inside it. After a restore, its slices exist with no record and it looks like an orphan. Re-insert its record during restore — the manifest has everything needed.
2. `/.strubs/snapshots/` is a reserved container by convention only. Nothing enforces it today; an API caller could write there.

---

## E. Fresh-host recovery

**The rule: detect and refuse. Never adopt.**

Provisioning *formats disks*. The catastrophic version of this feature is the one that helpfully "recovers" the array by reinitialising it.

### Two required code changes before any of this is safe

**1. `Volume.verify()` must stop writing.** It reads `strubs/.identity` and, on `ENOENT`, **creates it** (`volume.ts:320` → `createIdentityFile()`). A function called *verify* has no business writing to a disk it was asked to inspect — and it means the ordinary startup path, pointed at an unknown disk, will silently stamp our identity onto it.

Split it, rather than asking every future caller to remember:

| | |
|---|---|
| `verifyIdentity()` | read-only. Missing identity → returns "absent", never writes. |
| `initializeIdentity()` | explicit, called **only** from the provisioning path. |

Recovery probing then simply cannot go wrong, because the dangerous capability isn't reachable from the path it uses. (Fixing the design beats documenting the hazard.)

**2. Provisioning must be blocked in the BACKEND during recovery, not just greyed out in the UI.** With a fresh Mongo, `ensureDeviceNotRegistered` (`device-provisioner.ts:103`) has no registered volumes to protect — there is nothing in the database to say the disk is ours. And `wipe` only checks for *mounted* partitions before destroying the partition table (`device-provisioner.ts:44`, `:144`). So on a rebuilt host, the disks holding 130 TB are, as far as the provisioner is concerned, blank media.

The recovery state must be a hard gate inside `deviceProvisioner`, refusing any device that carries a STRUBS nameplate or identity, regardless of what the API asks for.

### The flow

At startup, if the `volumes` collection is empty (fresh Mongo) **and** unclaimed block devices identify as ours:

1. Enter **RECOVERY** mode. Do not provision. Do not adopt. Do not start the object API.
2. **Identify the disks — read-only, always.** Two sources, neither needing the encryption key:
   - the **GPT nameplate** (G) — `strubs-<instance>-<volumeId>` — readable with no mount and no unlock;
   - failing that, **mount read-only** and read `strubs/.identity` (works on unencrypted volumes, and on legacy disks predating the nameplate). Probing goes through `verifyIdentity()`, never the volume-start path — see above.
3. **If any disk is `crypto_LUKS`, the passphrase comes first.** The bootstrap manifest lives *inside* the encrypted filesystem, so nothing beyond the nameplate is readable until the volume is unlocked. So the flow is: identify → prompt → unlock → *then* read manifests. (This is why the nameplate exists; see G.)
4. Read `.bootstrap.json` from the unlocked disks; take the newest `updatedAt`.
5. Surface it:

```
GET  /$/recovery
{ "state": "detected",
  "instanceIdentity": "3f9a…",
  "disksFound": 28, "disksExpected": 30, "missing": [{ "id": 34, "label": "3.3" }],
  "encrypted": 18, "locked": 18,          // needs a passphrase before we can read further
  "snapshot": { "objectId": "…", "completedAt": "…" },   // null until unlocked
  "journalSegments": 14 }
```

6. The UI shows a blocking banner: **"28 disks found carrying STRUBS instance 3f9a… (18 encrypted) — Unlock and restore, or Wipe?"** Provisioning of those devices is **blocked** until a human chooses.

`POST /$/recovery/restore`:

> ### The order is: SCAN FIRST, then overlay the namespace. Never the reverse.
>
> An earlier draft replayed the snapshot and journal into `content`, *then* ran `rebuild-index --reconcile` to mop up orphans — with reconcile told to "never overwrite a record that already has a name". Those two rules combine into a bug: **the replayed (possibly stale) `dv`/`pv` wins, and the disk scan is forbidden from correcting it.** Every object relocated since the snapshot would be restored pointing at a volume that no longer holds its slice, and rebalance has already deleted the source. Phantoms, at scale.
>
> The disk scan is the authority on placement. It must run **first**, and the snapshot/journal may only overlay `{name, containerId, mime, md5}` onto what it found.

```
0. (G) unlock every crypto_LUKS volume with the operator's passphrase, and write a fresh
   keyfile slot so the rebuilt host can boot unattended from here on

1. write /var/lib/strubs/identity from the manifest, and RELOAD it in-process
       ← without this no disk will mount; and writing the file is not enough,
         config.identityBuffer must be populated before volumes validate

2. seed the `volumes` collection from the manifest, mount and start the fleet
       (needs partitionSize et al — see A)

3. SCAN EVERY DISK.  Build the authoritative placement map from slice headers:
       {id → size, chunkSize, dataN, parityN, dataVolumes[], parityVolumes[]}
   resolving duplicates and inserting placeholders for missing volumes (see B).
   Nothing is written to Mongo yet.

4. locate the snapshot object within that map (it is just another id), decode it,
   and read the journal segments with ts >= snapshot.startedAt.
   These give a namespace map:  {id → name, containerId, mime, md5}

5. MERGE: placement from step 3, namespace from step 4. Placement always wins.
   Objects with no namespace entry → orphans → lost+found, md5 null, FROZEN.
   Write the resulting records.

6. force a storageStats reconcile; clear/hydrate the container cache
       (both are process-local or derived and will otherwise be wrong — see below)

7. report: restored / adopted / orphaned / conflicted / below quorum
8. leave the maintenance freeze ON until a verify pass has been run.
```

**The snapshot is chicken-and-egg only in appearance.** By step 4 the scan already knows every object on disk — including the snapshot object itself — so locating it needs no special case. It is just an id whose placement we already derived.

**Do not restore `runtimeConfig` wholesale.** The snapshot contains it, but `core.start()` consumes persisted operational state (`core.ts:72`) — `verifyStartedAt`, drain cursors, `rebalanceActive`. Restoring those would have a freshly-recovered array immediately resume a rebalance from a cursor that predates the disaster. **Filter the operational keys**; restore only genuine settings, and force `maintenanceFreeze = true` until a verify has passed.

**Derived state must be rebuilt, not assumed.** `storageStats` is skipped by the snapshot (correctly — it is derived), but after a bulk restore it is simply wrong until a forced reconcile (`stats-tracker.ts:117`). And `ContainerCache` is process-local (`container-cache.ts:13`), so an in-process restore that inserts container rows behind its back leaves it stale — clear and hydrate it.

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
- **(with G)** volumes whose GPT nameplate disagrees with their `.identity`

This is what keeps "the disks are authoritative" an actual property rather than an aspiration. It is nearly free once B exists.

---

## G. Encryption at rest — LUKS, optional, per-volume

### Threat model, stated first, because it collapses the design

Encryption at rest defends against exactly one thing here: **a disk leaving our physical control** — RMA'd, sold, discarded, stolen. That is a real threat: failing drives are pulled routinely and they hold customers' photos, video and call recordings.

It does **not** defend against a compromised host (the key must be online to serve reads) or against the network. Sequencing follows from that: it is defence in depth, not a foundation.

**It also depends on A–E existing first.** Encryption converts "we lost the metadata" into "we lost everything" — a lost key is unrecoverable in a way that a lost Mongo is not. Do not enable it before the recovery story is real.

### LUKS (dm-crypt), not application-level encryption

Measured on the production host (Intel i5-7500, AES-NI, *while a rebalance was running*):

| | |
|---|---|
| AES-XTS-256 | **2,397 MiB/s** encrypt, **2,439 MiB/s** decrypt, per thread |
| Peak observed disk I/O (rebalance) | ~217 MB/s (161 read + 56 write) |
| → crypto cost at peak | **~9% of one core** |
| Kernel slab per LUKS device | **~94 kB** → ~3 MB for 30 disks |
| `kcryptd` kernel threads | **4, regardless of device count** — a shared workqueue pool, not a daemon per disk |

The disks are an order of magnitude slower than the cipher. LUKS is free here, and there is **no per-disk memory growth** worth the name (contrast Ceph's gigabytes per OSD).

Counter-intuitively, LUKS is likely **faster than application-level** on this system despite doing strictly more crypto work: app-level encryption runs inside the Node process, would have to go to the libuv threadpool (the same reason `@ronomon/crypto-async` exists — hashing on the main thread blocks the event loop), and would contend there with RS encoding and MD5 hashing. dm-crypt runs in kernel context on the I/O path, entirely off the event loop.

App-level's one genuine advantage — encrypt-before-EC means scrub/repair/drain/rebalance operate on ciphertext and never decrypt — saves ~5× the crypto work on the repair path. At 9% of a core, that buys nothing, and it would require surgery on `content.md5` (splitting the plaintext hash used by the API from a ciphertext hash used by the repair gate) — i.e. touching the exact invariant that currently keeps the data honest. Not worth it.

**Do not use dm-integrity.** LUKS2 can do authenticated encryption, but it costs a journal write per write (severe amplification on spinning disks) and it only *detects*. We already detect via per-chunk MD5 **and can repair from parity**, which is strictly better.

### Drive errors behave the same

- **I/O errors pass straight through.** dm-crypt is transparent; a bad sector's `EIO` propagates unchanged to ext4 and to STRUBS.
- **Silent corruption is still caught, because our integrity checking sits *above* the encryption.** Chunk MD5s are over the plaintext we write; rot on the platter decrypts to garbage, the chunk MD5 fails, the reader reconstructs from parity. Unchanged.
- **Corruption amplification is bounded and irrelevant.** AES-XTS works in independent 16-byte blocks, so one flipped ciphertext bit corrupts 16 bytes of plaintext and no more. Our failure/repair unit is the 16 KB chunk, which we rebuild in full regardless — one bit or sixteen bytes is the same event.
- **Write atomicity is unchanged** (XTS is length-preserving and sector-aligned; no read-modify-write).

What genuinely gets worse: the LUKS header (below), forensics (a locked device tells you nothing — `debugfs` needs it unlocked), and one monitoring path that **must** be fixed first:

### ⚠ Hard prerequisite: the syslog watcher must resolve `dm-N`

**Verified:** ext4 names the *mapper* device in its logs, not the physical disk —

```
EXT4-fs (dm-0): mounted filesystem …
```

So on an encrypted volume, today's filesystem-error signature (`Buffer I/O error on dev sdf1`, `EXT4-fs (sdf1): shut down requested`, `JBD2: …sdf1-8`) becomes `dm-3`. `volume.deviceName` is the physical disk, and `parentDiskName` maps `sdf1 → sdf`; it maps **`dm-3` → nothing**. The watcher would drop those as *"ignoring ioerror on dm-3 (not a managed volume)"* — **the exact bug fixed in commit 52bd575, reintroduced one layer down.**

Resolution path exists and is trivial: `/sys/block/dm-3/slaves/` → `sdf1` → parent disk → volume. It needs writing, and it needs a test.

SCSI/medium-layer errors (`device offline error, dev sdf`, medium errors, USB dropouts) still name the physical device and keep working. It is specifically **filesystem-layer** errors that move.

**Encryption must not ship before this.** Otherwise we encrypt the disks while silently switching off the thing that tells us they are dying.

### The GPT nameplate — how a locked disk says who it is

A LUKS volume's `.identity` and `.bootstrap.json` live *inside* the encrypted filesystem, so a locked disk can't be identified. The fix is not a second partition — it is 26 characters in a field that is already there and already empty.

The disks are GPT and the **partition-name field is unused**. It holds 36 chars, lives in the partition table *outside* the LUKS container, and is readable with no mount, no unlock and no `cryptsetup`:

```
strubs-<first 16 hex of instance identity>-<volume id>      e.g.  strubs-3f9a1b2c5d6e7f80-13
```

**Verified on a loopback LUKS disk:** `sgdisk -c` writes it, `lsblk`/`blkid`/`sgdisk` all read it back, PARTUUID is unchanged, and the LUKS payload is intact. It is **non-destructive and can be applied to the existing fleet in place, today** — no drain, no repartition, no data movement.

> **Correction to an earlier draft:** that verification noted "PARTUUID is unchanged, so `findPartitionByUuid` still binds". The first half is true; the conclusion is wrong. **Nothing binds on PARTUUID** — `volume.partitionUuid` is the *filesystem* UUID (`device-discovery.ts:348`). The nameplate neither helps nor harms binding. It is purely a pre-unlock identity hint, and binding under LUKS is a separate problem, solved in the device layer below.

> Use **hyphens, not colons**: `sgdisk -c` takes `partnum:name`, so colons in the name are eaten as delimiters and silently truncate it.

**Why not a dedicated unencrypted partition?** Because there is nothing left to put in it. The one thing that seemed to require it — a password-wrapped copy of the key — is unnecessary: **a LUKS keyslot *is* a password-wrapped master key.** Everything else (the full manifest, the volume list, the snapshot pointer) is only needed once you are already unlocked. A second partition would cost a destructive full-fleet repartition (~264 TB of relocation) to buy space we do not use.

**The nameplate is advisory, never authoritative.** `.identity` inside the filesystem remains the real check. A stale or wrong nameplate cannot corrupt anything — worst case it mis-advertises and the real validation rejects it. Same philosophy as the syslog watcher: a hint that triggers a look, never a conclusion.

Apply it to **every** volume, encrypted or not — that is what gives the mixed fleet a single discovery path.

### Keys

**LUKS keyslots are the escrow.** Two slots per volume:

| Slot | Purpose |
|---|---|
| **Keyfile** — `/var/lib/strubs/luks.key`, mode 0400 | Unattended boot. `Restart=always` means a passphrase prompt at boot is a non-starter. |
| **Passphrase** — operator-chosen, Argon2id | Disaster recovery. The OS disk is gone; this is how you get back in. |

Be honest about what the keyfile means: with the key on the OS disk, we protect **disks that leave the building, not the host**. That is precisely the threat we have.

**Guards:**
- Refuse to enable encryption unless a passphrase slot has been set **and** the operator has confirmed they have recorded it. A keyfile-only fleet dies with the OS disk.
- The keyfile is **never** written into the nameplate, the manifest, the journal or a snapshot.
- Back up each volume's LUKS header (`cryptsetup luksHeaderBackup`, ~16 MB) — store as a STRUBS object and off-box. A corrupt header costs one disk, which 4+2 already survives, so this is insurance rather than a critical path. (LUKS2 also keeps a checksummed secondary header copy.)

### Per-volume, mixed fleet

Encryption is a property of a **volume**, not the fleet. Both states coexist indefinitely and are fully interchangeable as EC targets — the erasure coding neither knows nor cares.

- `VolumeStatus.isEncrypted` — **derived at discovery** from the partition (`FSTYPE == crypto_LUKS`), not stored as a mutable flag. The disk is the source of truth; a stored flag could drift.
- Volume start: `crypto_LUKS` → `luksOpen` with the keyfile → mount the mapper device. Otherwise → mount the partition directly. One branch, at the right layer.
- Hotplug: the device reconciler unlocks a reappearing encrypted disk the same way.
- SMART, `identify` (LED), and the raw-device paths are unchanged — they operate on the physical device.
- **Key unavailable ≠ array down.** If the keyfile is missing or a volume fails to unlock, that volume starts `unavailable` with a clear reason (`locked: key unavailable`); the rest of the fleet serves normally. Notify `critical` — and note that ≥3 locked volumes puts objects below quorum.

> **Partial encryption gives partial protection.** Until the fleet is 100% converted, pulling *any* unencrypted disk still leaks the slices on it. Report fleet coverage ("18 of 30 volumes encrypted") and do not let the UI imply the array is protected when it isn't.

### Conversion — every path supported

You cannot encrypt a disk in place. Every path is therefore some form of *drain → re-provision → refill*, which is machinery that already exists.

| Path | How | Cost |
|---|---|---|
| **New disks only** | `encryptNewVolumes = true`. Every disk provisioned from now on is encrypted. | Free |
| **On replacement** *(recommended default)* | Drives are drained and replaced as they age anyway. With the flag on, the fleet converts naturally over its normal refresh cycle. | Free — the drain was happening regardless |
| **On demand, one volume** | `POST /$/volumes/{id}/encrypt` → drain → wipe → `luksFormat` → `mkfs` → re-register → rebalance refills it. A wrapper over drain + provision + rebalance. | ~2× that disk's contents in relocation |
| **Whole fleet, one at a time** | The same action, queued, auto-continuing to the next volume on completion — exactly as drain already auto-continues. Cancellable; safe to stop half-way (mixed is a supported steady state). | **~264 TB of relocation, ~2 months at ~200 GB/hr.** State it plainly before anyone starts. |

The full-fleet conversion is a *complete rewrite of the array*: draining a volume moves ~4.4 TB off it and refilling moves ~4.4 TB back, times 30 disks. **The cheapest honest path is "on replacement" plus on-demand for anything you want done sooner.**

Order matters if you run the full conversion: convert **unencrypted** volumes, and never let the conversion job pick a source that would take the fleet below the free space needed to absorb a drain.

### The device layer does not understand LUKS at all — and one gap is a data-loss hole

This is the heaviest part of G, and an earlier draft badly understated it. Today the device layer assumes *partition == filesystem*, and every one of these breaks:

**⚠️ DATA LOSS — the wipe guard is blind to a mounted encrypted volume.**
`deviceHasMountedPartitions()` (`device-provisioner.ts:90`) looks for a mountpoint on the device's **direct `part` children**. On a LUKS volume the partition has **no mountpoint** — the *mapper* does, and the mapper is a `crypt` grandchild. So the guard returns `false`, and `POST /$/volumes {wipe}` would **cheerfully repartition a mounted, in-service, encrypted disk holding live data.**
This must be fixed *before* the first volume is ever encrypted. Not after.

**Discovery discards the filesystem.** `sanitizeRawBlockDevice` keeps only `type === 'part'` children (`device-discovery.ts:345`). A LUKS volume's ext4 lives on a `crypt` child, so discovery never sees it. Encrypted volumes would be invisible.

**Binding matches the wrong UUID.** `volume.partitionUuid` is the filesystem UUID from `lsblk` (`device-discovery.ts:348`, `volume-fleet.ts:75`) — under LUKS that becomes the **LUKS container UUID**. Workable, but it must be a deliberate decision with defined semantics, not an accident. (And `partition_size` must account for the LUKS header, given the size check at `volume-fleet.ts:86`.)

**Stale-mount detection compares the wrong path.** It matches `/proc/mounts` sources against the **raw partition path** (`volume-fleet.ts:431`). Under LUKS the source is `/dev/mapper/…`, so every encrypted volume looks perpetually unmounted.

**The syslog watcher can't even parse the line.** Beyond the `dm-N` → device resolution already flagged, the parser only matches `… dev <name>` (`system-log-watcher.ts:236`). `EXT4-fs (dm-0): …` never matches that pattern at all, so it isn't a resolution bug — the line is dropped before resolution is ever attempted. **Both the parser and the resolver need work.**

### Code surface

**IMPLEMENTED (2026-07-13/14). Shipped in `off`; zero volumes converted.**

| | |
|---|---|
| `device-provisioner.ts` | ✅ `deviceHasMountedPartitions` walks the whole subtree; `assertDeviceIsNotOurs` runs on EVERY path; `luksFormat` + passphrase + `luksOpen` → `mkfs.ext4` **on the mapper**; GPT nameplate; the `convertVolumeId` path (see below) |
| `device-discovery.ts` | ✅ keeps `crypt` grandchildren; exposes `PARTLABEL` (the nameplate). The partition's `uuid` under LUKS is the **container** uuid — deliberate: it is the one id readable while the disk is still locked |
| `volume-fleet.ts` | ✅ stale-mount detection compares the **mapper** path; `deregisterVolume()` (stop + unbind, delete nothing) |
| `volume.ts` | ✅ unlock before mount, **lock after unmount**; fsck the mapper, not the ciphertext; a volume that cannot unlock reports `locked: …` in `mountError` and the rest of the fleet serves on |
| `device-reconciler.ts` | ✅ nothing to do — it remounts via `volume.mount()`, which now unlocks first |
| `system-log-watcher.ts` | ✅ done as a prerequisite (`bbe8a4d`): parses `EXT4-fs (dm-N)`/`JBD2` and resolves `dm-N` → physical device via `mapperLeaves()` |
| `helpers/spawn.ts` | ✅ resolves on `close` (not `exit`) so a wipefs whose stdout we dropped can no longer look like a blank disk; `stdin` support so the passphrase never touches argv |
| `mgmt.ts` | ✅ `POST /$/volumes/{id}/encrypt`; `PUT /$/encryption/settings`; `isEncrypted` in `VolumeStatus`; three-way fleet coverage in `/$/status` |
| `ui/` | ✅ lock badges, coverage bar, encrypt action, and a partial-encryption warning that refuses to call the array protected |

**The recovery passphrase is enforced, not advised.** `luks.format()` creates only the keyfile slot, so
`addPassphrase()` + `assertRecoverable()` (which re-reads the header and demands ≥2 keyslots) run before
the mkfs — a keyfile-only volume is impossible to create, not merely discouraged. A salted-scrypt verifier
in Mongo (`luks-recovery-key.ts`) refuses a passphrase that disagrees with the rest of the fleet, so the
fleet cannot silently end up with two different recovery keys. The verifier does not weaken the threat
model: it lives on the OS disk, not the platters, and anyone holding the OS disk already has the keyfile.

**Conversion wipes one of our own disks on purpose**, so `convertVolumeId` inverts the identity guard: the
disk must **prove** it is that exact volume, of this instance, before anything touches it. A stranger's
disk, a blank disk, an unreadable disk, or one of ours bearing a different volume id all still refuse.

It also refuses:

- a volume that is **still writable** — it does not flip the read-only flag and walk straight in. A PUT
  commits its slice files *before* it inserts the object record, so a write already in flight would leave
  slices on a platter we are about to wipe and a record arriving afterwards pointing at them. The quiesce is
  the operator's hours-long drain, not a millisecond of ours;
- a volume whose **platter still holds slice files**, checked by walking the disk (`buildSliceIndex`) rather
  than by asking Mongo. **Mongo cannot see orphans**, and an orphan is *recoverable data* — reporting zero
  live slices for a disk carrying 9,000 of them, and wiping it, inverts *orphans beat phantoms*. The scan
  fails closed: an unreadable directory throws rather than reporting an empty disk;
- a volume that is **not mounted**, because then the platter cannot be scanned at all.

### Recovering an encrypted fleet — the day the passphrase earns its keep

The bootstrap scan unlocks `crypto_LUKS` partitions (keyfile first, recovery passphrase otherwise), reads the
manifest from the mapper, and locks up again. Without this, a fully encrypted fleet whose OS disk has died
scans as a pile of foreign disks and **the supported DR path is simply dead** — at the exact moment encryption
has turned "we lost the metadata" into "we lost everything". Disks that will not open are counted against the
recovery, exactly like disks that will not mount: a recovery planned from a partial view of the array is one
that can quietly decide a volume never existed.

Recovery then **puts the new keyfile back into a keyslot on every disk it opened**. Skip that and the recovery
works exactly once: every volume would unlock only when a human types the passphrase, and `Restart=always` has
nobody to ask.

**The verifier is not the authority; the platters are.** If Mongo is rebuilt, the recovery verifier is gone
while the encrypted disks are not — and trusting its absence would let the next encryption establish a *brand
new* passphrase and split the fleet. So when the verifier is missing but encrypted volumes exist, the
passphrase is checked against a real LUKS header (`cryptsetup --test-passphrase`). Creating the verifier is
atomic (`$setOnInsert`), so two concurrent first-encryptions cannot each believe they were first.

New binary dependency: `cryptsetup` (already present on the host).

### Failure modes to test

| | Expect |
|---|---|
| Keyfile missing at boot | encrypted volumes `unavailable: locked`; unencrypted volumes serve normally; `critical` notified |
| Bad sector on an encrypted volume | `EIO` propagates identically; chunk MD5 fails; reconstructed from parity |
| Bit rot on an encrypted volume | 16-byte plaintext corruption, caught by chunk MD5, chunk rebuilt |
| ext4 error on an encrypted volume | watcher resolves `dm-N` → volume and triggers a targeted verify **(regression test)** |
| Corrupt LUKS header | that volume is dead; treated as a failed disk; 4+2 survives; header backup restores it |
| Nameplate disagrees with `.identity` | `.identity` wins; drift reported by F |
| Conversion cancelled half-way | mixed fleet, fully functional, no data loss |
| Encryption enabled with no passphrase slot | refused |
| **`POST /$/volumes {wipe}` against a MOUNTED encrypted volume** | **refused** — the guard must see the mapper grandchild (`device-provisioner.ts:90`) |
| Encrypted volume after a reboot | discovered, unlocked, mounted through the mapper — not reported as unmounted (`volume-fleet.ts:431`) |
| `EXT4-fs (dm-N)` error line | parsed AND resolved to the volume; targeted verify fires |

| | Default | |
|---|---|---|
| `STRUBS_JOURNAL_ENABLED` | `true` | |
| `STRUBS_JOURNAL_REPLICAS` | `3` | across distinct bus groups |
| `STRUBS_JOURNAL_FLUSH_MS` | `50` | group-commit window |
| `STRUBS_SNAPSHOT_INTERVAL_MS` | `86400000` | daily; `0` disables |
| `STRUBS_SNAPSHOT_VALIDATE` | `true` | **do not turn this off** |
| `STRUBS_LUKS_KEYFILE` | `/var/lib/strubs/luks.key` | (G) mode 0400; unattended unlock |

Runtime settings (`runtimeConfig`, changeable from the API/UI without a restart):

| | Default | |
|---|---|---|
| `encryptNewVolumes` | `false` | (G) provision every new disk as LUKS |

## Failure modes to test

| | Expect |
|---|---|
| Kill mid-write, after journal, before Mongo | rebuild finds the object, fully named |
| Kill mid-delete, after journal, before unlink | orphan → lost+found (not a phantom) |
| Snapshot validation fails | rotation aborts, old manifest and both snapshots intact, `critical` notification |
| Manifest flip half-completes | both snapshots still exist; recovery picks the newest `updatedAt` |
| Mongo wiped, disks intact | rebuild-index reconstructs; a full restore names everything |
| Mongo wiped, disks intact, **no snapshot and no journal** | every object recoverable as a nameless orphan in lost+found — bytes intact. md5s are recomputed **only** where every data slice reads and verifies directly; anything needing reconstruction stays frozen and unstamped |
| Fresh host, no identity file | RECOVERY mode, not a crash and not a fresh identity |
| Two arrays' disks in one box | refuse, list both identities |
| A journal volume is drained | replicas re-elected and segments copied before it empties |
| Deleting a volume holding the last copy of a segment | refused, like a volume that still holds live slices |
| Snapshot object itself below quorum | fall back to the PREVIOUS snapshot + journal (that is why we keep two); only then degrade to rebuild-from-disk. Bytes are never at risk either way |
| Restore run against a non-empty Mongo | refused (do not let a button merge two arrays) |
| Object relocated by drain/rebalance after its journal entry | restore re-derives placement from disk; no phantom |
| An md5-null orphan is picked up by drain or rebalance | **skipped** — frozen until its md5 is stamped |
| `--reconcile` run while a PUT is in flight | the in-flight object is NOT adopted into lost+found |
| Recovery probing an unknown disk | read-only; `.identity` is NOT created on it (`volume.ts:320`) |
| Provisioning a disk that carries a STRUBS nameplate | refused **in the backend**, not just the UI |
| Manifest missing `partitionSize` | volume fails to bind (`volume-fleet.ts:86`) — so it is mandatory |

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
- **`partitionUuid` semantics under LUKS.** Binding on the LUKS container UUID works and is stable, but it is a *different thing* from what unencrypted volumes store. Decide deliberately: keep one column with two meanings, or add an explicit `luksUuid` and keep `partitionUuid` as the filesystem's. The former is less code; the latter is less surprising at 3am.
- **Journal replica count vs. quorum.** 3 replicas on distinct bus groups survives one enclosure. Is that the right number, given that losing the journal only costs *names*, not bytes?
