# Architecture

STRUBS is one Node process, a MongoDB database, and a pile of disks. That's the whole system.

```
   HTTP :80    HTTPS :443             FUSE /run/strubs/data
   object API  /$/ mgmt + UI          (read-only, opt-in)
        │          │                       │
        └──────────┼───────────────────────┘
                   │
              FileObject  ── reader / writer / repairer / verifier
                   │
              Reed–Solomon (4 data + 2 parity)
                   │
              IOManager ── VolumeFleet
                   │
   ┌───────┬───────┼───────┬───────┐
  vol 4   vol 17  vol 23  vol 30 ...        each an independent ext4 filesystem
                                            mounted at /run/strubs/mounts/<uuid>

              MongoDB ── content, volumes, faults, runtimeConfig, storageStats
```

Two things are worth internalising before reading further, because everything else follows from them:

1. **The disks share nothing.** Each volume is its own filesystem with its own files. No layer spans them. Losing a disk is a *slice* problem, never an *array* problem.
2. **Mongo holds the map — and the platters hold a copy of it.** A slice file on disk is an anonymous blob; the `content` record says which volumes hold which slice of which object. Losing Mongo used to mean losing the array, so STRUBS now writes the namespace back to the disks continuously: a replicated **journal** of every name, and a periodic **snapshot** of the whole namespace stored as an object and pointed at by every volume's bootstrap manifest. After a total database loss, `POST /$/recover-fleet` rebuilds the volume table from the disks and `POST /$/restore` rebuilds the namespace. Back Mongo up anyway — the restore is the bad day's path, not the cheap one.

## The volume model

A **volume** is one partition, one filesystem, one entry in the `volumes` collection. It carries a small set of flags that drive everything else:

| Flag | Meaning |
|---|---|
| `enabled` | Operator wants it in service. |
| `healthy` | STRUBS thinks the disk is sound. The health monitor can clear this at runtime. |
| `read_only` | Serves reads, accepts no new writes. |
| `is_draining` | Being emptied; excluded from placement, still readable. |
| `is_deleted` | Soft-deleted tombstone. |

The derived predicate that matters is **writable** = started ∧ enabled ∧ healthy ∧ ¬read-only ∧ ¬draining. Only writable volumes receive new slices.

When a disk misbehaves, STRUBS degrades it to **read-only + unhealthy** rather than ejecting it: reads keep working (its slices are still perfectly good sources for reconstruction), writes stop. **It never evicts a drive on its own.** Moving data is an operator's decision.

Every volume also carries a **bus group** — which enclosure or controller it hangs off — discovered from the device topology. It's used as a failure domain: see [Placement](#placement) below.

### Identity

A disk proves it belongs to this STRUBS instance by a 41-byte `.identity` file in its `strubs/` root, holding this instance's identity, the volume's uuid, and its numeric id. On start, a volume validates that file and refuses to mount if it belongs to a different instance or a different volume id. This is what makes it safe to shuffle physical drives between bays and enclosures — a volume is identified by what's *written on it*, not by which SATA port it landed in. Kernel names (`sdf`) are treated as a transient detail throughout.

## Writing an object

`PUT /photos/2024/cat.jpg`

1. **Plan.** The planner picks `dataN + parityN` (6) writable volumes, sorted by free space and round-robined across bus groups so consecutive slices land in different enclosures. Space is reserved on each.
2. **Stream and encode.** The body is consumed into chunk-set buffers of `dataN × chunkDataSize`. Each full chunk set is Reed–Solomon encoded — the data slices hold plaintext verbatim (the code is *systematic*), and parity is computed into the tail of the same buffer.
3. **Write.** Each slice is appended to a temp file on its volume, chunk by chunk, each chunk prefixed by an MD5 of its own data.
4. **Commit.** Each slice file is `rename()`d from `.tmp/` into its sharded path — an atomic publish.
5. **Record.** The `content` document is written with `dataVolumes`, `parityVolumes`, `chunkSize`, `size`, and the MD5 of the whole plaintext.

An object cannot be overwritten. `PUT` to an existing path returns **409**; delete it first.

### Placement

Volumes are chosen by **free space**, alternating across bus groups. Two consequences:

- **Mismatched disks just work.** A 16 TB drive has four times the free space of a 4 TB drive, so it receives roughly four times the slices. Nothing is sized down to the smallest member.
- **Enclosure failures are survivable.** With 4+2, two lost slices are fine — but three slices of one object in one enclosure means a single box outage takes that object below quorum while every disk is still healthy. Spreading across bus groups is what stops that.

Relocation (drain, rebalance) applies the same rule: it prefers the enclosure holding fewest of the object's slices, then the emptiest volume. It's a **preference, not an invariant** — it never blocks a move, and it re-reads the topology live, so it re-biases after you physically move drives between boxes.

## Reading an object

`GET /photos/2024/cat.jpg`, or a byte range of it.

The happy path is boring: read the data slices that overlap the requested range, concatenate their chunks, done. **Parity is never even opened when the data slices are healthy** — which is also why a normal read can't tell you whether your parity is any good. (That's the scrub's job, and it's a bigger deal than it sounds — see [Data integrity](data-integrity.md).)

When a slice faults, the reader degrades in stages rather than giving up:

1. Read the remaining data slices, then lazily open parity, until it has any `dataN` sources.
2. RS-decode just the missing chunks, for just that chunk set, and serve the read.
3. Report the fault to the remediation service, which is what eventually triggers a repair.
4. Escalate: some codes (`EOPEN`, `ETIMEOUT`, `EHEADER`, `EUNAVAIL`, `ENOENT`) mark the slice dead immediately; softer faults mark it dead after 2 occurrences. A dead slice is reconstructed wholesale rather than retried per chunk.
5. If fewer than `dataN` sources survive, throw `EQUORUM`. The read fails; nothing is silently wrong.

The key property: **a read never returns bytes it couldn't verify.** Every chunk is checked against its stored MD5 on the way out.

## Background jobs

All of them are gated by the [maintenance freeze](configuration.md#the-maintenance-freeze) and all of them are resumable — progress is checkpointed in `runtimeConfig`, so a restart mid-job picks up where it left off.

| Job | What it does |
|---|---|
| **Verify (scrub)** | Rolling verification of every object. `light` checks slice existence and headers; `full` reads and checksums every chunk *and* recomputes parity to compare with what's stored. Quarterly by default; a full pass on a large array takes weeks. |
| **Repair worker** | Consumes faults. Re-verifies the slice (a clean result means it was transient), and if it's genuinely bad, rebuilds it from parity — gated on the whole-object MD5. |
| **Drain** | Relocates *every* slice off one volume so the disk can be pulled. Works even on an offline disk, by reconstructing rather than copying. |
| **Rebalance** | Levels fill across the fleet after disks are added or removed. Sheds the biggest objects first, since byte mass concentrates in a small minority of large objects and every move costs the same fixed latency. |
| **Volume health monitor** | Aggregates faults and SMART; degrades a bad volume to read-only + unhealthy. Never evicts. |
| **System log watcher** | Reads smartd and kernel logs. A reported disk error is treated as a *hint* — it triggers a targeted verification of that drive, not a conclusion about it. |
| **Device reconciler** | Watches for disks appearing and vanishing (udev, with a periodic backstop) and remounts or marks volumes to match. |

### Who yields to whom

Two rules, both learned the hard way:

- **A rebalance owns the disks.** It parks any running scrub (preserving its cursor) and blocks new ones, releasing them when it finishes, is cancelled, or crashes. Scrubbing a volume whose slices are actively being relocated is verifying a moving target, and the two jobs otherwise just fight over the same spindles. A scrub requested during a rebalance is *queued*, not dropped.
- **Drains go before routine maintenance.** On startup and on unfreeze the order is: drain → scrub + repair → rebalance.

## Startup

Ordered deliberately (`lib/core.ts`):

1. Load instance identity, connect Mongo, hydrate the in-memory fault map.
2. `ioManager.init()` — discover devices, validate identities, mount and start volumes.
3. Start the SMART monitor.
4. If a rebalance is pending, **park the scrub before considering resuming it** — otherwise it would launch here and be killed seconds later.
5. Resume a pending scrub, *then* start the HTTP and FUSE servers — so an inbound request can't race the resume for job state.
6. If not frozen: resume a pending drain, start the scrub scheduler, the repair worker, and finally resume a pending rebalance.
7. Start the health monitor, device reconciler, and storage-stats tracker.

Shutdown aborts in-flight I/O (raising `IOABORT`), stops the servers, and unmounts the volumes. `IOABORT` is deliberately never recorded as a slice error — it says something about *us*, not about the disk.

## Code map

| Path | |
|---|---|
| `lib/core.ts` | Startup and shutdown orchestration. |
| `lib/io/manager.ts`, `volume-fleet.ts`, `volume.ts` | The volume fleet: mounting, flags, capacity. |
| `lib/io/planner.ts` | Volume selection for new writes. |
| `lib/io/failure-domain.ts` | Bus-group-aware placement for relocation. |
| `lib/io/file-object/` | The data path: `reader`, `writer`, `slice`, `slice-repairer`, `slice-verifier`. |
| `lib/io/device-*.ts` | Discovery, provisioning, hot-plug reconciliation. |
| `lib/jobs/` | Verify, repair scheduling, drain, rebalance. |
| `lib/remediation/` | Fault tracking and the repair worker. |
| `lib/database/` | Mongo repositories. |
| `lib/server/http/` | Object API, management API, UI hosting. |
| `lib/server/fuse/` | The read-only FUSE mount. |
| `lib/notify/` | Severity-routed notifications (log always, Slack optional). |
| `ui/` | Vue 3 + Vite management UI. |
| `tools/` | Standalone operator scripts (see [Operations](operations.md)). |
