import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted, so the mock object must be created in a hoisted block to be referenceable from it.
const { configMock } = vi.hoisted(() => ({
    configMock: { identity: 'a'.repeat(32), dataSliceCount: 4, paritySliceCount: 2 } as
        { identity: string | null; dataSliceCount: number; paritySliceCount: number }
}));
vi.mock('../lib/config', () => ({ config: configMock }));
vi.mock('../lib/database', () => ({ database: { getVolumes: vi.fn() } }));
vi.mock('../lib/io/manager', () => ({ ioManager: { getVolumeEntries: vi.fn(() => []) } }));

import {
    BootstrapManifestWriter,
    readManifest,
    writeManifestAtomically,
    newestManifest,
    MANIFEST_FILENAME,
    type BootstrapManifest
} from '../lib/io/bootstrap-manifest';

const volumeConfig = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    uuid: `uuid-${id}`,
    partition_uuid: `puuid-${id}`,
    partition_size: 3000591916544,
    data_size: 100,
    parity_size: 50,
    enabled: true,
    healthy: true,
    read_only: false,
    disk_serial: `SER-${id}`,
    label: `${id}.0`,
    ...over
} as any);

describe('bootstrap manifest', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-manifest-'));
        configMock.identity = 'a'.repeat(32);
    });

    afterEach(async () => {
        await fsp.rm(dir, { recursive: true, force: true });
    });

    describe('build', () => {
        it('carries the identity, geometry, and everything needed to re-MOUNT each volume', async () => {
            const writer = new BootstrapManifestWriter({
                getVolumeConfigs: async () => [volumeConfig(4), volumeConfig(2)],
                getWritableTargets: () => []
            });
            const manifest = await writer.build(new Date('2026-07-12T00:00:00Z'));

            expect(manifest).not.toBeNull();
            expect(manifest!.instanceIdentity).toBe('a'.repeat(32));
            expect(manifest!.geometry).toEqual({ dataSlices: 4, paritySlices: 2 });
            expect(manifest!.volumes.map(v => v.id)).toEqual([2, 4]);   // id-sorted
            const v4 = manifest!.volumes.find(v => v.id === 4)!;
            // partitionSize is MANDATORY: binding rejects a partition whose discovered size differs, so a
            // manifest without it yields a fleet that refuses to mount every volume.
            expect(v4.partitionSize).toBe(3000591916544);
            expect(v4.partitionUuid).toBe('puuid-4');
            expect(v4).toMatchObject({ uuid: 'uuid-4', enabled: true, healthy: true, readOnly: false, isDeleted: false });
            expect(manifest!.updatedAt).toBe('2026-07-12T00:00:00.000Z');
        });

        it('records a MISSING/deleted volume too, so recovery knows what it cannot see', async () => {
            const writer = new BootstrapManifestWriter({
                getVolumeConfigs: async () => [volumeConfig(7, { is_deleted: true, enabled: false })],
                getWritableTargets: () => []
            });
            const manifest = await writer.build();
            expect(manifest!.volumes[0]).toMatchObject({ id: 7, isDeleted: true, enabled: false });
        });

        it('refuses to build without an instance identity (it IS the critical field)', async () => {
            configMock.identity = null;
            const writer = new BootstrapManifestWriter({
                getVolumeConfigs: async () => [volumeConfig(1)],
                getWritableTargets: () => []
            });
            expect(await writer.build()).toBeNull();
        });
    });

    describe('atomic write + read', () => {
        it('round-trips, and leaves no .tmp behind', async () => {
            const body = Buffer.from(JSON.stringify({ instanceIdentity: 'abc', volumes: [], updatedAt: 'x' }));
            await writeManifestAtomically(dir, body);

            const read = await readManifest(dir);
            expect(read).toMatchObject({ instanceIdentity: 'abc' });
            const entries = await fsp.readdir(path.join(dir, 'strubs'));
            expect(entries).toEqual([MANIFEST_FILENAME]);      // the .tmp was renamed, not left
        });

        it('overwrites an existing manifest in place', async () => {
            await writeManifestAtomically(dir, Buffer.from(JSON.stringify({ instanceIdentity: 'old', volumes: [], updatedAt: '1' })));
            await writeManifestAtomically(dir, Buffer.from(JSON.stringify({ instanceIdentity: 'new', volumes: [], updatedAt: '2' })));
            expect((await readManifest(dir))!.instanceIdentity).toBe('new');
        });

        it('returns null for an absent or corrupt manifest rather than throwing', async () => {
            expect(await readManifest(dir)).toBeNull();          // absent

            await fsp.mkdir(path.join(dir, 'strubs'), { recursive: true });
            await fsp.writeFile(path.join(dir, 'strubs', MANIFEST_FILENAME), 'not json{{');
            expect(await readManifest(dir)).toBeNull();          // corrupt -- must not stop us reading another disk's copy

            await fsp.writeFile(path.join(dir, 'strubs', MANIFEST_FILENAME), '{"nope":true}');
            expect(await readManifest(dir)).toBeNull();          // structurally wrong
        });
    });

    describe('write()', () => {
        it('writes to every writable target and tolerates one failing disk', async () => {
            const good = path.join(dir, 'good');
            await fsp.mkdir(good, { recursive: true });
            // A "disk" that cannot be written: a plain FILE where the mount directory should be, so the
            // manifest's mkdir fails fast with ENOTDIR. Deterministic, and no reliance on system paths.
            const bad = path.join(dir, 'bad');
            await fsp.writeFile(bad, 'not a directory');

            const writer = new BootstrapManifestWriter({
                getVolumeConfigs: async () => [volumeConfig(1)],
                getWritableTargets: () => [{ id: 1, mountPoint: good }, { id: 2, mountPoint: bad }]
            });

            // One bad disk must not throw, and must not stop the good disk being written.
            await expect(writer.write()).resolves.toBeUndefined();
            expect((await readManifest(good))!.volumes[0].id).toBe(1);
        });

        it('writes nothing when there is no identity', async () => {
            configMock.identity = null;
            const target = path.join(dir, 'vol');
            await fsp.mkdir(target, { recursive: true });
            const writer = new BootstrapManifestWriter({
                getVolumeConfigs: async () => [volumeConfig(1)],
                getWritableTargets: () => [{ id: 1, mountPoint: target }]
            });
            await writer.write();
            expect(await readManifest(target)).toBeNull();
        });

        it('coalesces a burst of concurrent refreshes', async () => {
            const target = path.join(dir, 'vol');
            await fsp.mkdir(target, { recursive: true });
            const getVolumeConfigs = vi.fn(async () => [volumeConfig(1)]);
            const writer = new BootstrapManifestWriter({
                getVolumeConfigs,
                getWritableTargets: () => [{ id: 1, mountPoint: target }]
            });

            await Promise.all([writer.write(), writer.write(), writer.write(), writer.write()]);
            // Coalesced: far fewer passes than callers (one in flight + at most one queued follow-up).
            expect(getVolumeConfigs.mock.calls.length).toBeLessThanOrEqual(2);
            expect(await readManifest(target)).not.toBeNull();
        });
    });

    describe('newestManifest', () => {
        it('picks the newest updatedAt (copies across disks legitimately disagree)', () => {
            const m = (id: string, updatedAt: string) => ({ instanceIdentity: id, updatedAt, volumes: [] } as unknown as BootstrapManifest);
            const newest = newestManifest([
                m('old', '2026-07-01T00:00:00Z'),
                m('newest', '2026-07-12T00:00:00Z'),
                m('mid', '2026-07-05T00:00:00Z')
            ]);
            expect(newest!.instanceIdentity).toBe('newest');
            expect(newestManifest([])).toBeNull();
        });
    });
});
