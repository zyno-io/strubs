# Design: "Rebalance" operation

_Draft 2026-06-27. Companion to `drain-drive-design.md`; reuses the same per-slice relocation engine._

## Goal
Even out fill across the volume pool: move slices off over-full disks onto under-full ones so free space (and write/read load) is spread, avoiding hot spots and premature "this volume is full" while others sit empty. Immediately relevant: after the vol-31 re-home, `sdd`/vol 40 is heavily loaded while the new `sdac`/`sdae` are nearly empty — exactly the imbalance this fixes.

## Shared core with drain (factor this out)
Both drain and rebalance are policies over one **relocation engine**:
> _relocate a slice from volume A → volume B: place it on B (copy from A, with checksum verify; on EIO/timeout fall back to RS reconstruct from peers), then flip the object's volume ref A→B._

All the resilience lives here and is identical to the drain doc: per-read timeouts, bounded concurrency, copy-first / reconstruct-fallback / flag-unrecoverable-and-continue, and a per-slice **target-selection-excluding-the-object's-current-volumes** helper. Implement once; drain and rebalance differ only in *which* relocations they schedule and in the **source-slice disposition** (see below). A `SliceRelocator` module + `DrainVolumeJob` + `RebalanceJob` is the shape.

## The one critical difference: source disposition
- **Drain** keeps the source slice (the dying disk is a backup until pulled).
- **Rebalance must DELETE the source slice** after the target copy is verified and the ref flipped — otherwise no space is freed and the whole point is lost.
  - Order: copy → verify target checksums → flip ref → **delete source slice**.
  - Crash safety: copy-before-delete means a crash leaves the slice on both disks with the ref on one — harmless duplicate, swept by an **orphan-cleanup** pass (slice files on a volume the object no longer references). Never a window with zero copies.

## Metric: balance by FILL RATIO, not bytes
Volumes are heterogeneous (4/6/14/16 TB here), so balancing absolute used-bytes is wrong. Balance **`used / capacity`**:
- Target fill ratio = pool-wide `Σused / Σcapacity` over the **eligible** pool (started, enabled, healthy, writable; **exclude** failing / draining / read-only / unhealthy / deleted — don't move data onto a sick disk, and don't fight a drain).
- Each volume's deviation = `fill_i − target`. **Sources** = volumes above `target + band`; **targets** = below `target − band`. A **deadband** (e.g. ±3–5 %) prevents churning on noise.
- Capacity & free-bytes from `bytesTotal` / `bytesFree` (already on `VolumeStatus`).

## Scheduling: greedy pairing + subset selection
1. Compute fill ratios; build sorted source list (most-over-full first) and target list (most-under-full first).
2. Greedily pair the most-over-full source with the most-under-full target; relocate slices from source→target until one of them crosses the deadband, then re-sort and continue.
3. **Which slices to move from a source:** iterate its slices; a slice is movable to target T only if its object doesn't already have a slice on T (distinct-volume constraint). Skip non-movable ones (try them against a different target, or move on). No need to pick "special" slices — any movable slice reduces the source's fill.
4. **Convergence / termination:** recompute fill after each move (both volumes change); stop when every eligible volume is within the deadband, OR no valid moves remain (constraint-limited), OR a `maxBytes`/`maxMoves`/time budget is hit. Track moved slices to **avoid oscillation** (never move a slice that was just placed; the deadband + recompute also prevent ping-pong).

## Resilience, pacing, lifecycle (mostly inherited)
- Resilience: identical to drain (timeouts, bounded concurrency, copy→reconstruct→flag, continue-on-error). Rebalance normally runs over *healthy* disks, but a peer read during reconstruct may still hit a bad sector — same tolerant handling.
- **Low priority / background:** rebalance is non-urgent; pace it hard (read-delay), cap concurrency, and **yield to reads, drains, and repair**. Cancellable + cursor-resumable like the verify/drain jobs. Should pause under high client load.
- **Coordination:** skip volumes that are draining or flagged failing (as source or target). Don't relocate an object the repair worker is actively touching. Respect the global maintenance freeze? — rebalance is *optional housekeeping*, so it should be **gated by the freeze** (unlike drain, which is deliberate maintenance) — i.e. frozen ⇒ no rebalance.
- **Writer alignment:** STRUBS's writer placement should already prefer emptier volumes for *new* writes (passive balancing); rebalance is the *active* pass for existing data. Share the fill-ratio helper so both agree on "emptier."

## Lifecycle & API
- `POST /$/rebalance` start, optional params: `{ deadband, maxBytes, maxMoves, excludeVolumes }`. `GET` status (moved/remaining, per-volume fill before/after, ETA, reconstructed, unrecoverable). `DELETE` cancel (cooperative, cursor preserved).
- Optionally a **scheduled/auto** mode (low-rate trickle, like the rolling scrub) that keeps the array gently balanced without operator action — gated by load and freeze.
- A `RebalanceJob` singleton mirroring `verify-volumes-job` (batch, cursor, pacing, single-run guard, cancel).

## Reuse vs new
- **Reuse:** the `SliceRelocator` (shared with drain), reader RS reconstruct, slice read/checksum/write, writer placement + fill-ratio helper, verify-job batch/cursor/pacing/cancel skeleton, orphan-cleanup sweep, slice-error categories, runtime-config persistence.
- **New (rebalance-specific):** fill-ratio metric + deadband, greedy source/target pairing with subset selection + convergence/oscillation guards, **source-slice deletion** step, rebalance API + optional auto/scheduled trickle, load-aware pausing.

## Health-aware policy — ASYMMETRIC (the chosen behavior)
Health gates **where data LANDS, not where it's pulled FROM.** Concretely:

- **Onload / target side — health-gated.** **Never select a failing disk as a relocation target.** Hard-exclude `isHealthy === false` / reallocated>0 / pending>0 / high-fault-rate volumes from the target pool (optionally *soft-deprioritize* merely-suspect ones — CRC-flaky / old — preferring healthier targets). So rebalanced data only ever lands on healthy disks.
- **Unload / source side — capacity-only, health-blind.** A disk (failing or not) is a **source only if it's over the normal raw fill target**, and is only shed **down to that target** — never below. Do **not** reduce a failing disk's effective capacity to proactively empty it.

Net for a failing disk: it **receives nothing**, and it **sheds only its over-target excess** (like any disk), then is left alone. A failing disk at/under the fill target is **not touched at all** by rebalance.

**Why asymmetric:** proactively unloading a failing disk means *reading a lot off a fragile drive* (drain-style stress + bad-sector risk) for an operation the operator didn't request. We avoid that. Emptying a failing disk is the job of the deliberate, resilient **drain** op — not a side effect of housekeeping. Rebalance's only health duty is to **stop making failing disks worse** by piling more onto them.

_Cost to note:_ excluding failing disks as targets shrinks the target pool, so healthy disks absorb proportionally more (mild hot-spotting). Acceptable — and the explicit drain handles the failing disks when you choose to.

### Deferred escalation: health-weighted *unloading* (NOT now)
The fuller version — give each disk a weight `w∈(0,1]`, balance against **effective capacity `= capacity × w`** so low-weight disks balance at a low *actual* fill and data trickles off them automatically — is a **proactive soft-drain**. It is explicitly **deferred**: it stresses fragile disks with continuous reads. Keep it behind an opt-in flag for later; at `w→0` it converges with the drain op anyway. For now: health affects **targets only**.

### Health classification (drives target eligibility)
Classify each volume into **healthy / suspect / failing** from telemetry we already collect (SMART via `volumeSmartMonitor` + the slice-fault pipeline):
- **failing** — `isHealthy === false`, reallocated > 0, pending/uncorrectable > 0, or a high recent fault rate (EIO/checksum/timeout). ⇒ **excluded as a target.**
- **suspect** — CRC/link errors, or old (power-on-hours past ~40k h here), no platter defects. ⇒ **soft-deprioritized as a target** (used only if no healthy target has room).
- **healthy** — everything else. ⇒ preferred target.
This classification is the only health input the asymmetric policy needs; the continuous weight `w` is for the *deferred* unloading escalation.

### Guards
- **Source selection ignores classification** — over-target detection is raw `used/capacity` for all tiers, so a failing disk is never proactively emptied (only its over-target excess sheds).
- **Hysteresis / smoothing** — classification must change slowly (require a sustained signal) so a transient CRC/pending blip doesn't flip a disk to "failing", redirect a wave of moves, then revert when it clears. Reallocated/pending only ratchet; CRC decays.
- **Degrade gracefully** — unknown/unavailable SMART ⇒ treat as **healthy/eligible**, not excluded (don't strand the array because telemetry is missing).
- **Hot-spot awareness** — fewer eligible targets means healthy disks fill faster; spread across *all* healthy (and, if needed, suspect) targets rather than piling onto the emptiest one or two.

## Review corrections (Claude + Codex, 2026-06-27)
Hardening that supersedes looser wording above:
- **Conditional atomic flip.** The ref update must be one Mongo `updateOne` conditioned on `_id` + old source still in the exact slot + **target absent from all 6 refs** + object not deleted/leased. Proceed only if `matchedCount === 1`; otherwise leave everything (do **not** delete source). This also enforces distinct-volume at commit time (selection is stale by then).
- **Reconstruct trust.** Chunk-checksum-valid ≠ semantically correct (the current incident: stale/foreign parity passes its own hash). A reconstructed slice's checksums will pass even if wrong. So: reconstructed slices require **object-level MD5 / full-object read verification**, or a policy that **distrusts parity until a scrub validates it**. Until then, prefer copy of a checksum-clean *original* over reconstruct, and never trust reconstruct output blindly.
- **Parity slices: recompute, don't copy.** Copying a checksum-clean parity slice preserves *known-bad* parity. Relocating a parity slice should **recompute it from verified data**, not byte-copy.
- **Source delete is NOT immediately safe.** Readers that loaded the object before the flip still target the old source; deleting it at once can break in-flight reads ("never zero copies" only holds for the *array*, not for a stale reader's chosen slice). Use a **delete grace period** (delayed, watermarked deletion) and/or reader read-reload-on-miss. The delete must also be gated on a **confirmed-durable** flip, and record "ref moved, delete pending" + not count space freed until unlink confirms (handle unlink fail/timeout/read-only).
- **Orphan cleanup must not race relocations.** A copied-but-unflipped target is itself an orphan. Cleanup may only delete files older than a watermark AND not covered by an active relocation-intent record; or run only under a global "no active relocations" gate.
- **Health policy reconciled (resolves the contradiction).** Eligible **targets** = healthy/suspect (failing excluded). **Sources** = any volume over the raw fill target **that is still writable** (so its source slice can be deleted). A failing disk that is read-only or draining is **not** a rebalance source — emptying it is the **drain** op's job. So failing disks: never targets; sources only if over-target *and* writable.
- **Preflight = feasibility, not a sum.** Validate an actual (simulated) per-object target assignment under the distinct-volume + free-bytes constraints, not just `Σused ≤ Σfree`.
- **Timeouts everywhere + circuit breakers.** Reads, writes, fsync/close, rename/commit, and unlink can all hang on USB-DAS. JS timeouts can't cancel kernel I/O, so add per-volume circuit breakers, zombie-run guards, and a "stop copy-reading a failing source after N timeouts → reconstruct/skip" mode.
- **Convergence at scale must be durable.** Per-move recompute over ~1M slices is too costly and in-memory "moved" tracking doesn't survive resume → use **batch-level recompute** + a **durable** cooldown/history (or deterministic monotonic move rules).
- **Migrate slice state on move.** On success, update the slice's verification timestamps and clear/migrate any faults tied to the old volume, or verify/repair will keep acting on stale faults.

## Open questions
- Auto/continuous trickle vs only on-demand operator runs (or both)?
- Balance purely by fill %, or weight by disk health/age (steer data *away* from old/CRC-flaky disks even if they have room)? Given this fleet, a "health-weighted target ratio" (keep suspect disks emptier) could be valuable.
- Deadband + budget defaults; how aggressively to pause under client load.
- Should rebalance and the writer's new-write placement be unified under one "where should this slice live" policy?
