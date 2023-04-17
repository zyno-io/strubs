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

if (!process.argv[2] || !/^[0-9]+$/.test(process.argv[2])) throw new Error('need old volume ID')
const partitionCount = parseInt(process.argv[2]);
if (!process.argv[3] || !/^[0-9]+$/.test(process.argv[3])) throw new Error('need new volume ID')
const partitionIdx = parseInt(process.argv[3]);

let lastOpTs = Date.now();
let lastOp = null;

server.init = async function() {
    console.log('REASSIGN VOLS');

    const oldVolumeId = process.argv[2];
    const newVolumeId = process.argv[3];

    const oldVolume = IOManager._volumes[oldVolumeId];
    const newVolume = IOManager._volumes[newVolumeId];

    if (!oldVolume) throw new Error('oldVolume not found');
    if (!newVolume) throw new Error('newVolume not found');

    if (!newVolume.isMounted) throw new Error('newVolume is not mounted');

    const aFile = await database._collections.content.findOne({
        isFile: true,
        $or: [
            { dataVolumes: { $in: [oldVolume.id] } },
        ]
    });
    aFile.id = aFile._id.toHexString();

    const oldVolumeIndex = aFile.dataVolumes.indexOf(oldVolume.id);
    const fileName = `${aFile.id}.${oldVolumeIndex}`;

    const fullPath = newVolume.mountPoint + '/strubs/' + fileName.substr(0, 2) + '/' + fileName.substr(2, 2) + '/' + fileName.substr(4, 2) + '/' + fileName;
    if (!fs.existsSync(fullPath)) {
        throw new Error(`${fileName} does not exist on new volume`);
    }

    await database._collections.volumes.updateOne(
        { uuid: oldVolume.uuid },
        {
            $set: {
                archivedId: oldVolume.id,
                archivedLabel: oldVolume.label,
                id: null,
                label: null,
                enabled: false
            }
        }
    );

    await database._collections.volumes.updateOne(
        { uuid: newVolume.uuid },
        {
            $set: {
                originalId: newVolume.id,
                id: oldVolume.id
            }
        }
    );

    newVolume.id = oldVolume.id;
    await newVolume.createIdentityFile();

    console.log('done');
    process.exit(0);
}

new Core();

// TODO: move any 1 letter folder structures to 2