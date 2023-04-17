const FileObject = require('../../io/file-object');
const Log = require('../../log');

// TODO: GET and HEAD should import from the same object (or Get from Head?) and have a shared write headers function
// TODO: add "returned bytes" count for metrics and logging

class ObjectGetRequest {
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

                this.response.setHeader('Content-MD5', this.objectRecord.md5.toString('hex'));

                if (this.objectRecord.mime)
                    this.response.setHeader('Content-Type', this.objectRecord.mime);

                this.response.setHeader('X-Data-Slice-Count', this.objectRecord.dataVolumes.length);
                this.response.setHeader('X-Data-Slice-Volumes', this.objectRecord.dataVolumes.join(','));
                this.response.setHeader('X-Parity-Slice-Count', this.objectRecord.parityVolumes.length);
                this.response.setHeader('X-Parity-Slice-Volumes', this.objectRecord.parityVolumes.join(','));
                this.response.setHeader('X-Chunk-Size', this.objectRecord.chunkSize);

                this.response.setHeader('Accept-Ranges', 'bytes');

                if (this.request.params.download_as)
                    this.response.setHeader('Content-Disposition', 'attachment; filename="' + this.request.params.download_as + '"');

                let object = new FileObject();
                await object.loadFromRecord(this.objectRecord);
                await object.prepareForRead();

                let contentLength;

                if (this.request.headers.range) {
                    let positions = this.request.headers.range.replace(/bytes=/, '').split('-');
                    let start = parseInt(positions[0], 10);
                    let end = parseInt(positions[1], 10) || null;

                    this.log('requested partial content from %s - %s', start, end || 'end');

                    if (!end)
                        end = object.size;
                    else
                        end += 1;

                    await object.setReadRange(start, end, true);

                    contentLength = end - start;
                    this.response.setHeader('Content-Length', end - start);
                    this.response.setHeader('Content-Range', 'bytes ' + start + '-' + (end - 1) + '/' + object.size);
                    this.response.writeHead(206);
                }

                else {
                    contentLength = object.size;
                    this.response.setHeader('Content-Length', object.size);
                    this.response.writeHead(200);
                }

                let isComplete = false;

                object.pipe(this.response);

                object.on('error', err => {
                    object.unpipe();
                    this.response.write('\n\nSTRUBS encountered an error. transfer incomplete.');
                    this.response.destroy();
                    reject(err);
                });

                object.on('end', () => {
                    isComplete = true;
                    object.close();
                    this.response.end();
                    resolve();
                });

                this.response.on('close', () => {
                    if (isComplete) return;
                    this.log('request for ' + this.request.url + ' canceled before file completed');
                    object.close();
                });
            }

            catch (err) {
                console.log('caught error');
                this.response.headersSent || this.response.writeHead(500);
                this.response.write('\n\nSTRUBS encountered an error. transfer incomplete.');
                this.response.end();
                reject(err);
            }
        });
    }

    log() {
        this.log = Log('http-server:request-' + this.requestId);
        this.log.apply(this.log, arguments);
    }
}

module.exports = ObjectGetRequest;