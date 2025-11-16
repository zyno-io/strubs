export type VolumePriority = 'normal' | 'low';

type Resolver = () => void;

class VolumePriorityState {
    private highCount = 0;
    private waiters: Resolver[] = [];

    incrementHigh(): void {
        this.highCount++;
    }

    decrementHigh(): void {
        if (this.highCount === 0)
            return;
        this.highCount--;
        if (this.highCount === 0)
            this.drainWaiters();
    }

    createWaitPromise(): Promise<void> | null {
        if (this.highCount === 0)
            return null;
        return new Promise(resolve => this.waiters.push(resolve));
    }

    forceUnblock(): void {
        this.drainWaiters();
    }

    getHighCount(): number {
        return this.highCount;
    }

    getWaiterCount(): number {
        return this.waiters.length;
    }

    private drainWaiters(): void {
        if (!this.waiters.length)
            return;
        const waiters = this.waiters.slice();
        this.waiters.length = 0;
        waiters.forEach(resolve => {
            try {
                resolve();
            }
            catch {
                // ignore resolver failures
            }
        });
    }
}

export class VolumePriorityManager {
    private readonly states = new Map<number, VolumePriorityState>();

    waitForAccess(volumeId: number, priority: VolumePriority): Promise<void> | null {
        if (priority === 'normal')
            return null;
        const state = this.getState(volumeId);
        return state.createWaitPromise();
    }

    registerHandle(volumeId: number, priority: VolumePriority): () => void {
        if (priority === 'low')
            return () => undefined;
        const state = this.getState(volumeId);
        state.incrementHigh();
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            state.decrementHigh();
        };
    }

    unblockAll(): void {
        for (const state of this.states.values()) {
            state.forceUnblock();
        }
    }

    getStats(): Array<{ volumeId: number; highCount: number; waiters: number }> {
        const stats: Array<{ volumeId: number; highCount: number; waiters: number }> = [];
        for (const [volumeId, state] of this.states.entries()) {
            const highCount = state.getHighCount();
            const waiters = state.getWaiterCount();
            if (highCount > 0 || waiters > 0) {
                stats.push({ volumeId, highCount, waiters });
            }
        }
        return stats;
    }

    private getState(volumeId: number): VolumePriorityState {
        let state = this.states.get(volumeId);
        if (!state) {
            state = new VolumePriorityState();
            this.states.set(volumeId, state);
        }
        return state;
    }
}

export const volumePriorityManager = new VolumePriorityManager();
