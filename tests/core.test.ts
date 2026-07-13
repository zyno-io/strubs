import { beforeEach, describe, expect, it, vi } from 'vitest';

const mkdirMock = vi.fn();
const chmodMock = vi.fn().mockResolvedValue(undefined);
vi.mock('fs', () => ({
    promises: {
        mkdir: mkdirMock,
        chmod: chmodMock,
    },
}));

const loadIdentityMock = vi.fn();
// `identity` present = the normal startup path. A null identity puts core into RECOVERY mode (fleet and
// object API stay down), which has its own test below.
const configMock: { loadIdentity: typeof loadIdentityMock; identity: string | null; bootstrapManifestIntervalMs: number } = {
    loadIdentity: loadIdentityMock,
    identity: 'a'.repeat(32),
    bootstrapManifestIntervalMs: 0,
};
vi.mock('../lib/config', () => ({
    config: configMock,
}));

const manifestWriteMock = vi.fn().mockResolvedValue(undefined);
const manifestStartPeriodicMock = vi.fn();
const manifestSetJournalIdsMock = vi.fn();
const manifestHydrateMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/io/bootstrap-manifest', () => ({
    bootstrapManifestWriter: {
        write: manifestWriteMock,
        startPeriodic: manifestStartPeriodicMock,
        stopPeriodic: vi.fn(),
        setJournalVolumeIds: manifestSetJournalIdsMock,
        // Read the snapshot pointer back off the platters at startup. Without it, the periodic refresh
        // would overwrite every manifest in the array with `snapshot: null` and orphan the snapshot.
        hydrateFromDisk: manifestHydrateMock,
    },
}));

const journalStartMock = vi.fn().mockResolvedValue(undefined);
const journalStopMock = vi.fn().mockResolvedValue(undefined);
const journalFlushMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/io/journal', () => ({
    journal: {
        start: journalStartMock,
        stop: journalStopMock,
        flush: journalFlushMock,
        replicaVolumeIds: [4, 17, 23],
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
const verifyPauseForRebalanceMock = vi.fn();
vi.mock('../lib/jobs/verify-volumes-job', () => ({
    verifyVolumesJob: {
        resumePendingJob: verifyResumeMock,
        stop: verifyStopMock,
        pauseForRebalance: verifyPauseForRebalanceMock
    }
}));

const drainResumeMock = vi.fn();
const drainStopMock = vi.fn();
vi.mock('../lib/jobs/drain-volume-job', () => ({
    drainVolumeJob: {
        resumePendingJob: drainResumeMock,
        stop: drainStopMock
    }
}));

const rebalanceResumeMock = vi.fn();
const rebalanceStopMock = vi.fn();
// A pending rebalance owns the disks -> startup parks the scrub before resuming it.
const rebalanceHasPendingMock = vi.fn().mockResolvedValue(false);
vi.mock('../lib/jobs/rebalance-job', () => ({
    rebalanceJob: {
        resumePendingJob: rebalanceResumeMock,
        stop: rebalanceStopMock,
        hasPendingRun: rebalanceHasPendingMock
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

// Mock the reconciler: its real start() spawns a persistent `udevadm monitor` subprocess, which would
// leak (orphan to init) when the test worker exits since these tests don't call core.stop().
const deviceReconcilerStartMock = vi.fn();
const deviceReconcilerStopMock = vi.fn();
vi.mock('../lib/io/device-reconciler', () => ({
    deviceReconciler: {
        start: deviceReconcilerStartMock,
        stop: deviceReconcilerStopMock
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

const adminBootstrapMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/server/http/admin-auth', () => ({
    adminAuth: { bootstrap: adminBootstrapMock },
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
        configMock.identity = 'a'.repeat(32);   // default: identity present -> normal startup
        manifestWriteMock.mockClear();
        manifestStartPeriodicMock.mockClear();
        manifestSetJournalIdsMock.mockClear();
        manifestHydrateMock.mockClear();
        journalStartMock.mockClear();
        journalStopMock.mockClear();
        journalFlushMock.mockClear();
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
        verifyPauseForRebalanceMock.mockReset();
        rebalanceHasPendingMock.mockReset();
        rebalanceHasPendingMock.mockResolvedValue(false);
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

    it('parks the scrub at startup when a rebalance is pending, rather than starting it to be killed', async () => {
        rebalanceHasPendingMock.mockResolvedValueOnce(true);
        const { Core } = await import('../lib/core');
        const core = new Core();

        await core.start();

        // Must be blocked BEFORE the resume, or the scrub launches and the resuming rebalance
        // immediately stops it again.
        expect(verifyPauseForRebalanceMock).toHaveBeenCalled();
        expect(verifyPauseForRebalanceMock.mock.invocationCallOrder[0])
            .toBeLessThan(verifyResumeMock.mock.invocationCallOrder[0]);
    });

    it('does not park the scrub at startup when no rebalance is pending', async () => {
        rebalanceHasPendingMock.mockResolvedValueOnce(false);
        const { Core } = await import('../lib/core');
        const core = new Core();

        await core.start();

        expect(verifyPauseForRebalanceMock).not.toHaveBeenCalled();
        expect(verifyResumeMock).toHaveBeenCalled();
    });

    it('performs the full startup sequence', async () => {
        const { Core } = await import('../lib/core');
        const core = new Core();

        await core.start();

        expect(loadIdentityMock).toHaveBeenCalledTimes(1);
        expect(mkdirMock).toHaveBeenCalledWith('/run/strubs', { mode: 0o700 });
        expect(connectMock).toHaveBeenCalledTimes(1);
        expect(ioInitMock).toHaveBeenCalledTimes(1);
        expect(smartMonitorStartMock).toHaveBeenCalledTimes(1);
        expect(serverStartMock).toHaveBeenCalledTimes(1);
        expect(verifyResumeMock).toHaveBeenCalledTimes(1);
        expect(storageStatsStartMock).toHaveBeenCalledTimes(1);
        // The fleet is up, so the bootstrap manifest is refreshed on every writable disk.
        expect(manifestWriteMock).toHaveBeenCalled();
        // The journal must be running BEFORE the object API accepts a write -- a PUT that lands before it
        // is a namespace change nobody recorded -- and its replica set is recorded in the manifest so a
        // recovery knows which disks to look on.
        expect(journalStartMock).toHaveBeenCalled();
        expect(manifestSetJournalIdsMock).toHaveBeenCalledWith([4, 17, 23]);
    });

    // A rebuilt host with no /var/lib/strubs/identity must NOT crash (it could never reach the UI that
    // offers to restore it) and must NOT start the fleet or the object API -- it cannot verify a single
    // disk, and it must never generate a replacement identity (that orphans every disk permanently).
    // Stopping the journal before the servers would leave the object API accepting writes while append()
    // is a no-op -- so a PUT arriving in that window commits to Mongo with NO journal record, which is
    // exactly the unjournaled namespace change the whole phase exists to prevent.
    it('stops the SERVERS before the journal, so no write can land unjournaled during shutdown', async () => {
        const { Core } = await import('../lib/core');
        const core = new Core();
        await core.start();
        await core.stop();

        expect(serverStopMock).toHaveBeenCalled();
        expect(journalStopMock).toHaveBeenCalled();
        expect(serverStopMock.mock.invocationCallOrder[0])
            .toBeLessThan(journalStopMock.mock.invocationCallOrder[0]);
    });

    // ...and stopping the servers in the right ORDER is not the same as stopping them SUCCESSFULLY.
    // ServerManager stops in reverse, so the object listener goes last: if FUSE or admin rejects first,
    // the object API can still be live. Pressing on with the shutdown then does three separate kinds of
    // damage, so the whole thing ABORTS instead.
    it('ABORTS the shutdown when the servers fail to stop, leaving everything up', async () => {
        serverStopMock.mockRejectedValue(new Error('FUSE unmount failed: device busy'));

        const { Core } = await import('../lib/core');
        const core = new Core();
        await core.start();
        await expect(core.stop()).rejects.toThrow('device busy');

        // A listener may still be accepting writes, so:
        expect(journalStopMock).not.toHaveBeenCalled();   // ...append() must not become a no-op
        expect(ioStopMock).not.toHaveBeenCalled();        // ...and the volumes must not be unmounted under it
        expect(journalFlushMock).toHaveBeenCalled();      // but acknowledged records still reach the platter

        // `started` must stay TRUE, or a retry would return early and never finish the job.
        serverStopMock.mockResolvedValue(undefined);
        await core.stop();
        expect(serverStopMock).toHaveBeenCalledTimes(2);  // the retry actually retried
        expect(journalStopMock).toHaveBeenCalled();       // ...and this time it completed
    });

    it('enters RECOVERY mode when there is no instance identity: admin surface only, no fleet', async () => {
        configMock.identity = null;

        const { Core } = await import('../lib/core');
        const core = new Core();

        await core.start();      // must not throw

        expect(ioInitMock).not.toHaveBeenCalled();          // fleet NOT started
        expect(smartMonitorStartMock).not.toHaveBeenCalled();
        expect(storageStatsStartMock).not.toHaveBeenCalled();
        expect(manifestWriteMock).not.toHaveBeenCalled();   // nothing to write without an identity
        expect(journalStartMock).not.toHaveBeenCalled();    // no fleet to journal onto
        expect(serverStartMock).toHaveBeenCalledWith({ recovery: true });   // admin-only
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

        expect(mkdirMock).toHaveBeenCalledWith('/run/strubs', { mode: 0o700 });
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
