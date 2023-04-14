const fs = require('fs').promises;
const _ = require('lodash');

const database = require('../database');
const log = require('../log')('io-manager');
const helpers = require('../helpers');
const ioHelpers = require('./helpers');
const Volume = require('./volume');
const { createError } = require('../helpers');

class IOManager {
    constructor() {
        this._volumes = {};
        this._volumeConfig = null;
        this._onlineDevices = [];
    }

    async init() {
        try {
            log('starting IO manager');

            await this._loadVolumeConfig();
            await this._queryOnlineDevices();
            await this._prepMountRoot();
            await this._initVolumes();
            await this._startVolumes();
            await this._countVolumeGroups();
            await this._logUtilization();
        }

        catch (err) {
            throw createError('IOFAIL', 'failed to init IO manager', err);
        }
    }

    async _loadVolumeConfig() {
        log('loading volume configuration...');
        this._volumeConfig = await database.getVolumes();
        log('loaded volume configuration');
    }

    async _queryOnlineDevices() {
        log('querying online devices...');

        let result;
        try {
            log('fetching block volumes');
            result = await ioHelpers.lsblk(null);
        }
        catch (err) {
            return reject(err);
        }

        const blockDevices = result.blockdevices.filter(blockDevice => blockDevice.type === 'disk');

        let smartPromises = [];
        for (let deviceIndex in blockDevices) {
            let blkDevice = blockDevices[deviceIndex];
            smartPromises.push(this._queryDeviceSMARTInfo(blkDevice));
        }
        await Promise.all(smartPromises);

        let deviceNamesBySerial = {};
        let cachePromises = [];
        for (let deviceIndex in blockDevices) {
            let blkDevice = blockDevices[deviceIndex];

            if (!blkDevice.smartInfo) {
                log('skipping device ' + blkDevice.name + ' with no SMART info');
                continue;
            }

            blkDevice.serial = blkDevice.smartInfo.serial_number;

            if (!blkDevice.serial) {
                log('skipping device ' + blkDevice.name + ' with no serial');
                continue;
            }

            if (deviceNamesBySerial[blkDevice.serial]) {
                log('skipping device ' + blkDevice.name + ' with same serial as device ' + deviceNamesBySerial[blkDevice.serial]);
                continue;
            }

            deviceNamesBySerial[blkDevice.serial] = blkDevice.name;
            cachePromises.push(this._cacheOnlineDevice(blkDevice));
        }

        await Promise.all(cachePromises);

        this._groupOnlineDevices();

        log('queried online devices');
    }

    async _queryDeviceSMARTInfo(blkDevice) {
        let tries = 0;
        while (true) {
            try {
                log('querying SMART info for ' + blkDevice.path);
                blkDevice.smartInfo = await ioHelpers.smartctl('-i', blkDevice.path);
                break;
            }

            catch (err) {
                if (!(err instanceof SyntaxError)) {
                    return log(`failed to fetch SMART info for ${blkDevice.path}:`, err);
                }

                log('error parsing SMART info for ' + blkDevice.path);
                tries++;

                if (tries === 3) {
                    return log(`max tries exceeded for ${blkDevice.path}`);
                }
            }
        }
    }

    async _cacheOnlineDevice(blkDevice) {
        let sysfsPath;
        try {
            sysfsPath = await fs.readlink('/sys/block/' + blkDevice.name)
        }
        catch (err) {
            throw helpers.createErrorWithParams('cannot read sysfs path for device %s, model %s, serial %s:', [ blkDevice.name, blkDevice.model, blkDevice.serial ], err);
        }

        let device = {
            sysfsPath: sysfsPath,
            name: blkDevice.name,
            model: blkDevice.model,
            serial: blkDevice.serial,
            size: Number(blkDevice.size),
            partitions: [],
        };

        for (let childIndex in blkDevice.children) {
            let child = blkDevice.children[childIndex];
            if (child.type != 'part') continue;

            device.partitions.push({
                name: child.name,
                uuid: child.uuid,
                size: Number(child.size),
                fsType: child.fstype,
                mountPoint: child.mountpoint
            });
        }

        this._onlineDevices.push(device);

        // log('cached device %s, model %s, serial %s, size %s, with %d partitions at bus %s', device.name, device.model, device.serial, ioHelpers.formatBytes(device.size), device.partitions.length, device.busAddress);
        log('cached device %s, model %s, serial %s, size %s, with %d partitions', device.name, device.model, device.serial, ioHelpers.formatBytes(device.size), device.partitions.length);
    }

    _groupOnlineDevices() {
        let ungroupedDevices = [];

        let groupCount = 0;

        this._onlineDevices.forEach(device => {
            let path = device.sysfsPath

            if (!/\/(usb|ata)[0-9]+\//.test(path)) {
                device.busGroup = ++groupCount;
                return;
            }

            path = path.replace(/^.*\/usb/, 'usb');
            path = path.replace(/^.*\/ata/, 'ata');
            path = path.replace(/\/[^/]+\/[^/]+\/host[0-9]+\/.*$/, '');

            ungroupedDevices.push({
                device: device,
                path: path.split('/')
            });
        });

        ungroupedDevices.sort((a, b) => {
            return b.path.length - a.path.length;
        });

        for (let index = 0, count = ungroupedDevices.length; index < count; index++) {
            let ungroupedDevice = ungroupedDevices[index];
            if (!ungroupedDevice) continue;

            let searchPath = Object.assign([], ungroupedDevice.path);

            do {
                for (let otherIndex = index + 1; otherIndex < count; otherIndex++) {
                    let otherDevice = ungroupedDevices[otherIndex];
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

        let busGroups = {};
        this._onlineDevices.forEach(device => {
            if (!busGroups[device.busGroup])
                busGroups[device.busGroup] = [];
            busGroups[device.busGroup].push(device.name);
        });

        let busGroupIds = Object.keys(busGroups);
        busGroupIds.sort();

        for (let busGroupId of busGroupIds)
            log('identified device group %s: %s', busGroupId, busGroups[busGroupId].join(', '));
    }

    _prepMountRoot() {
        return new Promise(async (resolve, reject) => {
            log('creating mount root...');

            try {
                await fs.mkdir('/var/run/strubs/mounts');
            }
            catch (err) {
                if (err.code == 'EEXIST') {
                    log('mount root exists');
                    return resolve();
                }

                return reject(err);
            }

            log('mount root created');
            resolve();
        });
    }

    _initVolumes() {
        log('initializing configured volumes...');
        this._volumeConfig.forEach(aVolumeConfig => this._initVolume(aVolumeConfig));
        log('initialized configured disks');
    }

    _initVolume(config) {
        let volume = new Volume(config);
        this._volumes[config.id] = volume;

        if (!volume.isEnabled)
            return log('volume%d: volume is disabled', config.id);

        let theOnlineDevice = _.find(this._onlineDevices, { serial: config.disk_serial });
        if (!theOnlineDevice)
            return log.error('volume%d: device with serial %s was not found', config.id, config.disk_serial);

        let thePartition = _.find(theOnlineDevice.partitions, { uuid: config.partition_uuid });
        if (!thePartition)
            return log.error('volume%d: device with serial %s was found, but the partition with uuid %s could not be found on the device', config.id, config.disk_serial, config.partition_uuid);

        if (thePartition.size != config.partition_size)
            return log.error('volume%d: device with serial %s and partition with uuid %s were found, but the size is %d, and the expected size is %d', config.id, config.disk_serial, config.partition_uuid, thePartition.size, config.partition_size);

        volume.deviceName = theOnlineDevice.name;
        volume.deviceGroup = theOnlineDevice.busGroup;
        volume.fsType = thePartition.fsType;
        volume.blockPath = '/dev/disk/by-uuid/' + thePartition.uuid;
        volume.mountPoint = thePartition.mountPoint;
        volume.isMounted = !!thePartition.mountPoint;

        return volume;
    }

    _startVolumes() {
        return new Promise((resolve, reject) => {
            let volumeCount = 0;
            let startableVolumes = _.filter(this._volumes, volume => {
                volumeCount++;
                return !!volume.blockPath;
            });

            log('%d of %d configured volumes were identified by the system and are available to start', startableVolumes.length, volumeCount);
            log('%d volumes are missing', volumeCount - startableVolumes.length);
            log('starting volumes...');

            let successCount = 0, failureCount = 0;

            let startPromises = startableVolumes.map(volume => {
                return volume.start()
                .then(() => {
                    successCount++;
                })
                .catch(e => {
                    failureCount++;
                });
            });

            Promise.all(startPromises)
            .then(() => {
                log('%d available volumes failed to start', failureCount);
                log('%d available volumes started', successCount);
                resolve();
            });
        });
    }

    _countVolumeGroups() {
        let volumeGroups = [];
        _.each(this._volumes, volume => {
            if (!volumeGroups.includes(volume.deviceGroup))
                volumeGroups.push(volume.deviceGroup);
        });

        this.volumeGroupCount = volumeGroups.length;
    }

    _logUtilization() {
        let volumeCount = 0, startedCount = 0;
        let bytesTotal = 0, bytesUsedData = 0, bytesUsedParity = 0, bytesFree = 0;

        _.each(this._volumes, volume => {
            volumeCount++;
            if (!volume.isStarted)
                return;

            startedCount++;
            bytesTotal += volume.bytesTotal;
            bytesUsedData += volume.bytesUsedData;
            bytesUsedParity += volume.bytesUsedParity;
            bytesFree += volume.bytesFree;
        });

        log('');
        log('*** ARRAY UTILIZATION ***')
        log('Configured Volumes: %d', volumeCount);
        log('Started Volumes:    %d', startedCount);
        log('    Capacity:       %s', ioHelpers.formatBytes(bytesTotal));
        log('    Data Size:      %s', ioHelpers.formatBytes(bytesUsedData));
        log('    Parity Size:    %s', ioHelpers.formatBytes(bytesUsedParity));
        log('    Other:          %s', ioHelpers.formatBytes(bytesTotal - bytesUsedData - bytesUsedParity - bytesFree));
        log('    Free:           %s', ioHelpers.formatBytes(bytesFree));
        log('');
    }

    getVolume(id) {
        return this._volumes[id];
    }

    getWritableVolumes() {
        return _.filter(this._volumes, { isWritable: true });
    }
}

module.exports = new IOManager;


/*
_startDisks() {
    const { v4: uuid } = require('uuid');
    let disks = [];
    let diskIndex = 0;
    for (let index in this._onlineDevices) {
        let device = this._onlineDevices[index];
        if (device.name == 'sda') continue;
        if (device.partitions.length != 1) throw new Error('device ' + device.name + ' has ' + device.partitions.length + ' partitions');
        disks.push({
            id: ++diskIndex,
            uuid: uuid(),
            disk_serial: device.serial,
            partition_uuid: device.partitions[0].uuid,
            partition_size: Number(device.partitions[0].size),
            slice_count: 0,
            data_size: 0,
            free_size: Number(device.partitions[0].size),
            enabled: true,
            healthy: true,
            read_only: false
        });
    }
    database._collections.volumes.insertMany(disks);
}
*/