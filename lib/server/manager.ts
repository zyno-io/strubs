import { HttpServer } from './http/server';
import { config } from '../config';
import { createLogger } from '../log';
import { ensureTlsMaterial } from './tls';

const log = createLogger('server-manager');

type ServerLifecycle = {
    start: () => void | Promise<void>;
    stop?: () => void | Promise<void>;
};

type MaybeServer = ServerLifecycle | null;
type ServerManagerDeps = {
    // The object API and the admin surface are separate origins (own port + scheme) -- see tls.ts and
    // the auth design. Object API is HTTP on config.httpPort; admin (management + UI) is HTTPS-only on
    // config.adminPort, so object-hosted script can never reach the admin cookie.
    createObjectServer: () => ServerLifecycle;
    createAdminServer: () => Promise<ServerLifecycle>;
    // A root-only Unix socket serving the admin API with NO credential check -- local ops and lockout
    // recovery. The boundary is filesystem permissions (0600 root), which a reverse proxy or SSRF
    // cannot inherit the way a localhost TCP port could.
    createAdminSocketServer: () => ServerLifecycle;
    // Returns null when FUSE is disabled. The import is dynamic so that a disabled FUSE never loads the
    // native fuse-native binding (fuse-native/index.js pulls it in at require-time) -- STRUBS then runs
    // on a host with no /dev/fuse or no binding built. Object access is unaffected.
    createFuseServer: () => MaybeServer | Promise<MaybeServer>;
};

const defaultDeps: ServerManagerDeps = {
    createObjectServer: () => new HttpServer(config.httpPort, undefined, undefined, { role: 'object' }),
    createAdminServer: async () => {
        const tls = await ensureTlsMaterial();
        return new HttpServer(config.adminPort, undefined, undefined, { role: 'admin', tls });
    },
    createAdminSocketServer: () => new HttpServer(config.adminSocketPath, undefined, undefined, { role: 'admin', trusted: true }),
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

    // `recovery` brings up the ADMIN surface only. Used when the host has no instance identity: the fleet
    // cannot be verified, so the object API and FUSE -- both of which would serve an array we cannot vouch
    // for -- must stay down until an operator restores the identity from a bootstrap manifest.
    async start(opts: { recovery?: boolean } = {}): Promise<void> {
        if (this.servers.length)
            return;
        if (this.starting)
            return this.starting;
        this.starting = this._startServers(opts);
        try {
            await this.starting;
        }
        finally {
            this.starting = null;
        }
    }

    private async _startServers(opts: { recovery?: boolean }): Promise<void> {
        log('starting server manager');
        const adminServer = await this.deps.createAdminServer();
        const adminSocketServer = this.deps.createAdminSocketServer();

        if (opts.recovery) {
            log.error('RECOVERY MODE: serving the admin surface ONLY -- object API and FUSE are not started');
            this.servers = [adminServer, adminSocketServer];
        }
        else {
            const objectServer = this.deps.createObjectServer();
            const fuseServer = await this.deps.createFuseServer();
            if (!fuseServer)
                log('FUSE disabled: the HTTP object API is the only local access path (set STRUBS_FUSE_ENABLED=true to mount)');
            this.servers = [objectServer, adminServer, adminSocketServer, ...(fuseServer ? [fuseServer] : [])];
        }

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
