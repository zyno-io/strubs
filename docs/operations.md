# Operations

The runbook. Most of this is doable from the web UI at `/$/ui`; the `curl` equivalents are given because they're what you'll want in a script or over SSH.

Throughout, `$` is escaped in URLs (`localhost/\$/volumes`) so your shell doesn't eat it.

## Deployment

STRUBS runs as root — it mounts filesystems and reads raw block devices.

```ini
# /etc/systemd/system/strubs.service
[Unit]
Description=strubs
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
ExecStart=/usr/bin/node service.js
WorkingDirectory=/opt/strubs/dist
Restart=always
RestartSec=10
User=root

[Install]
WantedBy=multi-user.target
```

Tuning goes in a drop-in, so it survives upgrades:

```ini
# /etc/systemd/system/strubs.service.d/tuning.conf
[Service]
Environment=STRUBS_DRAIN_CONCURRENCY=8
```

Deploying a change:

```bash
cd /opt/strubs
npx tsc                          # -> dist/
cd ui && npx vite build          # -> ui/dist/  (only if the UI changed)
systemctl restart strubs
```

> **Restarting is safe, but not free.** STRUBS unmounts its volumes on shutdown, so a restart will fail to unmount cleanly if anything else holds a file open on them (an `rsync`, a script). In-flight relocations are aborted (`IOABORT`) — safe, because a slice is only removed from its source *after* the copy is verified and the reference flipped — but they'll need to be redone. Long-running jobs (scrub, drain, rebalance) checkpoint their progress and resume automatically on boot.

### What STRUBS needs from the host

Worth knowing before you try to sandbox it, because it explains why it needs root.

| | |
|---|---|
| **Binaries** | `lsblk`, `parted`, `mkfs.ext4`, `partprobe`, `mount`, `umount`, `smartctl`, `journalctl`, `udevadm` |
| **Syscalls** | `mount`/`umount` — it mounts each volume itself |
| **Devices** | Raw reads on `/dev/sd*` (identity, SMART, LED flashing), and `/dev/fuse` |
| **Hotplug** | udev events, with a periodic scan as backstop |
| **Logs** | The systemd journal, for the kernel/smartd watcher |

### Running in Docker

You can. Be clear about what it does and doesn't buy you.

STRUBS needs the host's block devices, the `mount` syscall, raw device access, and `/dev/fuse`. Once you've handed a container all of that, **it is no longer a security boundary** — it's a packaging format. That's a perfectly good reason to do it (a pinned Node version, and the native modules here are the fiddly kind: `fuse-native`, `@ronomon/reed-solomon`, `diskusage`), just not the reason people usually reach for a container.

What it takes:

```bash
docker run -d --name strubs \
  --privileged \                          # or: --cap-add SYS_ADMIN --cap-add SYS_RAWIO --cap-add MKNOD
  -v /dev:/dev \                          # NOT --device: STRUBS must SEE new disks appear
  --device /dev/fuse \
  -v /run/udev:/run/udev:ro \             # udevadm
  -v /var/log/journal:/var/log/journal:ro \   # journalctl (kernel + smartd watcher)
  --mount type=bind,source=/run/strubs,target=/run/strubs,bind-propagation=rshared \
  -v /var/lib/strubs:/var/lib/strubs \    # instance identity
  -p 80:80 \
  strubs
```

Two of those are easy to get wrong:

- **`-v /dev:/dev`, not `--device=/dev/sdb`.** `--device` maps a *fixed* node. STRUBS is built around disks appearing and vanishing; a static mapping means hotplug never works and a replaced drive never shows up.
- **`bind-propagation=rshared` on `/run/strubs`.** Every volume STRUBS mounts lands under `/run/strubs/mounts/`, and the FUSE mount is at `/run/strubs/data`. Without shared propagation those mounts exist only inside the container's namespace — the host, and anything else on it, sees an empty directory.

The image needs `smartmontools`, `parted`, `e2fsprogs`, `util-linux`, and `fuse`.

If you *don't* grant everything, two features degrade rather than crash — both have an off switch:

| Missing | What stops working | Set |
|---|---|---|
| udev access | Hotplug detection | `STRUBS_DISABLE_UDEV=true` (falls back to periodic scanning) |
| Journal access | Kernel/smartd errors triggering a targeted verify | `STRUBS_SYSLOG_WATCH_INTERVAL_MS=0` |

**The recommendation: run STRUBS on the host, under systemd.** It's a single-host appliance that already fits that shape, and every sharp edge above simply doesn't exist. Containerise MongoDB separately if you like — that one is a clean win, and it's the piece you most want to be able to move, upgrade, and back up independently.

## Watching it

```bash
curl -s localhost/\$/status          | jq     # capacity, volumes by state
curl -s localhost/\$/volumes         | jq     # every drive: flags, SMART, fill
curl -s localhost/\$/faults          | jq     # outstanding slice faults
curl -s localhost/\$/verify-volumes  | jq     # scrub progress
curl -s localhost/\$/rebalance       | jq     # rebalance progress
journalctl -u strubs -f
```

Notifications go to the log always, and to Slack if `STRUBS_SLACK_WEBHOOK_URL` is set (see [Configuration](configuration.md#notifications)). `POST /$/notify/test` sends a real one, which is the only way to know your webhook works.

---

## Adding a drive

> **Provisioning wipes the disk.** Partitions and formats it. Get the path right.

Find the device, sanity-check its SMART, then provision it:

```bash
curl -s localhost/\$/blockDevices?sort=sysfsPath | jq '.[] | {name, size, model, serial, volumeId}'
smartctl -d sat -H -A /dev/sdx
```

```bash
curl -X POST localhost/\$/volumes -H 'Content-Type: application/json' \
  -d "{\"blockPath\":\"/dev/sdx\",\"wipe\":$(date +%s%3N)}"
```

`wipe` is a **timestamp**, and it must be within 10 seconds of now — that freshness window is the only thing standing between a replayed request and a formatted disk.

The new volume is mounted, started, and writable immediately, and new writes start landing on it (it has the most free space). Existing data doesn't move by itself — **[rebalance](#rebalancing) if you want it levelled.**

## Encryption (LUKS)

**Off by default.** The fleet default (`encryptNewVolumes`) is off, so new disks provision plaintext. One volume
(57) has been converted to encrypted as a canary and its recovery passphrase opens it; the rest are plaintext.
Every capability below is live; broad enablement is a deliberate next step, not the default.

What it defends against: **a disk leaving the building** — RMA'd, sold, discarded, stolen. That is a real
risk here; failing drives get pulled from this rack routinely and they hold customers' photographs, video
and call recordings. What it does **not** defend against: a compromised host. The key has to be online to
serve reads, so a root shell on this box reads everything regardless. Defence in depth, not a foundation.

### Before you can encrypt anything

Two secrets, and they do different jobs.

**The keyfile — STRUBS makes this for you.** It is created at startup if it does not exist
(`/var/lib/strubs/luks.key`, mode 0400, 512 random bytes). It is what unlocks the disks unattended:
`Restart=always` means a passphrase prompt at boot is a non-starter.

> ⚠️ **A missing keyfile is not always a new array — it is also what a LOST one looks like.** So STRUBS will
> only create one when **nothing is encrypted**. If the keyfile is gone while encrypted disks are attached — you
> restored the OS disk from an old backup, or wiped `/var/lib/strubs` — it **refuses** to generate a new one and
> raises a `critical` notification. A fresh key opens *none* of those disks, and inventing one would leave a
> system that looks perfectly healthy and cannot read a byte. Restore the keyfile from backup, or recover with
> the recovery passphrase (which writes a new keyfile slot onto every disk).

**Back the keyfile up.** It is the key to every disk this array will ever encrypt.

**The recovery passphrase — you set this**, in the UI (Volumes → Recovery passphrase → Set) or:

```bash
curl -X PUT localhost/\$/encryption/passphrase -H 'Content-Type: application/json' \
  -d '{"passphrase":"…"}'
```

It becomes each volume's second LUKS keyslot, and it is the only thing that opens these disks if the OS disk
dies. STRUBS will not create a volume with only the keyfile slot — a keyfile-only fleet dies with the OS disk,
taking every byte with it.

> **Write it down somewhere that is not this machine.** There is no undo, no reset, and no support line. Lose
> both it and the OS disk and 130TB becomes noise.

**Changing it rewrites the keyslot on every encrypted disk** — and it can, because STRUBS holds the keyfile and
the keyfile opens every disk. Pass the current one too:

```bash
curl -X PUT localhost/\$/encryption/passphrase -H 'Content-Type: application/json' \
  -d '{"passphrase":"the new one","currentPassphrase":"the old one"}'
```

The new passphrase is written to **every** disk and proven to open it *before* the change is recorded, and only
then is the old one retired. Crash half-way and at least one known passphrase still opens everything; re-run it
and it finishes the job.

> **It refuses to run while ANY disk is unplugged** — not just the ones we think are encrypted. A disk that
> misses a rotation keeps the *old* passphrase, silently, and you discover it on the single day it matters. We
> deliberately do **not** try to guess which absent disks are encrypted: that guess lives in the same database
> you may have just restored, and every version of it turned out to be wrong. Attach everything, then rotate.

### Turning it on

```bash
# New disks only. Converts NOTHING already in the array -- it decides what the next disk looks like.
curl -X PUT localhost/\$/encryption/settings -H 'Content-Type: application/json' \
  -d '{"encryptNewVolumes":true}'
```

Or per-disk at provision time: add `"encrypt":true,"recoveryPassphrase":"…"` to the `POST /$/volumes` body.

### Converting a drive that already holds data

**You cannot encrypt a disk in place.** Every honest path is *drain → rebuild → refill*, so conversion is a
wrapper over machinery that already exists:

```bash
curl -X POST localhost/\$/volumes/57/drain          # empties it; takes a while; watch it finish
curl -X POST localhost/\$/volumes/57/encrypt \
  -H 'Content-Type: application/json' -d '{"recoveryPassphrase":"…"}'
curl -X POST localhost/\$/rebalance                 # refills it
```

> **Encrypting a volume checks the passphrase two ways.** First locally, against an argon2id hash in
> `runtimeConfig` (~350 ms) — a fast reject for a wrong passphrase. Then, before that passphrase is written onto
> a new disk, it is **proven against a real attached encrypted disk** (`cryptsetup --test-passphrase`, ~3–4 s):
> the local hash lives in a database a restore can rewind, and the one thing that cannot be rewound is whether
> the passphrase actually opens the platters. If a restored database and the disks disagree, the disk wins and
> the encryption is refused. (STRUBS keeps the passphrase itself sealed under the keyfile so it can do this
> unattended; it is never derived *from* the disks.)

The encrypt step **refuses a volume that still holds live slices** — it does not drain for you. It wipes and
rebuilds the disk under the same volume id, and before it touches anything the disk must *prove* it is that
exact volume of this instance. A mistyped id destroys nothing.

Costs ~2× that disk's contents in relocation (~4.4 TB off, ~4.4 TB back). Converting the whole fleet is a
complete rewrite of the array — **~264 TB, ~2 months.** The cheap path is to leave `encryptNewVolumes` on
and let the fleet convert over its normal drive-replacement cycle.

### While the fleet is mixed

`GET /$/status` reports coverage as three lists — encrypted, plaintext, and *unknown* (disk absent, so we
cannot read its filesystem and will not guess). **Partial encryption is partial protection**: until every
volume is converted, pulling any plaintext disk still exposes every slice on it. The UI says so, loudly,
and will not call the array protected while one remains.

A locked volume is **not** an array outage: it starts unavailable with `locked: …` in its `mountError`, and
the rest of the fleet serves normally. Be clear-eyed, though — with 4+2, three locked volumes puts objects
below quorum.

### Recovering an encrypted fleet

The scenario the passphrase exists for: **the OS disk is gone.** Mongo, the volume table, the instance identity
and the keyfile went with it. Thirty encrypted disks are still in the rack.

```bash
# Ask the disks who they are -- and hand them the passphrase, because everything they have to say is
# behind the encryption.
curl -X POST localhost/\$/recover-fleet -H 'Content-Type: application/json' \
  -d '{"recoveryPassphrase":"…"}'
```

The scan unlocks each `crypto_LUKS` partition (keyfile first if it still exists, passphrase otherwise), reads
the bootstrap manifest from inside, and locks it again. Nothing is written to a disk to read it.

**Restore the keyfile before you recover, if you have a backup of it.** STRUBS will NOT invent one at startup
while encrypted disks are attached — a fresh random key would open none of them, and a system that looks healthy
but cannot read a byte is worse than one that refuses to start. So put the backed-up `/var/lib/strubs/luks.key`
back first. If it is truly lost, recover with the passphrase: the recovery uses it to unlock each disk and then
**writes a new keyfile keyslot onto every disk it opened** (that is the keyfile becoming valid again), reporting
them in `keyfileRestoredOn`. Either way, an encrypted disk whose keyslot could not be restored unlocks only when
a human types the passphrase — it will not survive a reboot, because `Restart=always` has nobody to ask. This is
why the keyfile must be backed up off the machine the day the first disk is encrypted.

Then restart STRUBS, let the fleet come up, and rebuild the namespace with `POST /$/restore` as usual.

> An encrypted disk that will not open is reported as **locked**, and counted against the recovery — the same
> as a disk that would not mount. A recovery planned from a partial view of the array is one that can silently
> decide a volume does not exist.

### Check that the recovery passphrase still works — the one thing nothing else will tell you

```bash
curl -X POST localhost/\$/encryption/audit -H 'Content-Type: application/json' \
  -d '{"recoveryPassphrase":"…"}'
```

**Run this regularly. Put it in the calendar.** The UI nags after 90 days and shows the result on the Volumes
tab — and a healthy audit is also what keeps *encrypting* a disk fast (see above), so it pays for itself.

Here is why it matters more than it looks. STRUBS unlocks disks with the **keyfile**. The recovery passphrase
keyslot is *never touched* in normal service — not at boot, not at mount, not on any read or write. So a disk
that is on the **wrong** passphrase will **mount and serve flawlessly, for years**. Every health check passes.
Every scrub passes. And then the OS disk dies, you take the passphrase out of the safe, and it opens eleven of
your thirty disks.

There is exactly one way for that to happen — **a disk that was unplugged when the passphrase was last
changed**, and came back afterwards. (Rotation refuses to run with a disk missing precisely to prevent it, but a
disk can always be reattached later.) Nothing else in this system will ever notice. This is the only thing that
looks — and the fix is simply to set the passphrase again with every disk attached.

The audit opens nothing and writes nothing — it asks each LUKS header whether the passphrase still fits
(`cryptsetup --test-passphrase`). ~3 seconds per encrypted volume, so ~90 seconds on a fully converted fleet.
It reports three things, and they are different:

| | Meaning |
|---|---|
| `refused` | ⚠️ These disks are on a **different passphrase** — almost certainly they missed a rotation. Lose the keyfile and you lose them. **Set the passphrase again with every disk attached** and they will be rewritten. |
| `notChecked` | Volumes whose disks were **not attached**, so they were never asked. The audit cannot call the fleet healthy without them — and they are the volumes most likely to be wrong, being the ones a rotation could not reach. |
| `unreadable` | The LUKS header would not read. A *disk* fault, not a passphrase fault — but it means those volumes' recoverability is **unknown**. |
| `unidentified` | A LUKS container carrying no STRUBS nameplate. We cannot tell whose it is. |

### Back up the LUKS headers

~16 MB each. A corrupt header costs one disk, which 4+2 already survives, so this is insurance rather than a
critical path — but it is cheap insurance:

```bash
cryptsetup luksHeaderBackup /dev/sdx1 --header-backup-file /root/luks-header-vol57.img
```

Store them **off-box**. A header backup plus the passphrase is a complete recovery kit for that disk.

## Replacing or removing a drive

The sequence is: **drain → confirm empty → identify → pull.**

### 1. Drain it

```bash
curl -X POST localhost/\$/volumes/13/drain
```

This marks the volume read-only + draining and relocates **every** slice it holds onto healthy volumes, rewriting object references as it goes. It's move-then-flip: a slice is written and verified on its new home, the reference is flipped, and only then is the source copy deleted. Cancelling or crashing mid-drain loses nothing.

It works on a **dead disk too** — with the drive offline it reconstructs each slice from parity instead of copying it. That's the whole point: you don't need the failing drive to be readable to get its data off it.

Watch it:

```bash
curl -s localhost/\$/volumes | jq '.[] | select(.id==13) | {isDraining, bytesFree, bytesTotal}'
journalctl -u strubs -f | grep -i drain
```

Slices that genuinely can't be rebuilt (below quorum) are **left in place and reported**, and they block removal until you accept the loss. That's deliberate.

### 2. Confirm it's actually empty

Do not skip this. Drain reports "complete" when its scan finishes, and a scan that skipped objects (because of an error mid-run) can still report complete.

```bash
curl -s localhost/\$/volumes/13 | jq '{isDraining, bytesFree, bytesTotal}'
```

The authoritative check is that nothing references it any more:

```js
db.content.countDocuments({ $or: [{ dataVolumes: 13 }, { parityVolumes: 13 }] })   // must be 0
```

`DELETE /$/volumes/13` will refuse while live slices remain, and tell you how many — so a refusal here is the system doing its job, not an obstacle to route around.

### 3. Find the physical drive

In a 30-bay chassis, the difference between `sdf` and `sdg` is somebody's afternoon. Flash its LED:

```bash
curl -X POST localhost/\$/volumes/13/identify     # re-POST every ~1s to keep it going
curl -X DELETE localhost/\$/volumes/13/identify   # stop
```

The UI does the heartbeat for you — open the volume menu and pick **Identify**. Reads stop by themselves ~3 seconds after the last ping, so a closed tab can't leave a drive spinning.

### 4. Remove it

```bash
curl -X DELETE localhost/\$/volumes/13    # soft-delete; refused if slices remain
```

Then physically pull it. Keep the drive on a shelf until a full verify confirms the relocated copies are good — it costs nothing and it's the difference between an inconvenience and an incident.

---

## Rebalancing

After adding or removing drives, fill is uneven. Rebalance levels it.

```bash
curl -X POST localhost/\$/rebalance -H 'Content-Type: application/json' -d '{}'
curl -s localhost/\$/rebalance | jq
curl -X DELETE localhost/\$/rebalance      # cancel any time; safe
```

It computes a capacity-weighted target fill across the pool, sheds from volumes above it, and lands on volumes below it. Some things worth knowing:

- **It shows up in the UI**, with live progress, rate, and ETA. `bytesToMove` is recomputed from actual volume fills, so it's honest across restarts.
- **It works biggest-objects-first.** Byte mass concentrates in a small minority of large objects while every move costs the same fixed latency, so this reaches the target in far fewer moves.
- **It never copies parity.** Parity is always recomputed from the data — a byte-copy would faithfully preserve parity that's silently wrong. This is why it's slower than a plain file copy, and it isn't negotiable. See [Data integrity](data-integrity.md#parity-verification).
- **It parks the scrub** while it runs, and releases it afterwards. A scrub of a volume whose slices are being relocated is verifying a moving target.

### Tuning it

Concurrency is a **live setting** — it applies to a running job at the next batch, no restart:

```bash
curl -X PUT localhost/\$/rebalance -H 'Content-Type: application/json' -d '{"concurrency":8}'
```

Relocation is latency-bound (open, read, write, commit, ref flip, delete), not bandwidth-bound, so concurrency is the lever that matters. Raise it in steps and watch `bytesPerSec` in the status. Back off if the drives start thrashing or kernel I/O errors appear — seek-bound disks in external enclosures have a real ceiling.

---

## Verification

```bash
# Full scrub of everything (reads every byte; takes a long time)
curl -X POST localhost/\$/verify-volumes -H 'Content-Type: application/json' -d '{"mode":"full"}'

# Light pass — existence + headers only. Hours, not weeks. Low stress.
curl -X POST localhost/\$/verify-volumes -H 'Content-Type: application/json' -d '{"mode":"light"}'

# Just one drive
curl -X POST localhost/\$/verify-volumes -H 'Content-Type: application/json' \
     -d '{"volumeIds":[13],"mode":"full"}'

# One object
curl -X POST localhost/\$/verify-file/6a4e9b8f3b1e7a0049000001 \
     -H 'Content-Type: application/json' -d '{"mode":"full"}'

curl -s localhost/\$/verify-volumes | jq
curl -X DELETE localhost/\$/verify-volumes
```

A scrub runs automatically every 90 days by default. **Use `full`.** A light verify will happily tell you every slice is present and correctly labelled while your parity is worthless — only a full pass recomputes parity and compares it. See [Data integrity](data-integrity.md).

If a rebalance is running, a verify request is **queued**, not rejected: the response carries `deferred: true` and it starts when the rebalance finishes. The UI shows it as *Waiting for rebalance*.

---

## When something is wrong

### First: consider freezing

```bash
curl -X PUT localhost/\$/maintenance-freeze -H 'Content-Type: application/json' -d '{"frozen":true}'
```

The freeze stops **all** background maintenance — scrub, repair, drain, rebalance — while reads and writes carry on normally. It's persisted and survives restarts.

Reach for it when you don't yet understand what's happening. Automatic repair is usually what you want, but repair *reconstructs slices*, and reconstructing from sources you haven't validated is exactly how a recoverable problem becomes a permanent one. **Freeze, diagnose, then unfreeze.** Unfreezing resumes work in order: drains, then scrub and repair, then rebalance.

### A drive is throwing errors

```bash
journalctl -k | grep -iE 'i/o error|medium error|offline'
smartctl -d sat -H -A /dev/sdx
curl -s localhost/\$/volumes/13 | jq .smartInfo
```

Distinguish two very different things:

- **Media errors** — reallocated or pending sectors, uncorrectable reads. The platter is going. Drain it.
- **Link errors** — the device dropping off the bus and re-enumerating (`device offline error`, USB CRC counts, `Buffer I/O error` followed by a re-attach). SMART will be spotless because the *disk* is fine — it's the cable, the bridge, or the enclosure. Reseat before you replace.

STRUBS itself treats a kernel error as a **hint**: the log watcher triggers a targeted verify of that drive rather than concluding anything. If the fault count crosses the threshold, the health monitor degrades the volume to read-only + unhealthy — reads keep working, writes stop. It **never** evicts a drive on its own.

### Objects are flagged

```bash
curl -s localhost/\$/faults | jq '.faults[] | {objectId, sliceIndex, volumeId, code, repairStatus, repairBlockedReason}'
```

```js
db.content.countDocuments({ isFile: true, sliceErrors: { $exists: true } })
db.content.find({ isFile: true, sliceErrors: { $exists: true } }).limit(5)
```

Blocked reasons, and what they mean:

| Reason | Meaning |
|---|---|
| `insufficient-slices` | Below quorum. Repair is refused — with too few good sources it would produce plausible-looking wrong bytes and overwrite what's left. |
| `unrecoverable` | Marked `recoveryComment` by an operator: accepted loss. |
| `target-unwritable` | Nowhere healthy to put the rebuilt slice. Add capacity or clear a volume's flags. |
| `reconstruction-mismatch` | **Serious.** The rebuild didn't reproduce the object's MD5, so it was refused rather than committed. The surviving slices are foreign or corrupt. Nothing was overwritten — this is the safety gate doing exactly its job. Investigate before touching it. |

If a fault looks stale — the object is fine and the slices are all present — re-verify that single object (`POST /$/verify-file/{id}`). A clean result clears it.

### A drive vanished

The device reconciler handles disks appearing, disappearing, and coming back under a different kernel name. If a volume is showing `isMissing`, the disk STRUBS expects is genuinely not there.

Identity lives **on the disk**, not in the bay, so you can move drives between ports and enclosures freely. To identify an unmounted disk out-of-band:

```bash
debugfs -R 'dump /strubs/.identity /tmp/id' /dev/sdX 2>/dev/null && xxd /tmp/id
# byte 37 (0x25) = volume id
```

> On USB and SAS enclosures, `lsblk` and `smartctl` often report the *enclosure bridge's* serial rather than the drive's — two bays can look like the same device. Don't identify drives by serial on those setups. The `.identity` file is the ground truth.

---

## The `tools/` directory

Standalone scripts, run with `node tools/<name>.js`. They talk to Mongo and the disks directly, and several require a compiled `dist/`. Most default to a dry run; read the script before running it.

They exist because a diagnosis you can run out-of-process, against a frozen system, is worth a lot more than one you have to redeploy the service to get.

| | |
|---|---|
| `full-verify.js`, `light-verify.js` | Out-of-process verification passes, gated on whole-object MD5. |
| `parity-verify.js` | Read-only parity audit — recompute and compare. |
| `classify-slice-errors.js` | Bucket flagged objects: readable-now / recoverable / lost. |
| `recover-residual.js` | Reconstruct and relocate slices from dead volumes, MD5-gated. |
| `restamp-headers.js` | Repair mis-stamped slice headers in place, data verified first. |
| `verify-dead.js`, `archive-dead.js` | Prove unrecoverability, then archive records and reclaim the slices. |
| `resync-stats.js` | Rebuild the cached storage statistics. |

The `parity-*.js` scripts are forensic tools from a specific incident. They're kept because the analysis they encode is hard to reproduce, not because you'll need them routinely.

## Backups

Say it once more: **back up MongoDB.**

The slices are useless without the `content` records that say which volumes hold them. Every disk can be perfectly healthy and the array still lost. `mongodump` on a schedule, off the box.

And STRUBS survives disks, not buildings. It is not an off-site backup.
