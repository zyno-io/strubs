# Design: "Drain Volume" operation

_Draft 2026-06-27. Generalizes the manual vol-31 drain (sdaf → sdd/sdac/sdae) into a first-class STRUBS operation._

## Goal
Operator-invokable drain of a volume — failing **or** simply undersized — that relocates **every** slice it holds onto other healthy volumes and rewrites the object references, so the disk can be pulled/replaced with zero data loss. Must be **resilient to I/O problems on the source disk (and on peer disks) during the copy**, never aborting the whole drain because of a few bad slices.

## The two hard parts (learned the hard way on vol 31)
1. **Placement constraint.** A slice cannot be relocated to a volume the object *already* uses (EC needs one slice per distinct volume). On vol 31, 144,668 objects already had a slice on the obvious target (vol 40); blindly moving there would have put 2 slices on one disk = no quorum margin. So target selection is **per-slice**, excluding the object's current volumes.
2. **Bad sectors / flaky disks.** Reading a slice off a failing drive can return EIO or *hang* the kernel I/O thread for tens of seconds. The drain must tolerate this per-slice and keep going.

## Per-slice strategy (the core)
For each object that has a slice on the draining volume, relocate that slice with this fallback ladder:

1. **Copy** the slice from the draining volume to the target (fast, no RS compute), under a read timeout (reuse the existing 30 s slice timeout → `ETIMEOUT`). Validate the chunk checksums. If clean → write to target → done.
2. **Reconstruct** (on read EIO / timeout / checksum-fail): rebuild the slice from the object's *other* slices via Reed-Solomon (the reader's existing `_assembleDataRegion` + RS decode), reading peers tolerantly (they may also be on problem disks → timeout/skip individually). If quorum (≥ dataSliceCount good peers) → write reconstructed slice to target → done. This path needs **no read of the dying drive at all**, so it works even if the source slice is totally unreadable.
3. **Unrecoverable** (copy failed AND reconstruct couldn't reach quorum): do **not** move the slice. Record a structured fault (`category: 'missing'`/`'unrecoverable'`), leave the ref pointing at the draining volume, surface it to the operator, and **continue the drain**. One dead slice never stalls the operation.

Copy-first keeps a healthy/undersized drain fast; reconstruct-fallback makes a failing-drive drain robust; the unrecoverable path makes it never hang.

## Resilience mechanisms
- **Timeouts everywhere** — every source/peer read uses the existing per-slice timeout so a bad sector can't wedge the job. A timed-out read => fall through to reconstruct (or skip that peer during reconstruct).
- **Bounded concurrency** — a stuck read pins a libuv threadpool thread (see `verify-volumes-job` `STOP_DRAIN_TIMEOUT_MS` note). Cap in-flight relocations low (config) so a cluster of bad sectors can't exhaust the pool.
- **Pacing** — reuse a read-delay (`verifyReadDelayMs`-style) to avoid hammering the dying drive / saturating peers.
- **Continue-on-error** — per-slice try/catch; tally `{moved, reconstructed, unrecoverable, skipped}`; never abort the batch.
- **Salvage note** — slices are all-or-nothing (chunk-checksummed), so partial-read salvage (ddrescue-style) doesn't help a single slice; reconstruction is the salvage path.

## Consistency & resumability
- **Move-then-flip.** Write the slice to the target and verify it BEFORE flipping the object's volume ref. The source slice is left in place, so every read is satisfiable throughout (old ref → source, new ref → target, never a gap). _(Manual vol-31 drain used exactly this ordering.)_
- **Source retained until volume removed** = a full backup. Slices on the draining disk are only deleted when the operator finalizes removal.
- **Cursor-based resume** (mirror `verify-volumes-job`: persisted `drainCursorId` per volume) so a restart/cancel resumes; re-running skips already-relocated slices (ref no longer points at the draining vol → no-op).
- **Crash window**: file-at-target but ref-not-yet-flipped is harmless (source still valid); a reconciliation sweep at the end re-checks "objects still referencing the draining vol whose slice now exists elsewhere."

## Placement / target selection
- Healthy target pool = volumes that are started, enabled, healthy, writable, **not** the draining vol, not flagged failing/draining, with free space. (Reuse the writer's volume-selection logic.)
- Per slice: candidates = pool **minus the object's current volumes**; pick by most-free-space (balances fill) or round-robin. Respect free bytes.
- **Pre-flight capacity check**: sum of the draining volume's data must fit in the pool's free space *under* the distinct-volume constraint; refuse to start otherwise with a clear shortfall report.

## Lifecycle & API
- Volume gains `isDraining` (persisted). While draining: the **writer stops placing new slices** on it (treat like read-only) but reads still serve.
- `POST /$/volumes/{id}/drain` start · `GET` status (moved/total, reconstructed, unrecoverable, ETA) · `DELETE` cancel (cooperative, preserves cursor).
- A `DrainVolumeJob` singleton (structure mirrors `VerifyVolumesJob`: batch over `findObjectsOnVolumesNeedingVerification`-style query, cursor, pacing, cancel, single-run guard).
- On completion (0 refs to the volume): mark `drained`; operator can disable/delete and pull the disk. Optionally auto-`isReadOnly` first.
- **Coordinate with repair/verify**: while a volume is draining, the repair worker and scrub **skip** its slices (avoid two systems relocating/repairing the same object). Drain is an explicit operator action and may run while the global maintenance freeze is on (it *is* the maintenance).

## Reuse vs new code
- **Reuse**: reader `_assembleDataRegion`/RS decode (reconstruct), slice read+checksum, writer slice placement, `verify-volumes-job` batch/cursor/pacing/cancel skeleton, repair-worker's reconstruct-and-write (a "repair to a *different* target volume" variant), runtime-config persistence, slice-error categories.
- **New**: `DrainVolumeJob`, `isDraining` flag + writer exclusion, target-selection-excluding-object's-volumes, per-slice copy→reconstruct→flag ladder, drain API routes, pre-flight capacity check, reconciliation sweep.

## Review corrections (Claude + Codex, 2026-06-27)
Shared with the rebalance doc's corrections (conditional atomic flip; reconstruct-trust / object-MD5 verify; recompute-don't-copy parity slices; timeouts on ALL I/O + circuit breakers + zombie guards; migrate slice faults/verify-state on move). Drain-specific:
- **Reconstruct safety is paramount here** because the whole point of a *failing*-drive drain is to lean on reconstruct. With parity already corrupt, an unverified reconstruct produces silent wrong data → require object-level verification or distrust-parity-until-scrubbed; otherwise the drain *manufactures* corruption.
- **Copy-first vs failing source.** For a failing drain, prefer reconstruct (or copy-with-short-timeout-then-reconstruct, and stop copy-reading after repeated timeouts) so the drain doesn't itself accelerate the dying disk. Copy-first stays the default only for healthy/undersized drains.
- **In-flight writes barrier.** `isDraining` blocks *new* placement, but writers that already planned/reserved the draining volume can still commit a ref to it afterward. Completion must **wait for or reject** those, then re-scan, before declaring done.
- **Hard "incomplete" state.** Unrecoverable slices leave refs on the volume. The lifecycle must **block `drained`/pull while ANY ref remains** (not just report counters) — pulling the disk with residual refs = data loss. Surface the residual/unrecoverable list as a blocking condition.
- **No-valid-target is a real failure mode** on a small fleet (object already occupies every healthy volume) — must be handled + surfaced, not assumed away.

## Open questions
- Auto-pick targets vs operator-specified target set (e.g. "drain vol 31 onto vols A,B,C")? Manual case effectively specified targets.
- After drain, auto-`is_deleted` the volume, or leave it disabled-but-present for the operator to pull?
- Surface unrecoverable slices as faults (existing pipeline) vs a dedicated drain report.
- Same-volume-group optimization: when target is the same filesystem as source (rare), rename instead of copy. (Not general; the manual case got it because the holding copy was already on the target fs.)
