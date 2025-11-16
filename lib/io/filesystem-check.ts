import { spawnHelper } from '../helpers/spawn';
import type { Logger } from '../log';

const SUPERBLOCK_ERROR_KEYWORDS = ['invalid', 'corrupt', 'error', 'couldn\'t', 'bad', 'missing', 'checksum', 'failed'];

const ACCEPTABLE_FSCK_CODES = new Set([0, 1, 2]);

type LoggerLike = Logger | ((...args: unknown[]) => void) | undefined;

const logInfo = (logger: LoggerLike, message: string, ...args: unknown[]): void => {
    if (typeof logger === 'function')
        logger(message, ...args);
};

export async function ensureExtFilesystemHealthy(blockPath: string, logger?: LoggerLike): Promise<void> {
    const dumpResult = await spawnHelper('dumpe2fs', ['-h', blockPath]);
    const dumpCode = typeof dumpResult.code === 'number' ? dumpResult.code : -1;
    const dumpOutput = [dumpResult.stdout, dumpResult.stderr ?? ''].filter(Boolean).join('\n');

    if (!needsFilesystemRepair(dumpCode, dumpOutput))
        return;

    logInfo(logger, 'filesystem issues detected on %s; running e2fsck -y', blockPath);
    const repairResult = await spawnHelper('e2fsck', ['-y', blockPath]);
    const repairCode = typeof repairResult.code === 'number' ? repairResult.code : -1;

    if (!ACCEPTABLE_FSCK_CODES.has(repairCode)) {
        const detail = [repairResult.stdout, repairResult.stderr ?? ''].filter(Boolean).join('\n');
        throw new Error('e2fsck exited with code ' + repairCode + (detail ? ': ' + detail : ''));
    }

    logInfo(logger, 'filesystem repair completed for %s (exit code %d)', blockPath, repairCode);
}

function needsFilesystemRepair(exitCode: number, output: string): boolean {
    if (exitCode !== 0)
        return true;
    if (!output)
        return false;
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
        const normalized = line.trim().toLowerCase();
        if (normalized.includes('superblock')) {
            if (SUPERBLOCK_ERROR_KEYWORDS.some(keyword => normalized.includes(keyword)))
                return true;
        }
        if (normalized.startsWith('filesystem state:') && normalized.includes('with errors'))
            return true;
        if (normalized.startsWith('fs error count:')) {
            const match = normalized.match(/(\d+)/);
            if (match && Number.parseInt(match[1], 10) > 0)
                return true;
        }
    }
    return false;
}
