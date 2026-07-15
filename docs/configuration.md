# Configuration

STRUBS is configured in two places, and the split is deliberate:

- **Environment variables** — things that are true of the *installation*: where Mongo lives, the erasure-coding geometry, how hard the background jobs are allowed to push the disks. Changing one needs a restart.
- **Runtime settings** — things an operator changes *while the system is running*, stored in the `runtimeConfig` Mongo collection and driven from the API or the UI. These survive restarts and take effect without one.

Environment variables are read once at startup (`lib/config.ts`) via `dotenv`, so a `.env` file in the working directory works, as does a systemd drop-in.

## Environment variables

Every setting has a working default. A stock install needs at most `STRUBS_MONGO_URL`.

### Core

| Variable | Default | Meaning |
|---|---|---|
| `STRUBS_MONGO_URL` | `mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin` | Metadata database. STRUBS keeps *all* object metadata here; see the warning below. |
| `STRUBS_DATA_SLICES` | `4` | Data slices per object (`k`). |
| `STRUBS_PARITY_SLICES` | `2` | Parity slices per object (`m`). |
| `STRUBS_LUKS_KEYFILE` | `/var/lib/strubs/luks.key` | The LUKS keyfile that unlocks encrypted volumes at boot. Checked (and created, if nothing is encrypted) at **every** startup, and read whenever the sealed recovery passphrase is used. Mode `0400`. See [Encryption](encryption.md). |

> **The EC geometry is not retroactive.** `STRUBS_DATA_SLICES` and `STRUBS_PARITY_SLICES` apply to *new* writes. Existing objects carry their own geometry in their slice headers and their Mongo record, and are read back with it. Changing these on a populated system gives you a fleet with mixed geometry — which works, but you should know you did it.

> **Mongo is a hard dependency, and it is the weak link.** The slices on disk are useless without the `content` records that say which volumes hold them. Back Mongo up. A lost metadata database is a lost array, even though every disk is fine.

### Verification (scrub)

| Variable | Default | Meaning |
|---|---|---|
| `STRUBS_SCRUB_INTERVAL_MS` | `7776000000` (90 days) | Rolling background scrub cadence. `0` disables the scheduler; manual verification still works. |
| `STRUBS_VERIFY_PARITY` | `true` | In `full` mode, also recompute parity and compare it to what's stored. Set `false` to disable. This is the only check that catches foreign parity — see [Data integrity](data-integrity.md). |
| `STRUBS_VERIFY_READ_DELAY_MS` | `2` | Pause between chunk reads. Trades scrub throughput for lower contention with foreground reads. |
| `STRUBS_VERIFY_PARALLEL` | number of enabled volumes, capped at CPU count | Objects verified concurrently. |

A full whole-object scrub reads every chunk of every slice, so on a large array it can take **weeks**. That is why the default is quarterly rather than daily: four catch-and-repair checkpoints a year, inside the redundancy window, without needlessly wearing the drives. Reads already checksum hot data continuously.

> The scheduler chunks long waits internally. Node clamps any `setTimeout` above ~24.8 days to 1 ms, so a naive 90-day interval would fire *continuously*.

### Repair

| Variable | Default | Meaning |
|---|---|---|
| `STRUBS_REPAIR_INTERVAL_MS` | `300000` (5 min) | Repair worker poll. `0` disables polling; newly reported faults still wake a pass. |
| `STRUBS_REPAIR_BATCH_SIZE` | `25` | Faults processed per pass. |
| `STRUBS_REPAIR_BACKLOG_DELAY_MS` | `10000` | Pause between passes when a backlog remains. |
| `STRUBS_REPAIR_BLOCKED_RETRY_MS` | `3600000` (1 hr) | How long before a *blocked* fault is retried. Terminal reasons (`unrecoverable`, `reconstruction-mismatch`) are never retried. |

### Relocation (drain and rebalance)

| Variable | Default | Meaning |
|---|---|---|
| `STRUBS_DRAIN_CONCURRENCY` | `4` | Slices a drain relocates at once. |

Rebalance concurrency is deliberately **not** an environment variable — it's a runtime setting (below). The right value is only discoverable by watching a real rebalance move real data, so it has to be changeable without a restart.

Relocation is latency-bound (open, read, write, commit, DB ref flip, delete), not bandwidth-bound. Raising concurrency helps a lot, up to the point where seek-bound drives start thrashing. Raise it in steps and watch the reported rate.

### Health monitoring

| Variable | Default | Meaning |
|---|---|---|
| `STRUBS_VOLUME_HEALTH_INTERVAL_MS` | `300000` (5 min) | Volume health monitor cadence. `0` disables. |
| `STRUBS_VOLUME_FAULT_THRESHOLD` | `10` | Faults on one volume before it is degraded to read-only + unhealthy. |
| `STRUBS_SYSLOG_WATCH_INTERVAL_MS` | `300000` (5 min) | smartd/kernel log watcher cadence. `0` disables. |
| `STRUBS_DEVICE_RECONCILE_INTERVAL_MS` | `300000` (5 min) | Backstop pass for the hotplug reconciler. `0` disables the periodic pass. |
| `STRUBS_DISABLE_UDEV` | `false` | Set `true` to fall back to periodic-only device reconciliation. |

The volume health monitor degrades a bad volume to **read-only + unhealthy** — reads keep working, writes stop. It never auto-evicts: pulling data off a disk is an operator decision.

### Notifications

| Variable | Default | Meaning |
|---|---|---|
| `STRUBS_SLACK_WEBHOOK_URL` | *(none)* | Slack incoming webhook. Without it, only the log transport is active. |
| `STRUBS_SLACK_MIN_SEVERITY` | `warning` | One of `info`, `warning`, `critical`. |
| `STRUBS_NOTIFY_COOLDOWN_MS` | `300000` (5 min) | Dedupe window for throttled transports. |

The log transport **always** receives every occurrence, even when Slack is throttled — so journald has the full record and Slack has the summary. The cooldown is armed only after a successful delivery, and a severity escalation bypasses it.

### Storage statistics

| Variable | Default | Meaning |
|---|---|---|
| `STRUBS_STORAGE_STATS_INTERVAL_MS` | `21600000` (6 hr) | Full reconciliation from content aggregation. |
| `STRUBS_STORAGE_STATS_FLUSH_INTERVAL_MS` | `5000` | How often live create/delete/relocate deltas are folded into the cached snapshot. |

## Runtime settings

Stored in the `runtimeConfig` collection, changed through the API or UI, and applied without a restart.

| Key | Set via | Meaning |
|---|---|---|
| `maintenanceFreeze` | `PUT /$/maintenance-freeze` | Pauses **all** automatic maintenance: verify, repair, drain, rebalance. See below. |
| `rebalanceConcurrency` | `PUT /$/rebalance` | Slices relocated at once, 1–64. Re-read once per batch, so it lands on a *running* rebalance. |
| `encryptNewVolumes` | `PUT /$/encryption/settings` | Provision every **new** disk as LUKS. Default `false`. Converts nothing that is already in the array — see [Encryption](encryption.md). |
| `luksRecoveryAudit` | *(written by `POST /$/encryption/audit`)* | The last time the recovery passphrase was PROVEN against every encrypted disk, and what it found. Never contains the passphrase. Null means it has never been checked — which on an encrypted fleet means nobody has confirmed the disks can actually be recovered. |
| `luksRecoveryVerifier` | `PUT /$/encryption/passphrase` | Salted **argon2id** hash of the fleet recovery passphrase, used to validate it locally before a volume is encrypted. **It is a verifier, not the key** — it opens nothing. Delete it and STRUBS refuses to encrypt anything until you set the passphrase again (which rewrites it on every disk, so nothing is lost). |
| `luksRecoverySealed` | *(written with the passphrase)* | The recovery passphrase **sealed under the keyfile** (AES-256-GCM, key derived from the keyfile). This is what lets STRUBS write the passphrase onto a NEW disk unattended — without it, `encryptNewVolumes` could not work, because a disk provisioned automatically has no operator to type it. It widens nothing: the keyfile already opens every disk, so anyone who can read this blob can read the keyfile beside it. It is never trusted on its own — what it yields is proven against `luksRecoveryVerifier` **and** (once the fleet has any encrypted disk) against a real attached disk before it is used. Restore an OS disk from a backup older than the keyfile and STRUBS ignores the seal (it will not open) and asks for the passphrase again. |

Other keys in this collection are **job checkpoints**, not settings — `verifyStartedAt`, `verifyVolumeIds`, `verifyCursorId`, `verifyMode`, `drainVolumeId`, `drainCursorId`, `rebalanceActive`. They exist so a job survives a restart. Don't hand-edit them; use the cancel endpoints, which clear them properly.

### The maintenance freeze

The freeze is the big red switch. With it on, STRUBS serves reads and writes normally but does no background work of its own — no scrub, no repair, no drain, no rebalance. It is persisted, so it survives a restart, and it is enforced at startup (the scheduler and repair worker simply never start).

Use it when you don't yet know what's wrong. Automatic repair is *usually* what you want, but a repair pass reconstructs slices, and reconstructing from sources you haven't validated is how you turn a recoverable problem into a permanent one. When in doubt, freeze first, diagnose, then unfreeze.

```bash
curl -X PUT localhost/\$/maintenance-freeze -H 'Content-Type: application/json' -d '{"frozen":true}'
```

Unfreezing resumes work in a deliberate order: drains first, then the scrub and repair worker, then the rebalance last.

## Where settings live in a deployment

The reference deployment runs under systemd with the environment in a drop-in:

```ini
# /etc/systemd/system/strubs.service.d/tuning.conf
[Service]
Environment=STRUBS_DRAIN_CONCURRENCY=8
```

```bash
systemctl daemon-reload && systemctl restart strubs
```

A `.env` file in the working directory works too — `dotenv` is loaded before config is read.
