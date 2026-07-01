# Disk note: `sde` — WD Red 4 TB (WD-WCC4E0420947)

_Last assessed: 2026-06-27_

## Identity
- **Device:** WDC WD40EFRX-68WT0N0 (Western Digital Red), 4 TB (4000785964544 B partition).
- **Serial:** WD-WCC4E0420947
- **Physical slot:** enclosure bay **2.1** (USB port `3.2.1`, LUN0 — derived from topology; matches the old label).
- **Was:** strubs **volume 35** (label `2.1`), now `is_deleted: true`, `enabled: false`, **`healthy: false`**.
- **Current state:** physically **blank** — no partition table, no filesystem, no signatures (`wipefs`/`blkid` clean). Properly drained before deletion (0 object references, 0 recorded faults). Disk wiped after deletion.

## Why was it retired? — no hardware smoking gun
The volume config was flagged **`healthy: false`** and deleted, but the disk's **ATA SMART shows no platter defects**:
- Reallocated 0, Current_Pending 0, Offline_Uncorrectable 0, Raw_Read_Error 0, Seek_Error 0, Spin_Retry 0.
- Error log: **"No Errors Logged."**
- Self-tests: short tests clean; one **Extended test "Aborted by host" @ ~41,858 h** (looks like a long scan cancelled as the drive was pulled).
- Age: **~42,450 power-on hours (~4.9 years)**, 34 power cycles, Load_Cycle 308k.
- 1× UDMA_CRC error (a USB-link blip).

SMART attributes survive a wipe, so 0 bad sectors is the disk's true lifetime history. Therefore `healthy: false` almost certainly came from something **ATA SMART can't see**:
- **USB-bridge / link flakiness** (drive dropping off the bus, I/O timeouts → strubs faults → unhealthy flag). The lone CRC error + the CRC errors seen on other drives in these TerraMaster USB enclosures support this. ATA SMART only sees the platter, not the bridge.
- and/or a **preventive/admin retirement** of an old drive (the aborted long-test coincides with a likely deliberate pull).

The exact reason is not recoverable from stored data.

## Reuse guidance
- **Lower-confidence spare.** It was flagged unhealthy for a reason invisible to SMART. The platter looks fine, but if the cause was a flaky **link/bay**, that problem may **follow the slot (bay 2.1)**, not the drive.
- **Prefer `sdac` / `sdae`** (Seagate IronWolf 4 TB, ZDHB81Y2 / ZDHB83QN) — truly free (no config), young (~7 mo / 5,354 h POH), pristine SMART, never flagged.
- If `sde` is ever reused: run an **extended SMART self-test** first, watch CRC/timeouts, and consider testing it in a *different* bay to separate disk-vs-link issues.
