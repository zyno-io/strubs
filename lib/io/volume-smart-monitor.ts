import { createLogger } from '../log';
import { smartctl as defaultSmartctl } from './helpers';
import { ioManager } from './manager';
import type { Volume } from './volume';

type VolumeSmartMonitorDeps = {
    ioManager: typeof ioManager;
    smartctl: typeof defaultSmartctl;
    createLogger: typeof createLogger;
};

export type VolumeSmartSummary = {
    updatedAt: string | null;
    isHealthy: boolean | null;
    temperatureC: number | null;
    powerOnHours: number | null;
    error: string | null;
    statusFlags: string[];
    isSupported: boolean;
};

export type VolumeSmartInfo = {
    summary: VolumeSmartSummary;
    details: Record<string, unknown> | null;
};

const defaultDeps: VolumeSmartMonitorDeps = {
    ioManager,
    smartctl: defaultSmartctl,
    createLogger
};

const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

const SMARTCTL_FLAG_INFO = [
    { bit: 0x04, message: 'SMART status check failed', markUnhealthy: true },
    { bit: 0x08, message: 'Pre-ID SMART health check failed', markUnhealthy: true },
    { bit: 0x10, message: 'Mandatory SMART command failed', markUnhealthy: false },
    { bit: 0x20, message: 'Self-test log contains errors', markUnhealthy: true },
    { bit: 0x40, message: 'Device in low-power mode (SMART restricted)', markUnhealthy: false },
    { bit: 0x80, message: 'Device in low-power mode (SMART unavailable)', markUnhealthy: true }
] as const;

export class VolumeSmartMonitor {
    private readonly deps: VolumeSmartMonitorDeps;
    private readonly log: ReturnType<typeof createLogger>;
    private readonly records = new Map<number, VolumeSmartInfo>();
    private interval: NodeJS.Timeout | null = null;
    private refreshPromise: Promise<void> | null = null;

    constructor(deps?: Partial<VolumeSmartMonitorDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('smart-monitor');
    }

    async start(): Promise<void> {
        if (this.interval)
            return;

        this.log('starting SMART monitor');
        this.interval = setInterval(() => {
            void this.refreshAll();
        }, REFRESH_INTERVAL_MS);
        this.interval.unref?.();
        await this.refreshAll();
    }

    async stop(): Promise<void> {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }

        if (this.refreshPromise)
            await this.refreshPromise;

        this.log('stopped SMART monitor');
    }

    getSummary(volumeId: number): VolumeSmartSummary {
        return this.records.get(volumeId)?.summary ?? this.createEmptySummary();
    }

    getInfo(volumeId: number): VolumeSmartInfo {
        return this.records.get(volumeId) ?? {
            summary: this.createEmptySummary(),
            details: null
        };
    }

    private async refreshAll(): Promise<void> {
        if (this.refreshPromise)
            return this.refreshPromise;

        this.refreshPromise = (async () => {
            const entries = this.deps.ioManager.getVolumeEntries();
            const activeIds = new Set<number>();
            for (const [id, volume] of entries) {
                if (!volume.isStarted)
                    continue;
                const devicePath = this.resolveDevicePath(volume);
                if (!devicePath)
                    continue;
                activeIds.add(id);
                await this.refreshVolume(id, devicePath);
            }
            for (const id of this.records.keys()) {
                if (!activeIds.has(id))
                    this.records.delete(id);
            }
        })()
            .catch(err => {
                this.log.error('failed to refresh SMART data', err);
            })
            .finally(() => {
                this.refreshPromise = null;
            });

        return this.refreshPromise;
    }

    private async refreshVolume(volumeId: number, devicePath: string): Promise<void> {
        try {
            const { data: details, exitCode } = await this.deps.smartctl('-a', devicePath);
            const summary = this.buildSummary(details);
            summary.updatedAt = new Date().toISOString();
            summary.error = null;
            this.applySmartctlFlags(summary, exitCode);
            this.records.set(volumeId, { summary, details });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const summary = this.createEmptySummary();
            summary.updatedAt = new Date().toISOString();
            summary.error = message;
            this.records.set(volumeId, { summary, details: null });
            this.log.error('failed to refresh SMART data for %s: %s', devicePath, message);
        }
    }

    private resolveDevicePath(volume: Volume): string | null {
        if (volume.deviceName)
            return `/dev/${volume.deviceName}`;
        if (!volume.blockPath)
            return null;

        const match = /^\/dev\/([^/]+)/.exec(volume.blockPath);
        if (!match)
            return null;
        return `/dev/${match[1]}`;
    }

    private buildSummary(details: Record<string, any>): VolumeSmartSummary {
        const summary = this.createEmptySummary();
        summary.isHealthy = this.extractHealth(details);
        summary.temperatureC = this.extractTemperature(details);
        summary.powerOnHours = this.extractPowerOnHours(details);
        summary.isSupported = this.isSmartSupported(details);
        return summary;
    }

    private extractHealth(details: Record<string, any>): boolean | null {
        const status = details.smart_status;
        if (status && typeof status === 'object' && typeof status.passed === 'boolean')
            return status.passed;
        return null;
    }

    private extractTemperature(details: Record<string, any>): number | null {
        const temperature = details.temperature;
        if (temperature && typeof temperature === 'object') {
            if (typeof temperature.current === 'number')
                return temperature.current;
            if (typeof temperature.current_celsius === 'number')
                return temperature.current_celsius;
            if (typeof temperature.drive === 'number')
                return temperature.drive;
        }

        const nvme = details.nvme_smart_health_information_log;
        if (nvme && typeof nvme === 'object') {
            if (typeof nvme.temperature_celsius === 'number')
                return nvme.temperature_celsius;
            if (typeof nvme.temperature === 'number')
                return Math.round(nvme.temperature - 273);
        }

        return null;
    }

    private extractPowerOnHours(details: Record<string, any>): number | null {
        const powerOn = details.power_on_time;
        if (powerOn && typeof powerOn === 'object' && typeof powerOn.hours === 'number')
            return powerOn.hours;

        const nvme = details.nvme_smart_health_information_log;
        if (nvme && typeof nvme === 'object' && typeof nvme.power_on_hours === 'number')
            return nvme.power_on_hours;

        return null;
    }

    private isSmartSupported(details: Record<string, any>): boolean {
        const support = details.smart_support;
        if (support && typeof support === 'object') {
            const available = (support as Record<string, unknown>).available;
            if (typeof available === 'boolean')
                return available;
        }
        return true;
    }

    private applySmartctlFlags(summary: VolumeSmartSummary, exitCode: number): void {
        const flags: string[] = [];
        let forceUnhealthy = false;
        for (const flag of SMARTCTL_FLAG_INFO) {
            if ((exitCode & flag.bit) === 0)
                continue;
            flags.push(flag.message);
            if (flag.markUnhealthy)
                forceUnhealthy = true;
        }

        summary.statusFlags = flags;

        if (forceUnhealthy && summary.isHealthy !== false)
            summary.isHealthy = false;
    }

    private createEmptySummary(): VolumeSmartSummary {
        return {
            updatedAt: null,
            isHealthy: null,
            temperatureC: null,
            powerOnHours: null,
            error: null,
            statusFlags: [],
            isSupported: true
        };
    }
}

export const volumeSmartMonitor = new VolumeSmartMonitor();
