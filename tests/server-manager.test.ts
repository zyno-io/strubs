import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerFactory = vi.fn(() => {
    const logger = vi.fn();
    logger.error = vi.fn();
    return logger;
});

vi.mock('../lib/log', () => ({
    createLogger: loggerFactory,
}));

const httpStartMock = vi.fn();
const httpStopMock = vi.fn();
const fuseStartMock = vi.fn();
const fuseStopMock = vi.fn();
const adminStartMock = vi.fn();
const adminStopMock = vi.fn();
const socketStartMock = vi.fn();
const socketStopMock = vi.fn();

const HttpServerMock = vi.fn(function () {
    return {
        start: httpStartMock,
        stop: httpStopMock,
    };
});

const FuseServerMock = vi.fn(function () {
    return {
        start: fuseStartMock,
        stop: fuseStopMock,
    };
});

vi.mock('../lib/server/http/server', () => ({
    HttpServer: HttpServerMock,
}));

vi.mock('../lib/server/fuse/server', () => ({
    FuseServer: FuseServerMock,
}));

describe('serverManager', () => {
    beforeEach(() => {
        vi.resetModules();
        httpStartMock.mockClear();
        httpStopMock.mockClear();
        fuseStartMock.mockClear();
        fuseStopMock.mockClear();
        adminStartMock.mockClear();
        adminStopMock.mockClear();
        socketStartMock.mockClear();
        socketStopMock.mockClear();
        HttpServerMock.mockClear();
        FuseServerMock.mockClear();
    });

    it('starts both HTTP and FUSE servers when FUSE is enabled', async () => {
        const { ServerManager } = await import('../lib/server/manager');
        const manager = new ServerManager({
            createObjectServer: () => ({ start: httpStartMock, stop: httpStopMock }),
            createAdminServer: async () => ({ start: adminStartMock, stop: adminStopMock }),
            createAdminSocketServer: () => ({ start: socketStartMock, stop: socketStopMock }),
            createFuseServer: () => ({ start: fuseStartMock, stop: fuseStopMock })
        });

        await manager.start();

        expect(httpStartMock).toHaveBeenCalledTimes(1);
        expect(fuseStartMock).toHaveBeenCalledTimes(1);
    });

    it('awaits an async createFuseServer (the default lazy-imports the native binding)', async () => {
        const { ServerManager } = await import('../lib/server/manager');
        const manager = new ServerManager({
            createObjectServer: () => ({ start: httpStartMock, stop: httpStopMock }),
            createAdminServer: async () => ({ start: adminStartMock, stop: adminStopMock }),
            createAdminSocketServer: () => ({ start: socketStartMock, stop: socketStopMock }),
            createFuseServer: async () => ({ start: fuseStartMock, stop: fuseStopMock })
        });

        await manager.start();

        expect(fuseStartMock).toHaveBeenCalledTimes(1);
    });

    it('runs HTTP-only when FUSE is disabled (createFuseServer returns null)', async () => {
        const { ServerManager } = await import('../lib/server/manager');
        const manager = new ServerManager({
            createObjectServer: () => ({ start: httpStartMock, stop: httpStopMock }),
            createAdminServer: async () => ({ start: adminStartMock, stop: adminStopMock }),
            createAdminSocketServer: () => ({ start: socketStartMock, stop: socketStopMock }),
            createFuseServer: () => null   // STRUBS_FUSE_ENABLED=false
        });

        await manager.start();

        expect(httpStartMock).toHaveBeenCalledTimes(1);
        expect(fuseStartMock).not.toHaveBeenCalled();

        // stop() must not choke on the absent FUSE server
        await manager.stop();
        expect(httpStopMock).toHaveBeenCalledTimes(1);
    });

    it('stops all managed servers', async () => {
        const { ServerManager } = await import('../lib/server/manager');
        const manager = new ServerManager({
            createObjectServer: () => ({ start: httpStartMock, stop: httpStopMock }),
            createAdminServer: async () => ({ start: adminStartMock, stop: adminStopMock }),
            createAdminSocketServer: () => ({ start: socketStartMock, stop: socketStopMock }),
            createFuseServer: () => ({ start: fuseStartMock, stop: fuseStopMock })
        });

        await manager.start();
        await manager.stop();

        expect(httpStopMock).toHaveBeenCalledTimes(1);
        expect(fuseStopMock).toHaveBeenCalledTimes(1);
    });

    it('does not restart servers when start is called twice', async () => {
        const { ServerManager } = await import('../lib/server/manager');
        const createObjectServer = vi.fn(() => ({ start: httpStartMock, stop: httpStopMock }));
        const manager = new ServerManager({
            createObjectServer,
            createAdminServer: async () => ({ start: adminStartMock, stop: adminStopMock }),
            createAdminSocketServer: () => ({ start: socketStartMock, stop: socketStopMock }),
            createFuseServer: () => ({ start: fuseStartMock, stop: fuseStopMock })
        });

        await manager.start();
        await manager.start();

        expect(createObjectServer).toHaveBeenCalledTimes(1);
    });
});
