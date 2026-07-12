import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnHelperMock, readFileMock } = vi.hoisted(() => ({
    spawnHelperMock: vi.fn(),
    readFileMock: vi.fn()
}));

vi.mock('../lib/helpers/spawn', () => ({ spawnHelper: spawnHelperMock }));
vi.mock('fs', async () => {
    const real = await vi.importActual<typeof import('fs')>('fs');
    return {
        ...real,
        promises: {
            ...real.promises,
            mkdtemp: vi.fn(async () => '/tmp/strubs-probe-test'),
            readFile: readFileMock,
            rm: vi.fn(async () => undefined)
        }
    };
});

import { probeStrubsIdentity, probeDeviceForStrubsIdentity } from '../lib/io/device-identity-probe';
import { buildVolumeIdentityBuffer } from '../lib/io/volume-identity';

const extPartition = { type: 'part', name: 'sdb1', path: '/dev/sdb1', size: 100, fstype: 'ext4' } as any;

const enoent = () => { const e: any = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };

describe('device identity probe', () => {
    beforeEach(() => {
        spawnHelperMock.mockReset();
        readFileMock.mockReset();
        spawnHelperMock.mockResolvedValue({ code: 0, stdout: '' });   // mount + umount succeed
    });

    it('identifies a real STRUBS disk from its .identity record', async () => {
        const identityBuffer = Buffer.from('2fb05f231d5e4c00bb71f3109b42476c', 'hex');
        readFileMock.mockResolvedValue(buildVolumeIdentityBuffer({
            volumeId: 17,
            volumeUuid: '11111111-2222-3333-4444-555555555555',
            identityBuffer
        }));

        const result = await probeStrubsIdentity(extPartition);
        expect(result).toEqual({
            status: 'strubs',
            identity: { instanceIdentity: '2fb05f231d5e4c00bb71f3109b42476c', volumeId: 17 }
        });
    });

    it('mounts READ-ONLY and never replays the journal (a probe must not write to what it inspects)', async () => {
        readFileMock.mockImplementation(enoent);
        await probeStrubsIdentity(extPartition);

        const mountCall = spawnHelperMock.mock.calls.find(c => c[0] === 'mount');
        expect(mountCall![1]).toEqual(['-o', 'ro,noload', '-t', 'ext4', '/dev/sdb1', '/tmp/strubs-probe-test']);
        // ...and it always unmounts, even when it finds nothing.
        expect(spawnHelperMock.mock.calls.some(c => c[0] === 'umount')).toBe(true);
    });

    it('reports CLEAN only when it positively read the filesystem and found no identity', async () => {
        readFileMock.mockImplementation(enoent);
        expect(await probeStrubsIdentity(extPartition)).toEqual({ status: 'clean' });
    });

    it('reports CLEAN for a partition with no filesystem of ours (nothing to mount)', async () => {
        const blank = { type: 'part', name: 'sdb1', path: '/dev/sdb1', size: 100, fstype: null } as any;
        expect(await probeStrubsIdentity(blank)).toEqual({ status: 'clean' });
        expect(spawnHelperMock).not.toHaveBeenCalled();   // never even tried to mount
    });

    // THE bug this tri-state exists to prevent: a failed mount used to return "nothing found", which the
    // provisioner read as "not ours" and happily wiped. A disk we cannot read is not a blank disk.
    it('reports UNKNOWN (never clean) when the filesystem exists but will not mount', async () => {
        spawnHelperMock.mockResolvedValue({ code: 32, stdout: 'mount: /dev/sdb1 already mounted' });
        const result = await probeStrubsIdentity(extPartition);
        expect(result.status).toBe('unknown');
        expect(result.status === 'unknown' && result.reason).toMatch(/could not read-only mount/);
    });

    // Cleanup is part of the safety property. A 'clean' verdict we could not unmount after is a verdict
    // about a disk we left in an unknown state -- and the caller is about to reformat it.
    it('downgrades a CLEAN verdict to UNKNOWN if the probe could not be unmounted', async () => {
        readFileMock.mockImplementation(enoent);                       // would otherwise be 'clean'
        spawnHelperMock
            .mockResolvedValueOnce({ code: 0, stdout: '' })            // mount ok
            .mockResolvedValueOnce({ code: 1, stdout: 'target is busy' }); // umount FAILS

        const result = await probeStrubsIdentity(extPartition);
        expect(result.status).toBe('unknown');
        expect(result.status === 'unknown' && result.reason).toMatch(/could not unmount/);
    });

    it('reports UNKNOWN for a truncated or bad-magic identity file', async () => {
        readFileMock.mockResolvedValue(Buffer.alloc(10));
        expect((await probeStrubsIdentity(extPartition)).status).toBe('unknown');

        readFileMock.mockResolvedValue(Buffer.alloc(41));   // right length, wrong magic
        expect((await probeStrubsIdentity(extPartition)).status).toBe('unknown');
    });

    describe('whole device', () => {
        it('a single STRUBS partition condemns the device', async () => {
            const identityBuffer = Buffer.from('2fb05f231d5e4c00bb71f3109b42476c', 'hex');
            readFileMock
                .mockImplementationOnce(enoent)                       // sdb1: clean
                .mockResolvedValueOnce(buildVolumeIdentityBuffer({    // sdb2: ours
                    volumeId: 4, volumeUuid: '11111111-2222-3333-4444-555555555555', identityBuffer
                }));

            const result = await probeDeviceForStrubsIdentity([
                extPartition,
                { ...extPartition, name: 'sdb2', path: '/dev/sdb2' }
            ]);
            expect(result.status).toBe('strubs');
        });

        it('an UNKNOWN partition condemns the device too -- clean requires ALL partitions be clean', async () => {
            spawnHelperMock
                .mockResolvedValueOnce({ code: 0, stdout: '' })       // sdb1 mount ok
                .mockResolvedValueOnce({ code: 0, stdout: '' })       // sdb1 umount
                .mockResolvedValueOnce({ code: 32, stdout: 'busy' }); // sdb2 mount FAILS
            readFileMock.mockImplementationOnce(enoent);              // sdb1: clean

            const result = await probeDeviceForStrubsIdentity([
                extPartition,
                { ...extPartition, name: 'sdb2', path: '/dev/sdb2' }
            ]);
            expect(result.status).toBe('unknown');
        });

        it('reports clean for a device with no partitions at all', async () => {
            expect(await probeDeviceForStrubsIdentity(undefined)).toEqual({ status: 'clean' });
            expect(await probeDeviceForStrubsIdentity([])).toEqual({ status: 'clean' });
        });
    });
});
