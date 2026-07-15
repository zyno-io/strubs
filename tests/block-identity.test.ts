import { describe, expect, it } from 'vitest';

import {
    luksHeaderSpecifier,
    byPartUuidPath,
    assertExactlyOneLuksHeader,
    resolveUniquePartUuid,
    currentPathForUuid
} from '../lib/io/block-identity';
import type { RawBlockDevice } from '../lib/io/device-discovery';

// A rack: whole disks, each with one partition carrying a uuid and a partuuid.
const disk = (name: string, uuid: string, partuuid: string): RawBlockDevice => ({
    name, path: `/dev/${name}`, type: 'disk', size: 1,
    children: [{ type: 'part', name: `${name}1`, path: `/dev/${name}1`, size: 1, uuid, partuuid }]
} as RawBlockDevice);

const rack = (...disks: RawBlockDevice[]) => async () => disks;

describe('block-identity handles', () => {
    it('builds a cryptsetup UUID= specifier and a by-partuuid path', () => {
        expect(luksHeaderSpecifier('abc-123')).toBe('UUID=abc-123');
        expect(byPartUuidPath('def-456')).toBe('/dev/disk/by-partuuid/def-456');
    });

    describe('assertExactlyOneLuksHeader', () => {
        it('passes when exactly one attached partition carries the uuid', async () => {
            await expect(assertExactlyOneLuksHeader('U1', rack(disk('sde', 'U1', 'P1'))))
                .resolves.toBeUndefined();
        });

        // ⚠️ THE SWAP: the disk we scanned is gone, so its uuid resolves to nothing. Refuse loudly.
        it('REFUSES when no attached partition carries the uuid (unplugged/swapped)', async () => {
            await expect(assertExactlyOneLuksHeader('U1', rack(disk('sde', 'OTHER', 'P1'))))
                .rejects.toThrow(/no attached partition carries that uuid/);
        });

        // ⚠️ THE CLONE: two headers with the same uuid make UUID= ambiguous -- a keyslot write could land on
        // either. Refuse.
        it('REFUSES when two attached partitions carry the same uuid (a clone)', async () => {
            await expect(assertExactlyOneLuksHeader('U1', rack(disk('sde', 'U1', 'P1'), disk('sdf', 'U1', 'P2'))))
                .rejects.toThrow(/2 attached partitions carry that uuid.*clone/);
        });

        it('finds the header on a nested (mapper) child', async () => {
            const withMapper: RawBlockDevice = {
                name: 'sde', path: '/dev/sde', type: 'disk', size: 1,
                children: [{
                    type: 'part', name: 'sde1', path: '/dev/sde1', size: 1, uuid: 'LUKS-U', partuuid: 'P1',
                    children: [{ type: 'crypt', name: 'strubs-x', size: 1, uuid: 'FS-U' }]
                }]
            } as RawBlockDevice;
            await expect(assertExactlyOneLuksHeader('LUKS-U', rack(withMapper))).resolves.toBeUndefined();
        });
    });

    describe('resolveUniquePartUuid', () => {
        it('returns the by-partuuid path when exactly one partition carries the partuuid', async () => {
            await expect(resolveUniquePartUuid('P1', rack(disk('sde', 'U1', 'P1'))))
                .resolves.toBe('/dev/disk/by-partuuid/P1');
        });

        it('REFUSES a partuuid no attached partition carries', async () => {
            await expect(resolveUniquePartUuid('P1', rack(disk('sde', 'U1', 'OTHER'))))
                .rejects.toThrow(/no attached partition carries that partuuid/);
        });

        it('REFUSES a duplicated partuuid (a clone)', async () => {
            await expect(resolveUniquePartUuid('P1', rack(disk('sde', 'U1', 'P1'), disk('sdf', 'U2', 'P1'))))
                .rejects.toThrow(/clone is attached/);
        });
    });

    it('currentPathForUuid is diagnostics only and returns null when nothing resolves', async () => {
        expect(await currentPathForUuid('U1', rack(disk('sde', 'U1', 'P1')))).toBe('/dev/sde1');
        expect(await currentPathForUuid('GONE', rack(disk('sde', 'U1', 'P1')))).toBeNull();
    });
});
