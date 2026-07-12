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
};

const defaultDeps: BootstrapManifestDeps = {
    getVolumeConfigs: () => database.getVolumes(),
    // Lazily resolved: ioManager hooks the manifest writer on every fleet change, so importing it at
    // module scope here would close an initialisation cycle. Deferring to call time breaks it.
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
    let best: BootstrapManifest | null = null;
    for (const m of manifests) {
        if (!m) continue;
        if (!best || Date.parse(m.updatedAt) > Date.parse(best.updatedAt))
            best = m;
    }
    return best;
}

export const bootstrapManifestWriter = new BootstrapManifestWriter();
