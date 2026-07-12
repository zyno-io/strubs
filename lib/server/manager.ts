import { HttpServer } from './http/server';
import { config } from '../config';
import { createLogger } from '../log';

const log = createLogger('server-manager');

type ServerLifecycle = {
    start: () => void | Promise<void>;
    stop?: () => void | Promise<void>;
};

type MaybeServer = ServerLifecycle | null;
type ServerManagerDeps = {
    createHttpServer: () => ServerLifecycle;
    // Returns null when FUSE is disabled. The import is dynamic so that a disabled FUSE never loads the
    // native fuse-native binding (fuse-native/index.js pulls it in at require-time) -- STRUBS then runs
    // on a host with no /dev/fuse or no binding built. Object access is unaffected.
    createFuseServer: () => MaybeServer | Promise<MaybeServer>;
};

const defaultDeps: ServerManagerDeps = {
    createHttpServer: () => new HttpServer(),
    createFuseServer: () => {
        if (!config.fuseEnabled)
            return null;
        // Lazy require (not a top-level import) so the native fuse-native binding is loaded only when
        // FUSE is actually enabled -- matches the codebase's lazy-load idiom (see repair-worker).
        const { FuseServer } = require('./fuse/server') as typeof import('./fuse/server');
        return new FuseServer();
    }
};

export class ServerManager {
    private readonly deps: ServerManagerDeps;
    private servers: ServerLifecycle[] = [];
    private starting: Promise<void> | null = null;
    private stopping: Promise<void> | null = null;

    constructor(deps?: Partial<ServerManagerDeps>) {
        this.deps = { ...defaultDeps, ...deps };
    }

    async start(): Promise<void> {
        if (this.servers.length)
            return;
        if (this.starting)
            return this.starting;
        this.starting = this._startServers();
        try {
            await this.starting;
        }
        finally {
            this.starting = null;
        }
    }

    private async _startServers(): Promise<void> {
        log('starting server manager');
        const httpServer = this.deps.createHttpServer();
        const fuseServer = await this.deps.createFuseServer();
        if (!fuseServer)
            log('FUSE disabled: the HTTP object API is the only access path (set STRUBS_FUSE_ENABLED=true to mount)');
        this.servers = fuseServer ? [httpServer, fuseServer] : [httpServer];
        for (const server of this.servers)
            await Promise.resolve(server.start());
    }

    async stop(): Promise<void> {
        if (!this.servers.length)
            return;
        if (this.stopping)
            return this.stopping;

        this.stopping = (async () => {
            for (const server of [...this.servers].reverse()) {
                if (server.stop)
                    await Promise.resolve(server.stop());
            }
            this.servers = [];
        })();

        try {
            await this.stopping;
        }
        finally {
            this.stopping = null;
        }
    }
}

export const serverManager = new ServerManager();
