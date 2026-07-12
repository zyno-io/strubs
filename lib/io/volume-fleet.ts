import _ from 'lodash';

import { database } from '../database';
import { createLogger } from '../log';
import { formatBytes, readProcMounts } from './helpers';
import { Volume, type VolumeConfig, type PersistedVolumeConfig } from './volume';
import type { CachedDevice, CachedPartition } from './device-discovery';

// An edge change detected by a reconcile pass. `missing`: backing disk disappeared. `restored`: an
// absent/unbound volume's disk is back and the volume was brought online. `healed`: a stale mount
// (disk dropped + re-added under a new kernel name) was torn down and remounted on the live node.
export type VolumeTransition = {
    volumeId: number;
    kind: 'missing' | 'restored' | 'healed';
    deviceName: string | null;
};

type VolumeFleetDeps = {
    database: typeof database;
    log: ReturnType<typeof createLogger>;
};

const defaultDeps: VolumeFleetDeps = {
    database,
    log: createLogger('io-manager')
};

export class VolumeFleet {
    private readonly deps: VolumeFleetDeps;
    private _volumeConfig: PersistedVolumeConfig[] = [];
    private _volumes: Record<number, Volume> = {};
    private _lock: Promise<void> = Promise.resolve();

    constructor(deps?: Partial<VolumeFleetDeps>) {
        this.deps = { ...defaultDeps, ...deps };
    }

    async loadConfig(): Promise<void> {
        this.deps.log('loading volume configuration...');
        const volumes = await this.deps.database.getVolumes();
        this._volumeConfig = (volumes || []) as PersistedVolumeConfig[];
        this.deps.log('loaded volume configuration');
    }

    initializeVolumes(devices: CachedDevice[]): void {
        this.deps.log('initializing configured volumes...');
        this._volumeConfig.forEach(config => this.initVolume(config, devices));
        this.deps.log('initialized configured disks');
    }

    private initVolume(config: PersistedVolumeConfig, devices: CachedDevice[]): Volume | undefined {
        const volume = new Volume(config);
        this._volumes[config.id as number] = volume;

        if (!volume.isEnabled) {
            this.deps.log('volume%d: volume is disabled', config.id);
            return undefined;
        }
        if (volume.isDeleted) {
            this.deps.log('volume%d: volume is deleted', config.id);
            return undefined;
        }

        if (!this.bindVolumeDevice(volume, devices))
            return undefined;

        return volume;
    }

    // Find the volume's disk in the latest discovery and bind it (device identity + partition). Returns
    // false (leaving the volume unbound: blockPath null, isPresent false) when the disk is absent or its
    // partition is the wrong size. Separated from initVolume so the reconciler and Enable path can
    // (re)bind an EXISTING volume object in place, preserving its counters/reservations.
    bindVolumeDevice(volume: Volume, devices: CachedDevice[]): boolean {
        const partitionMatch = this.findPartitionByUuid(devices, volume.partitionUuid ?? undefined);
        if (!partitionMatch) {
            this.deps.log.error?.(
                'volume%d: partition with uuid %s was not found on any discovered device',
                volume.id,
                volume.partitionUuid
            );
            return false;
        }

        const { device: onlineDevice, partition } = partitionMatch;
        if (partition.size !== volume.bytesTotal) {
            this.deps.log.error?.(
                'volume%d: partition with uuid %s on device %s has size %d, expected %d',
                volume.id,
                volume.partitionUuid,
                onlineDevice.name,
                partition.size,
                volume.bytesTotal
            );
            return false;
        }

        volume.bindDevice(onlineDevice, partition);
        return true;
    }

    getVolumeByPartitionUuid(partitionUuid: string): Volume | undefined {
        if (!partitionUuid)
            return undefined;
        return Object.values(this._volumes).find(volume => !volume.isDeleted && volume.partitionUuid === partitionUuid);
    }

    getVolumeByDeviceName(deviceName: string): Volume | undefined {
        if (!deviceName)
            return undefined;
        return Object.values(this._volumes).find(volume => !volume.isDeleted && volume.deviceName === deviceName);
    }

    // Serializes device (re)binding/start/stop across the reconciler, Enable, register and drain so two
    // paths never mount/unmount the same fleet concurrently. Mirrors the verify job's volume-lock style.
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
        const previous = this._lock;
        let release!: () => void;
        this._lock = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try {
            return await fn();
        }
        finally {
            release();
        }
    }

    async startVolumes(): Promise<void> {
        let volumeCount = 0;
        const allVolumes = Object.values(this._volumes);
        const startableVolumes = allVolumes.filter(volume => {
            volumeCount++;
            return Boolean(volume.blockPath);
        });

        this.deps.log('%d of %d configured volumes were identified by the system and are available to start', startableVolumes.length, volumeCount);
        this.deps.log('%d volumes are missing', volumeCount - startableVolumes.length);
        this.deps.log('starting volumes...');

        let successCount = 0;
        let failureCount = 0;

        await Promise.all(startableVolumes.map(volume => volume.start()
            .then(() => successCount++)
            .catch(() => failureCount++)
        ));

        this.deps.log('%d available volumes failed to start', failureCount);
        this.deps.log('%d available volumes started', successCount);
    }

    countVolumeGroups(): number {
        const volumeGroups = new Set<number | null>();
        Object.values(this._volumes).forEach(volume => {
            if (volume.deviceGroup !== null)
                volumeGroups.add(volume.deviceGroup);
        });

        return volumeGroups.size;
    }

    logUtilization(): void {
        let volumeCount = 0, startedCount = 0;
        let bytesTotal = 0, bytesUsedData = 0, bytesUsedParity = 0, bytesFree = 0;

        Object.values(this._volumes).forEach(volume => {
            volumeCount++;
            if (!volume.isStarted)
                return;

            startedCount++;
            bytesTotal += volume.bytesTotal;
            bytesUsedData += volume.bytesUsedData;
            bytesUsedParity += volume.bytesUsedParity;
            bytesFree += volume.bytesFree ?? 0;
        });

        this.deps.log('');
        this.deps.log('*** ARRAY UTILIZATION ***')
        this.deps.log('Configured Volumes: %d', volumeCount);
        this.deps.log('Started Volumes:    %d', startedCount);
        this.deps.log('    Capacity:       %s', formatBytes(bytesTotal));
        this.deps.log('    Data Size:      %s', formatBytes(bytesUsedData));
        this.deps.log('    Parity Size:    %s', formatBytes(bytesUsedParity));
        this.deps.log('    Other:          %s', formatBytes(bytesTotal - bytesUsedData - bytesUsedParity - bytesFree));
        this.deps.log('    Free:           %s', formatBytes(bytesFree));
        this.deps.log('');
    }

    getVolume(id: number): Volume | undefined {
        return this._volumes[id];
    }

    getVolumeEntries(): Array<[number, Volume]> {
        return Object.entries(this._volumes).map(([id, volume]) => [Number(id), volume]);
    }

    getWritableVolumes(): Volume[] {
        return Object.values(this._volumes).filter(volume => volume.isWritable && !volume.isDeleted);
    }

    async refreshVolumeStats(): Promise<void> {
        const volumes = Object.values(this._volumes).filter(volume => volume.isStarted);
        await Promise.all(volumes.map(async volume => {
            try {
                await volume.updateFreeBytes();
            }
            catch (err) {
                this.deps.log.error?.('volume%d: failed to refresh stats: %s', volume.id, err);
            }
        }));
    }

    async stopVolumes(): Promise<void> {
        const volumes = Object.values(this._volumes);
        if (!volumes.length)
            return;

        this.deps.log('stopping volumes...');

        let successCount = 0;
        let failureCount = 0;

        await Promise.all(volumes.map(volume => volume.stop()
            .then(() => successCount++)
            .catch(err => {
                failureCount++;
                this.deps.log.error?.('volume%d: failed to stop: %s', volume.id, err);
            })
        ));

        this.deps.log('%d volumes stopped', successCount);
        if (failureCount)
            this.deps.log.error?.('%d volumes failed to stop', failureCount);
    }

    // `initializeIdentity` is set ONLY by the provisioning path -- a freshly-formatted disk that has no
    // identity file yet. Leaving it off (every other caller) means an unidentified disk is refused, not
    // claimed. See Volume.start().
    async registerVolume(config: PersistedVolumeConfig, devices: CachedDevice[], opts: { initializeIdentity?: boolean } = {}): Promise<Volume> {
        return this.withLock(async () => {
            this._volumeConfig.push(config);
            const volume = this.initVolume(config, devices);
            if (!volume)
                throw new Error('failed to initialize volume from configuration');

            await volume.start({ initializeIdentity: opts.initializeIdentity });
            this.deps.log('volume%d: registered and started new volume', volume.id);
            return volume;
        });
    }

    // Serialized against the reconciler so an operator enable/disable never races an automatic
    // remount/markMissing on the same volume. softDeleteVolume (called internally on the isDeleted path)
    // deliberately does NOT take the lock, so this can't self-deadlock.
    async updateVolumeFlags(id: number, changes: { isEnabled?: boolean; isReadOnly?: boolean; isDeleted?: boolean; isHealthy?: boolean; isDraining?: boolean; label?: string | null; comment?: string | null }, devices: CachedDevice[]): Promise<void> {
        return this.withLock(() => this._updateVolumeFlagsLocked(id, changes, devices));
    }

    private async _updateVolumeFlagsLocked(id: number, changes: { isEnabled?: boolean; isReadOnly?: boolean; isDeleted?: boolean; isHealthy?: boolean; isDraining?: boolean; label?: string | null; comment?: string | null }, devices: CachedDevice[]): Promise<void> {
        const config = this._volumeConfig.find(cfg => cfg.id === id);
        if (!config)
            throw new Error('volume configuration not found');

        let volume: Volume | undefined = this._volumes[id];
        let stateChanged = false;

        if (changes.isDraining !== undefined) {
            config.is_draining = changes.isDraining;
            volume?.setDraining(changes.isDraining);
            stateChanged = true;
        }

        if (changes.isDeleted !== undefined) {
            if (changes.isDeleted) {
                await this.softDeleteVolume(id);   // stamps state_updated_at itself
                return;
            }
            config.is_deleted = false;
            volume?.unmarkDeleted();
            stateChanged = true;
        }

        if (changes.isReadOnly !== undefined) {
            config.read_only = changes.isReadOnly;
            volume?.setReadOnly(changes.isReadOnly);
            stateChanged = true;
        }

        if (changes.isHealthy !== undefined) {
            config.healthy = changes.isHealthy;
            volume?.setHealthy(changes.isHealthy);
            stateChanged = true;
        }

        if (changes.label !== undefined) {
            config.label = changes.label ?? null;
            volume?.setLabel(config.label);
        }

        if (changes.comment !== undefined) {
            config.comment = changes.comment ?? null;
            volume?.setComment(config.comment);
        }

        if (changes.isEnabled !== undefined) {
            if (changes.isEnabled) {
                config.enabled = true;
                if (!volume || volume.isDeleted) {
                    volume = this.initVolume(config, devices);
                    if (!volume)
                        throw new Error('failed to initialize volume from configuration');
                    this._volumes[id] = volume;
                }
                else if (!volume.blockPath) {
                    // Existing but unbound: a disk that was absent or still enumerating at boot (e.g. a
                    // slow DAS enclosure) leaves an unbound Volume object. Enabling refreshes the device
                    // list, so re-bind in place rather than starting with a null blockPath (which throws
                    // "mount path not configured"). Rebinding in place preserves the object's counters.
                    if (!this.bindVolumeDevice(volume, devices))
                        throw new Error(`volume ${id}: backing disk is not present; cannot enable`);
                }
                if (!volume.isStarted) {
                    await volume.start();
                }
                volume.setEnabled(true);
            }
            else {
                config.enabled = false;
                if (volume && volume.isStarted)
                    await volume.stop().catch(() => undefined);
                volume?.setEnabled(false);
            }
            stateChanged = true;
        }

        if (stateChanged) {
            const now = new Date();
            config.state_updated_at = now;
            volume?.setStateUpdatedAt(now);
        }
    }

    async softDeleteVolume(id: number): Promise<void> {
        const volume = this._volumes[id];
        if (!volume)
            return;
        await volume.stop().catch(() => undefined);
        volume.markDeleted();
        const now = new Date();
        volume.setStateUpdatedAt(now);
        const config = this._volumeConfig.find(cfg => cfg.id === id);
        if (config) {
            config.enabled = false;
            (config as PersistedVolumeConfig).is_deleted = true;
            (config as PersistedVolumeConfig).state_updated_at = now;
        }
        this.deps.log('volume%d: marked as deleted', id);
    }

    // One reconciliation pass against a fresh device snapshot. Detects disks that appeared, disappeared,
    // or are backing a now-stale mount (dropped + re-added under a new kernel name), and repairs each in
    // place. Returns the edge transitions so the caller can notify / wake repair. Runs under the fleet
    // lock so it never races Enable/register/drain. Operator intent is respected: disabled, deleted and
    // draining volumes are left untouched.
    async reconcile(devices: CachedDevice[], options?: { autoRecover?: boolean }): Promise<VolumeTransition[]> {
        // autoRecover=false (maintenance freeze) still detects and marks pulled disks missing, but holds
        // the remount/restart of returned disks so it doesn't fight an operator swapping drives.
        const autoRecover = options?.autoRecover !== false;
        return this.withLock(async () => {
            const transitions: VolumeTransition[] = [];
            const presentUuids = new Set<string>();
            for (const device of devices)
                for (const partition of device.partitions)
                    if (partition.uuid)
                        presentUuids.add(partition.uuid);

            const mounts = await readProcMounts();

            for (const volume of Object.values(this._volumes)) {
                if (volume.isDeleted || !volume.isEnabled || volume.isDraining)
                    continue;

                const present = volume.partitionUuid ? presentUuids.has(volume.partitionUuid) : false;

                if (!present) {
                    // Transition to absent: only act on the edge so we don't re-notify every pass.
                    if (volume.isPresent || volume.isStarted) {
                        const deviceName = volume.deviceName;
                        await volume.markMissing();
                        transitions.push({ volumeId: volume.id, kind: 'missing', deviceName });
                    }
                    continue;
                }

                const stale = this.isMountStale(volume, devices, mounts);
                if (volume.isStarted && volume.isPresent && volume.blockPath && !stale)
                    continue; // healthy and bound — nothing to do

                if (!autoRecover)
                    continue; // frozen: hold remount/restart of returned/stale disks

                try {
                    // Stale mount (backing device vanished/renamed): tear the dead mount down first so
                    // the rebind mounts the live node rather than stacking over the EIO'd one.
                    if (stale)
                        await volume.markMissing();
                    if (!volume.blockPath || !volume.isPresent) {
                        if (!this.bindVolumeDevice(volume, devices))
                            continue; // wrong size / not matchable — leave unbound, try again next pass
                    }
                    if (!volume.isStarted)
                        await volume.start();
                    transitions.push({ volumeId: volume.id, kind: stale ? 'healed' : 'restored', deviceName: volume.deviceName });
                }
                catch (err) {
                    this.deps.log.error?.('volume%d: reconcile failed to bring volume online: %s', volume.id, err instanceof Error ? err.message : String(err));
                }
            }

            return transitions;
        });
    }

    // A volume we believe is mounted whose /run/strubs mount is missing from the kernel table, or is
    // backed by a device that no longer holds this volume's partition (the vol-57 drop-and-rename case).
    private isMountStale(volume: Volume, devices: CachedDevice[], mounts: Map<string, string>): boolean {
        if (!volume.isMounted || !volume.mountPoint)
            return false;
        const source = mounts.get(volume.mountPoint);
        if (!source)
            return true;
        const match = this.findPartitionByUuid(devices, volume.partitionUuid ?? undefined);
        const livePath = match ? (match.partition.path ?? `/dev/${match.partition.name}`) : null;
        return source !== livePath;
    }

    private findPartitionByUuid(devices: CachedDevice[], partitionUuid?: string): { device: CachedDevice; partition: CachedPartition } | undefined {
        if (!partitionUuid)
            return undefined;

        for (const device of devices) {
            const partition = _.find(device.partitions, { uuid: partitionUuid });
            if (partition)
                return { device, partition };
        }

        return undefined;
    }
}

export const volumeFleet = new VolumeFleet();
