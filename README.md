# STRUBS

**Striping & Redundancy Using Basic Disks** — a single-host, fault-tolerant object store for organisations that have a lot of data, a limited budget, and no appetite for a storage system that can fail all at once.

STRUBS spreads every object across many independent disks using Reed–Solomon erasure coding. By default it writes **4 data slices + 2 parity slices**, on 6 different drives: any 2 of those drives can die and the object is still readable, and STRUBS rebuilds the missing slices onto healthy drives by itself.

In production since 2017. Currently holding 130+ TB of photos and video across ~30 disks of assorted sizes.

---

## The idea in one picture

```
                        object "photo.jpg"
                               │
             ┌─────────────────┴─────────────────┐
             │    Reed–Solomon encode (4 + 2)    │
             └─────────────────┬─────────────────┘
                               │
    ┌───────┬───────┬───────┬──┴────┬────────┬────────┐
    ▼       ▼       ▼       ▼       ▼        ▼
  data0   data1   data2   data3  parity0  parity1
    │       │       │       │       │        │
  disk 4  disk 17 disk 23 disk 30  disk 9   disk 41   ← 6 independent ext4 filesystems
```

Every disk is an ordinary disk, with an ordinary filesystem, holding ordinary files. **There is no array-level filesystem, no volume manager, and no RAID controller** — so there is no single thing whose failure loses everything. Pull a disk out, plug it into a laptop, and you can read the slice files sitting on it.

---

## Why this exists

STRUBS was written after a client lost data to a failed RAID *controller* — not to failed disks. Making that failure mode impossible is the whole point.

What follows are trade-offs, not criticisms. The alternatives are good systems solving *different* problems. The question is whether they solve **yours**: one machine, a pile of mismatched drives that grows a disk or two at a time, tens to hundreds of terabytes, a small budget, and no tolerance for a total-loss event.

### The failure mode we refuse to have

Hardware RAID, Linux `md` RAID, btrfs, and ZFS all build **one big thing** out of your disks. That thing is fast and convenient, and it is a shared fate: the array, the pool, or the filesystem is a single object that can be corrupted — and a controller or backplane sitting in front of it is a single component that can take every disk behind it offline at once. When that happens, "but the disks are fine" is cold comfort. The data is unreachable.

STRUBS has no such layer. The disks share nothing but a chassis. The worst a bad controller or a bad cable can do is take some drives offline — which is precisely the case the erasure coding already covers. And losing *more* disks than your parity count still doesn't destroy an array: it costs you exactly the objects that had too many slices on the drives you lost, and STRUBS can tell you which ones. There is no state in which everything is gone.

### Mismatched disks are the normal case, not an edge case

Small operations buy disks the way they can afford them: a 4 TB now, a pair of 16 TB next year, whatever's on sale. Most systems punish you for this.

- **Linux `md` RAID** sizes every member to the smallest disk. Put a 16 TB drive into an array of 4 TB drives and you have bought a 4 TB drive.
- **ZFS** wants uniform vdevs, and growing a pool has traditionally meant adding a whole vdev rather than a single disk. (RAIDZ expansion has since landed, but pool geometry is still something you commit to early.)
- **btrfs** is more relaxed about disk sizes, but its parity RAID (5/6) carries long-standing correctness caveats that keep it off most people's production list.

STRUBS doesn't care. Disks are just capacity. It picks the 6 volumes for an object by **fill ratio**, so a 16 TB drive simply receives four times as many slices as a 4 TB one, and the array is "full" only when the disks are genuinely full. Add one disk, any size, any time — the rebalancer levels the fleet in the background.

### RAM is not free

**Ceph** is excellent, and it is a *cluster*. Its own sizing guidance is several gigabytes of RAM **per OSD — that is, per disk**. On a 30-disk box, the memory bill alone rules it out, and you would be running a distributed system in the one configuration it is least designed for: a single node.

STRUBS runs on one machine, and its memory use scales with *in-flight requests*, not with the number of disks or the size of the array. Adding a disk costs you a disk.

### One system that knows both the disk and the object

This is the part that matters most in practice, and it's easy to miss.

Every other option in this list owns **one half** of the problem:

- **RAID, ZFS, btrfs** know about *blocks*. They cannot tell you which of your **files** a dying disk endangers, because at that layer a file isn't a thing. A rebuild re-mirrors the whole spindle, blindly, empty space included — and if it hits a second failure partway through, you find out what you lost afterwards.
- **MinIO** knows about *objects* and deliberately doesn't touch disks. No SMART, no provisioning, no drive-replacement lifecycle — it assumes something below it manages the drives. That's a clean separation of concerns; it just means you still have to solve the other half yourself.

STRUBS owns both ends, and closes the loop between them:

> the kernel logs an I/O error on `sdf` → the log watcher maps that device to a volume → it triggers a **targeted verification of that drive's objects** → bad slices become tracked faults → the repair worker rebuilds them from parity, gated on the whole-object checksum → if the drive keeps misbehaving it's degraded to read-only, so reads still work and writes stop → you drain it (every slice relocated, even if the disk is now dead) → you flash its LED to find the right bay → you pull it.

All of it inside one service, driven from one API and one UI.

Because it knows objects, it can answer the question you actually care about — **which files are at risk right now** — and repair exactly those. Nothing else in this list can, short of running Ceph.

### And the obvious alternative

**MinIO** is the closest thing in spirit, and it was still in its infancy when STRUBS was started. Since then its attention has moved toward a commercial product and the open-source edition has been pared back — which makes it an uncomfortable thing to build on if you are a small operator who just wants a stable box in a cupboard that still works in five years. It also expects uniform drives within an erasure set, and is really meant to be run as a multi-node cluster.

**Ceph** does own both halves, and its disk automation is genuinely comparable — device health metrics, SMART collection, LED identify, the lot. But you are taking on a distributed cluster, and the RAM bill above, to get it.

If MinIO or Ceph fits your situation, use them: they have vastly more people behind them. STRUBS exists for the case where they don't.

### What you give up

The other side of the trade, stated plainly:

- **One host.** STRUBS survives disks, not buildings. It is not a substitute for an off-site backup.
- **Not fast.** Erasure coding on write; reads reassemble from several spinning disks. It is built for bulk media, archives, and backups — not for a database's working set.
- **MongoDB is a hard dependency, and it is the weak link.** Every object's metadata lives there, and the slices on disk are useless without the records saying which volumes hold them. **Back Mongo up.** Losing it loses the array even though every disk is perfectly healthy.
- **Small project.** Production-proven, but by a small number of people. Read the code before you trust it with something irreplaceable.

---

## What you get

| | |
|---|---|
| **Erasure coding** | Reed–Solomon, 4+2 by default and configurable. Any 2 of 6 slices can be lost. |
| **Self-healing** | Damaged slices are detected, rebuilt from parity, and written back to healthy disks automatically. |
| **Verified reconstruction** | Every rebuild is gated on the whole-object MD5. A reconstruction that doesn't reproduce the original is refused, not committed. |
| **Background scrub** | Rolling verification of every chunk of every slice — including recomputing parity, which is the only way to catch parity that is silently wrong. |
| **Health monitoring** | SMART polling, plus a watcher that reads kernel and smartd logs and turns a reported disk error into a targeted verification of that drive. |
| **Hot-plug aware** | Disks that appear, vanish, or come back under a different kernel name are reconciled automatically. |
| **Drive replacement** | Drain a disk — every slice relocated, every reference rewritten — then pull it. No data loss, no downtime. |
| **Rebalancing** | Level fill across mismatched disks after adding or removing drives. |
| **Find the bay** | Flash a drive's activity LED, so you pull the right one out of a 30-disk chassis. |
| **Two front doors** | An HTTP object API, and a FUSE mount so existing tools can treat it as a directory. |
| **Web UI** | Fleet status, per-drive health, and the maintenance operations above. |

---

## Getting started

**You need:** Linux, Node.js 24+, MongoDB, and some disks. STRUBS runs as root — it mounts filesystems and reads raw block devices.

```bash
git clone <repo> /opt/strubs
cd /opt/strubs
yarn install
yarn build                 # tsc -> dist/
cd ui && yarn build        # the web UI
```

Point it at a database and start it:

```bash
export STRUBS_MONGO_URL='mongodb://user:pass@127.0.0.1:27017/strubs?authSource=admin'
yarn start                 # node dist/service.js
```

Then open **`http://<host>/$/ui`** and add your disks.

> **Adding a disk wipes it.** Provisioning partitions and formats the device. Be certain about the path.

You'll want at least `dataSlices + paritySlices` disks — 6 by default — before STRUBS can store anything with full redundancy.

For a real deployment — the systemd unit, adding and replacing drives, and what to do when one starts failing — see **[Operations](docs/operations.md)**.

> **There is no authentication.** None of the HTTP endpoints — object API, management API, or UI — authenticate anything. STRUBS is built to sit on a trusted network behind something that does. Do not expose it to the internet.

---

## Documentation

| | |
|---|---|
| [Architecture](docs/architecture.md) | How a read and a write actually work, the volume model, and the background jobs. |
| [Operations](docs/operations.md) | The runbook: adding, replacing, draining, and rebalancing drives; responding to failures. |
| [Data integrity](docs/data-integrity.md) | What "verified" means here, the quorum rules, and the failure modes checksums alone don't catch. |
| [HTTP API](docs/api.md) | The object API, the management API, and the FUSE mount. |
| [Configuration](docs/configuration.md) | Every environment variable and runtime setting. |
| [On-disk format](docs/on-disk-format.md) | Slice headers, chunk layout, and the Mongo schema — enough to recover data without STRUBS. |
| [Development](docs/development.md) | Building, testing, and the shape of the codebase. |

---

## History and credit

Before building this we tried [FreeNAS](https://www.freenas.org); the then-stable version had serious performance and stability problems on our hardware, and after a controller had already cost us data once, we had no appetite for another multi-disk filesystem.

The design is inspired by [Backblaze's Vault architecture](https://www.backblaze.com/blog/vault-cloud-storage-architecture/). It would not have been possible without Backblaze [open-sourcing their Reed–Solomon implementation](https://github.com/Backblaze/JavaReedSolomon) and [@ronomon's port to Node.js](https://github.com/ronomon/reed-solomon).

## License

[AGPL-3.0-only](LICENSE).
