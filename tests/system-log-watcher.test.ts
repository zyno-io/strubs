import { describe, expect, it, vi } from 'vitest';

// Avoid pulling the real verify job (native reed-solomon binding) at import.
vi.mock('../lib/jobs/verify-volumes-job', () => ({
    verifyVolumesJob: { start: vi.fn() }
}));

import { SystemLogWatcher } from '../lib/io/system-log-watcher';

const loggerFactory = () => vi.fn(() => Object.assign(vi.fn(), { error: vi.fn() })) as any;

const SMARTD_OUTPUT = [
    'Device: /dev/sdaf [SAT], 1 Currently unreadable (pending) sectors',
    'Device: /dev/sdx [SAT], 1 Currently unreadable (pending) sectors',
    'Device: /dev/sdz [SAT], Self-Test Log error count increased'
].join('\n');

const KERNEL_OUTPUT = [
    'critical target error, dev sdn, sector 109348576 op 0x0:(READ)',
    'blk_update_request: I/O error, dev sdn, sector 109348576'
].join('\n');

describe('SystemLogWatcher parsing', () => {
    it('extracts pending-sector devices from smartd output', () => {
        const signals = SystemLogWatcher.parseSmartdPending(SMARTD_OUTPUT);
        expect(signals.map(s => s.device)).toEqual(['sdaf', 'sdx']);
        expect(signals[0]).toMatchObject({ kind: 'pending' });
    });

    it('extracts dashed device names from smartd and kernel output', () => {
        const smartd = SystemLogWatcher.parseSmartdPending(
            'Device: /dev/dm-0 [SAT], 2 Currently unreadable (pending) sectors'
        );
        const kernel = SystemLogWatcher.parseKernelErrors(
            'blk_update_request: I/O error, dev dm-0, sector 1'
        );

        expect(smartd[0]).toMatchObject({ device: 'dm-0', kind: 'pending' });
        expect(kernel[0]).toMatchObject({ device: 'dm-0', kind: 'ioerror' });
    });

    it('extracts device errors from kernel output', () => {
        const signals = SystemLogWatcher.parseKernelErrors(KERNEL_OUTPUT);
        expect(signals.map(s => s.device)).toEqual(['sdn', 'sdn']);
        expect(signals[0]).toMatchObject({ kind: 'ioerror', detail: 'critical target error' });
    });

    it('maps a partition name back to its parent disk (whole disks unchanged)', () => {
        expect(SystemLogWatcher.parentDiskName('sdf1')).toBe('sdf');
        expect(SystemLogWatcher.parentDiskName('sdaf12')).toBe('sdaf');
        expect(SystemLogWatcher.parentDiskName('nvme0n1p2')).toBe('nvme0n1');
        expect(SystemLogWatcher.parentDiskName('sdf')).toBeNull();   // already a disk
        expect(SystemLogWatcher.parentDiskName('dm-0')).toBeNull();  // not a partition
    });
});

describe('SystemLogWatcher poll', () => {
    const makeDeps = (overrides?: any) => {
        const run = vi.fn(async (_cmd: string, args: string[]) => {
            if (args.includes('smartd'))
                return { code: 0, stdout: SMARTD_OUTPUT };
            if (args.includes('-k'))
                return { code: 0, stdout: KERNEL_OUTPUT };
            return { code: 0, stdout: '' };
        });
        const volumes: [number, any][] = overrides?.volumes ?? [
            [1, mkVol(1, 'sdaf')],
            [2, mkVol(2, 'sdn')]
        ];
        return {
            run,
            ioManager: {
                getVolumeByDeviceName: vi.fn((name: string) => {
                    const found = volumes.find(([, vol]) => !vol.isDeleted && vol.deviceName === name);
                    return found ? found[1] : undefined;
                })
            },
            verifyVolumesJob: { start: vi.fn().mockResolvedValue({ startedAt: 'x' }) },
            notificationService: { notify: vi.fn().mockResolvedValue({ delivered: [], failed: [], suppressed: false }) },
            persistPendingHighWater: vi.fn().mockResolvedValue(undefined),
            createLogger: loggerFactory(),
            now: () => 1000,
            ...overrides
        };
    };

    // A mock Volume whose in-memory high-water is mutated by setPendingSectorHighWater, mirroring the
    // real Volume (which loads pending_sector_high_water from its DB doc on startup).
    const mkVol = (id: number, device: string, highWater = 0) => ({
        id, deviceName: device, isDeleted: false, pendingSectorHighWater: highWater,
        setPendingSectorHighWater(n: number) { this.pendingSectorHighWater = n; }
    });
    const smartd = (device: string, count: number) => `Device: /dev/${device} [SAT], ${count} Currently unreadable (pending) sectors`;

    it('triggers targeted verify only for devices mapped to managed volumes', async () => {
        const deps = makeDeps();
        const watcher = new SystemLogWatcher({}, deps);
        await watcher.poll();

        // sdaf -> vol 1, sdn -> vol 2; sdx is unmapped and ignored.
        const verifiedVolumes = deps.verifyVolumesJob.start.mock.calls.map((c: any[]) => c[0].volumeIds[0]).sort();
        expect(verifiedVolumes).toEqual([1, 2]);
        expect(deps.notificationService.notify).toHaveBeenCalledTimes(2);
    });

    it('triggers verify for a filesystem I/O error, which names the PARTITION not the disk', async () => {
        // When a filesystem aborts, the kernel logs the error against the partition (sdf1) while the
        // volume's deviceName is the disk (sdf). Without the parent-disk mapping this is dropped as
        // "not a managed volume" -- a live I/O error on a managed volume, silently ignored.
        const deps = makeDeps({
            volumes: [[13, mkVol(13, 'sdf')]],
            run: vi.fn(async (_cmd: string, args: string[]) => args.includes('-k')
                ? { code: 0, stdout: 'Buffer I/O error on dev sdf1, logical block 488144896, lost sync page write' }
                : { code: 0, stdout: '' })
        });
        const watcher = new SystemLogWatcher({}, deps);

        await watcher.poll();

        expect(deps.verifyVolumesJob.start).toHaveBeenCalledTimes(1);
        expect(deps.verifyVolumesJob.start.mock.calls[0][0].volumeIds).toEqual([13]);
    });

    it('does not re-trigger a device within the cooldown window', async () => {
        const deps = makeDeps();
        const watcher = new SystemLogWatcher({ triggerCooldownMs: 100000 }, deps);
        await watcher.poll();
        await watcher.poll();
        // Each managed device triggered exactly once despite two polls.
        expect(deps.verifyVolumesJob.start).toHaveBeenCalledTimes(2);
    });

    it('survives journalctl failures', async () => {
        const deps = makeDeps({ run: vi.fn().mockRejectedValue(new Error('no journalctl')) });
        const watcher = new SystemLogWatcher({}, deps);
        await expect(watcher.poll()).resolves.toBeUndefined();
        expect(deps.verifyVolumesJob.start).not.toHaveBeenCalled();
    });

    it('does not advance its log window when a poll fails', async () => {
        const sinces: string[] = [];
        let firstCall = true;
        const run = vi.fn(async (_cmd: string, args: string[]) => {
            sinces.push(args[args.indexOf('--since') + 1]);
            if (firstCall) { firstCall = false; throw new Error('boom'); }
            if (args.includes('smartd')) return { code: 0, stdout: SMARTD_OUTPUT };
            if (args.includes('-k')) return { code: 0, stdout: KERNEL_OUTPUT };
            return { code: 0, stdout: '' };
        });
        const watcher = new SystemLogWatcher({}, makeDeps({ run }));
        await watcher.poll(); // fails -> window must not advance
        await watcher.poll(); // succeeds -> covers the same window, then advances
        await watcher.poll(); // now starts from the advanced cursor

        expect(sinces[2]).toBe(sinces[0]); // failed poll didn't move the cursor
        expect(sinces[4]).not.toBe(sinces[2]); // success did move it
    });

    it('re-triggers a device next poll when the targeted verify failed to start', async () => {
        const start = vi.fn()
            .mockRejectedValueOnce(new Error('busy'))
            .mockRejectedValueOnce(new Error('busy'))
            .mockResolvedValue({ startedAt: 'x' });
        const deps = makeDeps({ verifyVolumesJob: { start } });
        const watcher = new SystemLogWatcher({ triggerCooldownMs: 100000 }, deps);
        await watcher.poll(); // both devices fail to start -> no cooldown armed
        await watcher.poll(); // both retried
        expect(start).toHaveBeenCalledTimes(4);
    });

    it('re-triggers a device next poll when the targeted verify was not accepted', async () => {
        const start = vi.fn().mockResolvedValue({ startedAt: 'x', accepted: false });
        const deps = makeDeps({ verifyVolumesJob: { start } });
        const watcher = new SystemLogWatcher({ triggerCooldownMs: 100000 }, deps);
        await watcher.poll();
        await watcher.poll();

        expect(start).toHaveBeenCalledTimes(4);
    });

    it('does not re-verify a standing (unchanged) pending sector (cooldown disabled)', async () => {
        const run = vi.fn(async (_c: string, args: string[]) => ({ code: 0, stdout: args.includes('smartd') ? smartd('sdaf', 1) : '' }));
        const deps = makeDeps({ run });
        const watcher = new SystemLogWatcher({ triggerCooldownMs: 0 }, deps);
        await watcher.poll();
        await watcher.poll();
        expect(deps.verifyVolumesJob.start).toHaveBeenCalledTimes(1); // only the first appearance
    });

    it('re-verifies when the pending-sector count grows', async () => {
        let count = 1;
        const run = vi.fn(async (_c: string, args: string[]) => ({ code: 0, stdout: args.includes('smartd') ? smartd('sdaf', count) : '' }));
        const deps = makeDeps({ run });
        const watcher = new SystemLogWatcher({ triggerCooldownMs: 0 }, deps);
        await watcher.poll();          // 1 -> trigger
        count = 2; await watcher.poll(); // 2 > 1 -> trigger
        await watcher.poll();          // stable 2 -> ignored
        expect(deps.verifyVolumesJob.start).toHaveBeenCalledTimes(2);
    });

    it('persists the high-water onto the volume when it triggers', async () => {
        const run = vi.fn(async (_c: string, args: string[]) => ({ code: 0, stdout: args.includes('smartd') ? smartd('sdaf', 2) : '' }));
        const deps = makeDeps({ run });
        await new SystemLogWatcher({ triggerCooldownMs: 0 }, deps).poll();
        expect(deps.persistPendingHighWater).toHaveBeenCalledWith(1, 2); // sdaf -> vol 1, count 2
    });

    it('does not re-verify a pending sector already recorded on the volume (survives restart)', async () => {
        // vol 1 (sdaf) loaded from its DB doc already at high-water 1 -- as it would be after a restart
        const run = vi.fn(async (_c: string, args: string[]) => ({ code: 0, stdout: args.includes('smartd') ? smartd('sdaf', 1) : '' }));
        const deps = makeDeps({ run, volumes: [[1, mkVol(1, 'sdaf', 1)]] });
        await new SystemLogWatcher({ triggerCooldownMs: 0 }, deps).poll();
        expect(deps.verifyVolumesJob.start).not.toHaveBeenCalled();
    });
});
