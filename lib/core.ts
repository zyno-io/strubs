import { promises as fs } from 'fs';

import { config } from './config';
import { database } from './database';
import { ioManager } from './io/manager';
import { serverManager } from './server/manager';
import { adminAuth } from './server/http/admin-auth';
import { verifyVolumesJob } from './jobs/verify-volumes-job';
import { drainVolumeJob } from './jobs/drain-volume-job';
import { rebalanceJob } from './jobs/rebalance-job';
import { verifyScheduler } from './jobs/verify-scheduler';
import { createLogger } from './log';
import { volumeSmartMonitor } from './io/volume-smart-monitor';
import { systemLogWatcher } from './io/system-log-watcher';
import { volumeHealthMonitor } from './io/volume-health-monitor';
import { deviceReconciler } from './io/device-reconciler';
import { bootstrapManifestWriter } from './io/bootstrap-manifest';
import { journal } from './io/journal';
import { snapshotJob } from './jobs/snapshot-job';
import { configureNotifications } from './notify/bootstrap';
import { remediationService } from './remediation/service';
import { repairWorker } from './remediation/repair-worker';
import { storageStatsTracker } from './storage/stats-tracker';
import { isMaintenanceFrozen } from './maintenance';
import { HttpMgmt } from './server/http/mgmt';

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

            // No instance identity => this host cannot verify a single disk. Starting the fleet would
            // reject every volume ("not from this STRUBS instance"), and starting the object API would
            // expose an array we cannot vouch for. So: bring up the ADMIN surface only, and let an
            // operator restore the identity from a volume's bootstrap manifest. We never generate one --
            // a fresh identity permanently orphans every disk in the array.
            // A HALF-WRITTEN VOLUME TABLE IS THE SAME EMERGENCY, and it is a worse one, because this host has
            // an identity and would otherwise come up looking entirely healthy.
            //
            // A fleet restore that died part-way leaves Mongo holding a volume table that is well-formed,
            // internally consistent, and describes an array a third of its real size. Starting normally on that
            // table does three things, in ascending order of horror:
            //
            //   - the missing disks are not "unmounted", they are UNKNOWN, so nothing refuses on their behalf;
            //   - every object living on them reads as data loss, on an array that has lost nothing;
            //   - and then the periodic manifest write below serialises that partial table and stamps it onto
            //     EVERY remaining disk -- overwriting the good manifests, which are the only record of the
            //     disks it forgot. The array would destroy its own map of itself while reporting for duty.
            //
            // That last one is a WRITE, to every disk, of provably wrong data. So the marker gates startup,
            // not just the recovery jobs: admin surface only, no fleet, no journal, no manifest writes, until
            // an operator finishes the restore.
            //
            // NOTE the difference between THIS emergency and the namespace one further down. Here the VOLUME
            // TABLE is untrustworthy, so the fleet must not come up at all. There, the volume table is fine and
            // the fleet MUST come up -- because reading the snapshot off the platters is the entire point.
            const interrupted = await database.fleetRestoreIncomplete();
            if (interrupted) {
                log.error('RECOVERY MODE: a fleet restore started %s did not finish, so the volume table may be '
                    + 'missing disks. NOT starting the fleet, the journal, the object API, or any manifest write: '
                    + 'a partial table published to the platters would overwrite the only record of the disks it '
                    + 'does not know about. Re-run the fleet recovery to finish it.', interrupted.startedAt);
                await adminAuth.bootstrap();
                await serverManager.start({ recovery: true });
                this.started = true;
                log('STRUBS started in RECOVERY mode (incomplete fleet restore).');
                return;
            }

            if (!config.identity) {
                log.error('RECOVERY MODE: no instance identity; NOT starting the fleet or the object API');
                await adminAuth.bootstrap();
                await serverManager.start({ recovery: true });
                this.started = true;
                log('STRUBS started in RECOVERY mode.');
                return;
            }

            await ioManager.init();

            // Read the manifest back off the disks BEFORE anything writes one. The snapshot pointer lives in
            // memory, and the periodic refresh writes memory out to every volume -- so a process that came up
            // not knowing about the snapshot would erase it from all 29 of them within the minute, leaving
            // 127MB of erasure-coded namespace on the platters that nothing knows the name of.
            await bootstrapManifestWriter.hydrateFromDisk().catch(err =>
                log.error('could not read the manifest back off the platters: %s', err));

            // THE FLEET IS BACK. THE NAMES ARE NOT.
            //
            // A fleet restore mounts the disks; it does not put a single name back. Start normally on that
            // still-empty database and the snapshot job wakes up on schedule, snapshots the nothing it can see,
            // verifies it perfectly, and MOVES THE MANIFEST POINTER TO IT -- on every disk. The real snapshot,
            // the one holding all 3.5 million names, is still on the platters and nothing alive knows where.
            // The recovery system would have destroyed the namespace it exists to restore, and it would have
            // done it in the first five minutes, while the operator was making a cup of tea.
            //
            // THE FLEET COMES UP FIRST, AND THAT IS THE WHOLE POINT.
            //
            // The first version of this check ran BEFORE ioManager.init() and before the manifest was hydrated,
            // which bricked the array: the restore that is the ONLY way to clear this marker needs the disks
            // mounted (to read the snapshot object off the platters) and needs the manifest hydrated (to know
            // WHICH object). Neither had happened. The marker blocked the only thing that could clear it, and
            // the array sat in recovery mode forever. A safety net you cannot climb out of is a trap.
            //
            // So: the disks mount, the manifest is read, and then we stop. No journal, no object API, no
            // snapshot job, no manifest WRITES -- everything that could act on, or publish, a namespace that is
            // not there yet. The admin surface is up, and POST /$/restore has everything it needs.
            //
            // AND TO BE HONEST ABOUT WHAT THIS MODE IS NOT: it is not read-only. ioManager.init() mounts the
            // filesystems read-write, may run `e2fsck -y` on a dirty one, and creates `strubs/.tmp` where it is
            // missing. Those are writes, to a platter, in "recovery" mode. They are also unavoidable -- you
            // cannot read a snapshot object off a filesystem you have not mounted -- and they touch filesystem
            // metadata, never a slice. The invariant that actually matters is narrower and it does hold: nothing
            // in this mode writes an OBJECT, publishes a MANIFEST, or acts on what the empty database says.
            const namespaceMissing = await database.namespaceRestoreRequired();
            if (namespaceMissing) {
                log.error('RECOVERY MODE: the fleet is up but the NAMESPACE has not been restored (since %s). Mongo '
                    + 'is empty and the names of every object on this array are still only on the platters. The '
                    + 'disks are mounted and the manifest is read -- so POST /$/restore can run -- but the object '
                    + 'API, the journal, the snapshot job and every manifest WRITE are held back: a snapshot taken '
                    + 'now would point the manifest at an empty namespace and orphan the real one.',
                    namespaceMissing.since);

                // ...and DISARM the admin API. It is up, because the operator needs it -- and almost every
                // route on it reads a Mongo we have just declared non-authoritative in order to decide
                // something. POST /$/snapshot would snapshot the empty namespace and publish the pointer to
                // every disk; DELETE /$/volumes would ask an empty database how many objects are on a full
                // 3TB platter, hear "none", and drop it from the fleet. An allowlist, not a blocklist.
                HttpMgmt.setNamespaceMissing(true);

                await adminAuth.bootstrap();
                await serverManager.start({ recovery: true });
                this.started = true;
                log('STRUBS started in RECOVERY mode (fleet up, namespace not yet restored, admin API disarmed).');
                return;
            }

            // The journal must be up BEFORE the object API accepts a write: a PUT that lands before the
            // journal is running is a namespace change nobody recorded.
            await journal.start();

            // ...and THEN the live journal has the last word on where it actually lives. The manifest's list
            // is a memory of where the journal was when that manifest was written; the journal itself is
            // where it IS. Letting the older answer win would have the manifest advertise replicas that
            // moved -- and a recovery reads the journal only from the volumes the manifest names.
            //
            // An EMPTY replica list is refused by setJournalVolumeIds() itself -- the guard is at the sink,
            // because io/manager.ts and device-reconciler.ts call it too and a rule enforced at one of three
            // call sites is not a rule.
            bootstrapManifestWriter.setJournalVolumeIds(journal.replicaVolumeIds);
            // The fleet is up: refresh the bootstrap manifest on every writable volume. Fire-and-forget --
            // a manifest write must never delay or fail startup -- plus a periodic backstop so a manifest
            // can never silently stop refreshing (which you'd only discover during a recovery).
            void bootstrapManifestWriter.write().catch(err => log.error('initial bootstrap manifest write failed', err));
            bootstrapManifestWriter.startPeriodic(config.bootstrapManifestIntervalMs);
            await volumeSmartMonitor.start();
            // A rebalance owns the disks while it runs. If one is pending, park the scrub BEFORE we
            // consider resuming it — otherwise it would start here and get killed seconds later when
            // the rebalance resumes below. It stays queued and the rebalance releases it when done.
            if (await rebalanceJob.hasPendingRun())
                await verifyVolumesJob.pauseForRebalance();
            // Resume any pending verify run before exposing HTTP, so an inbound
            // verify/scrub request can't race the resume for job state.
            await verifyVolumesJob.resumePendingJob();
            // Ensure an admin password exists before the admin API is reachable -- generates and logs a
            // random one on first start (never a default, never an unauthenticated setter).
            await adminAuth.bootstrap();
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
            // The journal records what changes from now on. The SNAPSHOT is what puts the names of
            // everything that is ALREADY here onto the platters -- without it, DR-C protects the last
            // few hundred writes and nothing else.
            if (config.snapshotEnabled && !frozen)
                snapshotJob.start(config.snapshotIntervalMs);
            deviceReconciler.start(config.deviceReconcileIntervalMs, { udev: config.deviceReconcileUdev });
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

            // THE SERVERS GO DOWN FIRST -- before the journal, and before ANY other teardown.
            //
            // Everything below this line dismantles machinery that a live listener depends on: the journal
            // it must write to, the volumes it reads from, the workers that keep them honest. None of it may
            // run until we have PROVEN that nothing is listening. Stopping the journal while a listener is
            // still up is the worst of them -- append() becomes a no-op, so a PUT in that window commits to
            // Mongo with no journal record, which is exactly the unjournaled namespace change this whole
            // phase exists to prevent.
            //
            // So if the servers do not stop, we ABORT the shutdown with the system still WHOLE: background
            // jobs still running, journal still armed, disks still mounted, `started` still true so a second
            // stop() is a real retry rather than an early return. We flush what is queued (those records are
            // already acknowledged) and hand the problem back to the caller.
            try {
                await this.deps.serverManager.stop();
            }
            catch (err) {
                log.error('server stop FAILED: ABORTING shutdown with everything still up -- a listener may '
                    + 'still be accepting writes, so nothing it depends on may be torn down', err);
                await journal.flush().catch(flushErr => log.error('journal flush during failed shutdown failed', flushErr));
                throw err;
            }

            verifyScheduler.stop();
            systemLogWatcher.stop();
            snapshotJob.stop();
            repairWorker.stop();
            bootstrapManifestWriter.stopPeriodic();
            volumeHealthMonitor.stop();
            deviceReconciler.stop();

            // Nothing can accept a write now: flush what is queued and close the segments.
            await journal.stop().catch(err => log.error('journal stop failed', err));

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
            // 0700: the admin recovery socket lives here and is credentialless, so the directory must
            // not be traversable by other local users.
            await fs.mkdir('/run/strubs', { mode: 0o700 });
            log('runtime directory created');
        }
        catch (err) {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code === 'EEXIST') {
                // Enforce the mode even if the directory already existed. FAIL CLOSED: the credentialless
                // admin socket lives here, so a directory we cannot lock to 0700 (a writable parent lets a
                // local user unlink/replace the socket) must abort startup, not continue.
                await fs.chmod('/run/strubs', 0o700);
                log('runtime directory exists');
                return;
            }

            throw err;
        }
    }
}
