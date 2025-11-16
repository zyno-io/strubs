import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class MockProcess extends EventEmitter {
    stdout: EventEmitter | null = new EventEmitter();
    stderr: EventEmitter | null = new EventEmitter();
}

const spawnMock = vi.fn();

vi.mock('child_process', () => ({
    spawn: (...args: unknown[]) => spawnMock(...args)
}));

import { spawnHelper } from '../lib/helpers/spawn';

describe('spawnHelper', () => {
    const createdProcesses: MockProcess[] = [];

    beforeEach(() => {
        createdProcesses.length = 0;
        spawnMock.mockImplementation(() => {
            const proc = new MockProcess();
            createdProcesses.push(proc);
            return proc;
        });
    });

    it('collects stdout and resolves when the process exits', async () => {
        const promise = spawnHelper('ls', ['-l']);
        const proc = createdProcesses[0];

        proc.stdout?.emit('data', Buffer.from('hello '));
        proc.stdout?.emit('data', Buffer.from('world'));
        proc.stderr?.emit('data', Buffer.from('warn '));
        proc.stderr?.emit('data', Buffer.from('msg'));
        proc.emit('exit', 0);

        await expect(promise).resolves.toEqual({ code: 0, stdout: 'hello world', stderr: 'warn msg' });
        expect(spawnMock).toHaveBeenCalledWith('ls', ['-l']);
    });

    it('rejects when the process emits an error', async () => {
        const promise = spawnHelper('ls', []);
        const proc = createdProcesses[0];
        const err = new Error('spawn failed');

        proc.emit('error', err);

        await expect(promise).rejects.toBe(err);
    });
});
