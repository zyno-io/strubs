import _ from 'lodash';

import { database } from '../database';
import { createLogger } from '../log';
import { formatBytes } from './helpers';
import { Volume, type VolumeConfig, type PersistedVolumeConfig } from './volume';
import type { CachedDevice, CachedPartition } from './device-discovery';

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

        const partitionMatch = this.findPartitionByUuid(devices, config.partition_uuid);
        if (!partitionMatch) {
            this.deps.log.error?.(
                'volume%d: partition with uuid %s was not found on any discovered device',
                config.id,
                config.partition_uuid
            );
            return undefined;
        }

        const { device: onlineDevice, partition } = partitionMatch;
        if (!partition) {
            this.deps.log.error?.(
                'volume%d: partition with uuid %s could not be found on the discovered device',
                config.id,
                config.partition_uuid
            );
            return undefined;
        }

        if (partition.size !== config.partition_size) {
            this.deps.log.error?.(
                'volume%d: partition with uuid %s on device %s has size %d, expected %d',
                config.id,
                config.partition_uuid,
                onlineDevice.name,
                partition.size,
                config.partition_size
            );
            return undefined;
        }

        volume.deviceSerial = onlineDevice.serial ?? null;
        volume.deviceModel = onlineDevice.model ?? null;
        volume.deviceVendor = onlineDevice.vendor ?? null;
        volume.deviceName = onlineDevice.name;
        volume.deviceGroup = onlineDevice.busGroup ?? null;
        volume.fsType = partition.fsType ?? null;
        volume.blockPath = partition.path ?? `/dev/${partition.name}`;
        volume.mountPoint = partition.mountPoint || null;
        volume.isMounted = !!partition.mountPoint;

        return volume;
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

    async registerVolume(config: PersistedVolumeConfig, devices: CachedDevice[]): Promise<Volume> {
        this._volumeConfig.push(config);
        const volume = this.initVolume(config, devices);
        if (!volume)
            throw new Error('failed to initialize volume from configuration');

        await volume.start();
        this.deps.log('volume%d: registered and started new volume', volume.id);
        return volume;
    }

    async updateVolumeFlags(id: number, changes: { isEnabled?: boolean; isReadOnly?: boolean; isDeleted?: boolean; isHealthy?: boolean; label?: string | null }, devices: CachedDevice[]): Promise<void> {
        const config = this._volumeConfig.find(cfg => cfg.id === id);
        if (!config)
            throw new Error('volume configuration not found');

        let volume: Volume | undefined = this._volumes[id];

        if (changes.isDeleted !== undefined) {
            if (changes.isDeleted) {
                await this.softDeleteVolume(id);
                return;
            }
            config.is_deleted = false;
            volume?.unmarkDeleted();
        }

        if (changes.isReadOnly !== undefined) {
            config.read_only = changes.isReadOnly;
            volume?.setReadOnly(changes.isReadOnly);
        }

        if (changes.isHealthy !== undefined) {
            config.healthy = changes.isHealthy;
            volume?.setHealthy(changes.isHealthy);
        }

        if (changes.label !== undefined) {
            config.label = changes.label ?? null;
            volume?.setLabel(config.label);
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
        }
    }

    async softDeleteVolume(id: number): Promise<void> {
        const volume = this._volumes[id];
        if (!volume)
            return;
        await volume.stop().catch(() => undefined);
        volume.markDeleted();
        const config = this._volumeConfig.find(cfg => cfg.id === id);
        if (config) {
            config.enabled = false;
            (config as PersistedVolumeConfig).is_deleted = true;
        }
        this.deps.log('volume%d: marked as deleted', id);
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
