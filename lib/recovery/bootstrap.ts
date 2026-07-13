import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';

import { createLogger } from '../log';
import { spawnHelper } from '../helpers/spawn';
import { newestManifest, type BootstrapManifest } from '../io/bootstrap-manifest';
import { listRawBlockDevices } from '../io/device-discovery';
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
    manifest: BootstrapManifest;
};

// Mount each candidate partition read-only, read its manifest, unmount. Returns everything found, so the
// caller can see disagreement rather than have it resolved for them behind their back.
export async function findManifestsOnDevices(): Promise<DiscoveredManifest[]> {
    const devices = await listRawBlockDevices();
    const found: DiscoveredManifest[] = [];
    const silent: string[] = [];

    for (const device of devices) {
        for (const child of device.children ?? []) {
            if (child.type !== 'part') continue;

            // We only ever mkfs ext. A foreign filesystem is not ours, and trying to mount one is how a
            // recovery tool starts touching things it should not.
            if (!child.fstype?.startsWith('ext')) continue;

            const partition = child.path ?? `/dev/${child.name}`;
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

    // Attached to the result so the caller can weigh the vote against the disks that did NOT answer, rather
    // than against only the ones that did.
    (found as DiscoveredManifest[] & { silent?: string[] }).silent = silent;
    return found;
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
        await spawnHelper('mount', ['-o', 'ro,noload', partition, mountPoint]);
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
};

export type FleetRecoveryDeps = {
    findManifests: () => Promise<DiscoveredManifest[]>;
    adoptIdentity: (identity: string) => Promise<void>;
    existingVolumes: () => Promise<unknown[]>;
    writeVolumes: (configs: PersistedVolumeConfig[]) => Promise<void>;
    restoreInterrupted: () => Promise<{ expected: number; startedAt: string } | null>;
    beginRestore: (expected: number) => Promise<void>;
};

export async function recoverFleetFromDisks(
    deps: FleetRecoveryDeps,
    opts: { force?: boolean } = {}
): Promise<FleetRecoverySummary> {
    const found = await deps.findManifests();
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

    log('restored %d volume(s) from the manifest; restart STRUBS to bring the fleet up', configs.length);

    return {
        identity: manifest.instanceIdentity,
        agreeingDisks: agreeing,
        foreignDisks: foreign,
        volumesRestored: configs.length,
        journalVolumeIds: manifest.journalVolumeIds ?? [],
        snapshotObjectId: manifest.snapshot?.objectId ?? null
    };
}
