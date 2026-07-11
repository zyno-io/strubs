import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceReconciler } from '../lib/io/device-reconciler';

const loggerFactory = () => {
    const log: any = (..._args: any[]) => undefined;
    log.error = (..._args: any[]) => undefined;
    return () => log;
};

const makeDeps = (overrides?: any) => ({
    ioManager: { reloadBlockDevices: vi.fn().mockResolvedValue([{ name: 'sdf', partitions: [] }]) },
    volumeFleet: { reconcile: vi.fn().mockResolvedValue([]) },
    notificationService: { notify: vi.fn().mockResolvedValue({ delivered: [], failed: [], suppressed: false }) },
    repairWorker: { wake: vi.fn() },
    isMaintenanceFrozen: vi.fn().mockResolvedValue(false),
    spawnUdev: () => null,
    createLogger: loggerFactory(),
    ...overrides
});

describe('DeviceReconciler', () => {
    it('sends a critical notification and does NOT wake repair when a disk goes missing', async () => {
        const deps = makeDeps();
        deps.volumeFleet.reconcile.mockResolvedValue([{ volumeId: 57, kind: 'missing', deviceName: 'sde' }]);

        await new DeviceReconciler(deps).reconcile('test');

        expect(deps.notificationService.notify).toHaveBeenCalledWith(expect.objectContaining({
            severity: 'critical',
            dedupeKey: 'device-missing:57'
        }));
        expect(deps.repairWorker.wake).not.toHaveBeenCalled();
    });

    it('wakes repair and notifies when a volume is restored', async () => {
        const deps = makeDeps();
        deps.volumeFleet.reconcile.mockResolvedValue([{ volumeId: 13, kind: 'restored', deviceName: 'sdf' }]);

        await new DeviceReconciler(deps).reconcile('test');

        expect(deps.repairWorker.wake).toHaveBeenCalledTimes(1);
        expect(deps.notificationService.notify).toHaveBeenCalledWith(expect.objectContaining({
            severity: 'info',
            dedupeKey: 'device-restored:13'
        }));
    });

    it('treats a healed stale mount as a restore (wake + notify)', async () => {
        const deps = makeDeps();
        deps.volumeFleet.reconcile.mockResolvedValue([{ volumeId: 57, kind: 'healed', deviceName: 'sde' }]);

        await new DeviceReconciler(deps).reconcile('test');

        expect(deps.repairWorker.wake).toHaveBeenCalledTimes(1);
        expect(deps.notificationService.notify).toHaveBeenCalledWith(expect.objectContaining({ severity: 'info' }));
    });

    it('holds auto-recovery (autoRecover=false) while maintenance is frozen', async () => {
        const deps = makeDeps({ isMaintenanceFrozen: vi.fn().mockResolvedValue(true) });

        await new DeviceReconciler(deps).reconcile('test');

        expect(deps.volumeFleet.reconcile).toHaveBeenCalledWith(expect.anything(), { autoRecover: false });
    });

    it('passes autoRecover=true when not frozen', async () => {
        const deps = makeDeps();

        await new DeviceReconciler(deps).reconcile('test');

        expect(deps.volumeFleet.reconcile).toHaveBeenCalledWith(expect.anything(), { autoRecover: true });
    });

    it('coalesces a trigger that arrives mid-pass into exactly one more pass', async () => {
        const deps = makeDeps();
        let releaseFirst: () => void;
        const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
        deps.volumeFleet.reconcile
            .mockImplementationOnce(async () => { await gate; return []; })
            .mockResolvedValue([]);

        const reconciler = new DeviceReconciler(deps);
        const first = reconciler.reconcile('a');   // enters, blocks on gate
        await reconciler.reconcile('b');           // in-flight -> queued, returns immediately
        releaseFirst!();
        await first;
        await new Promise(resolve => setImmediate(resolve)); // let the coalesced pass run

        expect(deps.ioManager.reloadBlockDevices).toHaveBeenCalledTimes(2);
    });

    describe('udev trigger', () => {
        beforeEach(() => vi.useFakeTimers());
        afterEach(() => vi.useRealTimers());

        it('is idempotent across double start() (no duplicate udev) even with the periodic pass disabled', () => {
            const spawnUdev = vi.fn(() => { const p: any = new EventEmitter(); p.stdout = new EventEmitter(); p.kill = vi.fn(); return p; });
            const deps = makeDeps({ spawnUdev });
            const reconciler = new DeviceReconciler(deps);
            reconciler.start(0, { udev: true });
            reconciler.start(0, { udev: true });
            expect(spawnUdev).toHaveBeenCalledTimes(1);
            reconciler.stop();
        });

        it('debounces udev events into a single reconcile', async () => {
            const proc: any = new EventEmitter();
            proc.stdout = new EventEmitter();
            proc.kill = vi.fn();
            const deps = makeDeps({ spawnUdev: () => proc });

            const reconciler = new DeviceReconciler(deps);
            reconciler.start(0, { udev: true });     // periodic disabled; udev only
            await Promise.resolve();                  // let the startup pass settle
            deps.ioManager.reloadBlockDevices.mockClear();

            proc.stdout.emit('data', Buffer.from('UDEV add /devices/.../sdf1 (block)\n'));
            proc.stdout.emit('data', Buffer.from('UDEV add /devices/.../sdf1 (block)\n'));
            expect(deps.ioManager.reloadBlockDevices).not.toHaveBeenCalled(); // still debouncing

            await vi.advanceTimersByTimeAsync(3000);
            expect(deps.ioManager.reloadBlockDevices).toHaveBeenCalledTimes(1); // burst -> one pass

            reconciler.stop();
            expect(proc.kill).toHaveBeenCalled();
        });
    });
});
