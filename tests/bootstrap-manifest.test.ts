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

    // THE ONE WRITE IN THIS SYSTEM THAT CAN DESTROY THE ARRAY'S ABILITY TO RECOVER ITSELF.
    //
    // Startup hydrates the snapshot pointer by READING the manifests, then publishes its in-memory state back
    // to every writable volume. If hydration could not read the disks -- a USB drive off its bus, an EIO --
    // this process believes there is no snapshot. Publishing that belief overwrites the pointer on every
    // HEALTHY disk. The snapshot object stays on the platters, 127MB of erasure-coded namespace, and nothing
    // left alive knows its name.
    describe('never erasing a snapshot pointer it does not know about', () => {
        const writerFor = (mounts: Array<{ id: number; mountPoint: string }>) =>
            new BootstrapManifestWriter({
                getVolumeConfigs: async () => [volumeConfig(1)],
                getWritableTargets: () => mounts,
                getReadableTargets: () => mounts
            } as never);

        it('KEEPS a snapshot pointer already on the disk when it does not know about one itself', async () => {
            const mount = path.join(dir, 'vol1');
            await fsp.mkdir(path.join(mount, 'strubs'), { recursive: true });

            // The disk knows about a snapshot. This process does not (hydration could not read it).
            const existing = {
                version: 1,
                instanceIdentity: 'a'.repeat(32),
                geometry: { dataSlices: 4, paritySlices: 2 },
                volumes: [],
                journalVolumeIds: [],
                snapshot: {
                    objectId: '5f5f5f5f5f5f5f5f5f5f5f5f', md5: 'm',
                    startedAt: 'T', completedAt: '2026-07-01T00:00:00Z', objects: 3545825
                },
                previousSnapshot: null,
                updatedAt: '2026-07-01T00:00:00Z'
            };
            await fsp.writeFile(path.join(mount, 'strubs', MANIFEST_FILENAME), JSON.stringify(existing));

            await writerFor([{ id: 1, mountPoint: mount }]).write();

            const after = await readManifest(mount);
            expect(after?.snapshot?.objectId).toBe('5f5f5f5f5f5f5f5f5f5f5f5f');
        });

        it('KEEPS a NEWER snapshot pointer even when this process knows about an older one', async () => {
            // The first version of this rule only fired when we knew of NO snapshot. But a process holding an
            // OLDER one is just as dangerous: a disk that has been out of the rack comes back carrying the
            // NEWEST pointer, the periodic refresh rolls over it with our stale one, and the newest snapshot --
            // 127MB of erasure-coded namespace, sitting right there -- is orphaned.
            const mount = path.join(dir, 'vol3');
            await fsp.mkdir(path.join(mount, 'strubs'), { recursive: true });

            const newer = {
                version: 1,
                instanceIdentity: 'a'.repeat(32),
                geometry: { dataSlices: 4, paritySlices: 2 },
                volumes: [],
                journalVolumeIds: [],
                snapshot: { objectId: '5f5f5f5f5f5f5f5f5f5f5f5f', md5: 'm', startedAt: 'T',
                    completedAt: '2026-07-12T00:00:00Z', objects: 3545825 },
                previousSnapshot: null,
                updatedAt: '2026-07-12T00:00:00Z'
            };
            await fsp.writeFile(path.join(mount, 'strubs', MANIFEST_FILENAME), JSON.stringify(newer));

            // This process knows only about an OLDER snapshot.
            const writer = writerFor([{ id: 3, mountPoint: mount }]);
            writer.setSnapshots({ objectId: '4e4e4e4e4e4e4e4e4e4e4e4e', md5: 'm', startedAt: 'T',
                completedAt: '2026-07-01T00:00:00Z', objects: 3000000 } as never, null);

            await writer.write();

            const after = await readManifest(mount);
            expect(after?.snapshot?.objectId).toBe('5f5f5f5f5f5f5f5f5f5f5f5f');   // theirs, because it is newer
        });

        // WHERE THE JOURNAL IS, AND WHEN THE SNAPSHOT WAS, ARE DIFFERENT QUESTIONS.
        it('takes the JOURNAL LIST from the most recently WRITTEN manifest, not the one with the newest snapshot', async () => {
            // Every disk names the same snapshot, so snapshot.completedAt cannot break the tie -- and the disk
            // that happens to win it is carrying a journal list from before the journal MOVED. A recovery would
            // then read the journal from the volumes it moved off. Old journal dirs are never deleted, so that
            // stale replica looks like a perfectly valid, contiguous, gap-free history: the gap check passes,
            // and every name written since the move is silently dropped by a restore that reports success.
            const snap = { objectId: '5f5f5f5f5f5f5f5f5f5f5f5f', md5: 'm', startedAt: 'T',
                completedAt: '2026-07-01T00:00:00Z', objects: 10 };
            const base = {
                version: 1, instanceIdentity: 'a'.repeat(32),
                geometry: { dataSlices: 4, paritySlices: 2 }, volumes: [], previousSnapshot: null, snapshot: snap
            };

            const stale = path.join(dir, 'volS');
            const fresh = path.join(dir, 'volF');
            await fsp.mkdir(path.join(stale, 'strubs'), { recursive: true });
            await fsp.mkdir(path.join(fresh, 'strubs'), { recursive: true });

            // Same snapshot on both. The JOURNAL moved from [1,2,3] to [7,8,9], and only the freshly-written
            // manifest knows it.
            await fsp.writeFile(path.join(stale, 'strubs', MANIFEST_FILENAME),
                JSON.stringify({ ...base, journalVolumeIds: [1, 2, 3], updatedAt: '2026-07-01T00:00:00Z' }));
            await fsp.writeFile(path.join(fresh, 'strubs', MANIFEST_FILENAME),
                JSON.stringify({ ...base, journalVolumeIds: [7, 8, 9], updatedAt: '2026-07-13T00:00:00Z' }));

            const writer = writerFor([{ id: 1, mountPoint: stale }, { id: 2, mountPoint: fresh }]);
            await writer.hydrateFromDisk();

            expect(writer.getJournalVolumeIds()).toEqual([7, 8, 9]);   // where the journal IS, not where it was
            expect(writer.getSnapshot()?.objectId).toBe('5f5f5f5f5f5f5f5f5f5f5f5f');
        });

        it('writes normally to a disk that has no manifest at all', async () => {
            // ENOENT is an EMPTY SLOT, not a hazard: a fresh disk, a new array. There is nothing to destroy,
            // and refusing here would mean a brand-new array never publishes a manifest -- silently disabling
            // the entire recovery path in the name of protecting it.
            const mount = path.join(dir, 'vol2');
            await fsp.mkdir(path.join(mount, 'strubs'), { recursive: true });

            await writerFor([{ id: 2, mountPoint: mount }]).write();

            const after = await readManifest(mount);
            expect(after?.instanceIdentity).toBe('a'.repeat(32));
            expect(after?.snapshot ?? null).toBeNull();
        });
    });
});
