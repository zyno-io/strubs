import { describe, expect, it, vi } from 'vitest';

import { VolumeHealthMonitor } from '../lib/io/volume-health-monitor';

const loggerFactory = () => vi.fn(() => Object.assign(vi.fn(), { error: vi.fn() })) as any;

const volume = (overrides?: any) => ({ isDeleted: false, isReadOnly: false, isHealthy: true, ...overrides });

const makeMonitor = (overrides?: any) => {
    const volumes: [number, any][] = overrides?.volumes ?? [[1, volume()], [2, volume()]];
    const deps = {
        database: { updateVolumeFlags: vi.fn().mockResolvedValue(undefined) },
        ioManager: {
            getVolume: vi.fn((id: number) => volumes.find(v => v[0] === id)?.[1]),
            getVolumeEntries: vi.fn(() => volumes),
            updateVolumeFlags: vi.fn(async (id: number, changes: any) => {
                const target = volumes.find(v => v[0] === id)?.[1];
                if (!target)
                    return;
                if (changes.isReadOnly !== undefined)
                    target.isReadOnly = changes.isReadOnly;
                if (changes.isHealthy !== undefined)
                    target.isHealthy = changes.isHealthy;
            })
        },
        volumeSmartMonitor: { getSummary: vi.fn(() => ({ isHealthy: true })) },
        remediationService: { listFaults: vi.fn(() => []) },
        notificationService: { notify: vi.fn().mockResolvedValue({ delivered: [], failed: [], suppressed: false }) },
        createLogger: loggerFactory(),
        ...overrides?.deps
    };
    return { monitor: new VolumeHealthMonitor({ faultThreshold: 3 }, deps), deps };
};

const faultsOnVolume = (volumeId: number, n: number) =>
    Array.from({ length: n }, (_unused, i) => ({ volumeId, objectId: `o${i}`, sliceIndex: 0, key: `${volumeId}:o${i}:0` }));

describe('VolumeHealthMonitor', () => {
    it('degrades a volume to read-only once its fault count crosses the threshold', async () => {
        const { monitor, deps } = makeMonitor();
        deps.remediationService.listFaults.mockReturnValue(faultsOnVolume(1, 3));
        await monitor.poll();

        expect(deps.ioManager.updateVolumeFlags).toHaveBeenCalledWith(1, { isReadOnly: true, isHealthy: false });
        // Degradation must be persisted (not just in-memory) so it survives restart.
        expect(deps.database.updateVolumeFlags).toHaveBeenCalledWith(1, { isReadOnly: true, isHealthy: false });
        expect(deps.notificationService.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical' }));
        // Never auto-disables (drain is manual).
        expect(deps.ioManager.updateVolumeFlags).not.toHaveBeenCalledWith(1, expect.objectContaining({ isEnabled: false }));
    });

    it('degrades a volume when SMART reports it unhealthy', async () => {
        const { monitor, deps } = makeMonitor();
        deps.volumeSmartMonitor.getSummary.mockImplementation((id: number) => ({ isHealthy: id === 2 ? false : true }));
        await monitor.poll();

        expect(deps.ioManager.updateVolumeFlags).toHaveBeenCalledWith(2, { isReadOnly: true, isHealthy: false });
        expect(deps.ioManager.updateVolumeFlags).not.toHaveBeenCalledWith(1, expect.anything());
    });

    it('does not act below threshold or repeatedly (hysteresis)', async () => {
        const { monitor, deps } = makeMonitor();
        deps.remediationService.listFaults.mockReturnValue(faultsOnVolume(1, 2)); // below threshold 3
        await monitor.poll();
        expect(deps.ioManager.updateVolumeFlags).not.toHaveBeenCalled();

        deps.remediationService.listFaults.mockReturnValue(faultsOnVolume(1, 5)); // now over
        await monitor.poll();
        await monitor.poll(); // second poll must not re-degrade
        expect(deps.ioManager.updateVolumeFlags).toHaveBeenCalledTimes(1);
    });

    it('can degrade a volume again after an operator restores its flags', async () => {
        const volumeOne = volume();
        const { monitor, deps } = makeMonitor({ volumes: [[1, volumeOne]] });
        deps.remediationService.listFaults.mockReturnValue(faultsOnVolume(1, 3));
        deps.ioManager.updateVolumeFlags.mockImplementation(async (_id: number, changes: any) => {
            if (changes.isReadOnly !== undefined)
                volumeOne.isReadOnly = changes.isReadOnly;
            if (changes.isHealthy !== undefined)
                volumeOne.isHealthy = changes.isHealthy;
        });

        await monitor.poll();
        await monitor.poll();
        expect(deps.ioManager.updateVolumeFlags).toHaveBeenCalledTimes(1);

        volumeOne.isReadOnly = false;
        volumeOne.isHealthy = true;
        await monitor.poll();

        expect(deps.ioManager.updateVolumeFlags).toHaveBeenCalledTimes(2);
    });
});
