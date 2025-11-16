import { promises as fs } from 'fs';
import path from 'path';
import _ from 'lodash';

import { createLogger } from '../log';
import { createError, createErrorWithParams } from '../helpers';
import { formatBytes, lsblk } from './helpers';
import { smartInfoService, type SmartInfoService } from './smart-info';

export type RawBlockDeviceChild = {
    type: string;
    name: string;
    path?: string;
    uuid?: string;
    size: string | number;
    fstype?: string;
    mountpoint?: string | null;
};

export type RawBlockDevice = {
    name: string;
    path: string;
    type: string;
    size: string | number;
    model?: string;
    vendor?: string;
    serial?: string;
    ptuuid?: string;
    pttype?: string;
    smartInfo?: { serial_number?: string };
    children?: RawBlockDeviceChild[];
    [key: string]: unknown;
};

export interface CachedPartition {
    name: string;
    path?: string;
    uuid?: string;
    size: number;
    fsType?: string;
    mountPoint?: string | null;
}

export interface CachedDevice {
    sysfsPath: string;
    name: string;
    model?: string;
    vendor?: string;
    serial?: string;
    byIdPaths: string[];
    partitionTableUuid?: string | null;
    partitionTableType?: string | null;
    size: number;
    partitions: CachedPartition[];
    smartInfo?: { serial_number?: string };
    busGroup?: number;
}

type DeviceDiscoveryDeps = {
    lsblk: typeof lsblk;
    smartInfoService: SmartInfoService;
    readlink: typeof fs.readlink;
    createLogger: typeof createLogger;
};

const defaultDeps: DeviceDiscoveryDeps = {
    lsblk,
    smartInfoService,
    readlink: fs.readlink,
    createLogger
};

export function getDeviceIdentityKey(device: RawBlockDevice): string | null {
    if (!device.serial || !device.pttype || !device.ptuuid)
        return null;
    return `${device.serial}:${device.pttype}:${device.ptuuid}`;
}

export class DeviceDiscovery {
    private readonly deps: DeviceDiscoveryDeps;
    private readonly log: ReturnType<typeof createLogger>;

    constructor(deps?: Partial<DeviceDiscoveryDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('device-discovery');
    }

    async discover(): Promise<CachedDevice[]> {
        this.log('querying online devices...');

        const blockDevices = await this.fetchBlockDevices();
        await this.populateSmartInfo(blockDevices);

        const cachedDevices = await this.cacheDevices(blockDevices);
        this.groupDevices(cachedDevices);

        this.log('queried online devices');
        return cachedDevices;
    }

    private async fetchBlockDevices(): Promise<RawBlockDevice[]> {
        try {
            this.log('fetching block volumes');
            const blockDevices = await listRawBlockDevices();
            return blockDevices;
        }
        catch (err) {
            throw createError('IOFAIL', 'failed to fetch block volumes', err as Error);
        }
    }

    private async populateSmartInfo(devices: RawBlockDevice[]): Promise<void> {
        for (const device of devices) {
            await this.queryDeviceSMARTInfo(device);
        }
    }

    private async queryDeviceSMARTInfo(blkDevice: RawBlockDevice): Promise<void> {
        blkDevice.smartInfo = await this.deps.smartInfoService.fetch(blkDevice.path) ?? undefined;
    }

    private async cacheDevices(blockDevices: RawBlockDevice[]): Promise<CachedDevice[]> {
        const cached: CachedDevice[] = [];
        const devicesByIdentity: Record<string, string> = {};
        const byIdIndex = await this.buildByIdIndex();

        for (const blkDevice of blockDevices) {
            if (!blkDevice.smartInfo) {
                this.log('skipping device ' + blkDevice.name + ' with no SMART info');
                continue;
            }

            const serial = blkDevice.smartInfo.serial_number;
            blkDevice.serial = serial;

            const identityKey = getDeviceIdentityKey(blkDevice);
            if (identityKey) {
                if (devicesByIdentity[identityKey]) {
                    this.log('skipping device %s with duplicate identity (serial %s, PT %s/%s) matching %s',
                        blkDevice.name,
                        blkDevice.serial ?? 'unknown',
                        blkDevice.pttype ?? 'unknown',
                        blkDevice.ptuuid ?? 'unknown',
                        devicesByIdentity[identityKey]
                    );
                    continue;
                }

                devicesByIdentity[identityKey] = blkDevice.name;
            }

            const cachedDevice = await this.cacheOnlineDevice(blkDevice, byIdIndex[blkDevice.name] ?? []);
            cached.push(cachedDevice);
        }

        return cached;
    }


    private async cacheOnlineDevice(blkDevice: RawBlockDevice, byIdPaths: string[]): Promise<CachedDevice> {
        let sysfsPath: string;
        try {
            sysfsPath = await this.deps.readlink('/sys/block/' + blkDevice.name)
        }
        catch (err) {
            throw createErrorWithParams(
                'IOFAIL',
                'cannot read sysfs path for device %s, model %s, serial %s:',
                [ blkDevice.name, blkDevice.model, blkDevice.serial ],
                err as Error
            );
        }

        const device: CachedDevice = {
            sysfsPath,
            name: blkDevice.name,
            model: blkDevice.model,
            vendor: blkDevice.vendor,
            serial: blkDevice.serial,
            byIdPaths,
            partitionTableUuid: blkDevice.ptuuid ?? null,
            partitionTableType: blkDevice.pttype ?? null,
            size: Number(blkDevice.size),
            partitions: [],
            smartInfo: blkDevice.smartInfo
        };

        for (const child of blkDevice.children ?? []) {
            if (child.type !== 'part') continue;

            device.partitions.push({
                name: child.name,
                path: child.path,
                uuid: child.uuid,
                size: Number(child.size),
                fsType: child.fstype,
                mountPoint: child.mountpoint
            });
        }

        const byIdDisplay = device.byIdPaths[0] ?? 'n/a';
        const ptType = device.partitionTableType ?? 'n/a';
        const ptUuid = device.partitionTableUuid ?? 'n/a';

        this.log(
            'cached device %s, model %s, serial %s, size %s, by-id %s, PT %s/%s, with %d partitions',
            device.name,
            device.model,
            device.serial,
            formatBytes(device.size),
            byIdDisplay,
            ptType,
            ptUuid,
            device.partitions.length
        );

        return device;
    }

    private async buildByIdIndex(): Promise<Record<string, string[]>> {
        try {
            const entries = await fs.readdir('/dev/disk/by-id');
            const index: Record<string, string[]> = {};

            await Promise.all(entries.map(async entry => {
                const linkPath = path.join('/dev/disk/by-id', entry);
                try {
                    const target = await this.deps.readlink(linkPath);
                    const resolved = path.resolve('/dev/disk/by-id', target);
                    const deviceName = path.basename(resolved);
                    if (!deviceName)
                        return;
                    if (!index[deviceName])
                        index[deviceName] = [];
                    index[deviceName].push(linkPath);
                }
                catch {
                    // best-effort lookup; ignore broken links
                }
            }));

            return index;
        }
        catch (err) {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code !== 'ENOENT')
                this.log('failed to enumerate /dev/disk/by-id entries: %s', nodeErr.message);
            return {};
        }
    }

    private groupDevices(devices: CachedDevice[]): void {
        const ungroupedDevices: Array<{ device: CachedDevice; path: string[] } | null> = [];

        let groupCount = 0;

        devices.forEach(device => {
            let path = device.sysfsPath;

            if (!/\/(usb|ata)[0-9]+\//.test(path)) {
                device.busGroup = ++groupCount;
                return;
            }

            path = path.replace(/^.*\/usb/, 'usb');
            path = path.replace(/^.*\/ata/, 'ata');
            path = path.replace(/\/[^/]+\/[^/]+\/host[0-9]+\/.*$/, '');

            ungroupedDevices.push({
                device,
                path: path.split('/')
            });
        });

        ungroupedDevices.sort((a, b) => {
            if (!a || !b) return 0;
            return b.path.length - a.path.length;
        });

        for (let index = 0, count = ungroupedDevices.length; index < count; index++) {
            const ungroupedDevice = ungroupedDevices[index];
            if (!ungroupedDevice) continue;

            let searchPath = [ ...ungroupedDevice.path ];

            do {
                for (let otherIndex = index + 1; otherIndex < count; otherIndex++) {
                    const otherDevice = ungroupedDevices[otherIndex];
                    if (!otherDevice) continue;

                    if (otherDevice.path.length < searchPath.length) continue;
                    if (otherDevice.path.slice(0, searchPath.length).join('/') !== searchPath.join('/')) continue;

                    if (!ungroupedDevice.device.busGroup)
                        ungroupedDevice.device.busGroup = ++groupCount;

                    otherDevice.device.busGroup = ungroupedDevice.device.busGroup;
                    ungroupedDevices[otherIndex] = null;
                }

                if (ungroupedDevice.device.busGroup) {
                    ungroupedDevices[index] = null;
                    break;
                }

                searchPath.pop();
            } while (searchPath.length);

            if (!ungroupedDevice.device.busGroup)
                ungroupedDevice.device.busGroup = ++groupCount;
        }

        const busGroups: Record<number, string[]> = {};
        devices.forEach(device => {
            const busGroupId = device.busGroup;
            if (busGroupId === null || busGroupId === undefined)
                return;
            if (!busGroups[busGroupId])
                busGroups[busGroupId] = [];
            busGroups[busGroupId].push(device.name);
        });

        const busGroupIds = Object.keys(busGroups).map(id => Number(id));
        busGroupIds.sort();

        for (const busGroupId of busGroupIds)
            this.log('identified device group %s: %s', busGroupId, busGroups[busGroupId]?.join(', '));
    }
}

export const deviceDiscovery = new DeviceDiscovery();

export async function listRawBlockDevices(): Promise<RawBlockDevice[]> {
    try {
        const result = await lsblk() as { blockdevices: RawBlockDevice[] };
        return (result.blockdevices || [])
            .filter(device => device.type === 'disk')
            .map(device => sanitizeRawBlockDevice(device));
    }
    catch (err) {
        throw createError('IOFAIL', 'failed to fetch block volumes', err as Error);
    }
}

function sanitizeRawBlockDevice(device: any): RawBlockDevice {
    const children = (device.children || [])
        .filter((child: any) => child?.type === 'part')
        .map((child: any): RawBlockDeviceChild => ({
            type: child.type,
            name: child.name,
            path: child.path ?? (child.name ? `/dev/${child.name}` : undefined),
            uuid: child.uuid,
            size: Number(child.size),
            fstype: child.fstype,
            mountpoint: child.mountpoint ?? null
        }));

    return {
        name: device.name,
        path: device.path,
        type: device.type,
        size: Number(device.size),
        model: device.model?.trim(),
        vendor: device.vendor?.trim(),
        serial: device.serial,
        ptuuid: device.ptuuid,
        pttype: device.pttype,
        smartInfo: device.smartInfo,
        children
    };
}
