---
layout: home

hero:
  name: STRUBS
  text: Striping & Redundancy Using Basic Disks
  tagline: A single-host, fault-tolerant object store. Every object is erasure-coded across many ordinary disks — so no controller, filesystem, or single component can ever take all your data at once.
  actions:
    - theme: brand
      text: How it works
      link: /architecture
    - theme: alt
      text: Run it
      link: /operations
    - theme: alt
      text: On GitHub
      link: https://github.com/signal24/strubs

features:
  - icon: 🧩
    title: Reed–Solomon, not RAID
    details: Every object is split into 4 data + 2 parity slices on 6 independent drives. Any 2 can die and the object is still readable — and STRUBS rebuilds the missing slices onto healthy drives by itself.
  - icon: 💾
    title: Ordinary disks, ordinary files
    details: No array-level filesystem, no volume manager, no RAID controller. Each disk is a plain ext4 filesystem holding plain slice files. Pull one out, plug it into a laptop, and read what's on it.
  - icon: 🛡️
    title: The disks are the truth
    details: MongoDB is a derived index; the platters are authoritative. Every guard asks the disk, not the cache — and a slice with no record (an orphan) is recoverable, while a record with no slice (a phantom) is not. Orphans beat phantoms.
  - icon: 🔍
    title: Self-healing and self-checking
    details: Background verification walks every slice against its checksums, repair reconstructs what's damaged, and drain/rebalance move data off failing or over-full disks — all while serving traffic, yielding to reads.
  - icon: 🔐
    title: Optional full-disk encryption
    details: LUKS2 on every platter, unattended-boot via a keyfile and disaster-recovery via a fleet passphrase — with a hardening story built to refuse every way of getting it wrong. Ships off; convert on demand.
  - icon: 🏚️
    title: Built for a bad day
    details: Rebuild the entire volume table from the disks after a total database loss. Recover an encrypted fleet with the passphrase alone. The supported disaster-recovery path is a first-class feature, not an afterthought.
---

## In one picture

```
                        object "photo.jpg"
                               │
             ┌─────────────────┴─────────────────┐
             │    Reed–Solomon encode (4 + 2)    │
             └─────────────────┬─────────────────┘
                               │
    ┌───────┬───────┬───────┬──┴────┬────────┬────────┐
    ▼       ▼       ▼       ▼        ▼        ▼
  data0   data1   data2   data3  parity0  parity1
    │       │       │       │        │        │
  disk 4  disk 17 disk 23 disk 30  disk 9   disk 41   ← 6 independent ext4 filesystems
```

## Why it exists

STRUBS was written after a client lost data to a failed RAID **controller** — not to failed disks. Making that
failure mode *impossible* is the whole point.

Hardware RAID, Linux `md`, btrfs, and ZFS all build **one big thing** out of your disks. That thing is fast and
convenient, and it is a shared fate: a controller or backplane in front of it can take every disk behind it
offline at once, and "but the disks are fine" is cold comfort when the data is unreachable. STRUBS refuses to
have a single component whose failure loses everything.

It is aimed at a specific shape of problem: **one machine, a pile of mismatched drives that grows a disk or two
at a time, tens to hundreds of terabytes, a small budget, and no tolerance for a total-loss event.** In
production since 2017, currently holding 130+ TB across ~30 disks of assorted sizes.

## Where to go next

- **[Architecture](/architecture)** — the volume model, how a write is placed and a read is served, and the background jobs.
- **[Data integrity](/data-integrity)** — the checksum layers, quorum, verification, and how STRUBS refuses to make a bad situation worse.
- **[On-disk format](/on-disk-format)** — the exact byte layout of a slice, and how to read your data with nothing but `dd` and a Reed–Solomon library.
- **[Running STRUBS](/operations)** — deployment, adding and removing drives, rebalancing, and disaster recovery.
- **[Encryption](/encryption)** — the full LUKS story: keyfile, recovery passphrase, the identity model, and the guarantees.
- **[Access control](/access-control)** — the two origins, admin sessions and bearer tokens, TLS, and the object-API credential system.
- **[HTTP API](/api)** — the object API and the management API.
