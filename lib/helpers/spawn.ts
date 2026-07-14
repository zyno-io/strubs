import { spawn } from 'child_process';

export interface SpawnResult {
    code: number | null;
    stdout: string;
    stderr?: string;
}

// How long after a process exits we will wait for its stdio to drain before giving up and returning what we
// got. Generous: every millisecond here is only ever spent on a child that has already exited AND is holding a
// pipe open, which is pathological. The normal path resolves on 'close' and never looks at this.
const STDIO_GRACE_MS = 5_000;

export interface SpawnOptions {
    // Written to the child's stdin and then closed. Use this for SECRETS: argv is world-readable via /proc for
    // the lifetime of the process, so a passphrase passed as an argument is a passphrase handed to every user
    // on the box.
    stdin?: string;
}

export function spawnHelper(path: string, args: string[], options: SpawnOptions = {}): Promise<SpawnResult> {
    return new Promise((resolve, reject) => {
        const proc = spawn(path, args);

        let out = '';
        proc.stdout?.on('data', data => {
            out += data.toString();
        });

        let errOut = '';
        proc.stderr?.on('data', data => {
            errOut += data.toString();
        });

        proc.on('error', err => {
            reject(err);
        });

        if (options.stdin !== undefined) {
            // EPIPE if the child exits without reading -- which is a normal way for a child to behave, and not
            // a reason to fail the call. The exit code tells us what happened.
            proc.stdin?.on('error', () => undefined);
            proc.stdin?.end(options.stdin);
        }

        // 'close', NOT 'exit' -- with a fallback, because neither one alone is safe.
        //
        // 'exit' fires when the process dies, while its stdio may still have buffered data in flight: resolving
        // there can hand back TRUNCATED -- or empty -- stdout for a command that in fact printed plenty. That is
        // not a cosmetic race. `probeSignature()` reads "exit 0 and no signatures" as PROOF THAT A DISK IS
        // BLANK, and a wipefs whose output we dropped on the floor looks exactly like a wipefs that found
        // nothing. The guard between a live STRUBS disk and `parted mklabel` would have been decided by a stdio
        // race.
        //
        // But 'close' alone can HANG: it waits for every pipe to close, and a child that leaves one open (a
        // forked grandchild, a tool that daemonizes) never gets there. A hang in here freezes discovery and
        // mounting, which is worse than the truncation we came to fix.
        //
        // So: resolve on 'close', and if the process has already exited and the streams have not caught up
        // within the grace period, resolve with what we have rather than waiting forever.
        let settled = false;
        let graceTimer: NodeJS.Timeout | null = null;

        const settle = (code: number | null) => {
            if (settled)
                return;
            settled = true;
            if (graceTimer)
                clearTimeout(graceTimer);
            resolve({ code, stdout: out, stderr: errOut });
        };

        proc.on('close', code => settle(code));

        proc.on('exit', code => {
            graceTimer = setTimeout(() => settle(code), STDIO_GRACE_MS);
            // Never hold the event loop open for a straggling pipe.
            graceTimer.unref?.();
        });
    });
}
