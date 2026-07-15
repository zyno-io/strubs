# Encryption (LUKS)

STRUBS can encrypt every platter with LUKS2. It ships **off** — the fleet default (`encryptNewVolumes`) is
`false`, so new disks provision plaintext — and it is designed to be turned on gradually, one disk at a time,
over an array's normal drive-replacement cycle.

**What it defends against:** a disk *leaving the building* — RMA'd, sold, discarded, stolen. That is a real risk
on a single-host array whose failing drives get pulled routinely and hold customers' data.

**What it does not defend against:** a compromised host. The key has to be online to serve reads, so a root
shell on the box reads everything regardless. This is defence in depth, not a foundation.

::: tip The short version
Two secrets: a **keyfile** (on the OS disk, unlocks the disks unattended) and a **recovery passphrase** (in your
safe, opens the disks if the OS disk dies). STRUBS makes the keyfile itself; you set the passphrase.
**Back up the keyfile off-machine the day you encrypt the first disk** — it is the key to every disk the array
will ever encrypt.
:::

## The two secrets

Every encrypted volume carries **two LUKS keyslots**, and they do different jobs.

### The keyfile — unattended boot

`/var/lib/strubs/luks.key`, mode `0400`, 512 random bytes. It is what unlocks the disks at startup without a
human present, because `Restart=always` means a passphrase prompt at boot is a non-starter.

**STRUBS creates it for you** at startup if it does not exist — *but only when no attached disk reports a LUKS
partition.*

::: warning A missing keyfile is not always a new array — it is also what a lost one looks like.
If the keyfile is gone while encrypted disks are attached — you restored the OS disk from an old backup, or
wiped `/var/lib/strubs` — STRUBS **refuses** to generate a new one and raises a `critical` notification. A fresh
random key would open *none* of those disks, and inventing one would leave a system that looks perfectly healthy
and cannot read a byte. Restore the keyfile from backup, or recover with the recovery passphrase (which writes a
new keyfile slot onto every disk).
:::

**Back the keyfile up, off the machine.** It is the key to every disk this array will ever encrypt, and losing
it plus the OS disk is only survivable through the recovery passphrase.

### The recovery passphrase — disaster recovery

You set this, in the UI (**Volumes → Recovery passphrase → Set**) or:

```bash
curl -X PUT localhost/\$/encryption/passphrase -H 'Content-Type: application/json' \
  -d '{"passphrase":"…"}'
```

It becomes each volume's **second** LUKS keyslot, and it is the only thing that opens these disks if the OS disk
dies. STRUBS will not create a volume with only the keyfile slot — a keyfile-only fleet dies with the OS disk,
taking every byte with it.

::: danger There is no undo, no reset, and no support line.
Write the passphrase down somewhere that is not this machine. Lose both it and the OS disk and 130 TB becomes
noise.
:::

## The design, in one principle

Everything above rests on a single idea, and understanding it explains why the whole feature behaves the way it
does:

> **The keyfile is the authority, and the keyfile opens every disk.**

An earlier design tried to *discover* the fleet passphrase from the platters — testing candidates against every
LUKS header, fingerprinting keyslots, refusing to trust its own database. That was solving the wrong problem.
STRUBS holds the keyfile, and the keyfile opens every disk. So the passphrase is not a fact to be *discovered*
and defended against drift — it is a fact to be **enforced**: to make it *P*, write *P* into every disk's second
keyslot, authenticating with the keyfile. There is nothing to detect and nothing to reconcile, because there is
nothing STRUBS cannot simply fix.

That collapses the whole problem into a few coherent rules:

- **Validation is local.** The passphrase is validated against an **argon2id hash** in `runtimeConfig`
  (`luksRecoveryVerifier`) — ~350 ms, no disk I/O. It is a *verifier*, not the key: it opens nothing.
- **STRUBS keeps a usable copy, sealed under the keyfile.** A hash can *check* a passphrase but cannot
  *produce* one, and LUKS needs the actual bytes to write a keyslot. So the passphrase is also stored **sealed**
  (`luksRecoverySealed`, AES-256-GCM with a key derived from the keyfile) — which is what lets `encryptNewVolumes`
  work: a disk provisioned automatically has no operator to prompt. The seal widens nothing, because the keyfile
  already opens every disk outright; anyone who can read the sealed blob can read the keyfile beside it.
- **The seal is never trusted on its own.** Whatever it yields is proven against the argon2 hash *and* — once
  the fleet has any encrypted disk to ask — against a **real attached encrypted disk** before it is written onto
  a new one. The hash lives in a database a restore can rewind; the one thing that cannot be rewound is whether
  the passphrase actually opens the platters. **If a restored database and the disks disagree, the disk wins.**
  (The very first encryption has no encrypted disk to ask, so only the hash gates it — after which every later
  disk is proven against a real one.)

::: details The governing principle: the disks are authoritative, MongoDB is a derived index
This is the rule the whole of STRUBS is built on, and encryption is no exception. Mongo can be restored,
rebuilt, or wiped; the platters cannot. Every guard here asks a disk, not the cache. The corollary —
**orphans beat phantoms** — is why a provisioning failure leaves a claimed disk with no database row (an orphan,
which recovery rebuilds) rather than a row pointing at an unclaimed disk (a phantom, which reads as data loss).
:::

## Turning it on

Encrypt every **new** disk from now on — this converts *nothing* already in the array; it decides what the next
disk looks like:

```bash
curl -X PUT localhost/\$/encryption/settings -H 'Content-Type: application/json' \
  -d '{"encryptNewVolumes":true}'
```

Or per-disk at provision time: add `"encrypt":true` to the `POST /$/volumes` body. You do **not** need to pass
the passphrase — STRUBS holds it sealed and writes it onto the new disk itself.

## Converting a drive that already holds data

**You cannot encrypt a disk in place.** Every honest path is *drain → rebuild → refill*, so conversion is a
wrapper over machinery that already exists:

```bash
curl -X POST localhost/\$/volumes/57/drain          # empties it; takes a while; watch it finish
curl -X POST localhost/\$/volumes/57/encrypt         # wipes + re-encrypts under the same id
curl -X POST localhost/\$/rebalance                 # refills it
```

The encrypt step:

- **refuses a volume that still holds live slices** — it does not drain for you, and it scans the actual platter
  (not just the database) for live-or-orphan slices before it wipes;
- **wipes and rebuilds under the same volume id**, and before it touches anything the disk must *prove* it is
  that exact volume of this instance — a mistyped id destroys nothing;
- **proves the fresh header opens with the passphrase** before putting the disk into service, so a disk that is
  somehow keyfile-only never enters the fleet.

::: warning The cost is a full rewrite
Converting a volume costs ~2× its contents in relocation (drain off, rebalance back). Converting the whole
fleet is a complete rewrite of the array — for ~130 TB, on the order of months. The cheap path is to leave
`encryptNewVolumes` on and let the fleet convert over its normal drive-replacement cycle.
:::

## A mixed fleet

`GET /$/status` reports coverage under `encryption`: `encryptedVolumeIds`, `plaintextVolumeIds`, and
`unknownVolumeIds` (disk absent, so its filesystem cannot be read and STRUBS will not guess).

**Partial encryption is partial protection.** Until every volume is converted, pulling any plaintext disk still
exposes every slice on it. The UI says so, loudly, and will not call the array "protected" while one plaintext
volume remains.

A locked volume is **not** an array outage — it starts unavailable with `locked: …` in its `mountError` and the
rest of the fleet serves normally. Be clear-eyed, though: with 4+2, three locked volumes puts objects below
quorum.

## Rotating the passphrase

Changing the passphrase rewrites the second keyslot on **every** encrypted disk — and it can, because STRUBS
holds the keyfile and the keyfile opens every disk. Pass the current one too:

```bash
curl -X PUT localhost/\$/encryption/passphrase -H 'Content-Type: application/json' \
  -d '{"passphrase":"the new one","currentPassphrase":"the old one"}'
```

The ordering is chosen so a crash can never leave a disk that no known passphrase opens:

1. **Add** the new passphrase to every disk (authenticating with the keyfile). Now both open everything.
2. Only once every disk has it, **record** the new hash and re-seal.
3. **Retire** the old passphrase from every disk.

Crash at any point and at least one passphrase still opens every disk; re-run the rotation and it finishes the
job. Every keyslot operation addresses the header by its **LUKS UUID** (`cryptsetup … UUID=<uuid>`), not by
`/dev/sdX1`, so a USB disk that dropped and was replaced at the same path cannot be written by mistake.

::: warning It refuses to run while ANY disk is unplugged
Not just the ones STRUBS thinks are encrypted — *any* absent volume. A disk that misses a rotation keeps the
*old* passphrase, silently, and you discover it on the single day it matters. STRUBS deliberately does **not**
guess which absent disks are encrypted: that guess would live in the same database you may have just restored.
Attach everything, then rotate.
:::

### "Cannot use the recorded passphrase"

If an array set its passphrase before STRUBS kept a sealed copy — or its keyfile was restored from a different
backup — it holds a hash it can *check* but cannot *use* to encrypt a new disk. `GET /$/status` reports
`passphraseUsable: false`, and the UI offers **"Enter it once."** Supply the passphrase once; it is verified
against the hash and re-sealed. No keyslot is touched — it is the same passphrase.

```bash
curl -X POST localhost/\$/encryption/seal -H 'Content-Type: application/json' \
  -d '{"passphrase":"…"}'
```

## The audit — the one thing nothing else tells you

```bash
curl -X POST localhost/\$/encryption/audit    # uses the sealed passphrase; no body needed
```

**Run it regularly. Put it in the calendar.** The UI nags after 90 days and shows the result on the Volumes tab.

Here is why it matters more than it looks. STRUBS unlocks disks with the **keyfile**; the recovery-passphrase
keyslot is *never touched* in normal service — not at boot, not at mount, not on any read or write. So a disk
that is on the **wrong** passphrase will **mount and serve flawlessly, for years.** Every health check passes,
every scrub passes. And then the OS disk dies, you take the passphrase out of the safe, and it opens eleven of
your thirty disks.

There is exactly one way for that to happen: **a disk that was unplugged when the passphrase was last changed**,
and came back afterwards. Rotation refuses to run with a disk missing precisely to prevent it, but a disk can
always be reattached later. Nothing else in the system will ever notice. This audit is the only thing that
looks — and the fix is simply to set the passphrase again with every disk attached.

The audit opens nothing and writes nothing — it asks each LUKS header, by its UUID, whether the passphrase still
fits (`cryptsetup --test-passphrase`, ~3 s per volume). It also runs itself in the background a few minutes
after a database restart (which is what a restored database looks like), and after every conversion. It reports
four things, and they are different:

| Result | Meaning |
|---|---|
| `refused` | ⚠️ These disks are on a **different passphrase** — almost certainly they missed a rotation. Lose the keyfile and you lose them. **Set the passphrase again with every disk attached** to rewrite it. |
| `notChecked` | Volumes whose disks were **not attached**, so they were never asked. The audit cannot call the fleet healthy without them — and they are the volumes most likely to be wrong. |
| `unreadable` | The LUKS header would not read. A *disk* fault, not a passphrase fault — but those volumes' recoverability is **unknown**. |
| `unidentified` | A LUKS container carrying no STRUBS nameplate. STRUBS cannot tell whose it is. |

## Recovering an encrypted fleet

The scenario the passphrase exists for: **the OS disk is gone.** Mongo, the volume table, the instance identity
and the keyfile went with it. Thirty encrypted disks are still in the rack.

**Get a keyfile in place first — the recovery re-arms unattended boot with whatever keyfile is present, and does
nothing if there is none.**

- **If you have the backup**, restore `/var/lib/strubs/luks.key` and you are done — its keyslot is already on
  every disk.
- **If the keyfile is truly lost**, create a *fresh* one by hand (STRUBS will not invent one at startup while
  encrypted disks are attached):
  ```bash
  dd if=/dev/urandom of=/var/lib/strubs/luks.key bs=512 count=1 && chmod 400 /var/lib/strubs/luks.key
  ```
  A fresh key opens none of the disks *yet* — but the recovery, authenticating with the **passphrase**, adds it
  to every disk's keyslot, and from then on that new keyfile unlocks the fleet.

Either way, run the recovery. It unlocks each disk (keyfile if it opens them, passphrase otherwise), and
**writes the keyfile into a keyslot on every disk it opened**, reporting them in `keyfileRestoredOn`:

```bash
curl -X POST localhost/\$/recover-fleet -H 'Content-Type: application/json' \
  -d '{"recoveryPassphrase":"…"}'
```

The recovery scan unlocks each `crypto_LUKS` partition (keyfile first if it still exists, passphrase otherwise),
reads the bootstrap manifest from inside, and locks it again — nothing is written to a disk to read it. An
encrypted disk that will not open is reported as **locked** and counted against the recovery, the same as a disk
that would not mount: a recovery planned from a partial view of the array is one that can silently decide a
volume does not exist.

Then restart STRUBS, let the fleet come up, and rebuild the namespace with `POST /$/restore` as usual.

::: warning An encrypted disk whose keyslot could not be restored
It unlocks only when a human types the passphrase — it will not survive a reboot, because `Restart=always` has
nobody to ask. This is why the keyfile must be backed up off the machine the day the first disk is encrypted.
:::

## Backing up

**The keyfile** (`/var/lib/strubs/luks.key`) — off the machine, the day you encrypt the first disk. Two secrets
kept apart (keyfile in a backup, passphrase in a safe) is the whole recovery kit.

**The LUKS headers** — ~16 MB each, cheap insurance. A corrupt header costs one disk, which 4+2 already
survives, so this is not a critical path, but:

```bash
cryptsetup luksHeaderBackup /dev/sdx1 --header-backup-file /root/luks-header-vol57.img
```

Store them off-box. A header backup plus the passphrase is a complete recovery kit for that disk.

## What it refuses to get wrong

The encryption path is hardened against a specific family of mistakes — **a USB disk dropping and another taking
its `/dev/sdX` name mid-operation**, and **a database that has been restored to disagree with the platters.**
The guarantees, in one place:

- **A path is not an identity.** Whole-disk destructive operations (`parted`, `mkfs`) re-check the drive's
  **SMART serial** immediately before each write, through a single choke point. Operations on an existing LUKS
  header address it by **`UUID=<luksUuid>`**, which resolves to the exact header or to nothing.
- **Exactly one, or refuse.** A `dd` clone of a disk carries the same partition UUID, nameplate and identity. So
  every path that could wipe, key, or *mount* a disk requires the UUID to name exactly one attached partition —
  a clone makes it ambiguous, and STRUBS refuses rather than touch the wrong disk.
- **Orphans beat phantoms.** Provisioning claims the disk (writes its identity) *before* the database row, and
  registers it read-only until the row is durable — so a failure leaves a recoverable orphan, never a phantom,
  and no write can land on a volume that is not yet persisted.
- **The passphrase is proven against a platter before it is used**, not just against a database that a restore
  can rewind.
- **Every "could not tell" is a refusal, not a shrug.** An unreadable disk, an unplugged volume, an
  unidentifiable LUKS container — none of them is treated as "safe." The system fails closed.
