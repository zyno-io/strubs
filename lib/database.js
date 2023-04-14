const _ = require('lodash');
const mongodb = require('mongodb');

const log = require('./log')('database');
const { createError } = require('./helpers');

// TODO: cache MongoIDs for containers

class Database {
    constructor() {
        this._db = null;
        this._collections = {};
        this._containerCache = [];

        setInterval(this._cleanObjectCache.bind(this), 60000);
    }

    async connect() {
        try {
            log('connecting to database');

            this._client = await mongodb.MongoClient.connect('mongodb://localhost:27017/admin', {
                auth: {
                    user: 'strubs',
                    password: 'XNWd36eT78QxePGNPL6PysM3X8EWY2Em'
                },
                useNewUrlParser: true,
                useUnifiedTopology: true
            });
            this._db = this._client.db('strubs');

            this._collections.volumes = this._db.collection('volumes');
            this._collections.content = this._db.collection('content');

            log('connected');
        }
        catch (err) {
            throw createError('DBFAIL', 'failed to connect to database', err);
        }
    }

    getVolumes() {
        return new Promise((resolve, reject) => {
            let result = [];

            this._collections.volumes.find({})
            .on('data', item => result.push(item))
            .on('end', () => resolve(result));
        });
    }

    async createObjectRecord(object) {
        object._id = new mongodb.ObjectID(object.id);
        delete object.id;
        object.containerId = this.getMongoId(object.containerId);
        await this._collections.content.insertOne(object);
    }

    async getObjectById(id) {
        let object = await this._collections.content.findOne({
            _id: this.getMongoId(id)
        });

        if (!object)
            throw createError('ENOENT', 'object not found');

        object.id = object._id.toHexString();
        delete object._id;

        if (object.containerId)
            object.containerId = object.containerId.toHexString();

        return object;
    }

    async getObjectsInContainerPath(path) {
        let containerId = path.length ? await this.getContainer(path) : null;
        return await this.getObjectsInContainer(containerId);
    }

    async getObjectsInContainer(containerId) {
        let objects = await this._collections.content.find({
            containerId: this.getMongoId(containerId)
        }).project({ _id: 1, name: 1, isFile: 1, isContainer: 1, size: 1 }).toArray();

        for (let object of objects) {
            object.id = object._id.toHexString();
            delete object._id;
        }

        return objects;
    }

    async getObjectByPath(path) {
        let components = path.split('/');
        let objectName = components.pop();

        let containerId = null;

        if (components.length)
            containerId = await this.getContainer(components);

        let object = await this._collections.content.findOne({
            containerId: this.getMongoId(containerId),
            name: objectName
        });

        if (!object)
            throw createError('ENOENT', 'object not found');

        object.id = object._id.toHexString();
        delete object._id;

        if (object.containerId)
            object.containerId = object.containerId.toHexString();

        if (object.isContainer)
            this._cacheContainer(object);

        return object;
    }

    async getContainer(path, shouldCreateIfNotExists) {
        let components = typeof path == 'string' ? path.split('/') : path;

        let containerId = null;
        let shouldSkipLookup = false;

        while (components.length) {
            let name = components.shift();

            let cachedId = this._getCachedObjectId(name, containerId || null);
            if (cachedId) {
                containerId = cachedId;
                continue;
            }

            let object = null;

            if (!shouldSkipLookup) {
                object = await this._collections.content.findOne({
                    containerId: this.getMongoId(containerId),
                    name: name
                });
            }

            if (!object) {
                if (!shouldCreateIfNotExists)
                    throw createError('ENOENT', 'object not found');

                shouldSkipLookup = true;

                object = {
                    containerId: this.getMongoId(containerId),
                    name: name,
                    isContainer: true
                };
                await this._collections.content.insertOne(object);

                object.id = object._id.toHexString();
                delete object._id;

                object.containerId = containerId;
            }

            else if (!object.isContainer) {
                throw createError('ENOTDIR', 'object is not a container');
            }

            else {
                object.id = object._id.toHexString();
                delete object._id;

                object.containerId = containerId;
            }

            this._cacheContainer(object);

            containerId = object.id;
        }

        return containerId;
    }

    async getOrCreateContainer(path) {
        return await this.getContainer(path, true);
    }

    async deleteObjectById(id) {
        await this._collections.content.deleteOne({
            _id: this.getMongoId(id)
        });
    }

    getMongoId(id) {
        if (!id) return null;
        if (typeof(id) == 'string') return new mongodb.ObjectID(id);
        if (id instanceof mongodb.ObjectID) return id;
        if (id instanceof Buffer) return new mongodb.ObjectID(id.toString('hex'));
        throw new Error('unhandled mongo ID type');
    }

    getTimestampFromId(id) {
        let tsBuf =  Buffer.from(id.toString(), 'hex');
        let ts = tsBuf.readInt32BE(0);
        return ts * 1000;
    }

    _cacheContainer(object) {
        this._containerCache.push({
            id: object.id,
            containerId: object.containerId,
            name: object.name,
            lastUsed: Date.now()
        });
    }

    _getCachedObjectId(name, containerId) {
        let entry = _.find(this._containerCache, {
            containerId: containerId || null,
            name: name
        });

        if (entry) {
            entry.lastUsed = Date.now();
            return entry.id;
        }

        return null;
    }

    _cleanObjectCache() {
        log('clean object cache!');
    }
}

module.exports = new Database();
