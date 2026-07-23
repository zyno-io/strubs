import { afterEach, describe, expect, it, vi } from 'vitest';

// Avoid loading the real verify job (and its native reed-solomon binding) — the
// scheduler is exercised purely through injected deps.
vi.mock('../lib/jobs/verify-volumes-job', () => ({
    verifyVolumesJob: { start: vi.fn(), isRunning: vi.fn(() => false) }
}));

import { VerifyScheduler } from '../lib/jobs/verify-scheduler';

const loggerFactory = () => vi.fn(() => Object.assign(vi.fn(), { error: vi.fn() })) as any;

const makeDeps = (isRunning = false) => ({
    verifyVolumesJob: {
        start: vi.fn().mockResolvedValue({ startedAt: 'x' }),
        isRunning: vi.fn(() => isRunning)
    },
    createLogger: loggerFactory()
});

describe('VerifyScheduler', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not schedule when the interval is not positive', () => {
        const scheduler = new VerifyScheduler(makeDeps());
        scheduler.start(0);
        expect(scheduler.isScheduled()).toBe(false);
    });

    it('triggers a rolling scrub on each tick when the job is idle', async () => {
        vi.useFakeTimers();
        const deps = makeDeps(false);
        const scheduler = new VerifyScheduler(deps);
        scheduler.start(1000);
        expect(scheduler.isScheduled()).toBe(true);

        await vi.advanceTimersByTimeAsync(1000);
        expect(deps.verifyVolumesJob.start).toHaveBeenCalledTimes(1);
        // no volume filter = rolling scrub, tagged as scheduled rather than manual/fault-driven.
        expect(deps.verifyVolumesJob.start).toHaveBeenCalledWith({ trigger: { source: 'scheduled' } });
        scheduler.stop();
    });

    it('skips a tick when a verify run is already in flight', async () => {
        vi.useFakeTimers();
        const deps = makeDeps(true);
        const scheduler = new VerifyScheduler(deps);
        scheduler.start(1000);

        await vi.advanceTimersByTimeAsync(1000);
        expect(deps.verifyVolumesJob.start).not.toHaveBeenCalled();
        scheduler.stop();
    });

    it('stop() clears the schedule', () => {
        vi.useFakeTimers();
        const scheduler = new VerifyScheduler(makeDeps());
        scheduler.start(1000);
        expect(scheduler.isScheduled()).toBe(true);
        scheduler.stop();
        expect(scheduler.isScheduled()).toBe(false);
    });

    it('handles intervals beyond the 32-bit timer max without firing early', async () => {
        vi.useFakeTimers();
        const deps = makeDeps(false);
        const scheduler = new VerifyScheduler(deps);
        const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000; // 2,592,000,000 > 2^31-1 -> Node would clamp to 1ms
        scheduler.start(THIRTY_DAYS);

        // Advancing well past the overflow point must NOT trigger a scrub (the bug fired every 1ms).
        await vi.advanceTimersByTimeAsync(60_000);
        expect(deps.verifyVolumesJob.start).not.toHaveBeenCalled();

        // It fires only once the full interval has actually elapsed.
        await vi.advanceTimersByTimeAsync(THIRTY_DAYS);
        expect(deps.verifyVolumesJob.start).toHaveBeenCalledTimes(1);
        scheduler.stop();
    });
});
