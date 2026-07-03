import { promises as fs } from 'fs';

import { config } from './config';
import { database } from './database';
import { ioManager } from './io/manager';
import { serverManager } from './server/manager';
import { verifyVolumesJob } from './jobs/verify-volumes-job';
import { drainVolumeJob } from './jobs/drain-volume-job';
import { rebalanceJob } from './jobs/rebalance-job';
import { verifyScheduler } from './jobs/verify-scheduler';
import { createLogger } from './log';
import { volumeSmartMonitor } from './io/volume-smart-monitor';
import { systemLogWatcher } from './io/system-log-watcher';
import { volumeHealthMonitor } from './io/volume-health-monitor';
import { configureNotifications } from './notify/bootstrap';
import { remediationService } from './remediation/service';
import { repairWorker } from './remediation/repair-worker';
import { storageStatsTracker } from './storage/stats-tracker';
import { isMaintenanceFrozen } from './maintenance';

const log = createLogger('core');

type CoreDependencies = {
    config: typeof config;
    fs: typeof fs;
    database: typeof database;
    ioManager: typeof ioManager;
    serverManager: typeof serverManager;
    volumeSmartMonitor: typeof volumeSmartMonitor;
};

const defaultDeps: CoreDependencies = {
    config,
    fs,
    database,
    ioManager,
    serverManager,
    volumeSmartMonitor
};

export class Core {
    private readonly deps: CoreDependencies;
    private startPromise: Promise<void> | null = null;
    private stopPromise: Promise<void> | null = null;
    private started = false;

    constructor(deps?: Partial<CoreDependencies>) {
        this.deps = { ...defaultDeps, ...deps } as CoreDependencies;
    }

    async start(): Promise<void> {
        if (this.started)
            return;
        if (this.startPromise)
            return this.startPromise;

        this.startPromise = (async () => {
            const { config, database, ioManager, serverManager, volumeSmartMonitor } = this.deps;
            log('starting up STRUBS...');

            await config.loadIdentity();
            configureNotifications(config);
            await this.createRunDirectory();
            await database.connect();
            await remediationService.hydrate();
            await ioManager.init();
            await volumeSmartMonitor.start();
            // Resume any pending verify run before exposing HTTP, so an inbound
            // verify/scrub request can't race the resume for job state.
            await verifyVolumesJob.resumePendingJob();
            await serverManager.start();
            // Maintenance freeze gates ALL automatic verify+repair at startup: with
            // the flag set we never start the scheduler or repair worker, so the
            // persisted freeze survives a restart.
            const frozen = await isMaintenanceFrozen();
            if (frozen)
                log('maintenance freeze active: NOT starting verify scheduler or repair worker');
            else {
                // Drains run BEFORE routine maintenance: resume a pending drain first so the
                // scrub/repair doesn't fight it, then start the scheduler.
                await drainVolumeJob.resumePendingJob();
                verifyScheduler.start(config.scrubIntervalMs);
            }
            systemLogWatcher.start(config.systemLogWatchIntervalMs);
            if (!frozen) {
                repairWorker.start(config.repairIntervalMs, {
                    batchSize: config.repairBatchSize,
                    backlogDelayMs: config.repairBacklogDelayMs,
                    blockedRetryMs: config.repairBlockedRetryMs
                });
                // Rebalance is optional housekeeping — resume last, after drain + verify + repair.
                await rebalanceJob.resumePendingJob();
            }
            volumeHealthMonitor.start(config.volumeHealthIntervalMs, config.volumeFaultThreshold);
            storageStatsTracker.start({
                reconcileIntervalMs: config.storageStatsIntervalMs,
                flushIntervalMs: config.storageStatsFlushIntervalMs
            });

            this.started = true;
            log('STRUBS started.');
        })();

        try {
            await this.startPromise;
        }
        finally {
            this.startPromise = null;
        }
    }

    async stop(): Promise<void> {
        if (!this.started)
            return;
        if (this.stopPromise)
            return this.stopPromise;

        this.stopPromise = (async () => {
            let stopError: unknown = null;

            verifyScheduler.stop();
            systemLogWatcher.stop();
            repairWorker.stop();
            volumeHealthMonitor.stop();

            try {
                await this.deps.serverManager.stop();
            }
            catch (err) {
                stopError = err;
            }

            try {
                await storageStatsTracker.stop();
            }
            catch (err) {
                if (!stopError)
                    stopError = err;
            }

            try {
                await verifyVolumesJob.stop({ preserveState: true });
            }
            catch (err) {
                if (!stopError)
                    stopError = err;
            }

            try {
                await this.deps.volumeSmartMonitor.stop();
            }
            catch (err) {
                if (!stopError)
                    stopError = err;
            }

            try {
                await this.deps.ioManager.stop();
            }
            catch (err) {
                if (!stopError)
                    stopError = err;
            }

            this.started = false;

            if (stopError)
                throw stopError;
        })();

        try {
            await this.stopPromise;
        }
        finally {
            this.stopPromise = null;
        }
    }

    private async createRunDirectory(): Promise<void> {
        const { fs } = this.deps;
        log('creating runtime directory...');

        try {
            await fs.mkdir('/run/strubs');
            log('runtime directory created');
        }
        catch (err) {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code === 'EEXIST') {
                log('runtime directory exists');
                return;
            }

            throw err;
        }
    }
}
