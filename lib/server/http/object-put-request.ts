import { database } from '../../database';
import { type FileObject } from '../../io/file-object';
import { fileObjectService, type FileObjectService } from '../../io/file-object/service';
import { createLogger } from '../../log';
import type { HttpRequest, HttpResponse } from './server';

// TODO: move MD5 into FileObject

type ObjectPutRequestDeps = {
    fileObjectService: FileObjectService;
};

const defaultDeps: ObjectPutRequestDeps = {
    fileObjectService
};

export class ObjectPutRequest {
    private readonly requestId: number;
    private readonly request: HttpRequest;
    private readonly response: HttpResponse;
    private readonly logger: ReturnType<typeof createLogger>;
    private readonly deps: ObjectPutRequestDeps;

    constructor(requestId: number, request: HttpRequest, response: HttpResponse, deps: ObjectPutRequestDeps = defaultDeps) {
        this.requestId = requestId;
        this.request = request;
        this.response = response;
        this.logger = createLogger('http-server:request-' + this.requestId);
        this.deps = deps;
    }

    async process(): Promise<void> {
        const contentLengthHeader = this.request.headers['content-length'];
        const bytesExpected = this._parseNumberHeader(contentLengthHeader);
        if (!Number.isFinite(bytesExpected) || bytesExpected <= 0) {
            this._respondWithError(400, 'Invalid Content-Length');
            return;
        }

        let fileObject: FileObject;
        try {
            fileObject = await this._receiveUpload(bytesExpected);
        }
        catch (err) {
            this._handleUploadError(err as Error);
            return;
        }

        try {
            await this._finalizeUpload(fileObject);
        }
        catch (err) {
            await this._cleanupFailedUpload(fileObject);
            throw err;
        }
    }

    private async _receiveUpload(bytesExpected: number): Promise<FileObject> {
        const object = await this.deps.fileObjectService.createWritable(bytesExpected, { requestId: `http-${this.requestId}` });
        return new Promise<FileObject>((resolve, reject) => {
            let bytesReceived = 0;

            const cleanup = (): void => {
                this.request.removeAllListeners('data');
                this.request.removeAllListeners('aborted');
                this.request.removeAllListeners('end');
                this.request.removeAllListeners('error');
                object.removeAllListeners('drain');
                object.removeAllListeners('error');
                object.removeAllListeners('finish');
            };

            const rejectWithCleanup = (err: Error): void => {
                cleanup();
                reject(err);
            };
            const handleAbort = async (): Promise<void> => {
                this.logger('client aborted request to store object at ' + this.request.url);
                try {
                    await object.delete();
                }
                catch (err) {
                    this.logger('error deleting aborted object', err);
                }
                rejectWithCleanup(new ClientAbortError());
            };

            this.request.on('data', data => {
                bytesReceived += data.length;
                if (!object.write(data))
                    this.request.pause();
            });

            this.request.on('aborted', () => {
                void handleAbort();
            });

            this.request.on('end', async () => {
                if (bytesExpected !== bytesReceived) {
                    try {
                        await object.delete();
                    }
                    catch (err) {
                        this.logger('error deleting mismatched object', err);
                    }
                    return rejectWithCleanup(new LengthMismatchError(bytesExpected, bytesReceived));
                }

                object.end();
            });

            this.request.on('error', err => {
                this.logger('request error', err);
                object.delete().catch(() => {});
                rejectWithCleanup(err as Error);
            });

            object.on('drain', () => {
                this.request.resume();
            });

            object.on('error', err => {
                this.logger('object error', err);
                void object.delete();
                rejectWithCleanup(err as Error);
            });

            object.on('finish', () => {
                cleanup();
                resolve(object);
            });
        });
    }

    private _handleUploadError(err: Error): void {
        if (err instanceof LengthMismatchError) {
            this.response.writeHead(455, 'Length Mismatch', {
                'X-Received-Bytes': err.receivedBytes,
                'X-Expected-Bytes': err.expectedBytes
            });
            this.response.end('length mismatch');
            return;
        }

        if (err instanceof ClientAbortError)
            return;

        throw err;
    }

    private async _finalizeUpload(object: FileObject): Promise<void> {
        const md5Hex = object.md5?.toString('hex');
        const providedMd5 = this._getHeaderValue(this.request.headers['content-md5']);

        if (providedMd5 && md5Hex && providedMd5 !== md5Hex) {
            await object.delete();
            this.response.writeHead(456, 'MD5 Mismatch', {
                'X-Received-MD5': md5Hex
            });
            this.response.end('MD5 mismatch');
            return;
        }

        const contentType = this._getHeaderValue(this.request.headers['content-type']);
        if (contentType)
            object.mime = contentType;

        const { fileName, containerComponents } = this._extractPathComponents();
        if (!fileName) {
            await object.delete();
            throw new Error('missing file name');
        }

        if (containerComponents.length) {
            const { containerId, bucketId } = await database.getOrCreateContainerWithBucket(containerComponents);
            object.containerId = containerId;
            object.bucketId = bucketId;
        }

        object.name = fileName;
        await object.commit();

        const headers: Record<string, string> = {
            'x-object-id': object.id ?? '',
            'x-container-id': object.containerId ?? ''
        };
        if (md5Hex)
            headers['content-md5'] = md5Hex;
        this.response.writeHead(201, 'Created', headers);
        this.response.end();
    }

    private _extractPathComponents(): { fileName: string | undefined; containerComponents: string[] } {
        const path = (this.request.url || '').replace(/^\//, '');
        const pathComponents = path.split('/');
        const fileName = pathComponents.pop();
        return { fileName, containerComponents: pathComponents };
    }

    private async _cleanupFailedUpload(object: FileObject): Promise<void> {
        try {
            await object.delete();
        }
        catch (err) {
            this.logger('failed to clean up file object after error', err as Error);
        }
    }

    private _respondWithError(status: number, message: string): void {
        this.response.writeHead(status);
        this.response.end(message);
    }

    private _parseNumberHeader(header: string | string[] | undefined): number {
        const value = this._getHeaderValue(header);
        return value ? Number.parseInt(value, 10) : Number.NaN;
    }

    private _getHeaderValue(header: string | string[] | undefined): string | undefined {
        if (Array.isArray(header))
            return header[0];
        return header;
    }
}

class LengthMismatchError extends Error {
    constructor(public readonly expectedBytes: number, public readonly receivedBytes: number) {
        super('length mismatch');
    }
}

class ClientAbortError extends Error {
    constructor() {
        super('client aborted upload');
    }
}
