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

const DEAD_VOLUME_IDS = [32,42];
const REPLACEMENT_VOLUME_IDS = [45,46];
let replacementVols = [];
let lastOpTs = 0;
let lastOp = null;

const database = require('./lib/database');
const server = require('./lib/server/manager');
const IOManager = require('./lib/io/manager');
const Volume = require('./lib/io/volume');

server.init = async function() {
    console.log('REC HALF -- hijacked normal server init');

    const affectedContentCursor = database._collections.content.find({
        dataVolumes: { $in: [45] },
        parityVolumes: { $nin: [46] },
        size: { $mod: [2,0] }
    });

    affectedContentCursor.addCursorFlag('noCursorTimeout', true);

    let objectRecord;
    while (objectRecord = await affectedContentCursor.next()) {
        await migrateContentItem(objectRecord);
    }
};

async function migrateContentItem(objectRecord) {
    objectRecord.id = objectRecord._id.toHexString();
    const impactedIndex = objectRecord.dataVolumes.indexOf(45);

    let srcPath = '/run/strubs/mounts/15c4fd05-22ea-46d0-98f6-735da464af9a/strubs/' + objectRecord.id.substr(0, 2) + '/' + objectRecord.id.substr(2, 2) + '/' + objectRecord.id.substr(4, 2) + '/' + objectRecord.id + '.' + impactedIndex;

    let dstFolder = '/run/strubs/mounts/0568d1a7-1ffa-4b87-9252-eb9fe2e4488d/strubs/' + objectRecord.id.substr(0, 2) + '/' + objectRecord.id.substr(2, 2) + '/' + objectRecord.id.substr(4, 2);
    let dstPath = dstFolder + '/' + objectRecord.id + '.' + impactedIndex;

    try {
        await fsp.mkdir(dstFolder, { recursive: true });
    }
    catch (err) {
        if (err.code != 'EEXIST')
            throw err;
    }

    await fsp.copyFile(srcPath, dstPath);
    await fsp.unlink(srcPath);

    const updatedDataVolIds = [ ...objectRecord.dataVolumes ];
    updatedDataVolIds[impactedIndex] = 46;

    await database._collections.content.updateOne(
        { _id: objectRecord._id },
        {
            $set: {
                dataVolumes: updatedDataVolIds
            }
        }
    );

    process.stdout.write('.');
}

new Core();

// TODO: move any 1 letter folder structures to 2