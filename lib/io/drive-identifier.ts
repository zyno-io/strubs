import { promises as fsp } from 'fs';
import { createLogger } from '../log';

// Each heartbeat keeps the LED flashing this long; the UI re-pings well inside this window (~1s) so a
// dropped client (closed tab, crash, a "stop" click that never lands) self-heals -- reads cease within
// the TTL with no explicit cancel needed.
const IDENTIFY_TTL_MS = 3000;
const READ_CHUNK_BYTES = 1024 * 1024;                     // 1 MiB reads
// Advance the read offset so every read hits fresh sectors (defeats the page cache -> the head actually
// seeks -> the LED flashes). Wrap within the first 256 GiB, comfortably inside every drive in the fleet.
const READ_SPAN_BYTES = 256 * 1024 * 1024 * 1024;
const MAX_CONSECUTIVE_ERRORS = 16;                        // give up if the device keeps erroring (unplugged)
// After an explicit stop, briefly ignore identify() calls so a heartbeat POST that was already in flight
// when the operator hit Stop can't land afterward and revive the flashing. Must exceed the UI heartbeat
// interval (~1s) plus round-trip jitter.
const STOP_SUPPRESS_MS = 1500;

type DeviceReader = {
    read(buffer: Buffer, offset: number, length: number, position: number): Promise<unknown>;
    close(): Promise<void>;
};

type DriveIdentifierDeps = {
    now: () => number;
    openDevice: (devicePath: string) => Promise<DeviceReader>;
    createLogger: typeof createLogger;
};

type IdentifySession = { devicePath: string; expiry: number; running: boolean };

const defaultDeps: DriveIdentifierDeps = {
    now: () => Date.now(),
    openDevice: (devicePath: string) => fsp.open(devicePath, 'r') as unknown as Promise<DeviceReader>,
    createLogger
};

// Flashes a drive's activity LED so an operator can physically locate the bay before pulling it, by
// issuing continuous read-only I/O to the raw block device (like `dd if=/dev/sdX of=/dev/null`). Purely
// read-only and safe to run against a mounted, in-use drive. Keyed by device path so two calls for the
// same drive share one read loop.
export class DriveIdentifier {
    private readonly deps: DriveIdentifierDeps;
    private readonly log: ReturnType<typeof createLogger>;
    private readonly sessions = new Map<string, IdentifySession>();
    // devicePath -> timestamp until which identify() is ignored (set by stop(), so a racing in-flight
    // heartbeat can't restart a session the operator just stopped).
    private readonly suppressUntil = new Map<string, number>();

    constructor(deps?: Partial<DriveIdentifierDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('drive-identify');
    }

    // Start or extend flashing. Idempotent -- call every ~1s as a heartbeat; each call pushes the stop
    // deadline TTL into the future.
    identify(devicePath: string): void {
        const now = this.deps.now();
        // A heartbeat that raced a just-issued stop must not revive it (see STOP_SUPPRESS_MS).
        if (now < (this.suppressUntil.get(devicePath) ?? 0))
            return;
        const existing = this.sessions.get(devicePath);
        const expiry = now + IDENTIFY_TTL_MS;
        if (existing && existing.running) {
            existing.expiry = expiry;
            return;
        }
        const session: IdentifySession = { devicePath, expiry, running: true };
        this.sessions.set(devicePath, session);
        this.log('identifying drive %s (reading to flash its LED)', devicePath);
        void this.runLoop(session);
    }

    // Stop flashing (the explicit "stop" button / DELETE). Ends the read loop at its next check and
    // suppresses any in-flight heartbeat that would otherwise restart it. No-op if not running.
    stop(devicePath: string): void {
        this.suppressUntil.set(devicePath, this.deps.now() + STOP_SUPPRESS_MS);
        const session = this.sessions.get(devicePath);
        if (session)
            session.expiry = 0; // the loop exits at its next deadline check and closes the device
    }

    isIdentifying(devicePath: string): boolean {
        const session = this.sessions.get(devicePath);
        return !!session && session.running && this.deps.now() < session.expiry;
    }

    private async runLoop(session: IdentifySession): Promise<void> {
        let device: DeviceReader | null = null;
        const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
        let offset = 0;
        let consecutiveErrors = 0;
        try {
            device = await this.deps.openDevice(session.devicePath);
            while (this.deps.now() < session.expiry) {
                try {
                    await device.read(buffer, 0, READ_CHUNK_BYTES, offset);
                    consecutiveErrors = 0;
                }
                catch (err) {
                    // A bad sector (EIO) is fine on these aging drives -- skip past it and keep flashing.
                    // Only a run of errors (device yanked mid-identify) aborts the loop.
                    if (++consecutiveErrors > MAX_CONSECUTIVE_ERRORS) {
                        this.log.error('identify of %s aborted after %d read errors: %s', session.devicePath, consecutiveErrors, err instanceof Error ? err.message : String(err));
                        break;
                    }
                }
                offset += READ_CHUNK_BYTES;
                if (offset >= READ_SPAN_BYTES)
                    offset = 0;
            }
        }
        catch (err) {
            this.log.error('could not identify drive %s: %s', session.devicePath, err instanceof Error ? err.message : String(err));
        }
        finally {
            session.running = false;
            // Only clear the map entry if it's still THIS session -- a heartbeat that raced the shutdown
            // may have already installed a fresh session + loop we must not evict.
            if (this.sessions.get(session.devicePath) === session)
                this.sessions.delete(session.devicePath);
            if (device)
                await device.close().catch(() => undefined);
        }
    }
}

export const driveIdentifier = new DriveIdentifier();
