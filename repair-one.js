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
const FileObject = require('./lib/io/file-object');

server.init = async function() {
    console.log('hijacked normal server init');

    const [objectId, sliceIdx] = process.argv[2].split('.');

    const objectRecord = await database.getObjectById(objectId);

    objectRecord.unavailableSlices = [parseInt(sliceIdx)];

    const object = new FileObject();
    await object.loadFromRecord(objectRecord);
    await object.prepareForRead();

    const reader = object._reader;

    const writeSliceIdxs = [...objectRecord.unavailableSlices];
    for (const writeSliceIdx of writeSliceIdxs) {
        const targetSlice = reader._slices[writeSliceIdx];
        if (targetSlice._mode !== null) throw new Error('slice ' + writeSliceIdx + ' on ' + object.id + ' is mode ' + targetSlice._mode);
        await targetSlice.create();
    }

    while (!reader._hasReadSegment) {
        const chunkSize = reader._chunkSetDataSize / reader.dataSliceCount;
        await reader.readChunk();

        for (let writeSliceIdx of writeSliceIdxs) {
            const offset = chunkSize * writeSliceIdx;
            const data = reader._chunkSetBuffer.slice(offset, offset + chunkSize);

            const slice = reader._slices[writeSliceIdx];
            await slice.writeChunk(data);
        }
    }

    for (let writeSliceIdx of writeSliceIdxs) {
        const slice = reader._slices[writeSliceIdx];
        await slice.commit();
    }

    console.log('Finished repairing.');
    process.exit(0);
};

new Core();

// TODO: move any 1 letter folder structures to 2