# What building the recovery path taught us about the array

Everything here was found by running the new recovery code against the **live** 130TB array, not by
reading the source. Several of these are things the source flatly disagrees with. Where the source and
the platters disagree, the platters are right — that is the whole premise of this work.

Last updated: 2026-07-13, during DR-E/DR-F.

---

## 1. The slice header checksum is not uniform across the array's history

**Status: understood, handled, documented in `docs/on-disk-format.md`.**

`md5(header[23..47]) == header[7..22]` holds for slices written from ~2015 onward and **fails for
everything older**. Sampled 1,932 real slices, by object year:

| Object year | Passes | Fails |
|---|---|---|
| 2014 | 0 | 6 |
| 2015 | 171 | 303 |
| 2019 | 1,446 | 0 |
| 2026 | 6 | 0 |

Every failure is a healthy slice stamped by older code. The recovery reader (`readSliceHeader()`)
therefore treats the checksum as **advisory** and gates on structure instead.

This was caught by the first live rehearsal, which reported a real, fully-intact object
(`53ba9b5e3b1e7a6144152e6b`) as unrecoverable. Had it shipped, a real recovery would have told an
operator that a large fraction of the oldest data on the array was gone while it sat there, intact, on
six disks.

**Deferred, deliberately:** correcting or re-stamping the old headers is a job for the next full VERIFY
pass, once all the code changes have landed. It is not urgent — structure carries the recovery, and the
data is fine — and doing it while the code is still moving would be re-writing 3.5M headers against a
target that has not stopped changing. Nobody has reconstructed what the pre-2015 scheme actually *was*;
the 2015 split suggests a writer change mid-year, and that is the thread to pull when the time comes.

## 2. The magic bytes on disk are `01 C3 BB 02`, not `01 FB 02 FB`

**Status: RESOLVED in code (the bytes are unchanged; the source no longer lies about them).**

A UTF-8 encoding bug in the writer, baked into every slice of ~3.5M objects. `Buffer.write('\x01\xfb\x02\xfb')`
defaults to UTF-8, so `\xfb` (U+00FB) encodes as `c3 bb` — and the six bytes it emitted became `01 c3 bb 02`
once the version and header-length fields overwrote the tail.

It cannot be *fixed*: correcting the writer would not repair history, it would DIVIDE it, and 130TB would
stop matching its own reader in a single deploy. **These bytes are the format now.**

What HAS changed is that the code no longer contradicts the disk. `SLICE_MAGIC` in `lib/constants.ts` is
declared as the literal four bytes, and the writer (`lib/io/file-object/slice.ts`) and every reader share
that one constant. Proven byte-identical to the old spelling across the whole 48-byte header before it
went in. The old code was worse than wrong, it was *misleading* — anybody who trusted the source would
have built a reader that found nothing and concluded the array was empty.

## 3. ⚠️ The relocator was closing copied slices without fsync — during a live 18TB rebalance

**Status: FIXED in DR-C (`72d256b`), but the historical exposure has never been checked.**

`slice-relocator.ts` copied a slice to its destination volume and **closed the file without calling
`sync()`**, while the rebalance then deleted the source. The data was in page cache, not on the platter.
A host crash or a power loss inside that window would have left the destination slice **torn or
zero-length with its only other copy already unlinked.**

This bug was live *while an 18TB rebalance was running through it*. We did not crash, so most likely
nothing was lost — but "most likely" is not a statement anyone should be satisfied with about 18TB.

**This is the one item on this page that has an outstanding action.** The drift scrub (DR-F,
`POST /$/drift`) finds objects whose slices are missing or below quorum; a full verify scrub reads the
chunk bodies and would find torn ones. **Neither has been run against the volumes that were rebalance
destinations during that window.** It should be, and it is cheap relative to what it rules out.

## 4. The ~10,260 orphans were silent phone calls, and they have been quarantined

**Status: INVESTIGATED and CLEARED. Quarantined 2026-07-13; not yet purged.**

The slice index found **3,556,085** objects with slices on disk against **3,545,825** named in Mongo — about
10,260 objects on the platters that the database had never heard of.

My first read of this was wrong twice over, and both errors are worth recording because they are the kind a
plausible story invites:

1. I called it a **delete-path leak**, on the strength of the shape of a histogram. Then I actually TESTED the
   delete path — PUT a 3MB object, watched six slices land on six disks, DELETE, all six gone. Clean. The
   hypothesis died in thirty seconds, and I should have spent those thirty seconds first.
2. I sampled the orphans by walking the filesystem and taking every Nth, which is not a sample of the orphans,
   it is a sample of one corner of one disk. A proper random sample said something entirely different.

**What they actually are.** 9,455 of 9,516 are objects whose content is *entirely* `0xFF`, and every size is an
exact multiple of **160 bytes**. That is G.711 μ-law: a 20ms frame at 8kHz is 160 bytes (the standard RTP
payload), and `0xFF` is μ-law digital silence. They are **silent PCMU call recordings** — tiny, mostly under
10KB. 8 more carry real μ-law waveforms, and 44 are zero-byte objects.

**Nine were media**, and the chunk headers described them completely:

| id | created | type | size | slices |
|---|---|---|---|---|
| `5475ce22…` | 2014-11-26 | MP4 | **36.4 GB** | **4 of 6 — exactly quorum, zero margin** |
| `62cf295d…` | 2022-07-13 | MP4 | 464.8 MB | 6/6 |
| `62cf12ef…` | 2022-07-13 | JPEG | 6.3 MB | 6/6 |
| `62cf04a2…` | 2022-07-13 | JPEG | 6.5 MB | 6/6 |
| 5 more | 2014–15 | MP4 | 0 bytes | — |

That 36 GB video accounted for essentially the entire 37 GB of orphan space, and had been one disk failure
from oblivion for twelve years without anybody knowing. Sean confirmed none of it was wanted.

**The window is the interesting part, and it is still unexplained.** Orphan rate by month, normalised against
ingest (which is the control I nearly skipped — a raw count means nothing if the array simply stopped taking
writes):

- **before 2017-07:** 0.00% — ~345,000 objects written, zero orphans
- **2017-07 → 2023-06:** ~**0.5%** — steady, six solid years
- **after 2023-06:** 0.00% — ~700,000 objects written, zero orphans

Sharp edges on both sides, with continuous ingest throughout. It cannot be a STRUBS code change: the repo has
**no commits at all between March 2021 and 2025**. Whatever started in 2017 and stopped in June 2023 was
*outside this codebase* — a client, an ingest pipeline, a phone system. Nobody has identified it, and since it
is not media, nobody is currently looking.

**Where they are now.** `tools/orphan-quarantine.ts` moved all 52,480 slice files (37.3 GB) into
`strubs/.quarantine/` on their own volumes — an atomic same-filesystem `rename`, not an unlink, so it is fully
reversible (`restore`). The space is NOT reclaimed until someone runs `purge --yes-delete-them`.

Read the refusals at the top of that tool before ever running it again. The short version: an orphan is defined
by SUBTRACTION (everything on disk, minus everything Mongo names), so **if Mongo is ever empty or half-loaded,
every object on the array looks like an orphan** and the tool would queue all 130TB for deletion. It refuses
below a 3M-object sanity floor, refuses above a 1% blast radius, refuses if any volume is unmounted, re-checks
every id against Mongo at apply time, and never touches anything younger than 30 days (an in-flight write has
slices and no record — it is shaped exactly like an orphan).

It also excludes **the namespace snapshot by id**, because a snapshot object is stored as an ordinary STRUBS
object with no content record — an orphan by the letter of the definition, and the last thing on this array
anybody should delete. The tool found its own snapshot in the list on the first run.

**Post-quarantine verification:** three random real objects read end-to-end through the object API, MD5s
matched. The array is healthy.

## 5. DR-G (LUKS) has two blocking prerequisites, both fail-open

**Status: NOT started. Both must be fixed before full-disk encryption ships in any mode.**

1. **The wipe guard reports an encrypted disk as `'clean'`.** A `crypto_LUKS` disk looks empty to the
   probe, so the guard that exists specifically to stop us destroying a disk with data on it would wave
   an encrypted, *full* disk straight through. The probe's own comment already documents this. **This is
   a fail-open on the one code path whose entire job is to prevent data destruction**, and it must be
   fixed before any disk is ever encrypted — otherwise turning on the feature arms the bug.

2. **`system-log-watcher.ts` cannot parse `EXT4-fs (dm-N)` device names.** Under LUKS the filesystem
   sits on a device-mapper node, not the raw partition, so every kernel filesystem error on an encrypted
   volume would be **silently dropped** — the array would stop noticing that an encrypted disk is dying.

Ship in `off`. Convert zero volumes. Fix both of the above first.

## 6. The review loop: 26 rounds, 106 findings — CONVERGED

Twenty-six adversarial review rounds found **106 issues**: 6, 7, 6, 3, 1, 1, 5, 3, 4, 6, 3, 5, 3, 2, 1, 2, 3,
4, 4, 4, 3, 4, 4, 4, 1, 0. Nearly every finding after round 1 was *introduced by the previous round's fix*.

That is not the review being pedantic. Recovery code fails **silently** — nothing crashes, the tool just says
something confident and wrong — so the only bugs that survive are the ones nobody can see.

### The one lesson worth keeping

**A failure to LOOK must never become a fact about the DATA.** This single mistake was fixed in **eight
different costumes** before it stopped coming back:

1. the slice header checksum (would have condemned every pre-2015 object)
2. `allPlattersOrRefuse()` returning empty when the fleet had not come up (all 3.5M objects as phantoms)
3. `locateSlices()` swallowing `EIO` as "no slices here"
4. the snapshot fetch quietly dropping unmounted disks
5. `readSliceHeader()` logging an `EIO` and *then returning null anyway*
6. hydration turning unreadable manifests into "there is no snapshot"
7. the journal location taken from a scan that could not read every disk
8. a quarantine marker that could not be read being treated as "no marker"

Its mirror — **reporting success for data that is gone** — accounted for most of the rest: a lone rotted header
supplying its own quorum bar; `found` counting filenames instead of slices that decode; a missing journal
segment resurrecting deleted objects; upserts leaving a DELETED object in place because it is absent from the
snapshot *precisely because* it was deleted.

### The fixes kept being worse than the bugs

Three times, a guard written to prevent a disaster *caused* one:

- the `namespace-restore-required` marker blocked the only route that could clear it (**bricking the array**);
- the recovery allowlist named auth routes that DO NOT EXIST, so nobody could log in to run the restore;
- the durable journal quarantine (rounds 19–21) produced **two separate paths to total namespace loss**, and
  its documented "way out" was unreachable — `chooseReplicas()` filtered quarantined volumes out before the
  seeding loop, so a quarantined disk could never be re-seeded at all.

That last one is the important one. After seven bugs across two rounds, the answer was not a better quarantine.
It was to **delete the mechanism** and solve the actual problem — a `policy` record has no platter truth — where
it belonged.

### The final design, for the one op the platters cannot arbitrate

The journal records INTENT before the operation completes. A batch rejected by every replica is rolled back, but
*"the fsync failed"* is not *"the bytes are not there"*, and if the rollback cannot be proven either, the journal
may hold a complete, parseable record for a change whose caller was told it **FAILED**.

**That ambiguity is not locally decidable.** Both answers are unsound: REJECT and an escaped record may survive;
PROMOTE to success and the caller may unlink an object's slices on the strength of a `del` that is in no journal.
Nor can replicas vote on it — this journal accepts a batch that lands on ONE (`durable > 0`), so a real commit
can also live on exactly one disk. The bytes are identical.

So the question is not decided. The **consequence** is made safe:

| op | how the replay settles it |
|---|---|
| `put` | the platters decide: no slices, no name → dropped |
| `del` | the platters decide: slices still there → ignored |
| `container` | accepted residue, and always was: a stray empty folder |
| **`policy`** | **may CLOSE a bucket, never OPEN one** — per *field*, not per record |

An escaped or stale policy record can therefore only ever **over-close** a bucket. An operator notices in a
moment (things stop being publicly readable) and fixes it with one call. It can never, under any failure, hand
the public a bucket somebody deliberately shut. The price — a legitimate "make this public" recorded after the
last snapshot is not restored and must be re-applied — is an availability annoyance against a silent data leak.
That is not a close call.

**782 tests, `tsc` clean.**

## 7. Deferred

- **DR-B** — deferred by decision, to be done later as a verify step rather than now.
- **Phase 5** — skipped by decision.
