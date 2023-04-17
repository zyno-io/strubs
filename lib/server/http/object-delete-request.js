const FileObject = require('../../io/file-object');
const Log = require('../../log');

class ObjectDeleteRequest {
    constructor(requestId, objectRecord, request, response) {
        this.requestId = requestId;
        this.objectRecord = objectRecord;
        this.request = request;
        this.response = response;
    }

    process() {
        return new Promise(async (resolve, reject) => {
            try {
                this.response.setHeader('X-Object-Id', this.objectRecord.id);

                if (this.objectRecord.containerId)
                    this.response.setHeader('X-Container-Id', this.objectRecord.containerId);

                this.response.setHeader('X-Data-Slice-Count', this.objectRecord.dataVolumes.length);
                this.response.setHeader('X-Data-Slice-Volumes', this.objectRecord.dataVolumes.join(','));
                this.response.setHeader('X-Parity-Slice-Count', this.objectRecord.parityVolumes.length);
                this.response.setHeader('X-Parity-Slice-Volumes', this.objectRecord.parityVolumes.join(','));

                let object = new FileObject();
                await object.loadFromRecord(this.objectRecord);
                await object.delete();

                this.response.writeHead(200);
                this.response.end();
            }

            catch (err) {
                console.log('caught error');
                this.response.headersSent || this.response.writeHead(500);
                this.response.write('\n\nSTRUBS encountered an error.');
                this.response.destroy();
                reject(err);
            }
        });
    }

    log() {
        this.log = Log('http-server:request-' + this.requestId);
        this.log.apply(this.log, arguments);
    }
}

module.exports = ObjectDeleteRequest;