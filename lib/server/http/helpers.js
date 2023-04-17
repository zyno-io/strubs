const database = require('../../database');

class HttpHelpers {
    static async getObjectMeta(path) {
        try {
            let objectMeta;
            if (path.length == 26 && /^\/\$[0-9a-f]{24}$/.test(path))
                objectMeta = await database.getObjectById(path.substr(2));
            else
                objectMeta = await database.getObjectByPath(path.substr(1));
            return objectMeta;
        }
        catch (err) {
            if (err.code == 'ENOENT')
                return null;
            else
                throw err;
        }
    }
}

module.exports = HttpHelpers;