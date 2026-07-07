import { describe, expect, it, vi } from 'vitest';
import { DriveIdentifier } from '../lib/io/drive-identifier';
import type { Logger } from '../lib/log';

const noopLogger = (_subject: string): Logger => {
    const logger = ((..._args: unknown[]) => undefined) as Logger;
    logger.error = () => undefined;
    return logger;
};

// Build an identifier with a fake clock and a fake device whose read() advances the clock, so the TTL
// loop terminates deterministically without real time. Each read burns `stepMs` of the 3s TTL.
const makeIdentifier = (opts: { stepMs: number; onRead?: (readCount: number, identifier: DriveIdentifier) => void; throwEvery?: 'always' | number }) => {
    let clock = 0;
    let reads = 0;
    let closed = false;
    const reader = {
        read: async () => {
            reads++;
            clock += opts.stepMs;
            opts.onRead?.(reads, identifier);
            if (opts.throwEvery === 'always' || opts.throwEvery === reads)
                throw Object.assign(new Error('EIO'), { code: 'EIO' });
        },
        close: async () => { closed = true; }
    };
    const openDevice = vi.fn(async () => reader);
    const identifier = new DriveIdentifier({ now: () => clock, openDevice, createLogger: noopLogger });
    return { identifier, openDevice, stats: () => ({ reads, closed, clock }) };
};

describe('DriveIdentifier', () => {
    it('reads the device to flash the LED, then stops when the 3s TTL elapses and closes it', async () => {
        const { identifier, openDevice, stats } = makeIdentifier({ stepMs: 1000 });
        identifier.identify('/dev/sdx'); // expiry = 0 + 3000
        await vi.waitFor(() => expect(stats().closed).toBe(true));
        expect(openDevice).toHaveBeenCalledWith('/dev/sdx');
        expect(stats().reads).toBe(3); // reads at clock 0,1000,2000; at 3000 the loop exits
    });

    it('a heartbeat pushes the deadline out (keeps flashing while the UI pings)', async () => {
        // On the 2nd read (clock=2000) re-identify -> expiry becomes 2000+3000=5000, so it keeps going.
        const h = makeIdentifier({ stepMs: 1000, onRead: (n, id) => { if (n === 2) id.identify('/dev/sdx'); } });
        h.identifier.identify('/dev/sdx');
        await vi.waitFor(() => expect(h.stats().closed).toBe(true));
        expect(h.stats().reads).toBe(5); // without the heartbeat it would have stopped at 3
    });

    it('stop() ends the flashing promptly', async () => {
        const h = makeIdentifier({ stepMs: 1000, onRead: (n, id) => { if (n === 2) id.stop('/dev/sdx'); } });
        h.identifier.identify('/dev/sdx');
        await vi.waitFor(() => expect(h.stats().closed).toBe(true));
        expect(h.stats().reads).toBe(2); // stopped right after the 2nd read, not at the TTL
    });

    it('tolerates a bad sector (single read error) and keeps flashing', async () => {
        const { identifier, stats } = makeIdentifier({ stepMs: 1000, throwEvery: 1 }); // first read throws
        identifier.identify('/dev/sdx');
        await vi.waitFor(() => expect(stats().closed).toBe(true));
        expect(stats().reads).toBe(3); // didn't abort on the error; ran the full TTL
    });

    it('aborts if the device keeps erroring (yanked mid-identify)', async () => {
        const { identifier, stats } = makeIdentifier({ stepMs: 1, throwEvery: 'always' }); // never advances past TTL
        identifier.identify('/dev/sdx');
        await vi.waitFor(() => expect(stats().closed).toBe(true));
        expect(stats().reads).toBe(17); // 16 tolerated, the 17th trips the abort
    });

    it('a heartbeat that raced an explicit stop cannot revive the flashing (stop wins)', async () => {
        // On read #2, stop() then an immediately-following identify() (a heartbeat POST that was already
        // in flight when Stop was clicked). Without suppression that identify would restart the session.
        const h = makeIdentifier({ stepMs: 500, onRead: (n, id) => {
            if (n === 2) { id.stop('/dev/sdx'); id.identify('/dev/sdx'); }
        } });
        h.identifier.identify('/dev/sdx');
        await vi.waitFor(() => expect(h.stats().closed).toBe(true));
        expect(h.stats().reads).toBe(2); // stayed stopped despite the racing heartbeat
    });

    it('re-identifies normally once the stop-suppression window has elapsed', async () => {
        let clock = 0;
        let reads = 0;
        let closed = false;
        const reader = { read: async () => { reads++; clock += 1000; }, close: async () => { closed = true; } };
        const id = new DriveIdentifier({ now: () => clock, openDevice: async () => reader, createLogger: noopLogger });
        id.stop('/dev/sdx');                 // suppress until clock 1500
        id.identify('/dev/sdx');             // clock 0 < 1500 -> ignored
        expect(id.isIdentifying('/dev/sdx')).toBe(false);
        clock = 2000;                        // past the suppression window
        id.identify('/dev/sdx');             // now honored
        await vi.waitFor(() => expect(closed).toBe(true));
        expect(reads).toBeGreaterThan(0);    // flashed again
    });

    it('isIdentifying reflects the live state', async () => {
        const h = makeIdentifier({ stepMs: 1000 });
        expect(h.identifier.isIdentifying('/dev/sdx')).toBe(false);
        h.identifier.identify('/dev/sdx');
        expect(h.identifier.isIdentifying('/dev/sdx')).toBe(true);
        await vi.waitFor(() => expect(h.stats().closed).toBe(true));
        expect(h.identifier.isIdentifying('/dev/sdx')).toBe(false);
    });
});
