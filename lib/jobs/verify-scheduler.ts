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
        this.timer = setInterval(() => this.tick(), intervalMs);
        this.timer.unref?.();
    }

    stop(): void {
        if (!this.timer)
            return;
        clearInterval(this.timer);
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
