import { type StoredObjectRecord, type FileObject } from '../../io/file-object';
import { fileObjectService, type FileObjectService } from '../../io/file-object/service';
import { createLogger } from '../../log';
import type { HttpRequest, HttpResponse } from './server';
import { applyFileMetadataHeaders, applyObjectIdentityHeaders, applySliceHeaders, applyObjectSecurityHeaders, sanitizeDispositionFilename } from './object-response-headers';

// TODO: GET and HEAD should import from the same object (or Get from Head?) and have a shared write headers function
// TODO: add "returned bytes" count for metrics and logging

type ObjectGetRequestDeps = {
    fileObjectService: FileObjectService;
};

const defaultDeps: ObjectGetRequestDeps = {
    fileObjectService
};

export class ObjectGetRequest {
    private readonly requestId: number;
    private readonly objectRecord: StoredObjectRecord;
    private readonly request: HttpRequest;
    private readonly response: HttpResponse;
    private readonly logger: ReturnType<typeof createLogger>;
    private readonly deps: ObjectGetRequestDeps;

    constructor(requestId: number, objectRecord: StoredObjectRecord, request: HttpRequest, response: HttpResponse, deps: ObjectGetRequestDeps = defaultDeps) {
        this.requestId = requestId;
        this.objectRecord = objectRecord;
        this.request = request;
        this.response = response;
        this.logger = createLogger('http-server:request-' + this.requestId);
        this.deps = deps;
    }

    async process(): Promise<void> {
        try {
            applyObjectIdentityHeaders(this.response, this.objectRecord);
            applyFileMetadataHeaders(this.response, this.objectRecord);
            applySliceHeaders(this.response, this.objectRecord);
            this.response.setHeader('Accept-Ranges', 'bytes');

            const downloadAs = this.request.params.download_as;
            if (typeof downloadAs === 'string' && downloadAs.length)
                this.response.setHeader('Content-Disposition', `attachment; filename="${sanitizeDispositionFilename(downloadAs)}"`);

            // After any caller-supplied disposition, before serving the body: neuter active content.
            applyObjectSecurityHeaders(this.response, this.objectRecord);

            const object = await this.deps.fileObjectService.openForRead(this.objectRecord, { requestId: `http-${this.requestId}` });

            const rangeHeader = this._getHeaderValue(this.request.headers.range);
            if (rangeHeader) {
                if (!this._configureRangeResponse(rangeHeader, object))
                    return;
            }
            else {
                this.response.setHeader('Content-Length', object.size);
                this.response.writeHead(200);
                object.setReadRange(0, object.size, true);
            }

            await new Promise<void>((resolve, reject) => {
                let isComplete = false;

                const cleanup = (): void => {
                    object.removeListener('error', handleError);
                    object.removeListener('end', handleEnd);
                };

                const handleError = (err: Error): void => {
                    this._handleStreamError(object, err, cleanup, reject);
                };

                const handleEnd = (): void => {
                    cleanup();
                    isComplete = true;
                    object.close().finally(() => {
                        this.response.end();
                        resolve();
                    });
                };

                object.on('error', handleError);
                object.on('end', handleEnd);
                object.pipe(this.response);

                this.response.on('close', () => {
                    if (isComplete) return;
                    cleanup();
                    this.logger('request for ' + this.request.url + ' canceled before file completed');
                    object.close().finally(() => resolve());
                });
            });
        }

        catch (err) {
            this.response.headersSent || this.response.writeHead(500);
            this.response.write('\n\nSTRUBS encountered an error. transfer incomplete.');
            this.response.end();
            throw err;
        }
    }

    private _configureRangeResponse(rangeHeader: string, object: FileObject): boolean {
        const [startStr, endStr] = rangeHeader.replace(/bytes=/, '').split('-');
        const start = Number.parseInt(startStr, 10);
        const endValue = endStr ? Number.parseInt(endStr, 10) : NaN;

        if (Number.isNaN(start) || start < 0 || start >= object.size) {
            this._respondWithRangeError();
            return false;
        }

        let end = Number.isNaN(endValue) ? object.size : Math.min(endValue + 1, object.size);
        if (end <= start) {
            this._respondWithRangeError();
            return false;
        }

        this.logger('requested partial content from %s - %s', start, end || 'end');

        object.setReadRange(start, end, true);

        const contentLength = end - start;
        this.response.setHeader('Content-Length', contentLength);
        this.response.setHeader('Content-Range', `bytes ${start}-${end - 1}/${object.size}`);
        this.response.writeHead(206);

        return true;
    }

    private _handleStreamError(object: FileObject, err: Error, cleanup: () => void, reject: (err: Error) => void): void {
        cleanup();
        object.unpipe(this.response);
        if (!this.response.headersSent)
            this.response.writeHead(500);
        this.response.write('\n\nSTRUBS encountered an error. transfer incomplete.');
        this.response.destroy(err);
        reject(err);
    }

    private _respondWithRangeError(): void {
        this.response.writeHead(416, 'Invalid Range');
        this.response.end();
    }

    private _getHeaderValue(header: string | string[] | undefined): string | undefined {
        if (Array.isArray(header))
            return header[0];
        return header;
    }
}
