import { randomUUID } from 'crypto';

import { database } from '../database';
import { ioManager } from './manager';
import { HttpBadRequestError } from '../server/http/errors';
import { getDeviceIdentityKey, listRawBlockDevices, type RawBlockDevice, type RawBlockDeviceChild } from './device-discovery';
import { spawnHelper } from '../helpers/spawn';
import type { VolumeConfig, PersistedVolumeConfig } from './volume';

type DeviceProvisionerDeps = {
    listRawBlockDevices: typeof listRawBlockDevices;
    database: typeof database;
    ioManager: typeof ioManager;
    spawnHelper: typeof spawnHelper;
    sleepSecs: (seconds: number) => Promise<void>;
};

const defaultDeps: DeviceProvisionerDeps = {
    listRawBlockDevices,
    database,
    ioManager,
    spawnHelper,
    sleepSecs: (seconds: number) => new Promise(resolve => setTimeout(resolve, seconds * 1000))
};

export type ProvisionOptions = {
    blockPath: string;
    wipe?: boolean;
    replace?: boolean;
};

export class DeviceProvisioner {
    constructor(private readonly deps: DeviceProvisionerDeps = defaultDeps) {}

    async provision(options: ProvisionOptions): Promise<PersistedVolumeConfig> {
        const { blockPath, wipe, replace } = options;
        this.validateWipeOption(wipe);

        let devices = await this.deps.listRawBlockDevices();
        let targetDevice = this.findDeviceByPath(devices, blockPath);
        if (!targetDevice)
            throw new HttpBadRequestError('block device not found');

        if (wipe === true) {
            if (this.deviceHasMountedPartitions(targetDevice))
                throw new HttpBadRequestError('block device has mounted partitions');
            await this.wipeDevice(blockPath);
            await this.deps.sleepSecs(1);
            devices = await this.deps.listRawBlockDevices();
            targetDevice = this.findDeviceByPath(devices, blockPath);
            if (!targetDevice)
                throw new HttpBadRequestError('block device not found after wipe');
        }

        if (targetDevice.children?.length)
            throw new HttpBadRequestError('block device already partitioned');
        if (!targetDevice.serial)
            throw new HttpBadRequestError('block device serial unavailable');

        const replacedVolumeId = await this.ensureDeviceNotRegistered(targetDevice, devices, replace);

        await this.partitionDevice(blockPath, !wipe);
        await this.deps.sleepSecs(1);

        let partitionInfo = await this.waitForPartition(blockPath);
        const partitionPath = this.resolvePartitionPath(partitionInfo.partition);

        await this.formatPartition(partitionPath);
        await this.deps.sleepSecs(2);

        partitionInfo = await this.waitForPartition(blockPath);
        const finalDevice = partitionInfo.device;
        const partition = partitionInfo.partition;
        if (!partition.uuid)
            throw new HttpBadRequestError('partition UUID unavailable');

        if (replacedVolumeId)
            await this.deps.database.deleteVolume(replacedVolumeId);

        const volumeConfig = await this.createVolumeConfig(finalDevice, partition, replacedVolumeId);
        await this.deps.database.createVolume(volumeConfig);
        await this.deps.ioManager.registerVolume(volumeConfig);
        return volumeConfig;
    }

    private findDeviceByPath(devices: RawBlockDevice[], blockPath: string): RawBlockDevice | undefined {
        return devices.find(device => device.path === blockPath);
    }

    private deviceHasMountedPartitions(device: RawBlockDevice): boolean {
        return Boolean(device.children?.some(child => {
            const mountPoint = child.mountpoint;
            return typeof mountPoint === 'string' && mountPoint.length > 0;
        }));
    }

    private validateWipeOption(wipe?: boolean): void {
        if (wipe === undefined || typeof wipe === 'boolean')
            return;
        throw new HttpBadRequestError('wipe must be a boolean');
    }

    private async ensureDeviceNotRegistered(targetDevice: RawBlockDevice, devices: RawBlockDevice[], replace?: boolean): Promise<number | undefined> {
        const { identityKeys, serials, volumeIdByIdentity, volumeIdBySerial } = await this.getRegisteredIdentities(devices);
        if (targetDevice.serial && serials.has(targetDevice.serial)) {
            if (!replace)
                throw new HttpBadRequestError('device already registered');
            return volumeIdBySerial.get(targetDevice.serial);
        }
        const identityKey = getDeviceIdentityKey(targetDevice);
        if (identityKey && identityKeys.has(identityKey)) {
            if (!replace)
                throw new HttpBadRequestError('device already registered');
            return volumeIdByIdentity.get(identityKey);
        }
        return undefined;
    }

    private async getRegisteredIdentities(devices: RawBlockDevice[]): Promise<{ identityKeys: Set<string>; serials: Set<string>; volumeIdByIdentity: Map<string, number>; volumeIdBySerial: Map<string, number> }> {
        const identityKeys = new Set<string>();
        const serials = new Set<string>();
        const volumeIdByIdentity = new Map<string, number>();
        const volumeIdBySerial = new Map<string, number>();
        for (const [volumeId, volume] of this.deps.ioManager.getVolumeEntries()) {
            if (volume.deviceSerial) {
                serials.add(volume.deviceSerial);
                volumeIdBySerial.set(volume.deviceSerial, volumeId);
            }
            const partitionUuid = volume.partitionUuid;
            if (!partitionUuid)
                continue;
            const device = devices.find(dev => dev.children?.some(child => child.uuid === partitionUuid));
            if (!device)
                continue;
            const identityKey = getDeviceIdentityKey(device);
            if (identityKey) {
                identityKeys.add(identityKey);
                volumeIdByIdentity.set(identityKey, volumeId);
            }
        }
        return { identityKeys, serials, volumeIdByIdentity, volumeIdBySerial };
    }

    private async wipeDevice(blockPath: string): Promise<void> {
        await this.runCommand('parted', ['-s', blockPath, 'mklabel', 'gpt'], 'failed to wipe partition table');
    }

    private async partitionDevice(blockPath: string, shouldCreateLabel: boolean): Promise<void> {
        if (shouldCreateLabel)
            await this.runCommand('parted', ['-s', blockPath, 'mklabel', 'gpt'], 'failed to create partition table');
        await this.runCommand('parted', ['-s', blockPath, 'mkpart', 'primary', 'ext4', '0%', '100%'], 'failed to create partition');
        await this.deps.spawnHelper('partprobe', [blockPath]).catch(() => undefined);
    }

    private async formatPartition(partitionPath: string): Promise<void> {
        await this.runCommand('mkfs.ext4', ['-F', partitionPath], 'failed to format partition');
    }

    private resolvePartitionPath(partition: RawBlockDeviceChild): string {
        return `/dev/${partition.name}`;
    }

    private async waitForPartition(blockPath: string, attempts = 20, delayMs = 500): Promise<{ device: RawBlockDevice; partition: RawBlockDeviceChild }> {
        for (let attempt = 0; attempt < attempts; attempt++) {
            const devices = await this.deps.listRawBlockDevices();
            const device = this.findDeviceByPath(devices, blockPath);
            const partition = device?.children?.[0];
            if (device && partition)
                return { device, partition };
            await this.deps.sleepSecs(delayMs / 1000);
        }
        throw new HttpBadRequestError('partition creation timed out');
    }

    private async createVolumeConfig(device: RawBlockDevice, partition: RawBlockDeviceChild, replaceVolumeId?: number): Promise<PersistedVolumeConfig> {
        const existing = await this.deps.database.getVolumes();
        const nextId = replaceVolumeId ?? this.getNextVolumeId(existing);
        if (!device.serial)
            throw new HttpBadRequestError('device serial unavailable');
        if (!partition.uuid)
            throw new HttpBadRequestError('partition UUID unavailable');
        return {
            id: nextId,
            uuid: randomUUID(),
            enabled: true,
            healthy: true,
            read_only: false,
            disk_serial: device.serial,
            partition_uuid: partition.uuid,
            partition_size: Number(partition.size),
            data_size: 0,
            parity_size: 0,
            is_deleted: false
        };
    }

    private getNextVolumeId(existing: Array<{ id?: number }>): number {
        const maxId = existing.reduce((max, volume) => typeof volume.id === 'number' ? Math.max(max, volume.id) : max, 0);
        return maxId + 1;
    }

    private async runCommand(command: string, args: string[], context: string): Promise<void> {
        const { code, stdout } = await this.deps.spawnHelper(command, args);
        if (code !== 0)
            throw new HttpBadRequestError(`${context}: ${stdout || 'command failed'}`);
    }
}

export const deviceProvisioner = new DeviceProvisioner();
