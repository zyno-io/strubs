import { createLogger } from '../log';
import { database } from '../database';
import { ioManager } from './manager';
import { volumeSmartMonitor, VolumeSmartMonitor } from './volume-smart-monitor';
import { remediationService, RemediationService } from '../remediation/service';
import { notificationService, NotificationService } from '../notify/service';
import type { Volume } from './volume';

type VolumeHealthMonitorDeps = {
    database: Pick<typeof database, 'updateVolumeFlags'>;
    ioManager: Pick<typeof ioManager, 'getVolume' | 'getVolumeEntries' | 'updateVolumeFlags'>;
    volumeSmartMonitor: Pick<VolumeSmartMonitor, 'getSummary'>;
    remediationService: Pick<RemediationService, 'listFaults'>;
    notificationService: NotificationService;
    createLogger: typeof createLogger;
};

const defaultDeps: VolumeHealthMonitorDeps = {
    database,
    ioManager,
    volumeSmartMonitor,
    remediationService,
    notificationService,
    createLogger
};

const DEFAULT_FAULT_THRESHOLD = 10;

// Tier-2 degradation. Aggregates per-volume slice faults and SMART health, and
// when a volume crosses a threshold (too many distinct faulted slices, or SMART
// reports it unhealthy) it is transitioned to READ-ONLY and marked unhealthy:
// reads keep working (reconstructing as needed) while new writes stop. This is
// safe and reversible. Eviction (disabling a drive, which can drop objects below
// quorum) is deliberately NOT automated — it remains an operator action.
export class VolumeHealthMonitor {
    private readonly deps: VolumeHealthMonitorDeps;
    private readonly log: ReturnType<typeof createLogger>;
    private faultThreshold: number;
    private timer: NodeJS.Timeout | null = null;
    private polling = false;

    constructor(options?: { faultThreshold?: number }, deps?: Partial<VolumeHealthMonitorDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('volume-health');
        this.faultThreshold = options?.faultThreshold ?? DEFAULT_FAULT_THRESHOLD;
    }

    start(intervalMs: number, faultThreshold?: number): void {
        if (this.timer)
            return;
        if (typeof faultThreshold === 'number' && Number.isFinite(faultThreshold) && faultThreshold > 0)
            this.faultThreshold = faultThreshold;
        if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
            this.log('volume health monitor disabled (no interval configured)');
            return;
        }
        this.log('volume health monitor polling every %dms', intervalMs);
        this.timer = setInterval(() => void this.poll(), intervalMs);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    isRunning(): boolean {
        return this.timer !== null;
    }

    async poll(): Promise<void> {
        if (this.polling)
            return;
        this.polling = true;
        try {
            const faultsByVolume = this.aggregateFaults();
            for (const [id, volume] of this.deps.ioManager.getVolumeEntries())
                await this.evaluateVolume(id, volume as Volume, faultsByVolume.get(id) ?? 0);
        }
        catch (err) {
            this.log.error('volume health poll failed: %s', err instanceof Error ? err.message : String(err));
        }
        finally {
            this.polling = false;
        }
    }

    private aggregateFaults(): Map<number, number> {
        const counts = new Map<number, number>();
        for (const fault of this.deps.remediationService.listFaults()) {
            if (fault.volumeId === null)
                continue;
            counts.set(fault.volumeId, (counts.get(fault.volumeId) ?? 0) + 1);
        }
        return counts;
    }

    private async evaluateVolume(id: number, volume: Volume, faultCount: number): Promise<void> {
        if (volume.isDeleted)
            return;
        // Already read-only / unhealthy — nothing to escalate (and don't churn).
        if (volume.isReadOnly || !volume.isHealthy)
            return;

        const smartUnhealthy = this.deps.volumeSmartMonitor.getSummary(id).isHealthy === false;
        const overThreshold = faultCount >= this.faultThreshold;
        if (!smartUnhealthy && !overThreshold)
            return;

        const reason = smartUnhealthy ? 'SMART reports the device unhealthy' : `${faultCount} slice faults exceed threshold ${this.faultThreshold}`;
        this.log('degrading volume %d to read-only: %s', id, reason);

        try {
            // Persist to the DB and update the in-memory fleet, so the drive
            // stays degraded across restarts (mirrors the HTTP mgmt path).
            await this.deps.database.updateVolumeFlags(id, { isReadOnly: true, isHealthy: false });
            await this.deps.ioManager.updateVolumeFlags(id, { isReadOnly: true, isHealthy: false });
        }
        catch (err) {
            this.log.error('failed to degrade volume %d: %s', id, err instanceof Error ? err.message : String(err));
            return;
        }

        await this.deps.notificationService.notify({
            severity: 'critical',
            title: `Volume ${id} degraded to read-only`,
            body: `${reason}. Reads continue via reconstruction; new writes are stopped. Operator action required to evacuate/replace the drive.`,
            dedupeKey: `volume-degraded:${id}`,
            context: { volumeId: id, faultCount, smartUnhealthy }
        }).catch(err => {
            this.log.error('failed to notify volume %d degradation: %s', id, err instanceof Error ? err.message : String(err));
        });
    }
}

export const volumeHealthMonitor = new VolumeHealthMonitor();
