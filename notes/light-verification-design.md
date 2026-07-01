# Design: "Light verification" + error-flag reset

_Draft 2026-06-28. A fast, low-stress verification tier (existence + header only) plus a clean reset of stale error flags, for use after the drains and as an ongoing app feature._

## Why
The full scrub reads **every chunk of every slice** (~80 TB), which is slow and *stresses the fragile fleet* — exactly what we don't want now. Most of what we care about post-incident is **"is each slice present and correctly attributed?"** — missing slices and mis-stamped headers (the vol-34 and `5ba6` failure modes). That needs only the 48-byte header, not the data. A light pass answers it in hours, not days, with near-zero disk stress.

## Part 1 — Reset (archive) the error flags first
The verify merge (`verification-state.ts` `buildObjectVerificationStateUpdate`) carries forward existing `sliceErrors`, and the current ones are **stale** (they reference now-drained volumes 7/31, pre-drain state). For a *true* fresh picture we clear them but keep the values:
- `db.content.updateMany({ sliceErrors: { $exists: true } }, { $rename: { "sliceErrors": "sliceErrorsArchive" } })`
  - Moves the field, preserving every value under `sliceErrorsArchive` (the incident's error map stays queryable for analysis), leaving live `sliceErrors` absent = clean slate.
- Decide on `lastVerifiedAt` / `sliceVerificationTimes`: leave (the light pass overwrites) **or** also archive/clear if we want to force a from-scratch sweep. (Lean: archive `sliceErrors` only; let the pass refresh the rest.)
- This is a one-shot Mongo op; safe to run while frozen (no I/O, no repair trigger).

## Part 2 — Light verification (existence + header, NO chunk read)
Per slice (data + parity): resolve path (volume mount + shard + `id.idx`) →
1. **Existence** — missing file ⇒ `category: 'missing'` (or `volume-unavailable` if its volume is offline).
2. **Header** — read the 48-byte header and run the existing `_validateHeader` checks (object-id bytes 23-35, data/parity counts @40/41, slice index @42, chunk size @43-45). Mismatch ⇒ `EHEADER` / `header-mismatch`.
3. **Stop.** No chunk reads, no checksums.

Catches **missing** and **mis-attributed** slices fleet-wide. Does **not** catch chunk-level (checksum) corruption — that still needs a full read, run later/targeted. Cost: ~21M header reads (3.5M objects × 6) = open+48B+close each → hours and minimal stress, vs the full read's ~80 TB / days. Runs fine **while frozen** (writes `sliceErrors`, doesn't invoke repair).

## Part 3 — Bake it into the app as a verification *mode* (recommended)
Trivial, because the header check is already in `slice.open()`:
- `FileObjectSliceVerifier.verifySlice` does `slice.open()` (validates header) then `verifyOpenSlice` (reads all chunks). **Light mode = run `open()`, skip `verifyOpenSlice`.** Existence/availability is implicit (open throws ENOENT/EUNAVAIL).
- Add a `mode: 'light' | 'full'` (default keep `full`) threaded from the verify job + API (`POST /$/verify-volumes { mode }`) down to the verifier. Light reuses the **error categorization** we already built (open failures → `EHEADER` / `ENOENT(missing)` / `EUNAVAIL`).
- Result: a **two-tier scrub** — *light* (fast, existence+header, safe to run often / after any maintenance / on a fragile fleet) and *full* (deep, chunk checksums, occasional or targeted at suspects). The rolling scrub could default to light with periodic/targeted full passes.

## Sequencing (this incident)
After the vol-7 drain settles (and vol 31 disabled): **archive `sliceErrors` → run light verify → analyze the fresh map** (missing vs header-mismatch, by volume/container) → then a **targeted full verify** only on header-clean objects we still suspect (e.g. the corrupt-parity set) to catch checksum corruption. Keep `sliceErrorsArchive` for before/after comparison.

## Notes
- Light verify is read-mostly but **writes `sliceErrors`** — keep it gated by the freeze when run as the app job, but a standalone tool can run now (it never triggers repair). 
- Same per-slice timeout/tolerance applies to the header read (a bad sector under the header → `io`/`timeout`, not a hang).
