import { spawnHelper } from '../helpers/spawn';
import { createLogger } from '../log';
import { ioManager } from './manager';
import { verifyVolumesJob } from '../jobs/verify-volumes-job';
import { notificationService, NotificationService } from '../notify/service';
import type { Volume } from './volume';

type RunFn = (command: string, args: string[]) => Promise<{ code: number | null; stdout: string }>;

type SystemLogWatcherDeps = {
    run: RunFn;
    ioManager: Pick<typeof ioManager, 'getVolumeEntries'>;
    verifyVolumesJob: Pick<typeof verifyVolumesJob, 'start'>;
    notificationService: NotificationService;
    createLogger: typeof createLogger;
    now: () => number;
};

const defaultDeps: SystemLogWatcherDeps = {
    run: (command, args) => spawnHelper(command, args),
    ioManager,
    verifyVolumesJob,
    notificationService,
    createLogger,
    now: () => Date.now()
};

export type DeviceSignal = {
    device: string;            // bare device name, e.g. "sdn"
    kind: 'pending' | 'ioerror';
    detail: string;
};

const DEFAULT_LOOKBACK_MS = 60 * 60 * 1000;       // first poll window
const DEFAULT_TRIGGER_COOLDOWN_MS = 6 * 60 * 60 * 1000; // per-device re-trigger guard

// Watches smartd / kernel logs for device-level trouble (pending/unreadable
// sectors, critical target errors). These are TREATED AS HINTS, not proof of
// object damage: a fresh signal triggers a targeted verify of the affected
// volume (which performs the authoritative checksum check and raises real,
// object-attributed faults) plus a device-level notification.
export class SystemLogWatcher {
    private readonly deps: SystemLogWatcherDeps;
    private readonly log: ReturnType<typeof createLogger>;
    private readonly cooldownMs: number;
    private timer: NodeJS.Timeout | null = null;
    private lastPollAt: Date | null = null;
    private polling = false;
    private readonly lastTriggered = new Map<string, number>();

    constructor(options?: { triggerCooldownMs?: number }, deps?: Partial<SystemLogWatcherDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('syslog-watcher');
        this.cooldownMs = options?.triggerCooldownMs ?? DEFAULT_TRIGGER_COOLDOWN_MS;
    }

    start(intervalMs: number): void {
        if (this.timer)
            return;
        if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
            this.log('system log watcher disabled (no interval configured)');
            return;
        }
        this.log('system log watcher polling every %dms', intervalMs);
        this.timer = setInterval(() => void this.poll(), intervalMs);
        this.timer.unref?.();
        void this.poll();
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
        const since = this.lastPollAt ?? new Date(this.deps.now() - DEFAULT_LOOKBACK_MS);
        const pollStart = new Date(this.deps.now());
        try {
            const signals = await this.collectSignals(since);
            const byDevice = this.dedupeByDevice(signals);
            for (const signal of byDevice)
                await this.handleSignal(signal);
            // Only advance the cursor when the poll fully succeeded; otherwise
            // the next poll re-covers this window rather than skipping it.
            this.lastPollAt = pollStart;
        }
        catch (err) {
            this.log.error('system log poll failed: %s', err instanceof Error ? err.message : String(err));
        }
        finally {
            this.polling = false;
        }
    }

    private async collectSignals(since: Date): Promise<DeviceSignal[]> {
        const sinceArg = this.formatSince(since);
        const [smartd, kernel] = await Promise.all([
            this.runJournal(['-t', 'smartd', '-o', 'cat', '--no-pager', '--since', sinceArg]),
            this.runJournal(['-k', '-o', 'cat', '--no-pager', '--since', sinceArg])
        ]);
        return [
            ...SystemLogWatcher.parseSmartdPending(smartd),
            ...SystemLogWatcher.parseKernelErrors(kernel)
        ];
    }

    private async runJournal(args: string[]): Promise<string> {
        const { code, stdout } = await this.deps.run('journalctl', args);
        if (code !== 0)
            throw new Error(`journalctl exited with code ${code}`);
        return stdout ?? '';
    }

    private dedupeByDevice(signals: DeviceSignal[]): DeviceSignal[] {
        const seen = new Map<string, DeviceSignal>();
        for (const signal of signals) {
            if (!seen.has(signal.device))
                seen.set(signal.device, signal);
        }
        return Array.from(seen.values());
    }

    private async handleSignal(signal: DeviceSignal): Promise<void> {
        const last = this.lastTriggered.get(signal.device);
        const now = this.deps.now();
        if (last !== undefined && now - last < this.cooldownMs)
            return; // already acted on this device recently

        const volumeId = this.resolveVolumeId(signal.device);
        if (volumeId === null) {
            // Not a managed volume (yet) — don't arm the cooldown, so we still
            // react if it becomes one later.
            this.log('ignoring %s on %s (not a managed volume)', signal.kind, signal.device);
            return;
        }

        this.log('device %s (volume %d) reported %s; triggering targeted verify', signal.device, volumeId, signal.kind);

        await this.deps.notificationService.notify({
            severity: 'warning',
            title: `Device ${signal.device} reported ${signal.kind}`,
            body: `${signal.detail} — triggering targeted verify of volume ${volumeId}`,
            dedupeKey: `syslog:${signal.device}:${signal.kind}`,
            context: { device: signal.device, volumeId, kind: signal.kind }
        }).catch(err => {
            this.log.error('failed to notify for %s: %s', signal.device, err instanceof Error ? err.message : String(err));
        });

        try {
            const result = await this.deps.verifyVolumesJob.start({ volumeIds: [volumeId] });
            if (result.accepted === false) {
                this.log('targeted verify for volume %d was not accepted; leaving %s out of cooldown', volumeId, signal.device);
                return;
            }
            // Arm the cooldown only once the verify run was accepted, so a
            // transient failure doesn't suppress this device for hours.
            this.lastTriggered.set(signal.device, now);
        }
        catch (err) {
            this.log.error('failed to start targeted verify for volume %d: %s', volumeId, err instanceof Error ? err.message : String(err));
        }
    }

    private resolveVolumeId(device: string): number | null {
        for (const [id, volume] of this.deps.ioManager.getVolumeEntries()) {
            const vol = volume as Volume;
            if (vol.isDeleted)
                continue;
            if (vol.deviceName === device)
                return id;
        }
        return null;
    }

    private formatSince(date: Date): string {
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
            `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    // "Device: /dev/sdaf [SAT], 1 Currently unreadable (pending) sectors"
    static parseSmartdPending(text: string): DeviceSignal[] {
        const signals: DeviceSignal[] = [];
        const re = /Device:\s+\/dev\/([a-zA-Z0-9_.-]+).*?(\d+)\s+Currently unreadable \(pending\) sectors/g;
        let match: RegExpExecArray | null;
        while ((match = re.exec(text)) !== null) {
            signals.push({ device: match[1], kind: 'pending', detail: `${match[2]} pending sector(s)` });
        }
        return signals;
    }

    // "critical target error, dev sdn, sector 109348576 ..." / "I/O error, dev sdn,"
    static parseKernelErrors(text: string): DeviceSignal[] {
        const signals: DeviceSignal[] = [];
        const re = /(critical target error|I\/O error|medium error).*?\bdev\s+([a-zA-Z0-9_.-]+)/gi;
        let match: RegExpExecArray | null;
        while ((match = re.exec(text)) !== null) {
            signals.push({ device: match[2], kind: 'ioerror', detail: match[1].toLowerCase() });
        }
        return signals;
    }
}

export const systemLogWatcher = new SystemLogWatcher();
