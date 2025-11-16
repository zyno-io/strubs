import http from 'http';
import querystring from 'querystring';

import { createLogger } from '../../log';
import type { StoredObjectRecord } from '../../io/file-object';
import type { ContentDocument } from '../../database';

import { HttpMgmt } from './mgmt';
import { ObjectGetRequest } from './object-get-request';
import { ObjectHeadRequest } from './object-head-request';
import { ObjectPutRequest } from './object-put-request';
import { ObjectDeleteRequest } from './object-delete-request';
import { ObjectOptionsRequest } from './object-options-request';
import { HttpHelpers } from './helpers';
import { HttpBadRequestError, HttpNotFoundError } from './errors';

const log = createLogger('http-server');

type HttpRequest = http.IncomingMessage & {
    url: string;
    params: querystring.ParsedUrlQuery;
};

type HttpResponse = http.ServerResponse;
export type HttpContentPayload = {
    body: unknown;
    headers?: Record<string, string>;
    statusCode?: number;
    contentType?: string;
};
type RouteHandler = (requestId: number, req: HttpRequest, res: HttpResponse) => Promise<void>;
type HttpServerDependencies = {
    ObjectGetRequest: typeof ObjectGetRequest;
    ObjectHeadRequest: typeof ObjectHeadRequest;
    ObjectOptionsRequest: typeof ObjectOptionsRequest;
    ObjectPutRequest: typeof ObjectPutRequest;
    ObjectDeleteRequest: typeof ObjectDeleteRequest;
};

const defaultDeps: HttpServerDependencies = {
    ObjectGetRequest,
    ObjectHeadRequest,
    ObjectOptionsRequest,
    ObjectPutRequest,
    ObjectDeleteRequest
};

export class HttpServer {
    public port: number;
    private _requestCount = 0;
    private readonly _server: http.Server;
    private readonly _routes: Record<string, RouteHandler>;
    private readonly _managementRoute: RouteHandler;
    private readonly deps: HttpServerDependencies;

    constructor(port = 80, server?: http.Server, deps?: Partial<HttpServerDependencies>) {
        this.port = port;
        this.deps = { ...defaultDeps, ...deps };

        this._server = server ?? http.createServer();
        this._server.on('listening', this._handleHttpListening.bind(this));
        this._server.on('close', this._handleHttpClose.bind(this));
        this._server.on('request', this._handleHttpRequest.bind(this));

        this._routes = {
            GET: this._handleHttpGetRequest.bind(this),
            HEAD: this._handleHttpHeadRequest.bind(this),
            OPTIONS: this._handleHttpOptionsRequest.bind(this),
            PUT: this._handleHttpPutRequest.bind(this),
            DELETE: this._handleHttpDeleteRequest.bind(this)
        };
        this._managementRoute = this._handleHttpManagementRequest.bind(this);
    }

    start(): void {
        this._server.listen(this.port);
    }

    stop(): Promise<void> {
        return new Promise((resolve, reject) => {
            this._server.close(err => {
                if (err) return reject(err);
                resolve();
            });
        });
    }

    private _handleHttpListening(): void {
        const address = this._server.address();
        if (!address)
            return log('listening (address unavailable)');
        if (typeof address === 'string')
            return log('listening on %s', address);
        log('listening on %s:%d', address.address, address.port);
    }

    private _handleHttpClose(): void {
        log('stopped listening');
    }

    private async _handleHttpRequest(req: http.IncomingMessage, res: HttpResponse): Promise<void> {
        const requestId = ++this._requestCount;

        const request = this._prepareRequest(req, res);
        if (!request)
            return;

        const method = req.method!.toUpperCase();
        this._logRequestStart(requestId, request, method);

        const handler = this._resolveRoute(method, request.url);
        if (!handler)
            return this._outputHttpBadRequest('unsupported method', req, res);

        try {
            await handler(requestId, request, res);
        }
        catch (err) {
            log.error('error processing request %d from %s:%d: %s %s', requestId, req.socket.remoteAddress, req.socket.remotePort, method, request.url, err);
            this._outputHttpInternalServerError(req, res);
        }
    }

    private _prepareRequest(req: http.IncomingMessage, res: HttpResponse): HttpRequest | null {
        if (!req.url || !req.method) {
            this._outputHttpBadRequest('malformed request', req, res);
            return null;
        }

        if (!this._validateUrl(req.url)) {
            this._outputHttpBadRequest('malformed URL', req, res);
            return null;
        }

        const request = req as HttpRequest;
        const { path, params } = this._parseUrl(req.url);
        request.url = path;
        request.params = params;
        return request;
    }

    private _parseUrl(url: string): { path: string; params: querystring.ParsedUrlQuery } {
        const indexOfQ = url.indexOf('?');
        if (indexOfQ === -1)
            return { path: url, params: {} };

        const qs = url.slice(indexOfQ + 1);
        return {
            path: url.slice(0, indexOfQ),
            params: querystring.parse(qs)
        };
    }

    private _logRequestStart(requestId: number, req: http.IncomingMessage, method: string): void {
        log('new request %d from %s:%d: %s %s', requestId, req.socket.remoteAddress, req.socket.remotePort, method, req.url);
    }

    private _resolveRoute(method: string, path: string): RouteHandler | null {
        if (path.startsWith('/$/'))
            return this._managementRoute;

        return this._routes[method] ?? null;
    }

    private async _handleHttpManagementRequest(requestId: number, req: HttpRequest, res: HttpResponse): Promise<void> {
        try {
            const response = await HttpMgmt.handle(requestId, req, res);
            this._outputHttpContent(response, req, res);
        } catch (err) {
            if (err instanceof HttpBadRequestError) {
                this._outputHttpBadRequest(err.message, req, res);
            } else if (err instanceof HttpNotFoundError) {
                this._outputHttpNotFound(req, res);
            } else {
                log.error('error processing request', err);
                this._outputHttpInternalServerError(req, res);
            }
        }
    }

    private async _handleHttpGetRequest(requestId: number, req: HttpRequest, res: HttpResponse): Promise<void> {
        await this._withFileRecord(req, res, async record => {
            const RequestCtor = this.deps.ObjectGetRequest;
            const request = new RequestCtor(requestId, record, req, res);
            await request.process();
        });
    }

    private async _handleHttpHeadRequest(requestId: number, req: HttpRequest, res: HttpResponse): Promise<void> {
        await this._withFileRecord(req, res, async record => {
            const RequestCtor = this.deps.ObjectHeadRequest;
            const request = new RequestCtor(requestId, record, req, res);
            await request.process();
        });
    }

    private async _handleHttpOptionsRequest(requestId: number, req: HttpRequest, res: HttpResponse): Promise<void> {
        await this._withFileRecord(req, res, async record => {
            const RequestCtor = this.deps.ObjectOptionsRequest;
            const request = new RequestCtor(requestId, record, req, res);
            await request.process();
        });
    }

    private async _handleHttpPutRequest(requestId: number, req: HttpRequest, res: HttpResponse): Promise<void> {
        if (!req.headers['content-length'])
            return this._outputHttpBadRequest('missing content-length', req, res);

        // fake header?
        // ^^ HUH???

        if (/^\/\$/.test(req.url))
            return this._outputHttpBadRequest('path cannot begin with $', req, res);

        // TODO: keep an internal cache of files currently being uploaded as not to trample them with the same name

        const objectMeta = await this._getObjectMeta(req.url);
        if (objectMeta) return this._outputHttpConflict('object exists', req, res);

        // ensure file doesn't already exist

        const RequestCtor = this.deps.ObjectPutRequest;
        const request = new RequestCtor(requestId, req, res);
        await request.process();
    }

    private async _handleHttpDeleteRequest(requestId: number, req: HttpRequest, res: HttpResponse): Promise<void> {
        await this._withFileRecord(req, res, async record => {
            const RequestCtor = this.deps.ObjectDeleteRequest;
            const request = new RequestCtor(requestId, record, req, res);
            await request.process();
        });
    }

    private _outputHttpContent(content: unknown, req: http.IncomingMessage, res: HttpResponse): void {
        if (this._isHttpContentPayload(content)) {
            this._sendCustomContent(content, res);
            return;
        }

        if (!content) {
            res.writeHead(204);
            res.end();
            return;
        }

        if (content instanceof Buffer) {
            res.writeHead(200, 'OK', { 'content-type': 'application/octet-stream' });
            res.end(content);
            return;
        }

        if (typeof content === 'object') {
            res.writeHead(200, 'OK', { 'content-type': 'application/json' });
            res.end(JSON.stringify(content));
            return;
        }

        res.writeHead(200, 'OK', { 'content-type': 'text/plain' });
        res.end(String(content));
    }

    private _sendCustomContent(payload: HttpContentPayload, res: HttpResponse): void {
        const headers = payload.headers ?? {};
        const hasBody = payload.body !== undefined && payload.body !== null;
        if (payload.contentType && !headers['content-type'])
            headers['content-type'] = payload.contentType;
        for (const [key, value] of Object.entries(headers))
            res.setHeader(key, value);

        const status = payload.statusCode ?? (hasBody ? 200 : 204);
        res.statusCode = status;

        if (!hasBody) {
            res.end();
            return;
        }

        const body = payload.body;
        if (Buffer.isBuffer(body)) {
            if (!res.hasHeader('content-type'))
                res.setHeader('content-type', payload.contentType ?? 'application/octet-stream');
            res.end(body);
            return;
        }

        if (typeof body === 'object') {
            if (!res.hasHeader('content-type'))
                res.setHeader('content-type', payload.contentType ?? 'application/json');
            res.end(JSON.stringify(body));
            return;
        }

        if (!res.hasHeader('content-type'))
            res.setHeader('content-type', payload.contentType ?? 'text/plain');
        res.end(String(body));
    }

    private _isHttpContentPayload(content: unknown): content is HttpContentPayload {
        if (!content || typeof content !== 'object')
            return false;
        return Object.prototype.hasOwnProperty.call(content, 'body');
    }

    private _outputHttpNotFound(req: http.IncomingMessage, res: HttpResponse): void {
        res.writeHead(404, 'Object Not Found');
        res.end('404');
    }

    private _outputHttpBadRequest(message: string, req: http.IncomingMessage, res: HttpResponse): void {
        res.writeHead(400, 'Bad Request');
        res.end(message);
    }

    private _outputHttpConflict(message: string, req: http.IncomingMessage, res: HttpResponse): void {
        res.writeHead(409, 'Conflict');
        res.end(message);
    }

    private _outputHttpInternalServerError(req: http.IncomingMessage, res: HttpResponse): void {
        res.headersSent || res.writeHead(500, 'Internal Server Error');
        res.finished || res.end('500');
    }

    private _validateUrl(url: string): boolean {
        if (url.substring(0, 1) !== '/')
            return false;
        if (url.includes('//') || url.includes('/./') || url.includes('/../'))
            return false;
        return true;
    }

    private async _getObjectMeta(path: string): Promise<ContentDocument | null> {
        return HttpHelpers.getObjectMeta(path);
    }

    private _isFileRecord(object: ContentDocument): object is StoredObjectRecord {
        return typeof object.id === 'string'
            && typeof object.size === 'number'
            && typeof object.chunkSize === 'number'
            && Array.isArray(object.dataVolumes)
            && Array.isArray(object.parityVolumes);
    }

    private async _withFileRecord(req: HttpRequest, res: HttpResponse, handler: (record: StoredObjectRecord) => Promise<void>): Promise<void> {
        const objectMeta = await this._getObjectMeta(req.url);
        if (!objectMeta || !this._isFileRecord(objectMeta))
            return this._outputHttpNotFound(req, res);
        await handler(objectMeta);
    }
}
export type { HttpRequest, HttpResponse };
