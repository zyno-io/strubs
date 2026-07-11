# Data integrity

Erasure coding protects you from disks that *die*. The harder problem is disks — and code — that lie: bytes that read back cleanly, pass every checksum, and are nonetheless wrong. This document is about what STRUBS actually verifies, what it deliberately refuses to do, and the failure modes that per-slice checksums alone will not catch.

Most of what's here was learned by having it go wrong.

## The layers

| Layer | Catches | Runs |
|---|---|---|
| **Chunk MD5** | Bit rot, bad sectors, short reads, torn writes | On every read of every chunk |
| **Slice header** | A slice on the wrong disk, or mis-stamped at write time | On every slice open |
| **Whole-object MD5** | A slice that is internally consistent but *not this object's data* | Only where it matters: before committing a reconstruction |
| **Parity recompute** | Parity that is silently wrong | Full scrub only |

The interesting rows are the last two, because they cover the cases the first two structurally cannot.

## Why chunk checksums aren't enough

A chunk's MD5 covers that chunk's own data. It answers *"did these bytes survive the disk?"* — nothing more.

It does **not** answer *"are these the right bytes?"* A slice that was written from the wrong source data, or reconstructed from bad inputs, is **self-consistent**: every chunk matches its own MD5 perfectly. It will pass every read, every light verify, and every per-slice check, forever. It is wrong, and nothing in that layer can tell.

This is not hypothetical. It's how you lose data on a system that reports itself healthy:

> A repair path with no whole-object check reconstructs a damaged slice from sources it hasn't validated. The reconstruction is garbage, but it's *self-consistent* garbage — correct chunk MD5s and all — and it gets written over the last good copy. The object now reads back cleanly and is permanently wrong. The system reports zero errors.

Two mechanisms exist specifically to close that hole.

### The whole-object MD5 gate

`content.md5` is the MD5 of the entire plaintext, recorded at write time.

Normal reads **never check it** — that would mean reading the whole object to serve a byte range. It is used in exactly one place, and it is the most important check in the system:

**A reconstruction is not committed unless it reproduces the stored whole-object MD5.**

The repairer rebuilds the slice, hashes the reconstructed plaintext, and compares. If it doesn't match, it throws `ECORRUPT`, deletes the temp file, and **refuses to overwrite anything**. The fault is marked `reconstruction-mismatch` — a terminal state that is never retried, because retrying will just produce the same wrong answer and re-raise the same alert.

This is the difference between "we couldn't fix it" and "we broke it". The first is recoverable. The second is not.

Every path that rebuilds a slice goes through this gate: the repair worker, drain, and rebalance.

### Parity verification

Here's the uncomfortable part: **a healthy read never opens the parity slices.** If the data slices are fine, parity is never touched, so it is never checked. Parity can be silently, completely wrong for years — and you find out at the exact moment you need it, which is the moment a disk dies.

This is the failure mode that turns a survivable incident into data loss. Lose one data slice: fine, that's what parity is for. Lose one data slice *and* discover both parity slices were garbage all along: the object is gone, and it was gone long before the disk failed.

So a **full** scrub does something a plain checksum pass can't: it *recomputes* the parity from the data and compares it with what's stored on disk. Mismatched parity is flagged (`EPARITY` / category `parity-mismatch`) and repaired in place — the repair recomputes correct parity from verified data.

A byte-copy of a parity slice therefore preserves a wrong one. This is why **relocation never copies parity** — during a drain or a rebalance, parity is always *recomputed* from the data, never moved. It costs more I/O. It is not optional.

> If you take one operational lesson from this page: run a **full** scrub, not just a light one, and don't disable `STRUBS_VERIFY_PARITY`. A light verify will tell you every slice is present and correctly attributed while your parity is worthless.

## Verification modes

| Mode | Reads | Catches | Cost |
|---|---|---|---|
| **light** | Slice existence + the 48-byte header | Missing slices, mis-stamped or misfiled slices | Hours on a large fleet. Near-zero disk stress. |
| **full** | Every chunk of every slice, plus a parity recompute | Everything above, plus bit rot, plus wrong parity | Weeks on a large fleet. Reads everything. |

Light verification exists for a specific situation: when the fleet is fragile and you need answers *now*, a full read of every byte is exactly the stress you can't afford. Light gives you "is everything present and correctly labelled?" in hours instead of weeks.

But be clear about the trade: **light verification cannot see corrupt parity, and it cannot see a self-consistent-but-wrong slice.** It is a triage tool, not a substitute.

The default scrub is quarterly and full. On a large array a full pass takes weeks, so four passes a year is roughly continuous — and reads already checksum hot data all the time.

## Quorum, and refusing to make things worse

With 4+2, any 4 of 6 slices reconstruct the object. Lose more than 2 and the object is **below quorum**: `EQUORUM`, the read fails loudly.

The repair worker **refuses to touch** objects it can't help:

- **Below quorum** — blocked as `insufficient-slices`. Reconstruction is not just futile here, it's *dangerous*: with too few good sources, a rebuild produces plausible-looking wrong bytes that pass every per-slice check and overwrite what's left.
- **Marked `recoveryComment`** — blocked as `unrecoverable`. An operator has documented this object as accepted loss. Don't grind on it.
- **Reconstruction mismatch** — terminal, as above.

The principle: **when STRUBS can't be sure, it stops and says so.** It does not guess, and it does not write.

## Failure domains

Slices of an object should sit in as many independent enclosures as possible. With 4+2 you survive two lost slices — but three slices of one object behind a single controller means one enclosure outage takes it below quorum with **every disk perfectly healthy**.

New writes round-robin across bus groups. Relocation (drain, rebalance) prefers the enclosure holding fewest of the object's slices, then the emptiest volume.

This is a **preference, not an invariant**. It never blocks a move, and it reads the topology live — so if you physically shuffle drives between enclosures (which is normal), subsequent relocations simply re-bias toward the new layout. There's no persisted assumption to go stale.

## Transient vs. permanent

Not every error is evidence about a disk. Two cases matter:

- **`IOABORT`** — our own shutdown cancelled an in-flight read. This says something about *us*, not about the slice: we never learned whether it reads. It is never persisted as a slice error and never counts toward quorum. Getting this wrong means a restart during a verify permanently parks healthy objects as "unrecoverable".
- **`EUNAVAIL`** — the volume is offline. That's a *volume* state, not a slice defect. It clears when the disk comes back.

The repair worker also re-verifies before it repairs. A slice that reads clean on the second look was transient, and the fault is cleared without touching anything.

## Errors carry structure

Slice errors record a `code` and a `category`, not just a message:

`checksum` · `header-mismatch` · `volume-unavailable` · `missing` · `io` · `timeout` · `parity-mismatch` · `unknown`

This matters more than it sounds. If a pulled disk, a mis-stamped header, a timeout, and genuine bit rot all land in the database as free text, they are indistinguishable — and a single pulled disk produces thousands of "errors" that look exactly like data loss. You can't triage what you can't tell apart.

## What a healthy system looks like

```bash
curl -s localhost/\$/faults | jq '.faults | length'          # 0
curl -s localhost/\$/verify-volumes | jq '.errors.total'     # 0
```

And in Mongo, the number of objects carrying any slice error:

```js
db.content.countDocuments({ isFile: true, sliceErrors: { $exists: true } })   // 0
```

If that last number is not zero, [Operations](operations.md#when-something-is-wrong) is the next stop.
