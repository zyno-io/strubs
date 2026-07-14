import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class MockStdin extends EventEmitter {
    ended: string | null = null;
    end(data: string) { this.ended = data; }
}

class MockProcess extends EventEmitter {
    stdout: EventEmitter | null = new EventEmitter();
    stderr: EventEmitter | null = new EventEmitter();
    stdin: MockStdin | null = new MockStdin();
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

    it('collects stdout and resolves once the streams have closed', async () => {
        const promise = spawnHelper('ls', ['-l']);
        const proc = createdProcesses[0];

        proc.stdout?.emit('data', Buffer.from('hello '));
        proc.stdout?.emit('data', Buffer.from('world'));
        proc.stderr?.emit('data', Buffer.from('warn '));
        proc.stderr?.emit('data', Buffer.from('msg'));
        proc.emit('close', 0);

        await expect(promise).resolves.toEqual({ code: 0, stdout: 'hello world', stderr: 'warn msg' });
        expect(spawnMock).toHaveBeenCalledWith('ls', ['-l']);
    });

    // THE RACE THIS EXISTS TO CLOSE. 'exit' fires while stdio may still be in flight -- and a wipefs whose
    // output we dropped looks exactly like a wipefs that found nothing, which the provisioner reads as PROOF
    // that a disk is blank. Data arriving after 'exit' must still be in the result.
    it('does not truncate output that arrives after the process exits', async () => {
        const promise = spawnHelper('wipefs', ['-n', '/dev/sdb']);
        const proc = createdProcesses[0];

        proc.emit('exit', 0);
        proc.stdout?.emit('data', Buffer.from('{"signatures": [{"fstype": "ext4"}]}'));
        proc.emit('close', 0);

        await expect(promise).resolves.toEqual({
            code: 0,
            stdout: '{"signatures": [{"fstype": "ext4"}]}',
            stderr: ''
        });
    });

    // ...but 'close' alone could hang forever on a child that leaves a pipe open, and a hang in here freezes
    // discovery and mounting. After the grace period we return what we have.
    it('does not hang when a stream never closes', async () => {
        vi.useFakeTimers();
        try {
            const promise = spawnHelper('parted', ['-s', '/dev/sdb', 'mklabel', 'gpt']);
            const proc = createdProcesses[0];

            proc.stdout?.emit('data', Buffer.from('done'));
            proc.emit('exit', 0);
            // No 'close'. The pipe is being held open by something that outlived the child.
            await vi.advanceTimersByTimeAsync(5_000);

            await expect(promise).resolves.toEqual({ code: 0, stdout: 'done', stderr: '' });
        }
        finally {
            vi.useRealTimers();
        }
    });

    // A passphrase on the command line is a passphrase handed to every user on the box, via /proc.
    it('writes stdin to the child and never to argv', async () => {
        const promise = spawnHelper('cryptsetup', ['luksAddKey', '-'], { stdin: 'a recovery passphrase' });
        const proc = createdProcesses[0];

        expect(proc.stdin?.ended).toBe('a recovery passphrase');
        expect(spawnMock.mock.calls[0][1]).not.toContain('a recovery passphrase');

        proc.emit('close', 0);
        await promise;
    });

    it('survives a child that exits without reading stdin', async () => {
        const promise = spawnHelper('cryptsetup', ['luksAddKey', '-'], { stdin: 'secret passphrase' });
        const proc = createdProcesses[0];

        // EPIPE. Normal, and not a reason to fail the call: the exit code says what happened.
        proc.stdin?.emit('error', new Error('EPIPE'));
        proc.emit('close', 1);

        await expect(promise).resolves.toMatchObject({ code: 1 });
    });

    it('rejects when the process emits an error', async () => {
        const promise = spawnHelper('ls', []);
        const proc = createdProcesses[0];
        const err = new Error('spawn failed');

        proc.emit('error', err);

        await expect(promise).rejects.toBe(err);
    });
});
