import { promises as fsp } from 'fs';

import { spawnHelper } from '../helpers/spawn';
import { createLogger } from '../log';
import { ioManager } from './manager';
import { verifyVolumesJob } from '../jobs/verify-volumes-job';
import { notificationService, NotificationService } from '../notify/service';
import { database } from '../database';
import type { Volume } from './volume';

type RunFn = (command: string, args: string[]) => Promise<{ code: number | null; stdout: string }>;

type SystemLogWatcherDeps = {
    run: RunFn;
    ioManager: Pick<typeof ioManager, 'getVolumeByDeviceName'>;
    verifyVolumesJob: Pick<typeof verifyVolumesJob, 'start'>;
    notificationService: NotificationService;
    // Persist a volume's pending-sector high-water (the in-memory Volume is updated separately).
    persistPendingHighWater: (volumeId: number, count: number) => Promise<void>;
    createLogger: typeof createLogger;
    now: () => number;
};

const defaultDeps: SystemLogWatcherDeps = {
    run: (command, args) => spawnHelper(command, args),
    ioManager,
    verifyVolumesJob,
    notificationService,
    persistPendingHighWater: (volumeId, count) => database.setVolumePendingSectorHighWater(volumeId, count),
    createLogger,
    now: () => Date.now()
};

export type DeviceSignal = {
    device: string;            // bare device name, e.g. "sdn"
    kind: 'pending' | 'ioerror';
    detail: string;
    count?: number;            // for 'pending': the current pending-sector count
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
    // Keyed by VOLUME, not device name: several device names now resolve to one volume (smartd names the
    // disk "sdf", the kernel names the partition "sdf1"). Keyed by name, each would carry its own
    // cooldown and a single poll could fire two verifies of the same drive, then re-notify every poll.
    private readonly lastTriggered = new Map<number, number>();

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
            ...SystemLogWatcher.parseKernelErrors(kernel),
            ...SystemLogWatcher.parseExt4Errors(kernel),
            ...SystemLogWatcher.parseJbd2Errors(kernel)
        ];
    }

    private async runJournal(args: string[]): Promise<string> {
        const { code, stdout } = await this.deps.run('journalctl', args);
        if (code !== 0)
            throw new Error(`journalctl exited with code ${code}`);
        return stdout ?? '';
    }

    private dedupeByDevice(signals: DeviceSignal[]): DeviceSignal[] {
        // Keep the LAST signal per device: for pending, the most recent line carries the current count,
        // so an increase within the same window (e.g. 1 -> 2) isn't masked by an earlier line.
        const seen = new Map<string, DeviceSignal>();
        for (const signal of signals)
            seen.set(signal.device, signal);
        return Array.from(seen.values());
    }

    private async handleSignal(signal: DeviceSignal): Promise<void> {
        const volume = await this.resolveVolume(signal.device);
        if (!volume) {
            // A DEVICE WE CANNOT PLACE IS NOT A DEVICE WITH NOTHING WRONG WITH IT.
            //
            // Most of the time this really is a disk we do not manage, and saying so quietly is right. But a
            // kernel filesystem error we could not attribute to a volume is the array losing its ability to
            // notice a disk dying -- so a name we do not RECOGNISE is said loudly, once, rather than filed
            // under "not ours" with everything else.
            if (/^dm-\d+$/.test(signal.device))
                this.log.error('a kernel error on %s could not be traced back to any volume. Under LUKS the '
                    + 'filesystem sits on a device-mapper node, and if this cannot be resolved the array will '
                    + 'stop noticing that an encrypted disk is failing.', signal.device);
            else
                this.log('ignoring %s on %s (not a managed volume)', signal.kind, signal.device);
            return;
        }
        const volumeId = volume.id;

        // Pending sectors are a STANDING condition smartd re-reports every check. Only act when the count
        // has grown beyond what we've already verified for THIS volume -- a stable known-pending sector
        // must not perpetually re-verify a whole drive. The high-water lives on the volume, so it
        // survives restarts and is discarded with the volume.
        if (signal.kind === 'pending' && (signal.count ?? 0) <= volume.pendingSectorHighWater)
            return;

        const last = this.lastTriggered.get(volumeId);
        const now = this.deps.now();
        if (last !== undefined && now - last < this.cooldownMs)
            return; // already acted on this volume recently, whichever device name reported it

        this.log('device %s (volume %d) reported %s; triggering targeted verify', signal.device, volumeId, signal.kind);

        await this.deps.notificationService.notify({
            severity: 'warning',
            title: `Device ${signal.device} reported ${signal.kind}`,
            body: `${signal.detail} — triggering targeted verify of volume ${volumeId}`,
            dedupeKey: `syslog:vol${volumeId}:${signal.kind}`,
            context: { device: signal.device, volumeId, kind: signal.kind }
        }).catch(err => {
            this.log.error('failed to notify for %s: %s', signal.device, err instanceof Error ? err.message : String(err));
        });

        try {
            const result = await this.deps.verifyVolumesJob.start({
                volumeIds: [volumeId],
                trigger: { source: 'syslog-watcher', device: signal.device, volumeId, kind: signal.kind, detail: signal.detail }
            });
            if (result.accepted === false) {
                this.log('targeted verify for volume %d was not accepted; leaving it out of cooldown', volumeId);
                return;
            }
            // Arm the cooldown only once the verify run was accepted, so a
            // transient failure doesn't suppress this volume for hours.
            this.lastTriggered.set(volumeId, now);
            // Record the pending high-water on the volume (in-memory + persisted) so this standing count
            // won't re-trigger; only a further increase will.
            if (signal.kind === 'pending') {
                volume.setPendingSectorHighWater(signal.count ?? 0);
                await this.deps.persistPendingHighWater(volumeId, signal.count ?? 0);
            }
        }
        catch (err) {
            this.log.error('failed to start targeted verify for volume %d: %s', volumeId, err instanceof Error ? err.message : String(err));
        }
    }

    // smartd names the DISK ("Device: /dev/sdaf"), but the kernel names the PARTITION when the error
    // comes up through the filesystem ("Buffer I/O error on dev sdf1"). volume.deviceName is the disk,
    // so a partition-scoped signal has to be mapped back to its parent disk -- otherwise it is dropped
    // as "not a managed volume", which silently killed the kernel-error half of this watcher.
    private async resolveVolume(device: string): Promise<Volume | null> {
        const exact = this.deps.ioManager.getVolumeByDeviceName(device);
        if (exact)
            return exact;

        // UNDER LUKS, THE KERNEL DOES NOT NAME YOUR DISK. IT NAMES THE MAPPER.
        //
        // An encrypted volume's ext4 lives on a device-mapper node, so its filesystem errors arrive as
        // `EXT4-fs (dm-3): ...` -- and "dm-3" matches nothing in the fleet, matches nothing in
        // parentDiskName(), and was therefore dropped as "not a managed volume". Every kernel filesystem error
        // on every encrypted disk in the rack, silently discarded. The array would stop noticing that an
        // encrypted disk was dying, which is precisely the thing it is there to notice.
        //
        // The mapping is in /sys: a dm node's `slaves` directory names the block device underneath it.
        const leaves = await SystemLogWatcher.mapperLeaves(device);

        const matched = new Map<number, Volume>();
        for (const leaf of leaves) {
            const v = this.deps.ioManager.getVolumeByDeviceName(leaf)
                ?? this.deps.ioManager.getVolumeByDeviceName(SystemLogWatcher.parentDiskName(leaf) ?? leaf);
            if (v) matched.set(v.id, v);
        }

        // ONE mapper, ONE volume -- and if that is not true, we do not GUESS which.
        //
        // Taking slaves[0] would attribute a failing disk's error to whichever name readdir happened to return
        // first, which on a stacked or multi-slave mapper is a coin toss. Arming a verify against the WRONG
        // volume is worse than arming none: it reads a healthy disk and reports it fine, while the one that is
        // actually dying is never looked at.
        if (matched.size === 1)
            return [...matched.values()][0];

        if (matched.size > 1) {
            this.log.error('a kernel error on %s maps to MORE THAN ONE managed volume (%s). Refusing to guess which '
                + 'disk it belongs to -- verifying the wrong one would report a healthy disk fine while the failing '
                + 'one is never looked at. Verify them by hand.',
                device, [...matched.values()].map(v => v.id).join(', '));
            return null;
        }

        const parent = SystemLogWatcher.parentDiskName(device);
        if (!parent)
            return null;
        return this.deps.ioManager.getVolumeByDeviceName(parent) ?? null;
    }

    // "dm-3" -> every real block device underneath it, following /sys/block/<dm>/slaves all the way down.
    //
    // Mappers STACK: dm-5 can sit on dm-4 which sits on sdf1, and a single-layer lookup stops at dm-4 and finds
    // nothing. And a mapper can have SEVERAL slaves. So this walks the whole tree, with a visited set (a cycle
    // in /sys would be a kernel bug, but a loop that hangs the log watcher would be ours), and returns the
    // leaves -- the devices that are not themselves mappers.
    // JBD2 IS THE JOURNAL LAYER, AND IT SPEAKS FOR ITSELF.
    //
    //     JBD2: Detected IO errors while flushing file data on dm-3-8
    //     JBD2: I/O error when updating journal superblock for dm-3-8.
    //     Aborting journal on device dm-3-8.
    //     JBD2: Error -5 detected when updating journal superblock for sdf1-8.
    //
    // None of those say "EXT4-fs", and none of them say "dev <name>", so neither existing parser saw them --
    // and an aborted journal is not a hint that a disk MIGHT be failing. It is the filesystem announcing that
    // it has stopped being able to write, which is the last thing it says before it goes read-only.
    //
    // The device name carries a journal suffix (`dm-3-8`, `sdf1-8`) which has to come off before the volume can
    // be found.
    static parseJbd2Errors(text: string): DeviceSignal[] {
        const signals: DeviceSignal[] = [];
        // `on <dev>` AND `for <dev>` -- jbd2 uses both, and the `for` form is the one it emits when it cannot
        // update the journal superblock, which is about as close to "this disk is gone" as a filesystem gets.
        const re = /(?:JBD2:\s*([^\n]*?)\s+(?:on|for)\s+|Aborting journal on device\s+)([a-zA-Z0-9_.-]+)/gi;

        let match: RegExpExecArray | null;
        while ((match = re.exec(text)) !== null) {
            const detail = (match[1] ?? 'aborting journal').trim().slice(0, 120);

            // `dm-3-8` -> `dm-3`, `sdf1-8` -> `sdf1`. The trailing `-N` is the journal's minor number, not
            // part of the device.
            const device = match[2].replace(/\.$/, '').replace(/-\d+$/, '');

            signals.push({ device, kind: 'ioerror', detail: `jbd2: ${detail}` });
        }

        return signals;
    }

    static async mapperLeaves(device: string, seen = new Set<string>()): Promise<string[]> {
        if (!/^dm-\d+$/.test(device) || seen.has(device)) return [];
        seen.add(device);

        const slaves = await fsp.readdir(`/sys/block/${device}/slaves`).catch(() => [] as string[]);
        const out: string[] = [];

        for (const slave of slaves) {
            if (/^dm-\d+$/.test(slave)) out.push(...await SystemLogWatcher.mapperLeaves(slave, seen));
            else out.push(slave);
        }

        return out;
    }

    // "sdf1" -> "sdf", "nvme0n1p2" -> "nvme0n1". null when `device` is already a whole disk.
    static parentDiskName(device: string): string | null {
        const nvme = /^(nvme\d+n\d+)p\d+$/.exec(device);
        if (nvme)
            return nvme[1];
        const sd = /^([a-zA-Z]+)\d+$/.exec(device);
        return sd ? sd[1] : null;
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
            const count = parseInt(match[2], 10);
            signals.push({ device: match[1], kind: 'pending', detail: `${count} pending sector(s)`, count });
        }
        return signals;
    }

    // "critical target error, dev sdn, sector 109348576 ..." / "I/O error, dev sdn,"
    static parseKernelErrors(text: string): DeviceSignal[] {
        const signals: DeviceSignal[] = [];
        // The phrases a failing block device actually uses. Missing one means a dying disk that nobody hears:
        // `device offline error` and `hardware error` are exactly what a USB enclosure says as it goes.
        const re = /(critical target error|critical medium error|I\/O error|medium error|hardware error|device offline error|unaligned write command|rejecting I\/O to offline device).*?\bdev\s+([a-zA-Z0-9_.-]+)/gi;
        let match: RegExpExecArray | null;
        while ((match = re.exec(text)) !== null) {
            signals.push({ device: match[2], kind: 'ioerror', detail: match[1].toLowerCase() });
        }

        // ...AND THE FORMS WHERE THE DEVICE COMES FIRST, IN BRACKETS.
        //
        //     sd 1:0:0:0: [sdf] rejecting I/O to offline device
        //     sd 1:0:0:0: [sdg] Unaligned partial completion
        //
        // The rule above needs `dev <name>` AFTER the phrase, so every one of these was dropped -- and
        // "rejecting I/O to offline device" is a USB enclosure that has already gone.
        const bracketed = /\[([a-zA-Z0-9_.-]+)\][^\n]*?(rejecting I\/O to offline device|device offline|hardware error|medium error|critical target error|unrecovered read error|unaligned partial completion|device not ready)/gi;

        while ((match = bracketed.exec(text)) !== null) {
            signals.push({ device: match[1], kind: 'ioerror', detail: match[2].toLowerCase() });
        }

        // One line can match both rules ("[sdg] ... hardware error, dev sdg"). One signal per device is what
        // the caller wants anyway -- it arms a verify, and a disk cannot be verified twice at once.
        // Keep the FIRST hit for each device: it is the most specific thing the kernel said before the noise
        // that follows it ("critical target error" comes before the generic "I/O error" it cascades into).
        const byDevice = new Map<string, DeviceSignal>();
        for (const sig of signals) if (!byDevice.has(sig.device)) byDevice.set(sig.device, sig);
        return [...byDevice.values()];
    }

    // THE FILESYSTEM'S OWN COMPLAINTS, WHICH NOBODY WAS LISTENING TO.
    //
    // The block layer says "I/O error, dev sdf" -- and that is what parseKernelErrors() catches. But ext4 has
    // its own voice, and it is a different sentence:
    //
    //     EXT4-fs error (device sdf1): ext4_find_entry:1455: inode #2: reading directory lblock 0
    //     EXT4-fs (dm-3): I/O error while writing superblock
    //     EXT4-fs warning (device dm-3): ext4_end_bio:343: I/O error 10 writing to inode 42
    //
    // None of those match "…dev <name>", so none of them were ever parsed -- for ANY disk. That is a gap that
    // has always been there; the array has simply never heard the filesystem tell it a disk was going.
    //
    // It becomes acute under LUKS. The physical I/O errors still name the real disk (`dev sdf`), but the
    // FILESYSTEM errors name the device-mapper node -- `EXT4-fs (dm-3)` -- and dm-3 is not a name the fleet has
    // ever heard of. So on an encrypted array, this whole channel goes quiet: the layer closest to the data,
    // the one that knows a directory would not read, saying nothing at all.
    //
    // Fixed before a single volume is encrypted, because turning encryption on with this in place would arm it.
    static parseExt4Errors(text: string): DeviceSignal[] {
        const signals: DeviceSignal[] = [];

        // `EXT4-fs error (device X):`, `EXT4-fs warning (device X):`, and the bare `EXT4-fs (X):` that ext4
        // uses for its most serious ones ("I/O error while writing superblock").
        const re = /EXT4-fs\s*(?:(error|warning)\s*)?\((?:device\s+)?([a-zA-Z0-9_.-]+)\)\s*:?\s*([^\n]*)/gi;

        let match: RegExpExecArray | null;
        while ((match = re.exec(text)) !== null) {
            const detail = (match[3] ?? '').trim().slice(0, 120);

            // NOT EVERY EXT4 LINE IS A DYING DISK, and treating them all as one would drown the real signal.
            //
            // ext4 announces itself on every mount ("EXT4-fs (sdb1): mounted filesystem with ordered data
            // mode") using the same bare form as its most serious complaint ("EXT4-fs (dm-3): I/O error while
            // writing superblock"). The keyword alone cannot tell them apart, so the CONTENT has to.
            //
            // AND THE VOCABULARY MATTERS. The first version of this looked for "I/O error" and friends, which
            // misses the sentences ext4 uses when it has actually given up:
            //
            //     EXT4-fs (dm-3): shut down requested
            //     EXT4-fs (dm-3): Remounting filesystem read-only
            //     EXT4-fs error (device sdf1): Journal has aborted
            //
            // A filesystem that has aborted its journal or gone read-only is not a warning about a disk. It IS
            // a disk, dying, in the plainest words the kernel has -- and every one of them would have been
            // dropped as "not severe enough".
            const SEVERE = /I\/O error|read error|write error|failed|corrupt|shut down requested|remounting filesystem read-only|aborted journal|journal has aborted|mounting fs with errors|previous I\/O error|inode.*is corrupt|comm .*: reading directory/i;

            const severe = match[1]?.toLowerCase() === 'error' || SEVERE.test(detail);

            if (!severe) continue;

            signals.push({
                device: match[2],
                kind: 'ioerror',
                detail: `ext4: ${detail || (match[1] ?? 'error')}`
            });
        }

        return signals;
    }
}

export const systemLogWatcher = new SystemLogWatcher();
