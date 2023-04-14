const crypto = require('crypto');
const os = require('os');

const spawnHelper = require('../helpers/spawn');

const hostname = os.hostname();
const hostId = crypto.createHash('md5').update(hostname).digest().slice(13);

const objectIdPid = process.pid & 0xff;
let objectIdCounter = 0;

// NOTE: this follows the Mongo spec, but it's for our objects, so it's here.
// we need IDs for our files, so rather than generating a Mongo ID _and_ a file ID
// we're just doing it once. but our file needs an ID for writing data long before
// the database gets around to generating an ID, thus we make one here.
// TODO: update deprecated format?
function generateObjectId() {
    let objectIndex = ++objectIdCounter & 0xffffff;
    let time = Math.floor(Date.now() / 1000);

    let result = Buffer.allocUnsafe(12);
    result.writeInt32BE(time, 0);
    hostId.copy(result, 4);
    result.writeInt16BE(objectIdPid, 7);
    result.writeIntBE(objectIndex, 9, 3);

    return result;
}

async function lsblk(additionalParams) {
    return new Promise((resolve, reject) => {
        let params = ['-OJb'];

        if (additionalParams)
            for (index in additionalParams)
                params.push(additionalParams[index]);

        spawnHelper('lsblk', params, (err, code, out) => {
            if (err)
                return reject(err);

            if (code != 0)
                return reject(new Error('lsblk exited with code ' + code));

            let result;
            try {
                result = JSON.parse(out);
            }
            catch (e) {
                return reject(e);
            }

            return resolve(result);
        });
    });
}

async function smartctl(...args) {
    return new Promise((resolve, reject) => {
        args.unshift('--json=c');

        spawnHelper('smartctl', args, (err, code, out) => {
            if (err)
                return reject(err);

            if (code != 0)
                return reject(new Error('smartctl exited with code ' + code));

            let result;
            try {
                result = JSON.parse(out);
            }
            catch (e) {
                return reject(e);
            }

            return resolve(result);
        });
    });
}

async function mount(blockPath, mountPath, fsType, options) {
    return new Promise((resolve, reject) => {
        let params = [ blockPath, '-t', fsType, mountPath ];

        if (options) {
            let optionsParts = [];
            for (let key in options)
                optionsParts.push(key + '=' + options[key]);
            let optionsStr = optionsParts.join(',');
            params.splice(3, 0, '-o', optionsStr);
        }

        spawnHelper('mount', params, (err, code, out) => {
            if (err)
                return reject(err);

            if (code != 0)
                return reject(new Error('mount exited with code ' + code + ': ' + out));

            return resolve();
        });
    });
}

function formatBytes(bytes) {
    if (bytes >= 1099511627776)
        return Number(bytes / 1099511627776).toFixed(2) + ' TB';
    if (bytes >= 1073741824)
        return Number(bytes / 1073741824).toFixed(2) + ' GB';
    if (bytes >= 1048576)
        return Number(bytes / 1048576).toFixed(2) + ' MB';
    if (bytes >= 1024)
        return Number(bytes / 1024).toFixed(2) + ' KB';
    return bytes + ' b';
}

module.exports = {
    generateObjectId,
    lsblk,
    smartctl,
    mount,
    formatBytes
};