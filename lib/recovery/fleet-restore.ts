import { createLogger } from '../log';
import type { BootstrapManifest, ManifestVolume } from '../io/bootstrap-manifest';
import type { PersistedVolumeConfig } from '../io/volume';

const log = createLogger('fleet-restore');

// THE CHICKEN AND THE EGG.
//
// The fleet cannot mount a single disk without the volume table, and the volume table lived in Mongo. So on
// a bare host, with 30 drives sitting there full of data, STRUBS could not even open them -- not because the
// data was gone, but because it had forgotten what it owned.
//
// That is the entire reason the bootstrap manifest is written to EVERY disk rather than kept in one place:
// so that any surviving drive can tell you about all the others. Recovering the fleet is not a clever
// algorithm, it is simply the act of reading it back.
//
// Deleted volumes are restored too, and it matters. A recovery that quietly dropped them would produce a
// fleet that believes disks it has never heard of are foreign -- and the wipe guard would then be looking at
// a drive full of STRUBS slices with no record of it, which is the one situation where "I don't recognise
// this, it must be blank" costs you 3TB.
export function volumeConfigsFromManifest(manifest: BootstrapManifest): PersistedVolumeConfig[] {
    return manifest.volumes.map((v: ManifestVolume) => ({
        id: v.id,
        uuid: v.uuid,
        enabled: v.enabled,
        healthy: v.healthy,
        read_only: v.readOnly,
        disk_serial: v.diskSerial ?? '',
        partition_uuid: v.partitionUuid ?? '',
        // MANDATORY, and the manifest is written to refuse to exist without it: binding rejects a partition
        // whose discovered size does not match, so a volume restored without it comes back as one the fleet
        // knows about and will not mount -- which is worse than not knowing about it at all.
        partition_size: v.partitionSize,
        data_size: v.dataSize,
        parity_size: v.paritySize,
        label: v.label ?? null,
        is_deleted: v.isDeleted,
        is_draining: v.isDraining
    }));
}

// What a recovery is about to do, said out loud before it does it.
//
// Restoring the fleet writes the volume table into an empty database. If the database is NOT empty, we are
// not recovering -- we are overwriting a live array's idea of its own disks with one from a manifest that
// may be older than it is. That is not a recovery, that is an accident, and it is refused.
export function assertSafeToRestoreFleet(
    existing: unknown[],
    force: boolean,
    // An interrupted restore left its marker behind. Those volume documents are not a live fleet's opinion of
    // itself -- they are the debris of this very operation, half-finished, and refusing to overwrite them would
    // leave the array permanently stuck: unable to resume, and unable to start, because the table has holes in
    // it. A resume is the ONLY case where writing over an existing table is the safe thing to do.
    interrupted: { expected: number; startedAt: string } | null = null
): void {
    if (interrupted) {
        log('a previous fleet restore (started %s, %d volume[s]) did not finish. Resuming it: the volume table in '
            + 'the database is the wreckage of that attempt, not a live fleet.', interrupted.startedAt, interrupted.expected);
        return;
    }

    if (!existing.length || force) return;

    throw new Error(`refusing to restore the volume table: the database already knows about ${existing.length} `
        + `volume(s). Restoring over a live fleet would replace what the array currently believes about its own `
        + `disks with whatever a manifest happened to say. If you are certain -- and you should be very certain -- `
        + `this needs to be forced explicitly.`);
}

export function summariseManifest(manifest: BootstrapManifest): string {
    const live = manifest.volumes.filter(v => !v.isDeleted).length;
    return `identity ${manifest.instanceIdentity.slice(0, 8)}…, geometry ${manifest.geometry.dataSlices}+`
        + `${manifest.geometry.paritySlices}, ${live} live volume(s) of ${manifest.volumes.length}, journal on `
        + `[${manifest.journalVolumeIds.join(', ')}], snapshot ${manifest.snapshot?.objectId ?? 'NONE'}`;
}
