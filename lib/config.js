require('dotenv').config()

const fs = require('fs').promises;

const log = require('./log')('config');

class Config {
    dataSliceCount = process.env.STRUBS_DATA_SLICES ? parseInt(process.env.STRUBS_DATA_SLICES) : 4;
    paritySliceCount = process.env.STRUBS_PARITY_SLICES ? parseInt(process.env.STRUBS_PARITY_SLICES) : 2;
    chunkSize = 16384;

    constructor() {
        this.identity = null;
        this.identityBuffer = null;
    }

    load(cb) {
        return new Promise(async (resolve, reject) => {
            log('loading identity');

            let data = await fs.readFile('/var/lib/strubs/identity');

            this.identity = String(data).trim();
            this.identityBuffer = Buffer.from(this.identity.replace(/[^0-9a-f]/g, ''), 'hex');

            log('loaded identity:', this.identity);
            resolve();
        });
    }
}

module.exports = new Config();