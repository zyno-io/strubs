import { beforeEach, describe, expect, it, vi } from 'vitest';

const mkdirMock = vi.fn();
vi.mock('fs', () => ({
    promises: {
        mkdir: mkdirMock,
    },
}));

const loadIdentityMock = vi.fn();
vi.mock('../lib/config', () => ({
    config: {
        loadIdentity: loadIdentityMock,
    },
}));

const connectMock = vi.fn();
vi.mock('../lib/database', () => ({
    database: {
        connect: connectMock,
    },
}));

const ioInitMock = vi.fn();
const ioStopMock = vi.fn();
vi.mock('../lib/io/manager', () => ({
    ioManager: {
        init: ioInitMock,
        stop: ioStopMock
    },
}));

const verifyResumeMock = vi.fn();
const verifyStopMock = vi.fn();
vi.mock('../lib/jobs/verify-volumes-job', () => ({
    verifyVolumesJob: {
        resumePendingJob: verifyResumeMock,
        stop: verifyStopMock
    }
}));

const evictResumeMock = vi.fn();
const evictStopMock = vi.fn();
vi.mock('../lib/jobs/evict-volume-job', () => ({
    evictVolumeJob: {
        resumePendingJob: evictResumeMock,
        stop: evictStopMock
    }
}));

const smartMonitorStartMock = vi.fn();
const smartMonitorStopMock = vi.fn();
vi.mock('../lib/io/volume-smart-monitor', () => ({
    volumeSmartMonitor: {
        start: smartMonitorStartMock,
        stop: smartMonitorStopMock
    }
}));

const storageStatsStartMock = vi.fn();
const storageStatsStopMock = vi.fn();
vi.mock('../lib/storage/stats-tracker', () => ({
    storageStatsTracker: {
        start: storageStatsStartMock,
        stop: storageStatsStopMock
    }
}));

const serverStartMock = vi.fn();
const serverStopMock = vi.fn();
vi.mock('../lib/server/manager', () => ({
    serverManager: {
        start: serverStartMock,
        stop: serverStopMock,
    },
}));

const createLoggerMock = vi.fn(() => {
    const logger = vi.fn();
    logger.error = vi.fn();
    return logger;
});

vi.mock('../lib/log', () => ({
    createLogger: createLoggerMock,
}));

describe('Core', () => {
    beforeEach(() => {
        vi.resetModules();
        loadIdentityMock.mockReset();
        connectMock.mockReset();
        ioInitMock.mockReset();
        ioStopMock.mockReset();
        serverStartMock.mockReset();
        serverStopMock.mockReset();
        mkdirMock.mockReset();
        mkdirMock.mockResolvedValue();
        verifyResumeMock.mockReset();
        verifyStopMock.mockReset();
        smartMonitorStartMock.mockReset();
        smartMonitorStopMock.mockReset();
        storageStatsStartMock.mockReset();
        storageStatsStopMock.mockReset();
        loadIdentityMock.mockResolvedValue(undefined);
        connectMock.mockResolvedValue(undefined);
        ioInitMock.mockResolvedValue(undefined);
        ioStopMock.mockResolvedValue(undefined);
        serverStartMock.mockResolvedValue(undefined);
        serverStopMock.mockResolvedValue(undefined);
        smartMonitorStartMock.mockResolvedValue(undefined);
        smartMonitorStopMock.mockResolvedValue(undefined);
        storageStatsStopMock.mockResolvedValue(undefined);
    });

    it('performs the full startup sequence', async () => {
        const { Core } = await import('../lib/core');
        const core = new Core();

        await core.start();

        expect(loadIdentityMock).toHaveBeenCalledTimes(1);
        expect(mkdirMock).toHaveBeenCalledWith('/run/strubs');
        expect(connectMock).toHaveBeenCalledTimes(1);
        expect(ioInitMock).toHaveBeenCalledTimes(1);
        expect(smartMonitorStartMock).toHaveBeenCalledTimes(1);
        expect(serverStartMock).toHaveBeenCalledTimes(1);
        expect(verifyResumeMock).toHaveBeenCalledTimes(1);
        expect(storageStatsStartMock).toHaveBeenCalledTimes(1);
    });

    it('treats EEXIST as a successful run directory creation', async () => {
        const existsError = Object.assign(new Error('exists'), { code: 'EEXIST' });
        mkdirMock.mockRejectedValueOnce(existsError);

        const { Core } = await import('../lib/core');
        const core = new Core();

        await core.start();

        expect(connectMock).toHaveBeenCalledTimes(1);
        expect(serverStartMock).toHaveBeenCalledTimes(1);
        expect(verifyResumeMock).toHaveBeenCalledTimes(1);
    });

    it('propagates failures from startup operations', async () => {
        const failure = new Error('boom');
        loadIdentityMock.mockRejectedValueOnce(failure);

        const { Core } = await import('../lib/core');
        const core = new Core();

        await expect(core.start()).rejects.toBe(failure);

        expect(serverStartMock).not.toHaveBeenCalled();
    });

    it('propagates downstream initialization failures', async () => {
        const downstreamFailure = new Error('io fail');
        ioInitMock.mockRejectedValueOnce(downstreamFailure);

        const { Core } = await import('../lib/core');
        const core = new Core();

        await expect(core.start()).rejects.toBe(downstreamFailure);

        expect(mkdirMock).toHaveBeenCalledWith('/run/strubs');
        expect(serverStartMock).not.toHaveBeenCalled();
        expect(verifyResumeMock).not.toHaveBeenCalled();
    });

    it('stops the server manager when requested', async () => {
        const { Core } = await import('../lib/core');
        const core = new Core();

        await core.start();
        await core.stop();

        expect(serverStopMock).toHaveBeenCalledTimes(1);
        expect(smartMonitorStopMock).toHaveBeenCalledTimes(1);
        expect(ioStopMock).toHaveBeenCalledTimes(1);
        expect(verifyStopMock).toHaveBeenCalledTimes(1);
        expect(storageStatsStopMock).toHaveBeenCalledTimes(1);
    });

    it('ignores stop when start has not completed', async () => {
        const { Core } = await import('../lib/core');
        const core = new Core();

        await core.stop();

        expect(serverStopMock).not.toHaveBeenCalled();
        expect(ioStopMock).not.toHaveBeenCalled();
        expect(verifyStopMock).not.toHaveBeenCalled();
        expect(storageStatsStopMock).not.toHaveBeenCalled();
    });
});
