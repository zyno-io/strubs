import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';

import { createLogger } from '../log';
import { spawnHelper } from '../helpers/spawn';
import { normalizeIdentity } from '../config';
import { newestManifest, type BootstrapManifest } from '../io/bootstrap-manifest';
import { listRawBlockDevices } from '../io/device-discovery';
import { classifyPartition } from '../io/signature-probe';
import {
    closeByName,
    ensureKeyfileSlot as luksEnsureKeyfileSlot,
    isLuksFsType,
    keyfileReadable,
    openWithSecret
} from '../io/luks';
import { assertExactlyOneLuksHeader, luksHeaderSpecifier } from '../io/block-identity';
import { volumeConfigsFromManifest, assertSafeToRestoreFleet } from './fleet-restore';
import type { PersistedVolumeConfig } from '../io/volume';

const log = createLogger('bootstrap-recovery');

// THE FIRST FIVE MINUTES OF THE WORST DAY.
//
// A bare host. A pile of drives. No identity, no volume table, no Mongo. STRUBS comes up in RECOVERY MODE --
// admin surface only, no fleet, no object API -- because a host that cannot verify a single disk has no
// business opening one, and because generating a fresh identity would permanently orphan every drive in the
// rack.
//
// So the only thing it can do is ASK THE DISKS. Every one of them carries a bootstrap manifest, which
// carries the instance identity, the whole volume table, and the id of the newest snapshot. Any single
// surviving drive can tell you about all the others -- which is exactly why the manifest is written to every
// disk rather than kept somewhere sensible and central.
//
// READ-ONLY, throughout. Every partition is mounted `ro`, read, and unmounted. Nothing here writes to a disk,
// because at this point we do not yet know what any of them are, and the one thing worse than a host that
// cannot read its array is a host that helpfully reformats it.

export type DiscoveredManifest = {
    device: string;

    // The LUKS container uuid, ONLY for an encrypted disk (undefined for a plaintext one). Captured at scan
    // time so a keyslot restore can address the header by `UUID=<luksUuid>` -- not by a path that may point at
    // a different disk by the time we get to writing. See notes/dr-g-by-uuid-migration-plan.md.
    luksUuid?: string;

    manifest: BootstrapManifest;
};

// Mount each candidate partition read-only, read its manifest, unmount. Returns everything found, so the
// caller can see disagreement rather than have it resolved for them behind their back.
export type ScanOptions = {
    // The fleet recovery passphrase. Needed when the disks are encrypted AND the keyfile is gone -- which is
    // the whole scenario the passphrase exists for. Without it, an encrypted fleet is scanned and found to be
    // a pile of unreadable ciphertext, which is not a recovery.
    recoveryPassphrase?: string;
};

export async function findManifestsOnDevices(options: ScanOptions = {}): Promise<DiscoveredManifest[]> {
    const devices = await listRawBlockDevices();
    const found: DiscoveredManifest[] = [];
    const silent: string[] = [];
    const locked: string[] = [];

    for (const device of devices) {
        for (const child of device.children ?? []) {
            if (child.type !== 'part') continue;

            const partition = child.path ?? `/dev/${child.name}`;

            // WHAT IS ON IT? -- and an lsblk that did not cache the fstype is not a disk with nothing on it.
            //
            // This loop used to read `child.fstype` directly, which meant an ENCRYPTED disk of ours whose
            // fstype lsblk had not cached was skipped as though it were a stranger's: it never got unlocked,
            // never counted as locked or silent, and so never VOTED on which array this host is. Recovery could
            // then adopt a volume table from a subset of the fleet and quietly decide the missing volumes never
            // existed. Same mistake, third guard -- so all three now share one classifier.
            const kind = await classifyPartition(child.fstype, partition);

            if (kind.kind === 'unreadable') {
                log.error('%s could not be identified (%s) -- counting it as SILENT. A disk that will not answer '
                    + 'is not a disk with nothing on it.', partition, kind.reason);
                silent.push(partition);
                continue;
            }

            // AN ENCRYPTED DISK IS NOT AN ABSENT ONE.
            //
            // The manifest lives INSIDE the filesystem, so on a LUKS volume it is behind the encryption -- and
            // the only thing outside it is the nameplate. Skipping these means that on a fully encrypted fleet
            // the recovery scan finds NOTHING, reports a bare host with a pile of foreign disks, and the
            // supported disaster-recovery path is simply dead -- at the exact moment encryption has made losing
            // the metadata unrecoverable rather than merely painful.
            //
            // So unlock and read it. The keyfile if we still have one, the operator's passphrase if we do not.
            if (kind.kind === 'luks') {
                const probe = await readManifestFromLuks(partition, options.recoveryPassphrase);

                if (probe.kind === 'manifest') {
                    log('found a bootstrap manifest on %s (encrypted)', partition);
                    found.push({ device: partition, luksUuid: child.uuid, manifest: probe.manifest });
                }
                else if (probe.kind === 'locked')
                    locked.push(partition);
                else if (probe.kind === 'silent')
                    silent.push(partition);

                continue;
            }

            // We only ever mkfs ext. A foreign filesystem -- or a positively blank partition -- is not ours, and
            // trying to mount one is how a recovery tool starts touching things it should not.
            if (kind.kind !== 'ext')
                continue;

            const probe = await readManifestReadOnly(partition);

            if (probe.kind === 'manifest') {
                log('found a bootstrap manifest on %s', partition);
                found.push({ device: partition, manifest: probe.manifest });
            }
            else if (probe.kind === 'silent') {
                silent.push(partition);
            }
            // 'none' -- it mounted and it is not ours. It gets no vote, for or against.
        }
    }

    if (silent.length)
        log.error('%d ext partition(s) would not give up a manifest: %s. If those are STRUBS disks, this recovery '
            + 'is being planned from an INCOMPLETE picture of the array.', silent.length, silent.join(', '));

    if (locked.length)
        log.error('%d encrypted partition(s) could NOT be unlocked: %s. Without the recovery passphrase they are '
            + 'ciphertext, and this recovery is being planned from an INCOMPLETE picture of the array.',
            locked.length, locked.join(', '));

    // Attached to the result so the caller can weigh the vote against the disks that did NOT answer, rather
    // than against only the ones that did. A LOCKED disk is a disk that did not answer.
    const annotated = found as DiscoveredManifest[] & { silent?: string[]; locked?: string[] };
    annotated.silent = [...silent, ...locked];
    annotated.locked = locked;
    return found;
}

// Unlock, read, lock again. Nothing is written -- the mapper is opened, the filesystem mounted `ro,noload`,
// and both are torn down before we return, whatever happens.
async function readManifestFromLuks(
    partition: string, passphrase?: string
): Promise<ProbeResult | { kind: 'locked' }> {
    // A name of our own, so we can never collide with (or adopt) a mapper somebody else left lying around.
    const name = `strubs-probe-${partition.replace(/[^a-zA-Z0-9]/g, '-')}`;

    // The keyfile first -- it is the ordinary case (a Mongo loss with the OS disk intact). The passphrase is
    // the bad day.
    const secrets: Array<{ keyfile?: string; passphrase?: string }> = [];
    if (await keyfileReadable())
        secrets.push({});
    if (passphrase)
        secrets.push({ passphrase });

    if (!secrets.length) {
        log.error('%s is encrypted, and we have neither the keyfile nor a recovery passphrase to open it with.',
            partition);
        return { kind: 'locked' };
    }

    for (const secret of secrets) {
        try {
            await openWithSecret(partition, name, secret);
        }
        catch {
            continue;   // this key did not open it; try the next
        }

        try {
            return await readManifestReadOnly(`/dev/mapper/${name}`);
        }
        finally {
            await closeByName(name).catch(() => undefined);
        }
    }

    log.error('%s is encrypted and none of the keys we hold opened it. If it is one of ours, this recovery is '
        + 'incomplete.', partition);
    return { kind: 'locked' };
}

// THREE ANSWERS, NOT TWO -- and conflating them let the host's own root filesystem vote on the recovery.
//
// 'none' means the partition mounted perfectly well and simply has no manifest on it: the host root, a swap
// of somebody's photos, a foreign ext4. Those disks are not silent, they ANSWERED, and the answer was "I am
// not one of yours." Counting them as silence would let the machine's own boot disk vote against the array.
//
// 'silent' means it would not mount, or would not read: on a bare host, very likely one of OURS, broken --
// and possibly carrying the newest volume table.
type ProbeResult =
    | { kind: 'manifest'; manifest: BootstrapManifest }
    | { kind: 'none' }
    | { kind: 'silent' };

async function readManifestReadOnly(partition: string): Promise<ProbeResult> {
    const mountPoint = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-probe-'));

    try {
        // `ro,noload` -- read-only, and do not replay the ext4 journal. Replaying it would be a WRITE, on a
        // disk we have not yet established is ours, in a tool whose entire promise is that it does not touch
        // anything.
        // ⚠️ CHECK THE EXIT CODE. spawnHelper RESOLVES on a non-zero exit -- it does not throw -- so this
        // `catch` only ever fired if the mount binary could not be spawned at all.
        //
        // A partition that FAILED TO MOUNT therefore fell straight through to the read below, found an empty
        // temp directory, got ENOENT, and was recorded as 'none': "it mounted fine and it is not one of ours."
        // The one answer it must never give. A disk that would not mount is exactly the disk most likely to be
        // OURS AND BROKEN, possibly carrying the newest volume table -- and it was being counted as a
        // stranger's, silently, in the vote that decides which array this host belongs to.
        //
        // The same costume the bug wears everywhere else in this system: a failure to LOOK, reported as a fact
        // about the DATA.
        const { code, stdout, stderr } = await spawnHelper('mount', ['-o', 'ro,noload', partition, mountPoint]);

        if (code !== 0) {
            log.error('%s would not mount read-only (%s) -- counting it as SILENT, not as a foreign disk',
                partition, (stderr || stdout || `exit ${code}`).trim());
            await fsp.rm(mountPoint, { recursive: true, force: true }).catch(() => undefined);
            return { kind: 'silent' };
        }
    }
    catch {
        // WILL NOT MOUNT. On a bare host, this is far more likely to be one of ours that has failed than a
        // stranger -- and it may be carrying the newest volume table.
        await fsp.rm(mountPoint, { recursive: true, force: true }).catch(() => undefined);
        return { kind: 'silent' };
    }

    try {
        const raw = await fsp.readFile(path.join(mountPoint, 'strubs', '.bootstrap.json'), 'utf8');
        return { kind: 'manifest', manifest: JSON.parse(raw) as BootstrapManifest };
    }
    catch (err) {
        const code = (err as NodeJS.ErrnoException).code;

        // It MOUNTED and it has no manifest. That is a complete, trustworthy answer -- "I am not one of
        // yours" -- and it is what the host's own root filesystem says. It is not silence.
        if (code === 'ENOENT') return { kind: 'none' };

        // It mounted and would not give up the file: EIO, a corrupt directory. That IS silence.
        return { kind: 'silent' };
    }
    finally {
        await spawnHelper('umount', [mountPoint]).catch(() => undefined);
        await fsp.rm(mountPoint, { recursive: true, force: true }).catch(() => undefined);
    }
}

// What the array says about itself, having asked every disk that will answer.
//
// The manifests should agree -- they are written together -- but a disk that has been out of the rack for a
// month will be carrying a month-old idea of the truth, so the NEWEST wins. And a manifest that names a
// different instance identity is not a stale copy of ours, it is somebody else's array entirely, and it does
// not get a vote in what ours looks like.
export function reconcileManifests(found: DiscoveredManifest[], force = false): {
    manifest: BootstrapManifest | null;
    agreeing: number;
    foreign: string[];
} {
    if (!found.length) return { manifest: null, agreeing: 0, foreign: [] };

    // WHICH ARRAY IS OURS?
    //
    // On a bare host there is no identity to compare against -- that is the whole problem, and it is why we
    // are here. So we cannot ask "does this manifest match us?", because there is no us yet.
    //
    // Taking the NEWEST manifest and calling everything that disagrees with it foreign gets this exactly
    // backwards: a single disk from somebody else's array, plugged in by mistake and written more recently
    // than ours, would become the array. Every one of our own disks would then be "foreign", and the
    // recovery would restore the wrong identity, the wrong volume table, and a snapshot object that does not
    // exist on these platters.
    //
    // The disks themselves are the vote. THIRTY drives carrying one identity and one carrying another is not
    // an ambiguity, it is a mistake with an obvious answer. Majority first, and only then newest-within-it.
    const byIdentity = new Map<string, DiscoveredManifest[]>();
    for (const f of found) {
        const key = f.manifest.instanceIdentity;
        if (!key) continue;                          // a manifest with no identity vouches for nothing
        const group = byIdentity.get(key) ?? [];
        group.push(f);
        byIdentity.set(key, group);
    }
    if (!byIdentity.size) return { manifest: null, agreeing: 0, foreign: [] };

    const groups = [...byIdentity.entries()].sort((a, b) => b[1].length - a[1].length);
    const [identity, ours] = groups[0];
    const total = found.filter(f => f.manifest.instanceIdentity).length;

    const silent = (found as DiscoveredManifest[] & { silent?: string[] }).silent ?? [];

    // TWO SEPARATE RULES, AND ONLY ONE OF THEM IS EVER FORCEABLE. Collapsing them into a single `force` was a
    // real bug: it let an operator who meant "those dead disks don't get a vote" also, silently, say "and a
    // stranger's disk may become this array".
    //
    // RULE 1 -- WHOSE ARRAY IS THIS? Decided by MAJORITY OF THE DISKS THAT ANSWERED, and it is NOT negotiable.
    //
    // A plurality is not enough, and 2-1-1 is the case that shows why: two disks of ours, one from array B, one
    // from array C. Ours "wins" with half the disks in the box, and the recovery proceeds on a host where half
    // the drives belong to somebody else -- which is not a recovery, it is an accident with three arrays in it.
    // More than half of the disks that spoke, or we do not guess.
    //
    // There is no --force for this, and there must not be. Adopting the wrong IDENTITY is not a degraded
    // recovery, it is a different array: every disk of ours becomes "foreign", the volume table is a stranger's,
    // and the snapshot pointer names an object that does not exist on these platters. The fix is one an operator
    // can perform in thirty seconds -- take the other disks out -- and no flag is worth skipping it.
    if (ours.length * 2 <= total) {
        const tally = groups.map(([id, g]) => `${g.length}×${id.slice(0, 8)}…`).join(', ');
        throw new Error(`the disks do not agree on which array this is (${tally}), and no identity holds a majority `
            + `of the ${total} disk(s) that answered. This is NOT forceable: adopting the wrong identity does not `
            + `give you a degraded recovery, it gives you somebody else's array, and every disk of yours becomes `
            + `foreign to it. Remove the disks that do not belong here and run this again.`);
    }

    // RULE 2 -- ARE WE LOOKING AT ENOUGH OF THE ARRAY TO TRUST ITS VOLUME TABLE? The disks that said NOTHING
    // count against us here, and on a bare host they are the ones most likely to be OURS and broken. Ten
    // readable disks and twenty dead ones is not a majority of anything; the newest volume table could easily
    // be on one that is not talking, and adopting an older one drops disks from the fleet -- which makes every
    // object living only on them read as data loss.
    //
    // THIS one is forceable, because the whole point of this tool is the day half the rack is gone, and a guard
    // that cannot be overridden on that day is not a safety feature, it is the outage. The operator who knows
    // those disks are dead says so, out loud, and proceeds -- and they are only overriding how COMPLETE the
    // picture is, never WHOSE array it is.
    if (ours.length * 2 <= total + silent.length) {
        if (!force)
            throw new Error(`${silent.length} disk(s) in this box would not give up a manifest at all, and the `
                + `${ours.length} that did are not a majority of the ${total + silent.length} present. Any one of the `
                + `silent disks could be carrying the newest volume table, and adopting an older one would drop disks `
                + `from the fleet -- every object living only on those disks would then read as data loss. Fix the `
                + `disks that will not answer, or force this deliberately if you know they are gone for good.`);

        log.error('%d disk(s) would not answer, and the majority rule is being FORCED past them. The volume table '
            + 'being adopted may be older than the one on a disk that is not talking, and any disk missing from it '
            + 'will be invisible to the array. The IDENTITY is not in doubt -- only the completeness of the picture.',
            silent.length);
    }

    const foreign = found.filter(f => f.manifest.instanceIdentity !== identity).map(f => f.device);
    if (foreign.length)
        log.error('%d device(s) carry a manifest for a DIFFERENT STRUBS instance and are being ignored: %s',
            foreign.length, foreign.join(', '));

    // ONE MANIFEST CANNOT ANSWER BOTH QUESTIONS, and asking it to was a real bug.
    //
    // `newestManifest()` deliberately prefers a manifest that CARRIES A SNAPSHOT over one that is merely newer
    // -- because a recovery that picks the freshest manifest, finds no snapshot pointer in it, and concludes
    // there is no snapshot has just thrown the namespace away while it sits on the platters. That is the right
    // rule for the snapshot pointer, and the WRONG one for the volume table.
    //
    // A disk that has been out of the rack for a month, carrying an old snapshot pointer, would win under that
    // rule and bring its month-old VOLUME TABLE with it -- rolling back every disk added or changed since. And
    // a volume missing from the restored table is a volume the platter scans never look at, which makes every
    // object living only on it read as data loss. The stale disk quietly deletes the newer half of the array.
    //
    // So reconcile the fields SEPARATELY, each by the rule that actually fits it:
    //   identity      -- by MAJORITY of disks (above); a bare host has no identity to compare against.
    //   volume table  -- by newest updatedAt: the most recent picture of what disks exist.
    //   snapshot      -- by newest snapshot, preferring any manifest that has one at all.
    // NaN LOSES EVERY COMPARISON, which means a manifest with a garbage `updatedAt` does not merely fail to
    // win -- it WINS, permanently, if it happens to be the one the reduce starts with. `finite > NaN` is false,
    // so every genuinely newer table in the rack gets rejected in turn and a stale one-volume table is adopted
    // as the array. Throw the unreadable ones out before the vote rather than let them referee it.
    const dated = ours.map(f => f.manifest).filter(m => Number.isFinite(Date.parse(m.updatedAt)));
    if (!dated.length)
        throw new Error(`every manifest for this array has an unreadable updatedAt, so there is no way to tell which `
            + `volume table is the current one. Adopting the wrong one would drop disks from the fleet, and every `
            + `object living only on those disks would read as data loss.`);

    const table = dated.reduce((best, m) => Date.parse(m.updatedAt) > Date.parse(best.updatedAt) ? m : best);

    // THE SNAPSHOT IS A SEPARATE QUESTION AND GETS A SEPARATE POOL.
    //
    // A manifest with an unreadable `updatedAt` has no business voting on WHICH VOLUME TABLE IS NEWEST -- that
    // is what the date is for, and a garbage one cannot answer it. But it may still be the only disk in the
    // rack carrying a snapshot pointer, and the pointer is ranked by `snapshot.completedAt`, which is a
    // different field entirely and may be perfectly fine.
    //
    // Excluding it from BOTH votes because it failed one of them is how a recovery concludes there is no
    // snapshot -- and rebuilds nothing -- while 127MB of erasure-coded namespace sits on the platters.
    const withSnapshot = newestManifest(ours.map(f => f.manifest));

    const manifest: BootstrapManifest = { ...table, snapshot: withSnapshot?.snapshot ?? table.snapshot ?? null };

    if (withSnapshot && withSnapshot !== table)
        log('the newest volume table and the newest snapshot are on DIFFERENT disks: taking the volume table '
            + 'from the manifest updated %s and the snapshot from the one completed %s',
            table.updatedAt, withSnapshot.snapshot?.completedAt);

    return { manifest, agreeing: ours.length, foreign };
}

// THE BARE-HOST ENTRY POINT: ask the disks who they are, and become that again.
//
// This is what an operator runs on a fresh machine with the drives plugged in and nothing else. It is
// deliberately the ONLY thing that can be run in recovery mode, and it does the minimum that unblocks
// everything else:
//
//   1. Read every disk that will answer (read-only, always).
//   2. Work out which array this actually is -- by majority, because on a bare host there is no identity to
//      compare against, and a single disk from somebody else's array must not be allowed to become us.
//   3. Adopt that identity. NEVER generate one: a fresh identity permanently orphans every drive in the rack.
//   4. Write the volume table back, so the fleet can mount.
//
// Then STRUBS is restarted, the fleet comes up, and the namespace can be rebuilt from the snapshot and the
// journal (which needs mounted disks, and could not have had them until now). Two steps, not one, and
// deliberately so: mounting 30 drives on a host that has just decided who it is deserves a look before the
// next thing starts writing to them.
export type FleetRecoverySummary = {
    identity: string;
    agreeingDisks: number;
    foreignDisks: string[];
    volumesRestored: number;
    journalVolumeIds: number[];
    snapshotObjectId: string | null;

    // Encrypted disks whose keyfile keyslot we put back, so the fleet can unlock unattended again. Empty on a
    // plaintext fleet, and empty when the recovery did not need the passphrase.
    keyfileRestoredOn: string[];
};

export type FleetRecoveryDeps = {
    findManifests: (options?: ScanOptions) => Promise<DiscoveredManifest[]>;
    adoptIdentity: (identity: string) => Promise<void>;
    existingVolumes: () => Promise<unknown[]>;
    writeVolumes: (configs: PersistedVolumeConfig[]) => Promise<void>;
    restoreInterrupted: () => Promise<{ expected: number; startedAt: string } | null>;
    beginRestore: (expected: number) => Promise<void>;
    ensureKeyfileSlot?: (partition: string, passphrase: string) => Promise<'added' | 'already-present'>;
    keyfileReadable?: () => Promise<boolean>;
    assertExactlyOneLuksHeader?: (luksUuid: string) => Promise<void>;
};

export async function recoverFleetFromDisks(
    deps: FleetRecoveryDeps,
    opts: { force?: boolean; recoveryPassphrase?: string } = {}
): Promise<FleetRecoverySummary> {
    const found = await deps.findManifests({ recoveryPassphrase: opts.recoveryPassphrase });
    if (!found.length)
        throw new Error('no bootstrap manifest was found on any disk attached to this host. Either these are not '
            + 'STRUBS disks, or none of them would mount. Nothing has been changed.');

    const { manifest, agreeing, foreign } = reconcileManifests(found, opts.force === true);
    if (!manifest)
        throw new Error('found manifests, but none of them names an instance identity. Nothing has been changed.');

    log('the disks say this is instance %s (%d of them agree)', manifest.instanceIdentity.slice(0, 8), agreeing);

    // Before anything is written: is this actually a recovery?
    assertSafeToRestoreFleet(await deps.existingVolumes(), opts.force === true, await deps.restoreInterrupted());

    const configs = volumeConfigsFromManifest(manifest);

    // THE MARKER GOES UP BEFORE THE FIRST MUTATION, and adopting the identity IS a mutation.
    //
    // It used to be raised inside writeVolumes(), which left a window: crash after the identity is adopted but
    // before the volume table is written, and the next boot has an identity, no marker, and no volume table --
    // which walks past the "no identity" guard AND the "restore incomplete" guard, and brings the fleet up
    // believing in whatever disks Mongo lists. After a wiped database, that is none of them.
    await deps.beginRestore(configs.length);

    // The identity, and it is never generated -- only adopted. A fresh identity would make every disk in the
    // rack unrecognisable to the host they are plugged into, permanently, and there is no undo.
    await deps.adoptIdentity(manifest.instanceIdentity);

    await deps.writeVolumes(configs);

    // RE-ARM UNATTENDED BOOT, or this recovery works exactly once.
    //
    // If we got in here on the PASSPHRASE, the keyfile is gone -- and every encrypted volume in the fleet will
    // now unlock only when a human types it. `Restart=always` has nobody to ask. The array would come back,
    // serve, and then never survive a reboot, which is a trap laid at the end of a recovery.
    //
    // So put the new keyfile back into a keyslot on each encrypted disk while we still hold a passphrase that
    // opens them. Best-effort per disk: a volume whose slot could not be restored is a volume that needs a hand
    // at the next boot, not a reason to fail a recovery that has otherwise worked.
    // ONLY THE DISKS OF THE ARRAY WE JUST ADOPTED.
    //
    // `found` is every disk that gave up a manifest -- including a stranger's, if one is plugged into this host
    // (reconcileManifests names them, which is the whole reason it counts a `foreign` list). Handing all of them
    // to the keyslot restorer would ADD THIS HOST'S KEYFILE TO ANOTHER ARRAY'S DISK, provided the operator's
    // passphrase happened to open it. That is writing to a disk we have just finished establishing is not ours,
    // in the one tool whose entire promise is that it does not touch things it has not identified.
    const ourDisks = found.filter(entry =>
        normalizeIdentity(entry.manifest.instanceIdentity ?? '') === normalizeIdentity(manifest.instanceIdentity));

    const keyfileRestored = await restoreKeyfileSlots(deps, ourDisks, opts.recoveryPassphrase);

    log('restored %d volume(s) from the manifest; restart STRUBS to bring the fleet up', configs.length);

    return {
        identity: manifest.instanceIdentity,
        agreeingDisks: agreeing,
        foreignDisks: foreign,
        volumesRestored: configs.length,
        journalVolumeIds: manifest.journalVolumeIds ?? [],
        snapshotObjectId: manifest.snapshot?.objectId ?? null,
        keyfileRestoredOn: keyfileRestored
    };
}

async function restoreKeyfileSlots(
    deps: FleetRecoveryDeps, found: DiscoveredManifest[], passphrase?: string
): Promise<string[]> {
    if (!passphrase)
        return [];

    const ensure = deps.ensureKeyfileSlot ?? luksEnsureKeyfileSlot;
    const readable = deps.keyfileReadable ?? keyfileReadable;

    if (!await readable()) {
        log.error('the recovery used the passphrase, but there is no keyfile on this host to put back into the '
            + 'disks\' keyslots. Create one (see docs/operations.md) and re-run the recovery, or the encrypted '
            + 'volumes will not unlock unattended and the array will not survive a reboot.');
        return [];
    }

    const assertOne = deps.assertExactlyOneLuksHeader ?? assertExactlyOneLuksHeader;
    const restored: string[] = [];

    for (const entry of found) {
        // A plaintext disk has no keyslot to restore. Only LUKS disks (which carry a container uuid) get here --
        // and we address the header BY THAT UUID, never by entry.device, because a path can point at a different
        // disk by the time we write and this tool's whole promise is that it does not touch what it did not
        // identify.
        if (!entry.luksUuid)
            continue;

        try {
            await assertOne(entry.luksUuid);   // refuse a clone or a vanished header, before we write the keyfile
            const outcome = await ensure(luksHeaderSpecifier(entry.luksUuid), passphrase);
            if (outcome === 'added') {
                restored.push(entry.device);
                log('the keyfile keyslot was restored on %s (LUKS %s)', entry.device, entry.luksUuid);
            }
        }
        catch (err) {
            // Not fatal. The volume still opens with the passphrase; it just will not do so by itself.
            log.error('could not restore the keyfile keyslot on %s: %s. That volume will not unlock unattended.',
                entry.device, err);
        }
    }

    return restored;
}
