import { createLogger } from '../log';
import { verifyVolumesJob } from './verify-volumes-job';

type VerifySchedulerDeps = {
    verifyVolumesJob: Pick<typeof verifyVolumesJob, 'start' | 'isRunning'>;
    createLogger: typeof createLogger;
};

const defaultDeps: VerifySchedulerDeps = {
    verifyVolumesJob,
    createLogger
};

const MAX_TIMER_MS = 2147483647; // Node's max setTimeout delay (2^31-1 ms, ~24.8 days)

// Drives the always-on, low-rate rolling scrub. It simply pokes the verify job
// on an interval; the job itself is a singleton that no-ops if a run (rolling or
// targeted) is already in flight, and it checkpoints/resumes its own progress,
// so the scrub naturally spans many ticks on a large array.
export class VerifyScheduler {
    private readonly deps: VerifySchedulerDeps;
    private readonly log: ReturnType<typeof createLogger>;
    private timer: NodeJS.Timeout | null = null;
    private intervalMs = 0;

    constructor(deps?: Partial<VerifySchedulerDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('verify-scheduler');
    }

    start(intervalMs: number): void {
        if (this.timer)
            return;
        if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
            this.log('rolling scrub disabled (no interval configured)');
            return;
        }
        this.intervalMs = intervalMs;
        this.log('rolling scrub scheduled every %dms', intervalMs);
        this.scheduleNext(intervalMs);
    }

    // Node's timers overflow to a 1ms delay for values above ~24.8 days (2^31-1 ms), which would fire
    // the scrub continuously. Chunk long waits into safe spans and only tick when the full delay elapses.
    private scheduleNext(remainingMs: number): void {
        const chunk = Math.min(remainingMs, MAX_TIMER_MS);
        this.timer = setTimeout(() => {
            const left = remainingMs - chunk;
            if (left > 0) {
                this.scheduleNext(left);
                return;
            }
            this.tick();
            this.scheduleNext(this.intervalMs);
        }, chunk);
        this.timer.unref?.();
    }

    stop(): void {
        if (!this.timer)
            return;
        clearTimeout(this.timer);
        this.timer = null;
    }

    isScheduled(): boolean {
        return this.timer !== null;
    }

    private tick(): void {
        if (this.deps.verifyVolumesJob.isRunning())
            return;
        this.log('triggering scheduled rolling scrub');
        void Promise.resolve(this.deps.verifyVolumesJob.start()).catch(err => {
            this.log.error('scheduled scrub failed to start: %s', err instanceof Error ? err.message : String(err));
        });
    }
}

export const verifyScheduler = new VerifyScheduler();
