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
        // ONE SIGNAL PER DEVICE. A single line can now match more than one rule (the bracketed SCSI form and
        // the `dev X` form both fire on "[sdg] ... hardware error, dev sdg"), and one signal per disk is what
        // the caller wants anyway -- it arms a verify, and a disk cannot be verified twice at once.
        const signals = SystemLogWatcher.parseKernelErrors(KERNEL_OUTPUT);
        expect(signals.map(s => s.device)).toEqual(['sdn']);
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

    // UNDER LUKS, THE KERNEL DOES NOT NAME YOUR DISK. IT NAMES THE MAPPER.
    //
    // An encrypted volume's ext4 sits on a device-mapper node. Its filesystem errors therefore arrive as
    // `EXT4-fs (dm-3): ...` -- and dm-3 is a name the fleet has never heard of. Both halves of this were broken:
    // the errors were never PARSED (no ext4 rule at all, for any disk), and even if they had been, dm-3 could
    // not be RESOLVED to a volume. On an encrypted array the whole channel goes quiet -- the layer closest to
    // the data, the one that knows a directory would not read, saying nothing at all.
    //
    // Fixed before a single volume is encrypted, because turning encryption on with this in place would arm it.
    describe('kernel block errors', () => {
        it('hears the phrases a failing USB enclosure actually uses', () => {
            // `device offline error` and `hardware error` are exactly what these enclosures say as they go, and
            // neither was in the original set. A phrase we do not listen for is a disk we do not hear die.
            const signals = SystemLogWatcher.parseKernelErrors([
                'blk_update_request: device offline error, dev sdf, sector 12345',
                'sd 1:0:0:0: [sdg] tag#0 FAILED Result: hostbyte=DID_ERROR hardware error, dev sdg,'
            ].join('\n'));

            expect(signals.map(s => s.device)).toEqual(['sdf', 'sdg']);
        });
    });

    // JBD2 IS THE JOURNAL LAYER, AND IT SPEAKS FOR ITSELF.
    //
    // An aborted journal is not a hint that a disk MIGHT be failing. It is the filesystem announcing that it has
    // stopped being able to write -- the last thing it says before it goes read-only. None of these lines say
    // "EXT4-fs", and none say "dev <name>", so neither existing parser saw a single one of them.
    describe('jbd2 journal failures', () => {
        it('hears an aborting journal, and strips the journal suffix off the device name', () => {
            const signals = SystemLogWatcher.parseJbd2Errors([
                'JBD2: Detected IO errors while flushing file data on dm-3-8',
                'Aborting journal on device sdf1-8.'
            ].join('\n'));

            // dm-3-8 -> dm-3 (the trailing -N is the journal's minor number, not part of the device)
            expect(signals.map(s => s.device)).toEqual(['dm-3', 'sdf1']);
            expect(signals.every(s => s.kind === 'ioerror')).toBe(true);
        });

        it('hears the "for <device>" form, which is what jbd2 says when it cannot write the superblock', () => {
            // jbd2 uses both `on <dev>` and `for <dev>`, and the `for` form is the one it emits when it cannot
            // update the journal superblock -- about as close to "this disk is gone" as a filesystem gets. The
            // first version of this parser only knew `on`, and would have heard nothing at all.
            const signals = SystemLogWatcher.parseJbd2Errors([
                'JBD2: I/O error when updating journal superblock for dm-3-8.',
                'JBD2: Error -5 detected when updating journal superblock for sdf1-8.',
                'JBD2: Detected IO errors while flushing file data on nvme0n1p1-8'
            ].join('\n'));

            expect(signals.map(s => s.device)).toEqual(['dm-3', 'sdf1', 'nvme0n1p1']);
        });
    });

    describe('ext4 filesystem errors', () => {
        it('parses EXT4-fs errors, including the device-mapper ones LUKS produces', () => {
            const signals = SystemLogWatcher.parseExt4Errors([
                'EXT4-fs error (device sdf1): ext4_find_entry:1455: inode #2: reading directory lblock 0',
                'EXT4-fs (dm-3): I/O error while writing superblock',
                'EXT4-fs warning (device dm-7): ext4_end_bio:343: I/O error 10 writing to inode 42',
                'EXT4-fs (sdb1): mounted filesystem with ordered data mode'
            ].join('\n'));

            expect(signals.map(s => s.device)).toEqual(['sdf1', 'dm-3', 'dm-7']);
            expect(signals.every(s => s.kind === 'ioerror')).toBe(true);

            // ...and a routine mount message is not a dying disk.
            expect(signals.map(s => s.device)).not.toContain('sdb1');
        });

        it('hears ext4 SAY IT HAS GIVEN UP, not just the word "error"', () => {
            // These are the sentences ext4 uses when it has actually stopped. A filesystem that has aborted its
            // journal or remounted itself read-only is not a warning ABOUT a disk -- it IS a disk, dying, in the
            // plainest words the kernel has. The first version of this filter looked for "I/O error" and friends
            // and would have dropped every one of them.
            const signals = SystemLogWatcher.parseExt4Errors([
                'EXT4-fs (dm-3): shut down requested',
                'EXT4-fs (dm-4): Remounting filesystem read-only',
                'EXT4-fs error (device sdf1): Journal has aborted',
                'EXT4-fs (sdg1): mounted filesystem with ordered data mode'      // routine: not a signal
            ].join('\n'));

            expect(signals.map(s => s.device)).toEqual(['dm-3', 'dm-4', 'sdf1']);
        });

        it('does not treat every ext4 warning as a failing disk', () => {
            const signals = SystemLogWatcher.parseExt4Errors(
                'EXT4-fs warning (device sdf1): ext4_multi_mount_protect:322: MMP interval 42 too big');
            expect(signals).toEqual([]);
        });
    });
});