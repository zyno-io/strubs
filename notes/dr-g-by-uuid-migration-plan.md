No code written. This is the execution plan against the current repo.

**Identity Model**
- Whole-disk operations stay path + SMART fenced: `parted mklabel`, `parted mkpart`, and GPT nameplate writes via `sgdisk -c` in [device-provisioner.ts](/opt/strubs/lib/io/device-provisioner.ts:817) and [device-provisioner.ts](/opt/strubs/lib/io/device-provisioner.ts:607). There is no trustworthy whole-disk `/dev/disk/by-*` on this hardware.
- Partition operations before a LUKS UUID exists use GPT `PARTUUID`: add `partuuid` to discovery, then target `/dev/disk/by-partuuid/<partuuid>` for fresh `luksFormat` and plaintext `mkfs`.
- LUKS header operations after the header exists use native cryptsetup `UUID=<luksUuid>`, never `/dev/sdX1`: `luksAddKey`, `luksRemoveKey`, `--test-passphrase`, `luksDump`, `luksOpen`, `ensureKeyfileSlot`.
- Mount/fsck targets use stable handles: plaintext mounts/fsck by `/dev/disk/by-uuid/<fsUuid>`; encrypted volumes open by `UUID=<luksUuid>` and then fsck/mount the mapper.
- Mongo remains a derived index. It may record UUIDs for lookup, but it must not be used as proof that a disk exists or that a path is still the intended disk.

**Per-Site Plan (A-E)**
- A, recovery-key existing headers: in [luks-recovery-key.ts](/opt/strubs/lib/io/luks-recovery-key.ts:672), replace `disk.path` calls with `disk.luksUuid` calls. `scanFleet()` already returns `EncryptedDisk { path, volumeId, luksUuid }` from [luks.ts](/opt/strubs/lib/io/luks.ts:632). If `luksUuid` is missing, count the disk unreadable/refuse; do not fall back to path.
- Rotation at [luks-recovery-key.ts](/opt/strubs/lib/io/luks-recovery-key.ts:684): keep the state machine unchanged: test idempotency, add new passphrase everywhere, persist verifier/reseal, then best-effort remove old passphrase. Only the target changes to `UUID=<luksUuid>`.
- Proof/audit at [luks-recovery-key.ts](/opt/strubs/lib/io/luks-recovery-key.ts:902) and [luks-recovery-key.ts](/opt/strubs/lib/io/luks-recovery-key.ts:977): test by LUKS UUID. An absent UUID target maps to `unreadable`, not `rejected`.
- B, fresh provisioning: after `parted mkpart` in [device-provisioner.ts](/opt/strubs/lib/io/device-provisioner.ts:318), require a unique `partition.partuuid`. Run `luksFormat` on `/dev/disk/by-partuuid/<partuuid>`, then immediately read the minted LUKS UUID from that same by-partuuid handle. From that point onward, `addPassphrase`, `assertRecoverable`, `testPassphrase`, and `open` switch to `UUID=<newLuksUuid>` in [device-provisioner.ts](/opt/strubs/lib/io/device-provisioner.ts:509).
- C, registration identity write: change [manager.ts](/opt/strubs/lib/io/manager.ts:110), [volume-fleet.ts](/opt/strubs/lib/io/volume-fleet.ts:242), and [volume.ts](/opt/strubs/lib/io/volume.ts:245) so provisioning’s mount/fsck/.identity path is stable-handle based. After mount, verify the mounted filesystem is backed by the expected source before [initializeIdentity](/opt/strubs/lib/io/volume.ts:440) writes `.identity`.
- D, Mongo ordering: move [database.createVolume](/opt/strubs/lib/io/device-provisioner.ts:416) after the physical identity claim currently at [device-provisioner.ts](/opt/strubs/lib/io/device-provisioner.ts:421). A failure before Mongo leaves only a disk orphan; never a row pointing at an unclaimed disk.
- E, bootstrap keyslot restore: extend `DiscoveredManifest` in [bootstrap.ts](/opt/strubs/lib/recovery/bootstrap.ts:39) to include `luksUuid?: string`. `restoreKeyfileSlots` at [bootstrap.ts](/opt/strubs/lib/recovery/bootstrap.ts:501) must call `ensureKeyfileSlotByUuid(luksUuid, passphrase)`, not `ensure(entry.device, ...)`.

**New Helpers/Choke Points**
- Add `lib/io/block-identity.ts`:
  - `byPartUuid(partUuid): string`
  - `byFsUuid(uuid): string`
  - `assertUniqueUuid(uuid, kind: 'luks' | 'fs' | 'part')`
  - `resolveUniqueUuid(...)` for diagnostics only, never as a replacement for `UUID=`.
- Add `RawBlockDeviceChild.partuuid` and `CachedPartition.partUuid` in [device-discovery.ts](/opt/strubs/lib/io/device-discovery.ts:10), [device-discovery.ts](/opt/strubs/lib/io/device-discovery.ts:65), and sanitizer [device-discovery.ts](/opt/strubs/lib/io/device-discovery.ts:392).
- In [luks.ts](/opt/strubs/lib/io/luks.ts:165), add UUID-targeted public helpers: `openByUuid`, `addPassphraseByUuid`, `removePassphraseByUuid`, `testPassphraseByUuid`, `assertRecoverableByUuid`, `ensureKeyfileSlotByUuid`.
- Keep path-targeted LUKS helpers only for the bootstrap moment before a header UUID exists, preferably `formatByPartUuid(partUuid): Promise<luksUuid>`.
- Replace mapper stale check in [luks.ts](/opt/strubs/lib/io/luks.ts:180): existing mapper reuse must compare mapper backing LUKS UUID, not backing kernel path.

**Ordering & Cleanup**
- Provisioning order becomes: SMART-fenced whole-disk partitioning → bind unique PARTUUID → format/mkfs via stable handle → physical `.identity` claim via stable mount → verify identity → `database.createVolume` → expose volume to `VolumeFleet` and refresh manifest.
- Implement a temporary physical claim path, not normal `registerVolume`: mount, fsck, write `.identity`, verify, then unmount/close or hand the already-verified volume to the fleet only after Mongo insert succeeds.
- If physical claim fails: unmount/close mapper; no Mongo row exists.
- If Mongo insert fails after `.identity`: unmount/close and leave the disk as an orphan. Do not wipe it. Add a provisioning preflight that refuses to allocate a new id while an attached STRUBS identity/nameplate exists without a Mongo row.
- If Mongo insert succeeds but fleet registration fails: delete the just-created Mongo row if no slices can have been placed yet; leave the physical disk orphaned and loud.

**Deletions**
- Delete `RecoveryKeyDeps.containerUuid` from [luks-recovery-key.ts](/opt/strubs/lib/io/luks-recovery-key.ts:231).
- Delete rotation’s local `assertStillTheSameDisk` at [luks-recovery-key.ts](/opt/strubs/lib/io/luks-recovery-key.ts:672) and its calls around lines 687, 706, 720, 728, 757, 771, and 783.
- Delete proof/audit local header checks at [luks-recovery-key.ts](/opt/strubs/lib/io/luks-recovery-key.ts:928) and [luks-recovery-key.ts](/opt/strubs/lib/io/luks-recovery-key.ts:996).
- Replace, do not keep, fresh-header path calls at [device-provisioner.ts](/opt/strubs/lib/io/device-provisioner.ts:514), [device-provisioner.ts](/opt/strubs/lib/io/device-provisioner.ts:520), [device-provisioner.ts](/opt/strubs/lib/io/device-provisioner.ts:530), [device-provisioner.ts](/opt/strubs/lib/io/device-provisioner.ts:545), and [device-provisioner.ts](/opt/strubs/lib/io/device-provisioner.ts:555).
- Remove the outer `fencedWrite(... registerVolume ...)` at [device-provisioner.ts](/opt/strubs/lib/io/device-provisioner.ts:421); the target guarantee moves inside stable-handle mount/claim.
- Keep `assertStillTheSameDisk` and `fencedWrite` in [device-provisioner.ts](/opt/strubs/lib/io/device-provisioner.ts:779) for whole-disk path writes only.

**Failure Modes**
- Dangling UUID/PARTUUID: fail closed. No path fallback. Reads return `unreadable`; writes throw a refusal.
- Duplicate LUKS UUID: treat `UUID=` as ambiguous unless a fresh duplicate scan proves exactly one matching LUKS header. Refuse key writes and opens if count is not one.
- Duplicate FS UUID or PARTUUID: refuse mkfs/mount/claim. This is a clone condition; require operator action.
- Stale mapper: if mapper name exists but backs a different LUKS UUID, close it. If close fails, refuse.
- Missing `luksUuid` from scan: do not operate on the disk; count it unknown/unreadable.

**Staged Rollout**
1. Add discovery/schema support for `partuuid` and optional manifest field `partitionPartUuid`; no behavior change.
2. Add UUID/PARTUUID helper layer and tests; keep old path helpers temporarily.
3. Migrate recovery-key rotation/proof/audit A to UUID helpers. Ship independently.
4. Migrate bootstrap restore E to carry/use `luksUuid`. Ship independently.
5. Migrate provisioning B to PARTUUID bootstrap then LUKS UUID operations. Ship with encrypted-provisioning canary only.
6. Migrate volume mount/identity claim C and reorder Mongo D. This is the highest-blast-radius stage.
7. Remove legacy path helper exports or make them private; add a static grep test preventing new header writes by path.

**Test/Verify Plan**
- Unit tests: assert cryptsetup args contain `UUID=<luksUuid>` for add/remove/test/dump/open/ensure; assert no `disk.path` is passed in A/E.
- Duplicate tests: 0 matches and 2 matches for LUKS UUID, FS UUID, and PARTUUID all refuse before cryptsetup/mount/mkfs.
- Provisioner tests: update existing swap-window tests so swaps after `luksFormat` produce UUID-absent failures, not SMART-bracket failures.
- Volume tests: simulate path reuse between bind and mount; `.identity` must not be written unless mounted source verifies.
- Loopback: create LUKS loop devices, detach/reattach to force path changes, verify UUID-targeted operations still hit the intended header; clone a LUKS header and verify duplicate refusal.
- Hardware canary: on a spare bay, provision encrypted, pull/reinsert during each stage, verify old UUID symlink removal fails closed and `cryptsetup luksUUID UUID=<u>` continues to resolve correctly when present.

**Risks & Rollback**
- Rotation risk is behavioral, not format risk: the five-round history is all around preserving the rotation state machine. Do not change ordering or idempotency logic, only target identity.
- Main regression risk is a helper accidentally falling back to path. Guard with static tests and mutation tests that fail if `disk.path` reaches cryptsetup writes.
- Rollback is binary rollback per stage. The on-disk format does not change; new `partitionPartUuid` metadata is additive. During rollback, freeze key rotation and encrypted provisioning rather than enabling a path fallback for header writes.
