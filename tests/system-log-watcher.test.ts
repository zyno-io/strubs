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
        const volumes: [number, any][] = [
            [1, { deviceName: 'sdaf', isDeleted: false }],
            [2, { deviceName: 'sdn', isDeleted: false }]
        ];
        return {
            run,
            ioManager: { getVolumeEntries: vi.fn(() => volumes) },
            verifyVolumesJob: { start: vi.fn().mockResolvedValue({ startedAt: 'x' }) },
            notificationService: { notify: vi.fn().mockResolvedValue({ delivered: [], failed: [], suppressed: false }) },
            createLogger: loggerFactory(),
            now: () => 1000,
            ...overrides
        };
    };

    it('triggers targeted verify only for devices mapped to managed volumes', async () => {
        const deps = makeDeps();
        const watcher = new SystemLogWatcher({}, deps);
        await watcher.poll();

        // sdaf -> vol 1, sdn -> vol 2; sdx is unmapped and ignored.
        const verifiedVolumes = deps.verifyVolumesJob.start.mock.calls.map((c: any[]) => c[0].volumeIds[0]).sort();
        expect(verifiedVolumes).toEqual([1, 2]);
        expect(deps.notificationService.notify).toHaveBeenCalledTimes(2);
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
});
