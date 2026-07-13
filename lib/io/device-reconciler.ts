import { spawn, type ChildProcess } from 'child_process';

import { createLogger } from '../log';
import { ioManager } from './manager';
import { volumeFleet, type VolumeFleet, type VolumeTransition } from './volume-fleet';
import { notificationService, NotificationService } from '../notify/service';
import { repairWorker } from '../remediation/repair-worker';
import { isMaintenanceFrozen } from '../maintenance';

type DeviceReconcilerDeps = {
    ioManager: Pick<typeof ioManager, 'reloadBlockDevices'>;
    volumeFleet: Pick<VolumeFleet, 'reconcile'>;
    notificationService: NotificationService;
    repairWorker: Pick<typeof repairWorker, 'wake'>;
    isMaintenanceFrozen: typeof isMaintenanceFrozen;
    // Spawn the udev monitor. Returns null when udevadm is unavailable, in which case we fall back to
    // the periodic pass only. Injectable so tests never touch a real subprocess.
    spawnUdev: () => ChildProcess | null;
    createLogger: typeof createLogger;
};

const defaultDeps: DeviceReconcilerDeps = {
    ioManager,
    volumeFleet,
    notificationService,
    repairWorker,
    isMaintenanceFrozen,
    spawnUdev: () => {
        try {
            return spawn('udevadm', ['monitor', '--udev', '--subsystem-match=block'], { stdio: ['ignore', 'pipe', 'ignore'] });
        }
        catch {
            return null;
        }
    },
    createLogger
};

// Coalesce a burst of udev events (a DAS enclosure re-enumerating fires many in a row) into one pass.
const UDEV_DEBOUNCE_MS = 3000;
// Backoff before respawning the udev monitor if it dies.
const UDEV_RESPAWN_MS = 5000;

// Makes STRUBS aware of disks appearing and disappearing. A udev monitor gives near-instant reaction;
// a periodic pass is the backstop for anything missed (or when udevadm is unavailable). Both funnel
// into the same fleet.reconcile() pass, which marks pulled disks missing, remounts/restarts volumes
// whose disk returned, and heals stale mounts. Mirrors the SystemLogWatcher/VolumeHealthMonitor shape.
export class DeviceReconciler {
    private readonly deps: DeviceReconcilerDeps;
    private readonly log: ReturnType<typeof createLogger>;
    private timer: NodeJS.Timeout | null = null;
    private reconciling = false;
    private queued = false;
    private stopped = false;
    private started = false;
    private udev: ChildProcess | null = null;
    private debounceTimer: NodeJS.Timeout | null = null;
    private respawnTimer: NodeJS.Timeout | null = null;

    constructor(deps?: Partial<DeviceReconcilerDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('device-reconciler');
    }

    start(intervalMs: number, options?: { udev?: boolean }): void {
        // Guard on `started`, not `this.timer`: with intervalMs=0 (periodic disabled) there is no timer,
        // and a second start() would otherwise spawn a duplicate udev monitor.
        if (this.started)
            return;
        this.started = true;
        this.stopped = false;

        if (Number.isFinite(intervalMs) && intervalMs > 0) {
            this.log('device reconciler polling every %dms', intervalMs);
            this.timer = setInterval(() => void this.reconcile('periodic'), intervalMs);
            this.timer.unref?.();
        }
        else {
            this.log('device reconciler periodic pass disabled (no interval configured)');
        }

        if (options?.udev !== false)
            this.startUdev();

        // Prime once so an insertion/removal that happened while we were down is caught at startup.
        void this.reconcile('startup');
    }

    stop(): void {
        this.stopped = true;
        this.started = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        if (this.respawnTimer) {
            clearTimeout(this.respawnTimer);
            this.respawnTimer = null;
        }
        if (this.udev) {
            this.udev.kill();
            this.udev = null;
        }
    }

    isRunning(): boolean {
        return this.timer !== null || this.udev !== null;
    }

    async reconcile(reason: string): Promise<void> {
        // Single-flight: a pass in progress absorbs concurrent triggers, then runs once more so the
        // latest device state is never left unprocessed.
        if (this.reconciling) {
            this.queued = true;
            return;
        }
        this.reconciling = true;
        try {
            const devices = await this.deps.ioManager.reloadBlockDevices();
            const autoRecover = !(await this.deps.isMaintenanceFrozen());
            const transitions = await this.deps.volumeFleet.reconcile(devices, { autoRecover });
            if (transitions.length)
                this.log('reconcile (%s) produced %d transition(s)', reason, transitions.length);
            for (const transition of transitions)
                await this.handleTransition(transition);

            // A disk PHYSICALLY appearing or disappearing is a fleet change too, and it does not pass
            // through ioManager.updateVolumeFlags -- so it would otherwise miss the journal's re-election
            // and the manifest refresh entirely. Pulling a journal disk is exactly the case that matters:
            // nothing else would notice the replica had gone.
            if (transitions.length)
                await this.refreshRecoveryArtifacts();
        }
        catch (err) {
            this.log.error('device reconcile (%s) failed: %s', reason, err instanceof Error ? err.message : String(err));
        }
        finally {
            this.reconciling = false;
            if (this.queued && !this.stopped) {
                this.queued = false;
                setImmediate(() => void this.reconcile('coalesced'));
            }
        }
    }

    // Keep the recovery artifacts in step with a fleet that changed by itself. Lazily required: the
    // journal reaches back into the io layer for mount points, so a top-level import closes a cycle.
    private async refreshRecoveryArtifacts(): Promise<void> {
        try {
            const { journal } = require('./journal') as typeof import('./journal');
            const { bootstrapManifestWriter } = require('./bootstrap-manifest') as typeof import('./bootstrap-manifest');
            await journal.onFleetChange();
            bootstrapManifestWriter.setJournalVolumeIds(journal.replicaVolumeIds);
            await bootstrapManifestWriter.write();
        }
        catch (err) {
            // A reconcile pass must never fail because a recovery artifact could not be refreshed; the
            // periodic manifest backstop will retry.
            this.log.error('failed to refresh recovery artifacts after reconcile: %s', err instanceof Error ? err.message : String(err));
        }
    }

    private async handleTransition(transition: VolumeTransition): Promise<void> {
        const { volumeId, kind, deviceName } = transition;
        const device = deviceName ?? 'unknown device';

        if (kind === 'missing') {
            await this.notify({
                severity: 'critical',
                title: `Volume ${volumeId} disk removed`,
                body: `The disk backing volume ${volumeId} (${device}) is no longer present. The volume is offline; reads are served via reconstruction. Reattach the disk to bring it back.`,
                dedupeKey: `device-missing:${volumeId}`,
                context: { volumeId, device: deviceName }
            });
            return;
        }

        // restored / healed: the volume is back online. Wake the repair worker so anything that faulted
        // while it was gone gets re-driven (mirrors registerVolume / availability changes).
        this.deps.repairWorker.wake(`volume ${volumeId} ${kind} by device reconciler`);
        await this.notify({
            severity: 'info',
            title: `Volume ${volumeId} back online`,
            body: kind === 'healed'
                ? `A stale mount for volume ${volumeId} was healed and remounted on the live device (${device}).`
                : `The disk backing volume ${volumeId} (${device}) returned and the volume was remounted and started.`,
            dedupeKey: `device-restored:${volumeId}`,
            context: { volumeId, device: deviceName, kind }
        });
    }

    private async notify(payload: Parameters<NotificationService['notify']>[0]): Promise<void> {
        await this.deps.notificationService.notify(payload).catch(err => {
            this.log.error('failed to send %s notification: %s', payload.dedupeKey, err instanceof Error ? err.message : String(err));
        });
    }

    private startUdev(): void {
        const proc = this.deps.spawnUdev();
        if (!proc) {
            this.log('udevadm monitor unavailable; running periodic-only');
            return;
        }
        this.udev = proc;
        this.log('watching udev for block device changes');

        proc.stdout?.on('data', () => this.scheduleDebounced());
        proc.on('error', err => this.log.error('udev monitor error: %s', err instanceof Error ? err.message : String(err)));
        proc.on('exit', () => {
            this.udev = null;
            if (this.stopped)
                return;
            this.log('udev monitor exited; respawning in %dms', UDEV_RESPAWN_MS);
            this.respawnTimer = setTimeout(() => this.startUdev(), UDEV_RESPAWN_MS);
            this.respawnTimer.unref?.();
        });
    }

    private scheduleDebounced(): void {
        if (this.debounceTimer)
            clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            void this.reconcile('udev');
        }, UDEV_DEBOUNCE_MS);
        this.debounceTimer.unref?.();
    }
}

export const deviceReconciler = new DeviceReconciler();
