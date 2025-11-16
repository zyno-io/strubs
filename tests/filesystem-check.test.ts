import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../lib/log';

const spawnHelperMock = vi.fn();

vi.mock('../lib/helpers/spawn', () => ({
    spawnHelper: (...args: unknown[]) => spawnHelperMock(...args)
}));

import { ensureExtFilesystemHealthy } from '../lib/io/filesystem-check';

const createLogger = (): Logger => {
    const logger = vi.fn() as unknown as Logger;
    logger.error = vi.fn();
    return logger;
};

describe('ensureExtFilesystemHealthy', () => {
    beforeEach(() => {
        spawnHelperMock.mockReset();
    });

    it('does nothing when dumpe2fs reports no issues', async () => {
        spawnHelperMock.mockResolvedValue({ code: 0, stdout: 'Primary superblock at 0', stderr: '' });

        await ensureExtFilesystemHealthy('/dev/sda1');

        expect(spawnHelperMock).toHaveBeenCalledTimes(1);
        expect(spawnHelperMock).toHaveBeenCalledWith('dumpe2fs', ['-h', '/dev/sda1']);
    });

    it('runs e2fsck when dumpe2fs reports superblock errors', async () => {
        spawnHelperMock
            .mockResolvedValueOnce({ code: 0, stdout: 'Superblock has an invalid checksum', stderr: '' })
            .mockResolvedValueOnce({ code: 1, stdout: 'File system errors corrected', stderr: '' });
        const logger = createLogger();

        await ensureExtFilesystemHealthy('/dev/sdb1', logger);

        expect(spawnHelperMock).toHaveBeenCalledTimes(2);
        expect(spawnHelperMock).toHaveBeenLastCalledWith('e2fsck', ['-y', '/dev/sdb1']);
        expect(logger).toHaveBeenCalled();
    });

    it('throws when e2fsck reports uncorrected errors', async () => {
        spawnHelperMock
            .mockResolvedValueOnce({ code: 0, stdout: 'Superblock invalid', stderr: '' })
            .mockResolvedValueOnce({ code: 4, stdout: 'Errors uncorrected', stderr: '' });

        await expect(ensureExtFilesystemHealthy('/dev/sdc1')).rejects.toThrow('e2fsck exited with code 4');
    });

    it('repairs when filesystem state indicates errors', async () => {
        spawnHelperMock
            .mockResolvedValueOnce({ code: 0, stdout: 'Filesystem state: clean with errors\nFS Error count: 3', stderr: '' })
            .mockResolvedValueOnce({ code: 2, stdout: 'Errors corrected, system altered', stderr: '' });

        await ensureExtFilesystemHealthy('/dev/sdd1');

        expect(spawnHelperMock).toHaveBeenLastCalledWith('e2fsck', ['-y', '/dev/sdd1']);
    });
});
