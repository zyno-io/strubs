import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnHelperMock = vi.fn();

vi.mock('../lib/helpers/spawn', () => ({
    spawnHelper: spawnHelperMock
}));

type IoHelpersModule = typeof import('../lib/io/helpers');
let ioHelpers: IoHelpersModule;

beforeAll(async () => {
    ioHelpers = await import('../lib/io/helpers');
});

beforeEach(() => {
    spawnHelperMock.mockReset();
});

describe('io helper commands', () => {
    it('invokes lsblk with JSON output flags', async () => {
        spawnHelperMock.mockResolvedValue({ code: 0, stdout: '{"blockdevices":[]}' });

        const result = await ioHelpers.lsblk();

        expect(result).toEqual({ blockdevices: [] });
        expect(spawnHelperMock).toHaveBeenCalledWith('lsblk', ['-OJb']);
    });

    it('passes additional lsblk parameters and surfaces errors', async () => {
        spawnHelperMock.mockResolvedValue({ code: 1, stdout: '' });
        await expect(ioHelpers.lsblk(['-p'])).rejects.toThrow('lsblk exited with code 1');
        expect(spawnHelperMock).toHaveBeenCalledWith('lsblk', ['-OJb', '-p']);
    });

    it('invokes smartctl with JSON output enforced', async () => {
        spawnHelperMock.mockResolvedValue({ code: 0, stdout: '{"serial_number":"XYZ"}' });

        const result = await ioHelpers.smartctl('-i', '/dev/sda');

        expect(result).toEqual({ data: { serial_number: 'XYZ' }, exitCode: 0 });
        expect(spawnHelperMock).toHaveBeenCalledWith('smartctl', ['--json=c', '-i', '/dev/sda']);
    });

    it('propagates smartctl failures when device cannot be opened', async () => {
        spawnHelperMock.mockResolvedValue({ code: 2, stdout: '{"error":"failed"}' });
        await expect(ioHelpers.smartctl('-H', '/dev/sdb')).rejects.toThrow('smartctl exited with code 2');
    });

    it('surfaces SMART health failures but still returns parsed data', async () => {
        spawnHelperMock.mockResolvedValue({ code: 4, stdout: '{"smart_status":{"passed":false}}' });
        const result = await ioHelpers.smartctl('-H', '/dev/sdb');
        expect(result).toEqual({ data: { smart_status: { passed: false } }, exitCode: 4 });
    });

    it('mounts block devices with provided options', async () => {
        spawnHelperMock.mockResolvedValue({ code: 0, stdout: '' });

        await ioHelpers.mount('/dev/sda1', '/mnt', 'ext4', { rw: true, uid: 1000 });

        expect(spawnHelperMock).toHaveBeenCalledWith('mount', [
            '/dev/sda1',
            '-t',
            'ext4',
            '-o',
            'rw=true,uid=1000',
            '/mnt'
        ]);
    });

    it('throws when mount exits with an error code', async () => {
        spawnHelperMock.mockResolvedValue({ code: 32, stdout: 'busy' });
        await expect(ioHelpers.mount('/dev/sdb1', '/mnt', 'xfs')).rejects.toThrow('mount exited with code 32: busy');
    });

    it('omits stdout info in mount errors when output is empty', async () => {
        spawnHelperMock.mockResolvedValue({ code: 1, stdout: '' });
        await expect(ioHelpers.mount('/dev/sdc1', '/mnt', 'btrfs')).rejects.toThrow('mount exited with code 1');
    });
});
