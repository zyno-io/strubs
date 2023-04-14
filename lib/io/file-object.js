// TODO: make sure data is actually flushed to disk on _finish

const { Duplex } = require('stream');

const database = require('../database');
const Log = require('../log');

const ioHelpers = require('./helpers');
const planner = require('./planner');

const FileObjectWriter = require('./file-object/writer');
const FileObjectReader = require('./file-object/reader');
const FileObjectDestroyer = require('./file-object/destroyer');

const MODE_WRITE = 1;
const MODE_READ = 2;

class FileObject extends Duplex {
    constructor() {
        super();

        this.id = null;
        this.idBuf = null;
        this.containerId = null;
        this.name = null;
        this.size = null;
        this.mime = null;
        this.md5 = null;
        this.chunkSize = null;
        this.dataSliceCount = null;
        this.dataSliceVolumeIds = null;
        this.paritySliceCount = null;
        this.paritySliceVolumeIds = null;
        this.unavailableSliceIdxs = null;

        this._mode = null;
        this._writer = null;
        this._reader = null;

        this._isPersisted = false;
        this._lockPromises = [];
        this._isAwaitingData = false;
        this._shouldTransmitEOR = false;
    }

    async createWithSize(size) {
        // generate an ID and store the size
        this.idBuf = ioHelpers.generateObjectId();
        this.id = this.idBuf.toString('hex');
        this.size = size;

        // chunk size, data & parity slice count, target volumes
        let plan = await planner.generatePlan(size);

        // copy over to object
        this.chunkSize = plan.chunkSize;
        this.dataSliceCount = plan.dataSliceCount;
        this.dataSliceVolumeIds = plan.dataVolumes;
        this.paritySliceCount = plan.paritySliceCount;
        this.paritySliceVolumeIds = plan.parityVolumes;

        // logging
        this.log(
            // TODO: add inflated size
            'preparing to store %d byte object inflated to ??? bytes, stored in %d byte chunks; data on volumes %s; parity on volumes %s',
            this.size,
            this.chunkSize,
            this.dataSliceVolumeIds.join(', '),
            this.paritySliceVolumeIds.join(', ')
        );

        // create a writer
        this._writer = new FileObjectWriter(this);

        // create slices
        try {
            await this._writer.prepare();
        }
        catch (err) {
            this.log.error('failed to create slices:', err);
            await this._writer.abort();
            throw new Error('failed to create file object');
        }

        // note that we are now configured and can accept data
        this._mode = MODE_WRITE;

        // logging
        this.log('ready to store');
    }

    async commit() {
        if (this._mode != MODE_WRITE)
            return callback(new Error('file object is not in a writable state'));

        await this._writer.commit();

        let dbObject = {
            id: this.id,
            containerId: this.containerId,
            isFile: true,
            name: this.name,
            size: this.size,
            md5: this.md5,
            mime: this.mime,
            chunkSize: this.chunkSize,
            dataVolumes: this.dataSliceVolumeIds,
            parityVolumes: this.paritySliceVolumeIds
        };

        if (!dbObject.mime)
            delete dbObject.mime;

        await database.createObjectRecord(dbObject);

        this._isPersisted = true;
        this._mode = null;

        this.log('committed');
    }

    async loadFromRecord(record) {
        this._isPersisted = true;

        // copy all the data from the record to the local object
        this.id = record.id;
        this.idBuf = Buffer.from(this.id, 'hex');
        this.size = record.size;
        this.containerId = record.containerId || null;
        this.name = record.name;
        this.size = record.size;
        this.md5 = record.md5;
        this.mime = record.mime || null;
        this.chunkSize = record.chunkSize;
        this.dataSliceVolumeIds = record.dataVolumes;
        this.dataSliceCount = this.dataSliceVolumeIds.length;
        this.paritySliceVolumeIds = record.parityVolumes;
        this.paritySliceCount = this.paritySliceVolumeIds.length;
        this.unavailableSliceIdxs = record.unavailableSlices;

        // logging
        this.log(
            // TODO: add inflated size
            'loaded %d byte object inflated to ??? bytes, stored in %d byte chunks; data on volumes %s; parity on volumes %s',
            this.size,
            this.chunkSize,
            this.dataSliceVolumeIds.join(', '),
            this.paritySliceVolumeIds.join(', ')
        );
    }

    async prepareForRead() {
        // create a reader
        this._reader = new FileObjectReader(this);

        // open slices
        try {
            await this._reader.prepare();
        }
        catch (err) {
            this.log.error('failed to open slices:', err);
            throw new Error('failed to open file object');
        }

        // note that we are now configured and can deliver data
        this._mode = MODE_READ;

        // logging
        this.log('ready to read');
    }

    setReadRange(start, end, shouldTransmitEOR) {
        if (this._mode != MODE_READ)
            return callback(new Error('file object is not in a readable state'));
        this._reader.setReadRange(start, end);
        this._shouldTransmitEOR = shouldTransmitEOR === true;
        this._isAwaitingData && this._read();
    }

    async delete() {
        this.log('deleting object');

        if (this._mode == MODE_WRITE) {
            await this._writer.abort();
        }
        else {
            let destroyer = new FileObjectDestroyer(this);
            await destroyer.destroy();
        }

        if (this._isPersisted) {
            await database.deleteObjectById(this.id);
        }

        this._mode = null;
        this._isPersisted = false;

        this.log('deleted object');
    }

    async _write(data, encoding, callback) {
        if (this._mode != MODE_WRITE)
            return callback(new Error('file object is not in a writable state'));

        try {
            await this._writer.write(data);
        }
        catch (err) {
            return callback(err);
        }

        callback();
    }

    async _final(callback) {
        if (this._mode != MODE_WRITE)
            return callback(new Error('file object is not in a writable state'));

        try {
           await this._writer.finish();
        }
        catch (err) {
            return callback(err);
        }

        this.md5 = this._writer.md5;

        callback();
    }

    async _read() {
        if (this._mode != MODE_READ)
            return this.emit('error', new Error('file object is not in a readable state'));

        try {
            let buffer = await this._reader.readChunk();

            if (buffer === null && this._shouldTransmitEOR === false) {
                this._isAwaitingData = true;
                return;
            }

            this.push(buffer);
            this._isAwaitingData = false;
        }

        catch (err) {
            return this.emit('error', err);
        }
    }

    async close() {
        if (this._mode != MODE_READ)
            throw new Error('file object is not in a readable state');

        super.destroy();
        await this._reader.close();

        this._reader = null;
        this._mode = null;
    }

    // TODO: add a thing to close the slices when the reading is complete

    async acquireIOLock() {
        const previousPromise = this._lockPromises[this._lockPromises.length - 1];
        let newPromiseResolver = null;
        const newPromise = new Promise(resolve => {
            newPromiseResolver = resolve;
        });
        newPromise.resolve = newPromiseResolver;
        this._lockPromises.push(newPromise);
        previousPromise !== undefined && await previousPromise;
    }

    releaseIOLock() {
        if (this._lockPromises.length == 0) return;
        const nextPromise = this._lockPromises.shift();
        nextPromise.resolve();
    }

    log() {
        this.log = Log('file:' + this.id);
        this.log.apply(this.log, arguments);
    }
}

module.exports = FileObject;