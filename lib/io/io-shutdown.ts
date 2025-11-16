import { createLogger } from '../log';
import { volumePriorityManager } from './volume-priority-manager';

class IOShutdownController {
    private aborted = false;
    private reason: string | null = null;
    private readonly log = createLogger('io-shutdown');
    private abortWaiters: Array<() => void> = [];

    abort(reason: string): void {
        if (this.aborted)
            return;
        this.aborted = true;
        this.reason = reason;
        this.log('aborting in-flight I/O due to %s', reason);

        // Unblock all priority waiters to prevent hangs during shutdown
        const stats = volumePriorityManager.getStats();
        if (stats.length > 0) {
            this.log('unblocking %d priority waiters across %d volumes',
                stats.reduce((sum, s) => sum + s.waiters, 0),
                stats.length);
        }
        volumePriorityManager.unblockAll();

        const waiters = this.abortWaiters.slice();
        this.abortWaiters.length = 0;
        waiters.forEach(resolve => {
            try {
                resolve();
            }
            catch {
                // ignore
            }
        });
    }

    isAborted(): boolean {
        return this.aborted;
    }

    waitForAbort(): Promise<void> {
        if (this.aborted)
            return Promise.resolve();
        return new Promise(resolve => {
            this.abortWaiters.push(resolve);
        });
    }

    throwIfAborted(): void {
        if (!this.aborted)
            return;
        const err = new Error('I/O aborted due to shutdown');
        (err as Error & { code?: string }).code = 'IOABORT';
        throw err;
    }

    getReason(): string | null {
        return this.reason;
    }

    resetForTests(): void {
        this.aborted = false;
        this.reason = null;
        this.abortWaiters.length = 0;
    }
}

export const ioShutdown = new IOShutdownController();
