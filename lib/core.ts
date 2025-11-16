import { promises as fs } from 'fs';

import { config } from './config';
import { database } from './database';
import { ioManager } from './io/manager';
import { serverManager } from './server/manager';
import { verifyVolumesJob } from './jobs/verify-volumes-job';
import { createLogger } from './log';
import { volumeSmartMonitor } from './io/volume-smart-monitor';

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
            await this.createRunDirectory();
            await database.connect();
            await ioManager.init();
            await volumeSmartMonitor.start();
            await serverManager.start();
            await verifyVolumesJob.resumePendingJob();

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

            try {
                await this.deps.serverManager.stop();
            }
            catch (err) {
                stopError = err;
            }

            try {
                await verifyVolumesJob.stop();
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
