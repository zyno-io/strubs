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
    console.log('hijacked normal server init');

    for (let index in REPLACEMENT_VOLUME_IDS) {
        const replacementVolId = REPLACEMENT_VOLUME_IDS[index];
        const volume = IOManager.getVolume(replacementVolId);
        volume.isReadOnly = false;

        // await volume.createIdentityFile();

        replacementVols[index] = volume;
    }

    const affectedContentCursor = database._collections.content.find({
        isFile: true,
        missingSlices: { $exists: false },
        size: { $ne: 0 },
        $or: [
            { dataVolumes: { $in: DEAD_VOLUME_IDS } },
            { parityVolumes: { $in: DEAD_VOLUME_IDS } }
        ]
    });

    affectedContentCursor.addCursorFlag('noCursorTimeout', true);

    setInterval(checkInactivity, 10000);

    let objectRecord;
    while (objectRecord = await affectedContentCursor.next()) {
        lastOpTs = Date.now();
        await repairContentItem(objectRecord);
    }
};

function checkInactivity() {
    if (Date.now() - lastOpTs > 120000) {
        console.log(`shit's frozen!`);
        console.log(`last op: ${lastOp}`);
        process.exit(-1);
    }
}

const FileObject = require('./lib/io/file-object');
async function repairContentItem(objectRecord) {
    // console.log(objectRecord);
    // process.exit(-1);

    objectRecord.id = objectRecord._id.toHexString();

    const object = new FileObject();
    await object.loadFromRecord(objectRecord);
    await object.prepareForRead();

    const reader = object._reader;

    if (!reader._mustReconstructData) {
        reader._mustReconstructData = true;
        reader._rsSourcesBits = 0;
        for (let index = 0; index < reader.dataSliceCount; index++)
            reader._rsSourcesBits |= (1 << index);
    }

    const writeSliceIdxs = [];

    const sliceVolumeIds = [ ...object.dataSliceVolumeIds, ...object.paritySliceVolumeIds ];
    const adjustedSliceVolumeIds = [ ...sliceVolumeIds ];

    reader._rsTargetsBits = 0;

    sliceVolumeIds.forEach((volumeId, index) => {
        if (DEAD_VOLUME_IDS.includes(volumeId)) {
            reader._rsTargetsBits |= (1 << index);
            writeSliceIdxs.push(index);
        }
    });

    for (let index in writeSliceIdxs) {
        const writeSliceIdx = writeSliceIdxs[index];
        const originalOffset = DEAD_VOLUME_IDS.indexOf(sliceVolumeIds[writeSliceIdx]);
        adjustedSliceVolumeIds[writeSliceIdx] = replacementVols[originalOffset].id;
        const targetSlice = reader._slices[writeSliceIdx];
        if (targetSlice._mode !== null) throw new Error('slice ' + writeSliceIdx + ' on ' + object.id + ' is mode ' + targetSlice._mode);
        targetSlice._volume = replacementVols[originalOffset];
        await targetSlice.create();
    }

    console.log(sliceVolumeIds, adjustedSliceVolumeIds);

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

    process.stdout.write('$');

    console.log('repair complete');
}

new Core();

// TODO: move any 1 letter folder structures to 2