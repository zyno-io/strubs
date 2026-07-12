import fs from 'fs';
import http from 'http';
import https from 'https';
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
import { authorizeObjectRequest } from './object-authz';
import { HttpHelpers } from './helpers';
import { HttpBadRequestError, HttpNotFoundError, HttpUnauthorizedError, HttpTooManyRequestsError } from './errors';
import { adminAuth, parseCookies, SESSION_COOKIE } from './admin-auth';
import { config } from '../../config';

const log = createLogger('http-server');

type HttpRequest = http.IncomingMessage & {
    url: string;
    params: querystring.ParsedUrlQuery;
    // Set by the server (never from a client header) when the request arrived on the trusted admin
    // Unix socket. Handlers use it for the lockout-recovery path (reset the password with no current one).
    trusted?: boolean;
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

// The two surfaces live on SEPARATE ORIGINS (see lib/server/tls.ts and the auth design). An 'object'
// listener serves only the object API and 404s any `/$/` path; an 'admin' listener serves only the
// management API + UI and 404s everything else. 'all' is the legacy single-origin behaviour, kept for
// tests. The separation is a security boundary, so a cross-origin path is a hard 404, never a redirect.
export type HttpServerRole = 'object' | 'admin' | 'all';

export interface HttpServerOptions {
    role?: HttpServerRole;
    tls?: { key: Buffer; cert: Buffer };
    // A trusted admin listener (the root-only Unix socket) serves the management API with NO credential
    // check -- the boundary is filesystem permissions, not the network. Never set this on a TCP listener.
    trusted?: boolean;
}

export class HttpServer {
    // A number is a TCP port; a string is a Unix socket path (the trusted admin socket).
    public port: number | string;
    public readonly role: HttpServerRole;
    private readonly _trusted: boolean;
    private _requestCount = 0;
    private readonly _server: http.Server;
    private readonly _routes: Record<string, RouteHandler>;
    private readonly _managementRoute: RouteHandler;
    private readonly deps: HttpServerDependencies;

    constructor(port: number | string = 80, server?: http.Server, deps?: Partial<HttpServerDependencies>, options?: HttpServerOptions) {
        this.port = port;
        this.role = options?.role ?? 'all';
        this._trusted = options?.trusted ?? false;
        this.deps = { ...defaultDeps, ...deps };

        this._server = server ?? (options?.tls
            ? https.createServer({ key: options.tls.key, cert: options.tls.cert })
            : http.createServer());
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
        if (typeof this.port === 'string') {
            // Unix socket: remove a stale socket file from an unclean shutdown, then bind and lock it
            // down to root-only. This socket serves the admin API with NO credential, so if we cannot
            // enforce 0600 we FAIL CLOSED -- the process exits rather than expose an unauthenticated
            // admin API to any local user. chmod after listen (the file does not exist until then).
            try { fs.unlinkSync(this.port); }
            catch { /* not there, fine */ }
            const socketPath = this.port;
            this._server.listen(socketPath, () => {
                try {
                    fs.chmodSync(socketPath, 0o600);
                }
                catch (err) {
                    log.error('FATAL: cannot secure admin socket %s to 0600: %s -- refusing to run', socketPath, err);
                    process.exit(1);
                }
            });
            return;
        }
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

        // Mark trust from the listener, not from any client-supplied header (which we ignore entirely).
        request.trusted = this._trusted;

        const method = req.method!.toUpperCase();
        this._logRequestStart(requestId, request, method);

        const handler = this._resolveRoute(method, request.url);
        if (!handler)
            return this._outputHttpBadRequest('unsupported method', req, res);

        // Admin authentication for any `/$/` request that isn't on the object-only listener. Gating on
        // `role !== 'object'` (rather than `=== 'admin'`) is defence in depth: the legacy single-origin
        // 'all' role must not silently serve the management API unauthenticated. The trusted Unix socket
        // is gated by filesystem permissions; login and the static UI are exempt (they are HOW you auth).
        if (this.role !== 'object' && !this._trusted && request.url.startsWith('/$/')) {
            // CSRF: reject a mutation whose Sec-Fetch-Site says it originated cross-site. Browsers set
            // this header unforgeably; a same-origin UI request is 'same-origin', a CSRF from another site
            // is 'cross-site'/'same-site'. Non-browser clients (curl, bearer-token automation) omit it ->
            // allowed. Applies to ALL mutating /$/ requests -- including the auth-exempt login endpoint,
            // so a cross-site page cannot drive login attempts (or logout) -- but not GET/HEAD/OPTIONS,
            // so the static UI and auth-status stay reachable. Belt-and-braces over SameSite=Strict and
            // the origin split.
            if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && this._isCrossSite(request))
                return this._outputHttpForbidden(res, 'cross-site request refused');
            // Authenticate everything except the login endpoint and the static UI (which are HOW you auth).
            if (!this._isAuthExempt(method, request.url) && !await this._authorizeAdmin(request))
                return this._outputHttpUnauthorized(res);
        }

        // Bucket authorisation for object-content requests. The single choke point: it runs before the
        // object handler on any listener that serves content, never on the admin origin or the trusted
        // socket, and never for /$/ paths (handled above). DARK by default (authEnforced=false) -- it
        // allows every request and only bumps a per-bucket counter -- so today's behaviour is unchanged
        // until an operator flips the switch.
        if (this.role !== 'admin' && !this._trusted && !request.url.startsWith('/$/')) {
            const decision = await authorizeObjectRequest(request.url, method, request.headers.authorization);
            if (!decision.allow) {
                if (decision.status === 401)
                    return this._outputHttpObjectUnauthorized(res, decision.message);
                if (decision.status === 503)
                    return this._outputHttpServiceUnavailable(res, decision.message);
                return this._outputHttpForbidden(res, decision.message);
            }
        }

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
        const isAdminPath = path.startsWith('/$/');

        // Enforce the origin boundary. An admin path on the object listener means "wrong scheme/port":
        // signal that clearly (see _wrongSchemeRoute) rather than a bare 404. An object path on the
        // admin listener is a hard 404 -- object CONTENT must never be served from the admin origin.
        if (this.role === 'object' && isAdminPath)
            return this._wrongSchemeRoute;
        if (this.role === 'admin' && !isAdminPath)
            return this._notFoundRoute;

        if (isAdminPath)
            return this._managementRoute;

        return this._routes[method] ?? null;
    }

    private _notFoundRoute: RouteHandler = async (_id, req, res) => this._outputHttpNotFound(req, res);

    // The admin API was reached over plain HTTP (the object origin). Point the caller at HTTPS.
    // A genuine top-level browser navigation is redirected so typing the bare host lands on the login;
    // everything else -- crucially any script fetch, which cannot forge Sec-Fetch-Mode: navigate --
    // gets a 421 instead. A redirect here would be dangerous: cookies are not port-scoped and :80/:443
    // are same-site, so 308-ing a POST would re-send the admin cookie to :443 and reopen the XSS->wipe
    // path the origin split exists to close.
    private _wrongSchemeRoute: RouteHandler = async (_id, req, res) => {
        const host = (req.headers.host ?? '').replace(/:\d+$/, '');
        const target = `https://${host}${config.adminPort === 443 ? '' : ':' + config.adminPort}${req.url}`;
        if (req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && host) {
            res.writeHead(308, 'Permanent Redirect', { Location: target });
            res.end();
            return;
        }
        res.writeHead(421, 'Misdirected Request', { 'Content-Type': 'text/plain' });
        res.end(`the management API is HTTPS-only; use ${host ? target : `https://<host>:${config.adminPort}${req.url}`}\n`);
    };

    // Reachable without a credential on the admin origin: the static UI (which is the login page) and
    // the session endpoints themselves. Everything else under /$/ requires auth.
    private _isAuthExempt(method: string, path: string): boolean {
        if (path === '/$/ui' || path.startsWith('/$/ui/'))
            return true; // login page + its assets
        if (path === '/$/session')
            return true; // POST login / DELETE logout
        if (path === '/$/auth/status')
            return true; // lets the SPA decide login-vs-dashboard
        return false;
    }

    // True only when the browser explicitly says the request came from a different site. Absent header
    // (non-browser client) or 'same-origin'/'none' (our UI, or a top-level navigation) is not cross-site.
    private _isCrossSite(req: HttpRequest): boolean {
        const site = req.headers['sec-fetch-site'];
        return typeof site === 'string' && site !== 'same-origin' && site !== 'none';
    }

    private _outputHttpForbidden(res: HttpResponse, message: string): void {
        res.writeHead(403, 'Forbidden', { 'Content-Type': 'text/plain' });
        res.end(message);
    }

    private async _authorizeAdmin(req: HttpRequest): Promise<boolean> {
        const auth = req.headers.authorization;
        if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
            if (await adminAuth.verifyBearer(auth.slice(7).trim()))
                return true;
        }
        const cookies = parseCookies(req.headers.cookie);
        return adminAuth.verifySession(cookies[SESSION_COOKIE]);
    }

    private _outputHttpUnauthorized(res: HttpResponse): void {
        // No WWW-Authenticate: Basic -- that would pop the browser's native auth dialog on the admin UI,
        // which uses a login page instead. A bare 401 lets the SPA render its login form.
        res.writeHead(401, 'Unauthorized');
        res.end('401');
    }

    // Object-API 401: DOES carry WWW-Authenticate: Basic, so a browser prompts for credentials and a
    // public-read bucket keeps working from <img src>. (This is the object origin, not the admin UI.)
    private _outputHttpObjectUnauthorized(res: HttpResponse, message: string): void {
        res.writeHead(401, 'Unauthorized', {
            'WWW-Authenticate': 'Basic realm="strubs"',
            'Content-Type': 'text/plain'
        });
        res.end(message);
    }

    // Authorization could not be evaluated (e.g. a DB error while enforced). Fail closed with a 503 rather
    // than serving the object or leaking an unhandled rejection out of the request path.
    private _outputHttpServiceUnavailable(res: HttpResponse, message: string): void {
        res.writeHead(503, 'Service Unavailable', { 'Content-Type': 'text/plain' });
        res.end(message);
    }

    private async _handleHttpManagementRequest(requestId: number, req: HttpRequest, res: HttpResponse): Promise<void> {
        try {
            const response = await HttpMgmt.handle(requestId, req, res);
            this._outputHttpContent(response, req, res);
        } catch (err) {
            if (err instanceof HttpBadRequestError) {
                this._outputHttpBadRequest(err.message, req, res);
            } else if (err instanceof HttpUnauthorizedError) {
                this._outputHttpUnauthorized(res);
            } else if (err instanceof HttpTooManyRequestsError) {
                res.writeHead(429, 'Too Many Requests', { 'Content-Type': 'text/plain', 'Retry-After': '30' });
                res.end(err.message || '429');
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
