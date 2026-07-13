import { promises as fsp } from 'fs';

import { config } from '../config';
import { createLogger } from '../log';
import { database } from '../database';
import type { PersistedVolumeConfig } from './volume';

const log = createLogger('bootstrap-manifest');

export const MANIFEST_FILENAME = '.bootstrap.json';
export const MANIFEST_VERSION = 1;

// A snapshot pointer. Populated by the snapshot job (D); null until then.
export type ManifestSnapshotRef = {
    objectId: string;
    md5: string;
    startedAt: string;
    completedAt: string;
    objects: number;
};

// Everything Volume/VolumeFleet needs to actually MOUNT this volume again on a bare host -- not merely
// enough to name it. partitionSize is mandatory: binding rejects a partition whose discovered size
// differs from bytesTotal, so a manifest without it produces a fleet that knows its volumes exist and
// refuses to mount every one of them.
export type ManifestVolume = {
    id: number;
    uuid: string;
    partitionUuid: string | null;
    partitionSize: number;
    dataSize: number;
    paritySize: number;
    enabled: boolean;
    healthy: boolean;
    readOnly: boolean;
    isDeleted: boolean;
    isDraining: boolean;
    diskSerial: string | null;
    label: string | null;
};

export type BootstrapManifest = {
    version: number;
    instanceIdentity: string;
    geometry: { dataSlices: number; paritySlices: number };
    volumes: ManifestVolume[];
    journalVolumeIds: number[];
    snapshot: ManifestSnapshotRef | null;
    previousSnapshot: ManifestSnapshotRef | null;
    updatedAt: string;
};

export type BootstrapManifestDeps = {
    getVolumeConfigs: () => Promise<PersistedVolumeConfig[]>;
    // Mount points we may WRITE a manifest to. A read-only or draining disk keeps whatever copy it had --
    // that's fine, recovery takes the newest updatedAt across all disks.
    getWritableTargets: () => Array<{ id: number; mountPoint: string }>;
    // Mount points we may READ a manifest from. Deliberately WIDER than the write set: a read-only,
    // draining or degraded disk is a perfectly good place to read the truth FROM, and it may be the only
    // one -- or the newest one -- still carrying it. Reading from the write set only would let a restart
    // come up believing there is no snapshot, and then write that belief to every disk in the array.
    getReadableTargets: () => Array<{ id: number; mountPoint: string }>;
};

const defaultDeps: BootstrapManifestDeps = {
    getVolumeConfigs: () => database.getVolumes(),
    // Lazily resolved: ioManager hooks the manifest writer on every fleet change, so importing it at
    // module scope here would close an initialisation cycle. Deferring to call time breaks it.
    getReadableTargets: () => {
        const { ioManager } = require('./manager') as typeof import('./manager');
        return ioManager.getVolumeEntries()
            .map(([, volume]) => volume)
            .filter(volume => volume.isMounted && volume.mountPoint)
            .map(volume => ({ id: volume.id, mountPoint: volume.mountPoint as string }));
    },
    getWritableTargets: () => {
        const { ioManager } = require('./manager') as typeof import('./manager');
        return ioManager.getVolumeEntries()
            .map(([, volume]) => volume)
            .filter(volume => volume.isWritable && volume.mountPoint)
            .map(volume => ({ id: volume.id, mountPoint: volume.mountPoint as string }));
    }
};

function toManifestVolume(cfg: PersistedVolumeConfig): ManifestVolume {
    return {
        id: cfg.id,
        uuid: cfg.uuid,
        partitionUuid: cfg.partition_uuid ?? null,
        partitionSize: cfg.partition_size,
        dataSize: cfg.data_size ?? 0,
        paritySize: cfg.parity_size ?? 0,
        enabled: cfg.enabled === true,
        healthy: cfg.healthy === true,
        readOnly: cfg.read_only === true,
        isDeleted: cfg.is_deleted === true,
        isDraining: cfg.is_draining === true,
        diskSerial: cfg.disk_serial ?? null,
        label: typeof cfg.label === 'string' ? cfg.label : null
    };
}

export class BootstrapManifestWriter {
    private readonly deps: BootstrapManifestDeps;
    // Coalesce bursts of fleet changes into one write pass.
    private pending: Promise<void> | null = null;
    private queued = false;
    // The follow-up pass triggered by a request that arrived while `pending` was in flight. Callers who
    // were coalesced await THIS, not `pending`, so they wait for a pass that saw their change.
    private trailing: Promise<void> | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    // Carried across writes; set by the snapshot job (D) and the journal (C).
    private snapshot: ManifestSnapshotRef | null = null;
    private previousSnapshot: ManifestSnapshotRef | null = null;
    private journalVolumeIds: number[] = [];

    constructor(deps: Partial<BootstrapManifestDeps> = {}) {
        this.deps = { ...defaultDeps, ...deps };
    }

    // Periodic backstop. Event hooks cover the operator-driven fleet changes, but a manifest that silently
    // stopped refreshing is exactly the failure you discover during a recovery -- so re-write on a timer
    // regardless, and let any hook we forgot be self-healing.
    startPeriodic(intervalMs: number): void {
        if (this.timer || intervalMs <= 0)
            return;
        this.timer = setInterval(() => { void this.write().catch(() => undefined); }, intervalMs);
        this.timer.unref?.();
    }

    stopPeriodic(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    setJournalVolumeIds(ids: number[]): void {
        this.journalVolumeIds = [...ids];
    }

    setSnapshots(snapshot: ManifestSnapshotRef | null, previousSnapshot: ManifestSnapshotRef | null): void {
        this.snapshot = snapshot;
        this.previousSnapshot = previousSnapshot;
    }

    getSnapshot(): ManifestSnapshotRef | null {
        return this.snapshot;
    }

    getPreviousSnapshot(): ManifestSnapshotRef | null {
        return this.previousSnapshot;
    }

    // Read the snapshot pointer back off the platters at startup.
    //
    // WITHOUT THIS, A RESTART DESTROYS IT. The pointer lives in memory here, and every periodic manifest
    // refresh writes whatever is in memory out to all 29 disks -- so a process that came up not knowing
    // about the snapshot would, within a minute, cheerfully overwrite every manifest in the array with
    // `snapshot: null`. The 127MB of erasure-coded namespace would still be sitting there, perfectly
    // intact, and nothing on any disk would know its name. A recovery would find nothing and never suspect
    // there was anything to find.
    //
    // The manifests are written to every writable volume, so any one of them will do -- and the NEWEST one
    // wins, because a volume that has been offline for a week is carrying a week-old idea of the truth.
    async hydrateFromDisk(): Promise<void> {
        // The newest manifest THAT ACTUALLY NAMES A SNAPSHOT -- not merely the newest manifest.
        //
        // A manifest with `snapshot: null` is not evidence that there is no snapshot. It is evidence that
        // whatever wrote it did not know about one: a volume that came back from a spell offline, a manifest
        // written before this feature existed, a disk that missed the publish. Letting one of those win
        // because it happens to be the newest would hydrate nothing -- and the next refresh, moments later,
        // would write that nothing to every disk in the array and orphan a perfectly good snapshot.
        //
        // We are looking for the most recent thing that KNOWS something, not the most recent thing.
        const newest = await this.newestManifestOnDisk({ withSnapshot: true });

        if (!newest?.snapshot) {
            log('no snapshot pointer found on any volume');
            return;
        }

        this.snapshot = newest.snapshot;
        // The FALLBACK is validated on the same terms as the pointer it backs up. It is about to be
        // broadcast to every disk in the array, and a fallback that is a shape rather than a snapshot is a
        // fallback that will fail you at exactly the moment you reach for it.
        this.previousSnapshot = isUsableSnapshotRef(newest.previousSnapshot) ? newest.previousSnapshot : null;
        log('recovered the snapshot pointer from the platters: object %s (%d objects, taken %s)',
            newest.snapshot.objectId, newest.snapshot.objects, newest.snapshot.completedAt);
    }

    // The newest manifest that this array is willing to believe.
    //
    // Read from every MOUNTED disk, not just the writable ones -- a read-only or draining volume is a
    // perfectly good place to read the truth from, and may be the only one still carrying it.
    //
    // And VALIDATED, because this is about to be written back to all 29 disks. A manifest with someone
    // else's instanceIdentity is somebody else's array, and adopting its snapshot pointer would have us
    // hand a recovery an object id that does not exist here. A manifest with an unparseable updatedAt is
    // not "very new", it is broken -- and a plain string comparison would happily let it beat every real
    // one. Anything we cannot vouch for does not get a vote.
    async newestManifestOnDisk(opts: { withSnapshot?: boolean } = {}): Promise<BootstrapManifest | null> {
        let newest: BootstrapManifest | null = null;
        let newestAt = -Infinity;

        for (const target of this.deps.getReadableTargets()) {
            let manifest: BootstrapManifest;
            try {
                manifest = JSON.parse(await fsp.readFile(`${target.mountPoint}/strubs/${MANIFEST_FILENAME}`, 'utf8'));
            }
            catch {
                continue;                   // absent, unreadable or unparseable: the next disk may be better
            }

            if (config.identity && manifest.instanceIdentity !== config.identity) {
                log.error('volume%d carries a bootstrap manifest for a DIFFERENT STRUBS instance (%s): ignoring it',
                    target.id, String(manifest.instanceIdentity).slice(0, 8));
                continue;
            }

            const at = Date.parse(manifest.updatedAt);
            if (!Number.isFinite(at)) {
                log.error('volume%d carries a bootstrap manifest with an unusable updatedAt (%s): ignoring it',
                    target.id, manifest.updatedAt);
                continue;
            }

            if (opts.withSnapshot && !isUsableSnapshotRef(manifest.snapshot))
                continue;                   // knows nothing usable about a snapshot: no say in whether one exists

            // RANK BY WHAT WE ARE ACTUALLY ASKING ABOUT.
            //
            // When the question is "which snapshot is newest", the manifest's own updatedAt is the wrong
            // key -- every routine refresh bumps it, so a manifest carrying an OLD pointer but touched five
            // minutes ago outranks one carrying the NEW pointer that has not been rewritten since. Get a
            // volume rejoining the fleet into that mix and the older pointer wins on freshness alone, is
            // broadcast everywhere, and the newer snapshot is orphaned -- and because the rebroadcast keeps
            // giving it a fresher updatedAt, it goes on winning forever.
            //
            // The snapshot's own completedAt is the only thing that says which namespace is more recent.
            const rank = opts.withSnapshot ? Date.parse(manifest.snapshot!.completedAt) : at;
            if (rank > newestAt) {
                newestAt = rank;
                newest = manifest;
            }
        }

        return newest;
    }

    async build(now = new Date()): Promise<BootstrapManifest | null> {
        // Without an identity there is nothing worth writing -- and the identity IS the critical field.
        if (!config.identity) {
            log.error('refusing to write a bootstrap manifest with no instance identity');
            return null;
        }
        const configs = await this.deps.getVolumeConfigs();
        return {
            version: MANIFEST_VERSION,
            instanceIdentity: config.identity,
            geometry: { dataSlices: config.dataSliceCount, paritySlices: config.paritySliceCount },
            volumes: (configs ?? []).map(toManifestVolume).sort((a, b) => a.id - b.id),
            journalVolumeIds: [...this.journalVolumeIds],
            snapshot: this.snapshot,
            previousSnapshot: this.previousSnapshot,
            updatedAt: now.toISOString()
        };
    }

    // Refresh the manifest on every writable volume. Coalesced: a burst of fleet changes collapses into
    // one pass plus at most one follow-up.
    //
    // The returned promise resolves only once a pass that STARTED AFTER this call has finished -- so
    // awaiting it means "the manifest now reflects my change". Returning the in-flight promise instead
    // would be a lie: that pass may have read the fleet state before the caller's mutation landed. The
    // snapshot rotation (D) flips the manifest's snapshot pointer and must not proceed on that lie.
    async write(): Promise<void> {
        if (this.pending) {
            this.queued = true;
            // Chain onto the CURRENT pass, then await the follow-up it will trigger, so the caller waits
            // for a pass that definitely saw its change.
            return this.pending.then(() => this.trailing ?? Promise.resolve(), () => this.trailing ?? Promise.resolve());
        }
        this.pending = this._writeOnce()
            .finally(() => {
                this.pending = null;
                if (this.queued) {
                    this.queued = false;
                    this.trailing = this.write().catch(() => undefined) as Promise<void>;
                }
                else {
                    this.trailing = null;
                }
            });
        return this.pending;
    }

    private async _writeOnce(): Promise<void> {
        let manifest: BootstrapManifest | null;
        try {
            manifest = await this.build();
        }
        catch (err) {
            log.error('failed to build bootstrap manifest', err);
            return;
        }
        if (!manifest)
            return;

        let targets: Array<{ id: number; mountPoint: string }>;
        try {
            targets = this.deps.getWritableTargets();
        }
        catch (err) {
            // Enumerating targets must not escape as an unhandled rejection -- callers fire this
            // and forget, so anything thrown here would surface as a process-level crash.
            log.error('failed to enumerate writable volumes for the bootstrap manifest', err);
            return;
        }
        if (!targets.length) {
            // Every disk read-only/draining/absent: manifests stop refreshing. Not fatal (recovery takes
            // the newest copy it can find) but worth saying out loud.
            log.error('no writable volumes: bootstrap manifests are NOT being refreshed');
            return;
        }

        const body = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
        let written = 0;
        for (const target of targets) {
            try {
                await writeManifestAtomically(target.mountPoint, body);
                written++;
            }
            catch (err) {
                // One bad disk must not stop the others -- and must never fail volume start.
                log.error('volume%d: failed to write bootstrap manifest: %s', target.id, err);
            }
        }
        log('wrote bootstrap manifest to %d/%d writable volumes', written, targets.length);
    }

    // Read the manifests back OFF THE PLATTERS and count how many actually name this snapshot.
    //
    // write() is fire-and-forget by design -- a manifest refresh must never fail volume start, so it
    // swallows a per-volume failure and returns cheerfully even if every single one of them failed. That is
    // right for a periodic refresh and completely wrong for "the snapshot pointer is published", which is a
    // claim about what is ON THE DISKS. A claim about the disks that nothing checked is a hope. So we go and
    // look.
    async countManifestsNaming(snapshotObjectId: string): Promise<number> {
        let found = 0;
        for (const target of this.deps.getWritableTargets()) {
            try {
                const raw = await fsp.readFile(`${target.mountPoint}/strubs/${MANIFEST_FILENAME}`, 'utf8');
                if ((JSON.parse(raw) as BootstrapManifest).snapshot?.objectId === snapshotObjectId)
                    found++;
            }
            catch {
                // Unreadable or absent: it does not name the snapshot, which is all we are counting.
            }
        }
        return found;
    }
}

// Is this actually a snapshot pointer, or just an object shaped vaguely like one?
//
// Whatever wins the "newest manifest" contest is about to be loaded into memory and then BROADCAST to every
// disk in the array. So a manifest carrying `snapshot: {}`, or an objectId that is not an object id, must not
// be allowed to win merely by having the newest timestamp -- it would replace a real pointer with a shape.
// A pointer we cannot use is not better than no pointer; it is worse, because it looks like one.
function isUsableSnapshotRef(ref: ManifestSnapshotRef | null | undefined): ref is ManifestSnapshotRef {
    return !!ref
        && typeof ref.objectId === 'string'
        && /^[0-9a-f]{24}$/i.test(ref.objectId)          // a real STRUBS object id, which is what a recovery scans for
        && Number.isFinite(Date.parse(ref.completedAt))
        && typeof ref.objects === 'number';
}

// Atomic: write a temp file, fsync it, rename over the target, then fsync the directory so the rename
// itself is durable. A torn manifest is worse than a stale one -- recovery would have nothing to parse.
export async function writeManifestAtomically(mountPoint: string, body: Buffer): Promise<void> {
    const dir = `${mountPoint}/strubs`;
    const finalPath = `${dir}/${MANIFEST_FILENAME}`;
    const tmpPath = `${finalPath}.tmp`;

    await fsp.mkdir(dir, { recursive: true });

    try {
        const fh = await fsp.open(tmpPath, 'w');
        try {
            await fh.writeFile(body);
            await fh.sync();
        }
        finally {
            await fh.close();
        }
        await fsp.rename(tmpPath, finalPath);
    }
    catch (err) {
        // Don't leave a half-written .bootstrap.json.tmp lying next to the real manifest -- a recovery
        // operator poking at these files at 3am should not find two, one of them truncated.
        await fsp.unlink(tmpPath).catch(() => undefined);
        throw err;
    }

    // fsync the directory so the rename survives a power cut.
    const dirFh = await fsp.open(dir, 'r');
    try {
        await dirFh.sync();
    }
    catch {
        // Some filesystems refuse to fsync a directory handle; the rename is still atomic.
    }
    finally {
        await dirFh.close();
    }
}

// Read and validate a manifest from a mounted volume. Returns null if absent or unparseable -- a corrupt
// manifest on one disk must not stop recovery from reading a good one off another.
export async function readManifest(mountPoint: string): Promise<BootstrapManifest | null> {
    let raw: string;
    try {
        raw = await fsp.readFile(`${mountPoint}/strubs/${MANIFEST_FILENAME}`, 'utf8');
    }
    catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
            log.error('failed to read bootstrap manifest at %s: %s', mountPoint, err);
        return null;
    }
    try {
        const parsed = JSON.parse(raw) as BootstrapManifest;
        if (typeof parsed?.instanceIdentity !== 'string' || !Array.isArray(parsed?.volumes)) {
            log.error('bootstrap manifest at %s is malformed', mountPoint);
            return null;
        }
        return parsed;
    }
    catch (err) {
        log.error('bootstrap manifest at %s is not valid JSON: %s', mountPoint, err);
        return null;
    }
}

// Recovery takes the NEWEST manifest across all disks -- copies briefly disagree, and that's by design.
export function newestManifest(manifests: BootstrapManifest[]): BootstrapManifest | null {
    // THE ONE THAT KNOWS THE MOST, not merely the one touched most recently.
    //
    // This is the helper a RECOVERY reaches for, on a bare host, with nothing but disks. If it hands back a
    // manifest that happens to have the freshest updatedAt but no snapshot pointer in it -- a volume that
    // came back from a spell offline, a disk that missed the last publish -- then the recovery concludes
    // there is no snapshot and rebuilds nothing, while 127MB of erasure-coded namespace sits on the platters
    // a metre away. So a manifest carrying a usable snapshot always beats one that does not, and only then
    // do we ask which is newer.
    const usable = manifests.filter(m => m && isUsableSnapshotRef(m.snapshot));
    const pool = usable.length ? usable : manifests.filter(Boolean);

    let best: BootstrapManifest | null = null;
    for (const m of pool) {
        if (!best) { best = m; continue; }
        // Among manifests that name a snapshot, the newest SNAPSHOT wins -- not the most recently rewritten
        // manifest, which every routine refresh would otherwise make the winner.
        const rank = usable.length
            ? Date.parse(m.snapshot!.completedAt) - Date.parse(best.snapshot!.completedAt)
            : Date.parse(m.updatedAt) - Date.parse(best.updatedAt);
        if (rank > 0) best = m;
    }
    return best;
}

export const bootstrapManifestWriter = new BootstrapManifestWriter();
