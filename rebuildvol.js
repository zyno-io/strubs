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

if (!process.argv[2] || !/^[0-9]+$/.test(process.argv[2])) throw new Error('need partition count')
const partitionCount = parseInt(process.argv[2]);
if (!process.argv[3] || !/^[0-9]+$/.test(process.argv[3])) throw new Error('need partition index')
const partitionIdx = parseInt(process.argv[3]);

let lastOpTs = Date.now();
let lastOp = null;

server.init = async function() {
    console.log('REBUILD VOLUMES -- hijacked normal server init');

    const volumes = Object.values(IOManager._volumes);

    // TODO: clean up shit that was moved from volume 3
    const unavailableVolumeIds = [33,37]; //volumes.filter(v => !v.isStarted).map(v => v.id);
    const temporarilyUnavailableVolumeIds = [31,43];
    console.log('unavailable volumes:', unavailableVolumeIds);
    console.log('temporarily unavailable volumes:', unavailableVolumeIds);

    const startedVolumes = volumes.filter(v => v.isStarted);

    const affectedContentCursor = database._collections.content.find({
        isFile: true,
        missingSlices: { $exists: false },
        size: { $ne: 0 },
        $or: [
            { dataVolumes: { $in: unavailableVolumeIds } },
            { parityVolumes: { $in: unavailableVolumeIds } }
        ],
        $expr: {
            $eq: [
                {
                    $mod: [
                        { $divide: [ { $toLong: { $toDate: '$_id' } }, 1000 ] },
                        partitionCount
                    ]
                },
                partitionIdx
            ]
        }
    });

    affectedContentCursor.addCursorFlag('noCursorTimeout', true);

    setInterval(checkInactivity, 10000);

    let objectRecord;
    while (objectRecord = await affectedContentCursor.next()) {
        lastOpTs = Date.now();

        const allVolumeIds = [
            ...objectRecord.dataVolumes,
            ...objectRecord.parityVolumes
        ]

        const availableVolumeIds = allVolumeIds.filter(v => !unavailableVolumeIds.includes(v) && !temporarilyUnavailableVolumeIds.includes(v));

        if (availableVolumeIds.length < 4) {
            process.stdout.write('~');
            continue;
        }

        const brokenVolumeIds = allVolumeIds.filter(v => unavailableVolumeIds.includes(v));
        const targetVolumes = startedVolumes.filter(v => !allVolumeIds.includes(v.id)).sort((a, b) => b.bytesFree - a.bytesFree).slice(0, brokenVolumeIds.length);

        objectRecord.id = objectRecord._id.toHexString();
        console.log(`[${new Date().toISOString()}] rebuilding [${objectRecord.id}] from [${brokenVolumeIds.join(',')}] to [${targetVolumes.map(v => v.id).join(',')}]`);

        try {
            await rebuildContentItem(objectRecord, brokenVolumeIds, targetVolumes);
        } catch(e) {
            if (e.code === 'ECHECKSUM') {
                console.error(e);
                await rebuildContentItem(objectRecord, brokenVolumeIds, targetVolumes, e.sliceIndex);
            } else {
                // throw e;
            }
        }
    }
};

function checkInactivity() {
    if (Date.now() - lastOpTs > 300000) {
        console.log(`shit's frozen!`);
        console.log(`last op: ${lastOp}`);
        process.exit(-1);
    }
}

const FileObject = require('./lib/io/file-object');
async function rebuildContentItem(objectRecord, brokenVolumeIds, targetVolumes, additionalBrokenSliceIdx) {
    const object = new FileObject();

    if (additionalBrokenSliceIdx !== undefined) {
        objectRecord.unavailableSlices = [additionalBrokenSliceIdx];
    }

    await object.loadFromRecord(objectRecord);
    await object.prepareForRead();

    const reader = object._reader;

    const writeSliceIdxs = [];

    const sliceVolumeIds = [ ...object.dataSliceVolumeIds, ...object.paritySliceVolumeIds ];
    const adjustedSliceVolumeIds = [ ...sliceVolumeIds ];

    reader._rsTargetsBits = 0;

    sliceVolumeIds.forEach((volumeId, index) => {
        if (brokenVolumeIds.includes(volumeId)) {
            reader._rsTargetsBits |= (1 << index);
            writeSliceIdxs.push(index);
        }
    });

    if (additionalBrokenSliceIdx !== undefined) {
        reader._rsTargetsBits |= (1 << additionalBrokenSliceIdx);
        if (!IOManager._volumes[sliceVolumeIds[additionalBrokenSliceIdx]].isReadOnly) {
            writeSliceIdxs.push(additionalBrokenSliceIdx);
            targetVolumes.push(IOManager._volumes[sliceVolumeIds[additionalBrokenSliceIdx]]);
        }
    }

    for (let index in writeSliceIdxs) {
        const writeSliceIdx = writeSliceIdxs[index];
        adjustedSliceVolumeIds[writeSliceIdx] = targetVolumes[index].id;
        const targetSlice = reader._slices[writeSliceIdx];
        if (targetSlice._mode !== null) throw new Error('slice ' + writeSliceIdx + ' on ' + object.id + ' is mode ' + targetSlice._mode);
        targetSlice._volume = targetVolumes[index];
        await targetSlice.create();
    }

    while (!reader._hasReadSegment) {
        const chunkSize = reader._chunkSetDataSize / reader.dataSliceCount;
        await reader.readChunk();
        lastOp = 'r';

        for (let writeSliceIdx of writeSliceIdxs) {
            const offset = chunkSize * writeSliceIdx;
            const data = reader._chunkSetBuffer.slice(offset, offset + chunkSize);

            const slice = reader._slices[writeSliceIdx];
            await slice.writeChunk(data);
            lastOp = writeSliceIdx;
        }

        process.stdout.write('.');
    }

    process.stdout.write('$');

    for (let writeSliceIdx of writeSliceIdxs) {
        const slice = reader._slices[writeSliceIdx];
        await slice.close();
    }

    process.stdout.write('$');

    await object.close();

    process.stdout.write('$');

    for (let writeSliceIdx of writeSliceIdxs) {
        const slice = reader._slices[writeSliceIdx];
        await slice.commit();
    }

    process.stdout.write('$');

    const dataVolIds = adjustedSliceVolumeIds.slice(0, object.dataSliceCount);
    const parityVolIds = adjustedSliceVolumeIds.slice(object.dataSliceCount);

    await database._collections.content.updateOne(
        { _id: objectRecord._id },
        {
            $set: {
                dataVolumes: dataVolIds,
                parityVolumes: parityVolIds
            }
        }
    );

    process.stdout.write('$\n');
}

new Core();

// TODO: move any 1 letter folder structures to 2