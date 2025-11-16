import { spawn } from 'child_process';

export interface SpawnResult {
    code: number | null;
    stdout: string;
    stderr?: string;
}

export function spawnHelper(path: string, args: string[]): Promise<SpawnResult> {
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

        proc.on('exit', code => {
            resolve({ code, stdout: out, stderr: errOut });
        });
    });
}
