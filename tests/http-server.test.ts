import type http from 'http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createLoggerMock = vi.fn(() => {
    const logger = vi.fn();
    logger.error = vi.fn();
    return logger;
});

vi.mock('../lib/log', () => ({
    createLogger: createLoggerMock,
}));

const httpHelpersGetObjectMeta = vi.fn();
vi.mock('../lib/server/http/helpers', () => ({
    HttpHelpers: {
        getObjectMeta: httpHelpersGetObjectMeta,
    },
}));

const mgmtHandle = vi.fn();
vi.mock('../lib/server/http/mgmt', () => ({
    HttpMgmt: {
        handle: mgmtHandle,
    },
}));

const createRequestClass = () => {
    const processFn = vi.fn().mockResolvedValue(undefined);
    const ctor = vi.fn();
    class RequestDouble {
        constructor(...args: unknown[]) {
            ctor(...args);
        }
        process = processFn;
    }
    return { process: processFn, ctor, Class: RequestDouble };
};

const objectGet = createRequestClass();
const objectHead = createRequestClass();
const objectPut = createRequestClass();
const objectDelete = createRequestClass();
const objectOptions = createRequestClass();

vi.mock('../lib/server/http/object-get-request', () => ({
    ObjectGetRequest: objectGet.Class,
}));
vi.mock('../lib/server/http/object-head-request', () => ({
    ObjectHeadRequest: objectHead.Class,
}));
vi.mock('../lib/server/http/object-put-request', () => ({
    ObjectPutRequest: objectPut.Class,
}));
vi.mock('../lib/server/http/object-delete-request', () => ({
    ObjectDeleteRequest: objectDelete.Class,
}));
vi.mock('../lib/server/http/object-options-request', () => ({
    ObjectOptionsRequest: objectOptions.Class,
}));

type ResData = {
    status?: number;
    body?: string | Buffer;
    headers?: Record<string, unknown>;
};

const createReqRes = (method: string, url: string, headers: http.IncomingHttpHeaders = {}) => {
    const req = {
        method,
        url,
        headers,
        socket: { remoteAddress: '127.0.0.1', remotePort: 8080 },
    } as unknown as http.IncomingMessage;

    const resData: ResData = {};

    const res = {
        headersSent: false,
        finished: false,
        writeHead: vi.fn((status: number, _statusText?: string, responseHeaders?: Record<string, unknown>) => {
            resData.status = status;
            resData.headers = responseHeaders;
            res.headersSent = true;
            return res;
        }),
        end: vi.fn((body?: string | Buffer) => {
            resData.body = body;
            res.finished = true;
        }),
    } as unknown as http.ServerResponse;

    return { req, res, resData };
};

const createNodeServer = () => ({
    on: vi.fn(),
    listen: vi.fn(),
    address: vi.fn(),
    close: vi.fn(),
});

const createFileRecord = () => ({
    id: 'object-1',
    size: 10,
    chunkSize: 5,
    dataVolumes: [1],
    parityVolumes: [2],
});

describe('HttpServer', () => {
    beforeEach(() => {
        vi.resetModules();
        httpHelpersGetObjectMeta.mockReset();
        mgmtHandle.mockReset();
        [objectGet, objectHead, objectPut, objectDelete, objectOptions].forEach(request => {
            request.ctor.mockClear();
            request.process.mockClear();
        });
    });

    const importServer = async (role?: 'object' | 'admin' | 'all') => {
        const nodeServer = createNodeServer();
        const { HttpServer } = await import('../lib/server/http/server');
        const server = new HttpServer(8080, nodeServer as unknown as http.Server, {
            ObjectGetRequest: objectGet.Class as any,
            ObjectHeadRequest: objectHead.Class as any,
            ObjectOptionsRequest: objectOptions.Class as any,
            ObjectPutRequest: objectPut.Class as any,
            ObjectDeleteRequest: objectDelete.Class as any,
        }, role ? { role } : undefined);
        return server as unknown as {
            _handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
        };
    };

    it('rejects malformed requests', async () => {
        const server = await importServer();
        const { req, res, resData } = createReqRes('GET', '');
        req.url = undefined as unknown as string;

        await server._handleHttpRequest(req, res);

        expect(resData.status).toBe(400);
        expect(resData.body).toBe('malformed request');
    });

    it('validates URL format', async () => {
        const server = await importServer();
        const { req, res, resData } = createReqRes('GET', 'file');

        await server._handleHttpRequest(req, res);

        expect(resData.status).toBe(400);
        expect(resData.body).toBe('malformed URL');
    });

    // The 'all' role gates /$/ behind auth (defence in depth), so mgmt-routing tests need a session.
    const authCookie = async (): Promise<string> => {
        const { adminAuth, SESSION_COOKIE } = await import('../lib/server/http/admin-auth');
        return `${SESSION_COOKIE}=${adminAuth.createSession()}`;
    };

    it('routes management requests through HttpMgmt', async () => {
        const server = await importServer();
        const { req, res, resData } = createReqRes('GET', '/$/volumes');
        req.headers.cookie = await authCookie();
        mgmtHandle.mockResolvedValueOnce({ healthy: true });

        await server._handleHttpRequest(req, res);

        expect(mgmtHandle).toHaveBeenCalledTimes(1);
        expect(resData.status).toBe(200);
        expect(resData.headers).toMatchObject({ 'content-type': 'application/json' });
        expect(typeof resData.body).toBe('string');
    });

    it('WRONG SCHEME: an admin path on the object listener is 421, never routes to mgmt', async () => {
        const server = await importServer('object');
        const { req, res, resData } = createReqRes('GET', '/$/volumes');
        req.headers.host = 'objectstorage';

        await server._handleHttpRequest(req, res);

        expect(mgmtHandle).not.toHaveBeenCalled();   // the management handler is unreachable here
        expect(resData.status).toBe(421);            // "use HTTPS", not a bare 404
    });

    it('WRONG SCHEME: a real browser navigation (Sec-Fetch-Mode: navigate) is 308-redirected to HTTPS', async () => {
        const server = await importServer('object');
        const { req, res, resData } = createReqRes('GET', '/$/ui');
        req.headers.host = 'objectstorage';
        req.headers['sec-fetch-mode'] = 'navigate';

        await server._handleHttpRequest(req, res);

        expect(resData.status).toBe(308);
        expect(resData.headers['Location']).toBe('https://objectstorage/$/ui');
    });

    it('WRONG SCHEME: a script fetch (no navigate) is NOT redirected -- it gets 421', async () => {
        // A 308 of a script fetch would re-send the admin cookie cross-scheme (cookies are not
        // port-scoped, :80/:443 are same-site) and reopen the XSS->wipe path. Scripts cannot forge
        // Sec-Fetch-Mode: navigate, so they must never be redirected.
        const server = await importServer('object');
        const { req, res, resData } = createReqRes('POST', '/$/volumes');
        req.headers.host = 'objectstorage';
        req.headers['sec-fetch-mode'] = 'cors';

        await server._handleHttpRequest(req, res);

        expect(resData.status).toBe(421);
    });

    it('ORIGIN SPLIT: an admin-role listener 404s object paths (never serves object content)', async () => {
        const server = await importServer('admin');
        const { req, res, resData } = createReqRes('GET', '/photo/cat.jpg');

        await server._handleHttpRequest(req, res);

        expect(objectGet.ctor).not.toHaveBeenCalled();  // no object request was ever constructed
        expect(resData.status).toBe(404);
    });

    it('DEFENCE IN DEPTH: the legacy "all" role also gates /$/ behind auth', async () => {
        const server = await importServer('all');   // no session
        const { req, res, resData } = createReqRes('GET', '/$/volumes');

        await server._handleHttpRequest(req, res);

        expect(mgmtHandle).not.toHaveBeenCalled();
        expect(resData.status).toBe(401);
    });

    it('CSRF: a cross-site mutation is refused with 403 (before auth)', async () => {
        const server = await importServer('admin');
        const { req, res, resData } = createReqRes('POST', '/$/rebalance');
        req.headers['sec-fetch-site'] = 'cross-site';
        // no session even -- cross-site is rejected before auth, so a probe learns nothing
        await server._handleHttpRequest(req, res);

        expect(mgmtHandle).not.toHaveBeenCalled();
        expect(resData.status).toBe(403);
    });

    it('CSRF: a bodyless same-origin POST is allowed (does not break the UI)', async () => {
        const server = await importServer('admin');
        const { req, res } = createReqRes('POST', '/$/rebalance');   // no body, no content-type
        req.headers.cookie = await authCookie();
        req.headers['sec-fetch-site'] = 'same-origin';
        mgmtHandle.mockResolvedValueOnce({ ok: true });
        await server._handleHttpRequest(req, res);

        expect(mgmtHandle).toHaveBeenCalledTimes(1);
    });

    it('CSRF: a non-browser client (no Sec-Fetch-Site) with a valid session is allowed', async () => {
        const server = await importServer('admin');
        const { req, res } = createReqRes('POST', '/$/rebalance');   // curl-style: no sec-fetch header
        req.headers.cookie = await authCookie();
        mgmtHandle.mockResolvedValueOnce({ ok: true });
        await server._handleHttpRequest(req, res);

        expect(mgmtHandle).toHaveBeenCalledTimes(1);
    });

    it('AUTH GATE: an admin /$/ route without a session is 401 (never reaches mgmt)', async () => {
        const server = await importServer('admin');
        const { req, res, resData } = createReqRes('GET', '/$/volumes');

        await server._handleHttpRequest(req, res);

        expect(mgmtHandle).not.toHaveBeenCalled();
        expect(resData.status).toBe(401);
    });

    it('AUTH GATE: a valid session cookie reaches the mgmt handler', async () => {
        const { adminAuth, SESSION_COOKIE } = await import('../lib/server/http/admin-auth');
        const token = adminAuth.createSession();
        const server = await importServer('admin');
        const { req, res, resData } = createReqRes('GET', '/$/volumes');
        req.headers.cookie = `${SESSION_COOKIE}=${token}`;
        mgmtHandle.mockResolvedValueOnce({ healthy: true });

        await server._handleHttpRequest(req, res);

        expect(mgmtHandle).toHaveBeenCalledTimes(1);
        expect(resData.status).toBe(200);
    });

    it('AUTH GATE: the login endpoint and static UI are reachable unauthenticated', async () => {
        const server = await importServer('admin');
        for (const path of ['/$/session', '/$/ui', '/$/ui/index.html', '/$/auth/status']) {
            mgmtHandle.mockResolvedValueOnce({ ok: true });
            const { req, res, resData } = createReqRes(path === '/$/session' ? 'POST' : 'GET', path);
            await server._handleHttpRequest(req, res);
            expect(resData.status, path).not.toBe(401);
        }
    });

    it('dispatches GET to ObjectGetRequest when object exists', async () => {
        const server = await importServer();
        const { req, res } = createReqRes('GET', '/object');
        httpHelpersGetObjectMeta.mockResolvedValueOnce(createFileRecord());

        await server._handleHttpRequest(req, res);

        expect(objectGet.ctor).toHaveBeenCalledTimes(1);
        expect(objectGet.process).toHaveBeenCalledTimes(1);
    });

    it('returns 404 when GET target is missing', async () => {
        const server = await importServer();
        const { req, res, resData } = createReqRes('GET', '/missing');
        httpHelpersGetObjectMeta.mockResolvedValueOnce(null);

        await server._handleHttpRequest(req, res);

        expect(resData.status).toBe(404);
        expect(resData.body).toBe('404');
    });

    it('rejects PUT without content-length', async () => {
        const server = await importServer();
        const { req, res, resData } = createReqRes('PUT', '/file');
        httpHelpersGetObjectMeta.mockResolvedValue(null);

        await server._handleHttpRequest(req, res);

        expect(resData.status).toBe(400);
        expect(resData.body).toBe('missing content-length');
    });

    it('rejects PUT when object already exists', async () => {
        const server = await importServer();
        const { req, res, resData } = createReqRes('PUT', '/file', { 'content-length': '10' });
        httpHelpersGetObjectMeta.mockResolvedValueOnce(createFileRecord());

        await server._handleHttpRequest(req, res);

        expect(resData.status).toBe(409);
        expect(resData.body).toBe('object exists');
        expect(objectPut.ctor).not.toHaveBeenCalled();
    });

    it('invokes ObjectDeleteRequest when file metadata exists', async () => {
        const server = await importServer();
        const { req, res } = createReqRes('DELETE', '/file');
        httpHelpersGetObjectMeta.mockResolvedValueOnce(createFileRecord());

        await server._handleHttpRequest(req, res);

        expect(objectDelete.ctor).toHaveBeenCalledTimes(1);
        expect(objectDelete.process).toHaveBeenCalledTimes(1);
    });

    it('returns 404 when DELETE target is missing', async () => {
        const server = await importServer();
        const { req, res, resData } = createReqRes('DELETE', '/file');
        httpHelpersGetObjectMeta.mockResolvedValueOnce(null);

        await server._handleHttpRequest(req, res);

        expect(resData.status).toBe(404);
    });

    it('dispatches HEAD requests to ObjectHeadRequest', async () => {
        const server = await importServer();
        const { req, res } = createReqRes('HEAD', '/file');
        httpHelpersGetObjectMeta.mockResolvedValueOnce(createFileRecord());

        await server._handleHttpRequest(req, res);

        expect(objectHead.ctor).toHaveBeenCalledTimes(1);
        expect(objectHead.process).toHaveBeenCalledTimes(1);
    });

    it('dispatches OPTIONS requests to ObjectOptionsRequest', async () => {
        const server = await importServer();
        const { req, res } = createReqRes('OPTIONS', '/file');
        httpHelpersGetObjectMeta.mockResolvedValueOnce(createFileRecord());

        await server._handleHttpRequest(req, res);

        expect(objectOptions.ctor).toHaveBeenCalledTimes(1);
        expect(objectOptions.process).toHaveBeenCalledTimes(1);
    });

    it('translates HttpMgmt bad requests into 400s', async () => {
        const server = await importServer();
        const { req, res, resData } = createReqRes('GET', '/$/volumes');
        req.headers.cookie = await authCookie();
        const { HttpBadRequestError } = await import('../lib/server/http/errors');
        mgmtHandle.mockRejectedValueOnce(new HttpBadRequestError('boom'));

        await server._handleHttpRequest(req, res);

        expect(resData.status).toBe(400);
        expect(resData.body).toBe('boom');
    });

    it('translates HttpMgmt not found into 404s', async () => {
        const server = await importServer();
        const { req, res, resData } = createReqRes('GET', '/$/volumes');
        req.headers.cookie = await authCookie();
        const { HttpNotFoundError } = await import('../lib/server/http/errors');
        mgmtHandle.mockRejectedValueOnce(new HttpNotFoundError('nope'));

        await server._handleHttpRequest(req, res);

        expect(resData.status).toBe(404);
        expect(resData.body).toBe('404');
    });

    it('falls back to 500 for unexpected HttpMgmt errors', async () => {
        const server = await importServer();
        const { req, res, resData } = createReqRes('GET', '/$/volumes');
        req.headers.cookie = await authCookie();
        mgmtHandle.mockRejectedValueOnce(new Error('kaboom'));

        await server._handleHttpRequest(req, res);

        expect(resData.status).toBe(500);
        expect(resData.body).toBe('500');
    });

    it('returns 500 when a request handler throws', async () => {
        const server = await importServer();
        const { req, res, resData } = createReqRes('GET', '/object');
        httpHelpersGetObjectMeta.mockResolvedValueOnce(createFileRecord());
        objectGet.process.mockRejectedValueOnce(new Error('explode'));

        await server._handleHttpRequest(req, res);

        expect(resData.status).toBe(500);
        expect(resData.body).toBe('500');
    });
});
