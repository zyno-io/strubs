const { HttpNotFoundError } = require("./errors");
const ioManager = require('../../io/manager');

class HttpMgmt {
    static async handle(requestId, req, res) {
        if (req.method === 'GET' && req.url === '/$mgmt/status') {
            return this.handleStatusRequest(req, res);
        } else {
            throw new HttpNotFoundError();
        }
    }

    static async handleStatusRequest(req, res) {
        return {
            volumes: await this.getVolumeStatus()
        };
    }

    static async getVolumeStatus() {
        return Object.entries(ioManager._volumes).map(([id, volume]) => ({
            id,
            uuid: volume.uuid,
            blockPath: volume.blockPath,
            mountPoint: volume.mountPoint,
            isMounted: volume.isMounted,
            isVerified: volume.isVerified,
            isStarted: volume.isStarted,
            isEnabled: volume.isEnabled,
            isHealthy: volume.isHealthy,
            isReadOnly: volume.isReadOnly,
            deviceSerial: volume.deviceSerial,
            partitionUuid: volume.partitionUuid,
            bytesTotal: volume.bytesTotal,
            bytesFree: volume.bytesFree
        }));
    }
}

module.exports = HttpMgmt;
