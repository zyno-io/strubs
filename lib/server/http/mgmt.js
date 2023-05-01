const HttpHelpers = require('./helpers');
const { HttpNotFoundError } = require("./errors");
const ioManager = require('../../io/manager');
const planner = require('../../io/planner');

class HttpMgmt {
    static async handle(requestId, req, res) {
        if (req.method === 'GET' && req.url === '/$mgmt/status') {
            return this.handleStatusRequest(req, res);
        }
        if (req.method === 'GET' && req.url.startsWith('/$mgmt/fileinfo/')) {
            return this.handleFileInfoRequest(req, res);
        }

        if (req.method === 'GET' && req.url ==='/$mgmt/plan')
            return this.handlePlanRequest(req, res);

        throw new HttpNotFoundError();
    }

    static async handlePlanRequest(req, res) {
        const size = parseInt(req.params.size);
        const plan = planner.generatePlan(size);
        return plan;
    };

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

    static async handleFileInfoRequest(req, res) {
        const fileName = req.url.substring(15);
        const objectMeta = await HttpHelpers.getObjectMeta(fileName);
        if (!objectMeta) {
            throw new HttpNotFoundError();
        }

        return {
            'X-Object-Id': objectMeta.id,
            'X-Container-Id': objectMeta.containerId,
            'Content-MD5': objectMeta.md5?.toString('hex'),
            'Content-Type': objectMeta.mime,
            'X-Data-Slice-Count': objectMeta.dataVolumes.length,
            'X-Data-Slice-Volumes': objectMeta.dataVolumes,
            'X-Parity-Slice-Count': objectMeta.parityVolumes.length,
            'X-Parity-Slice-Volumes': objectMeta.parityVolumes,
            'X-Chunk-Size': objectMeta.chunkSize,
            'slicePaths': await asyncMap(objectMeta.dataVolumes, async (volumeId, idx) => {
                try {
                    return await ioManager._volumes[volumeId].getCommitedPath(`${objectMeta.id}.${idx}`)
                } catch (e) {
                    return `Error: ${e}`;
                }
            }),
        }
    }
}

async function asyncMap(items, callback) {
    const result = [];
    for (let i = 0; i < items.length; i++) {
        result.push(await callback(items[i], i));
    }
    return result;
}

module.exports = HttpMgmt;
