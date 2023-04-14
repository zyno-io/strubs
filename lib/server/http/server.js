const http = require('http');
const querystring = require('querystring');

const database = require('../../database');
const log = require('../../log')('http-server');

const HttpMgmt = require('./mgmt');
const ObjectGetRequest = require('./object-get-request');
const ObjectHeadRequest = require('./object-head-request');
// const ObjectOptionsRequest = require('./object-options-request');
const ObjectPutRequest = require('./object-put-request');
const ObjectDeleteRequest = require('./object-delete-request');
const { HttpBadRequestError, HttpNotFoundError } = require('./errors');

class HttpServer {
    constructor() {
        this.port = 80;

        this._requestCount = 0;

        this._server = http.createServer();
        this._server.on('listening', this._handleHttpListening.bind(this));
        this._server.on('close', this._handleHttpClose.bind(this));
        this._server.on('request', this._handleHttpRequest.bind(this));
    }

    start() {
        this._server.listen(this.port);
    }

    _handleHttpListening() {
        let address = this._server.address();
        log('listening on %s:%d', address.address, address.port);
    }

    _handleHttpClose() {
        log('stopped listening');
    }

    async _handleHttpRequest(req, res) {
        let requestId = ++this._requestCount;

        log('new request %d from %s:%d: %s %s', requestId, req.socket.remoteAddress, req.socket.remotePort, req.method, req.url);

        if (!this._validateUrl(req.url))
            return this._outputHttpBadRequest('malformed URL', req, res);

        let indexOfQ = req.url.indexOf('?');
        if (indexOfQ > -1) {
            let qs = req.url.substr(indexOfQ + 1);
            req.url = req.url.substr(0, indexOfQ);
            req.params = querystring.parse(qs);
        }
        else {
            req.params = {};
        }

        try {
            if (req.url.startsWith('/$mgmt/'))
                await this._handleHttpManagementRequest(requestId, req, res);
            else if (req.method == 'GET')
                await this._handleHttpGetRequest(requestId, req, res);
            else if (req.method == 'HEAD')
                await this._handleHttpHeadRequest(requestId, req, res);
            else if (req.method == 'OPTIONS')
                await this._handleHttpOptionsRequest(requestId, req, res);
            else if (req.method == 'PUT')
                await this._handleHttpPutRequest(requestId, req, res);
            else if (req.method == 'DELETE')
                await this._handleHttpDeleteRequest(requestId, req, res);
            else
                this._outputHttpBadRequest('unsupported method', req, res);
        }

        catch (err) {
            log.error('error processing request %d from %s:%d: %s %s', requestId, req.socket.remoteAddress, req.socket.remotePort, req.method, req.url, err);
            this._outputHttpInternalServerError(req, res);
        }
    }

    async _handleHttpManagementRequest(requestId, req, res) {
        try {
            const response = await HttpMgmt.handle(requestId, req, res);
            this._outputHttpContent(response, req, res);
        } catch (err) {
            if (err instanceof HttpBadRequestError) {
                this._outputHttpBadRequest(err.message, req, res);
            } else if (err instanceof HttpNotFoundError) {
                this._outputHttpNotFound(req, res);
            } else {
                this._outputHttpInternalServerError(err.message, req, res);
            }
        }
    }

    async _handleHttpGetRequest(requestId, req, res) {
        let objectMeta = await this._getObjectMeta(req.url);
        if (!objectMeta) return this._outputHttpNotFound(req, res);
        let request = new ObjectGetRequest(requestId, objectMeta, req, res);
        await request.process();
    }

    async _handleHttpHeadRequest(requestId, req, res) {
        let objectMeta = await this._getObjectMeta(req.url);
        if (!objectMeta) return this._outputHttpNotFound(req, res);
        let request = new ObjectHeadRequest(requestId, objectMeta, req, res);
        await request.process();
    }

    async _handleHttpOptionsRequest(requestId, req, res) {
        let objectMeta = await this._getObjectMeta(req.url);
        if (!objectMeta) return this._outputHttpNotFound(req, res);
        let request = new ObjectHeadRequest(requestId, objectMeta, req, res);
        await request.process();
    }

    async _handleHttpPutRequest(requestId, req, res) {
        if (!req.headers['content-length'])
            return this._outputHttpBadRequest('missing content-length');

        // fake header?
        // ^^ HUH???

        if (/^\/\$/.test(req.url))
            return this._outputHttpBadRequest('path cannot begin with $');

        // TODO: keep an internal cache of files currently being uploaded as not to trample them with the same name

        let objectMeta = await this._getObjectMeta(req.url);
        if (objectMeta) return this._outputHttpConflict('object exists', req, res);

        // ensure file doesn't already exist

        let request = new ObjectPutRequest(requestId, req, res);
        await request.process();
    }

    async _handleHttpDeleteRequest(requestId, req, res) {
        let objectMeta = await this._getObjectMeta(req.url);
        if (!objectMeta) return this._outputHttpNotFound(req, res);
        let request = new ObjectDeleteRequest(requestId, objectMeta, req, res);
        await request.process();
    }

    _outputHttpContent(content, req, res) {
        if (!content) {
            res.writeHead(204);
            return res.end();
        }

        if (content instanceof Buffer) {
            res.writeHead(200, 'OK', { 'content-type': 'application/octet-stream' });
            return res.end(content);
        }

        if (typeof content === 'object') {
            res.writeHead(200, 'OK', { 'content-type': 'application/json' });
            return res.end(JSON.stringify(content));
        }

        res.writeHead(200, 'OK', { 'content-type': 'text/plain' });
        res.end(String(content));
    }

    _outputHttpNotFound(req, res) {
        res.writeHead(404, 'Object Not Found');
        res.end('404');
    }

    _outputHttpBadRequest(message, req, res) {
        res.writeHead(400, 'Bad Request');
        res.end(message);
    }

    _outputHttpConflict(message, req, res) {
        res.writeHead(409, 'Conflict');
        res.end(message);
    }

    _outputHttpInternalServerError(req, res) {
        res.headersSent || res.writeHead(500, 'Internal Server Error');
        res.finished || res.end('500');
    }

    _validateUrl(url) {
        if (url.substr(0, 1) != '/')
            return false;
        if (url.includes('//') || url.includes('/./') || url.includes('/../'))
            return false;
        return true;
    }

    async _getObjectMeta(path) {
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

module.exports = HttpServer;
