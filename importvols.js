const fs = require('fs');
const fsp = fs.promises;

global.constants = require('./lib/constants');

const Core = require('./lib/core');
const log = require('./lib/log')('bootstrap');

process.on('uncaughtException', err => {
    log.error('!! an uncaught exception has occurred', err);
    log.error('terminating');
    process.exit(-2);
});

process.on('unhandledRejection', err => {
    log.error('!! an uncaught promise rejection has occurred', err);
    log.error('terminating');
    process.exit(-2);
});

////////////////////////////////////////////////////////////////////////////////////////////////

const database = require('./lib/database');
const server = require('./lib/server/manager');
const IOManager = require('./lib/io/manager');
const { v4: uuid } = require('uuid');

server.init = async function() {
    console.log('IMPORT VOLS');

    const volumes = Object.values(IOManager._volumes);
    let maxVolumeId = Math.max(...volumes.map(v => v.id));

    const partitions = IOManager._onlineDevices.flatMap(d => d.partitions);

    const requestedInitVolumeNames = process.argv.slice(2);
    console.log('requested volumes', requestedInitVolumeNames);

    const initVolumeNames = requestedInitVolumeNames.filter(name => {
        const partition = partitions.find(p => p.name === name);
        if (!partition) return false;
        const partitionUuid = partition.uuid;
        if (IOManager._volumeConfig.some(c => c.partition_uuid === partitionUuid)) return false;
        return true;
    });

    console.log('adding volumes', initVolumeNames);

    for (const initVolumeName of initVolumeNames) {
        const device = IOManager._onlineDevices.find(d => d.partitions.some(p => p.name === initVolumeName));
        const partition = device.partitions.find(p => p.name === initVolumeName);

        const volumeConfig = {
            id: ++maxVolumeId,
            uuid: uuid(),
            disk_serial: device.serial,
            partition_uuid: partition.uuid,
            partition_size: Number(partition.size),
            slice_count: 0,
            data_size: 0,
            free_size: Number(partition.size),
            enabled: true,
            healthy: true,
            read_only: false
        }
        await database._collections.volumes.insertOne(volumeConfig);

        IOManager._volumeConfig.push(volumeConfig);

        const volume = await IOManager._initVolume(volumeConfig);
        await volume.start();

        volumes.push(volume);

        console.log('added volume', volumeConfig);
    }
};

new Core();
