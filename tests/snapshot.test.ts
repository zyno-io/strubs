import { promises as fsp, createWriteStream } from 'fs';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/config', () => ({ config: { snapshotPath: '/$snapshots', identity: 'this-array' } }));
vi.mock('../lib/notify/service', () => ({ notificationService: { notify: vi.fn(async () => undefined) } }));

import { SnapshotBuilder, orderParentsFirst, type SnapshotRecord } from '../lib/io/snapshot';
import { SnapshotJob } from '../lib/jobs/snapshot-job';

const readSnapshot = async (file: string): Promise<SnapshotRecord[]> => {
    const { gunzipSync } = await import('zlib');
    const raw = gunzipSync(await fsp.readFile(file)).toString('utf8');
    return raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
};

describe('namespace snapshot', () => {
    let dir: string;
    let file: string;

    beforeEach(async () => {
        dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-snapshot-'));
        file = path.join(dir, 'snap.ndjson.gz');
    });

    afterEach(async () => {
        await fsp.rm(dir, { recursive: true, force: true });
    });

    const builderFor = (containers: Array<{ id: string; cid: string | null; name: string; pr?: boolean; pw?: boolean }>, objects: any[]) =>
        new SnapshotBuilder({
            listContainers: async () => containers,
            streamObjects: () => (async function* () { for (const o of objects) yield o; })(),
            now: () => new Date('2026-07-13T00:00:00Z')
        });

    // A BUCKET'S ACCESS POLICY IS PART OF THE NAMESPACE.
    //
    // Drop publicRead/publicWrite from the snapshot and every restored bucket comes back PRIVATE. That is the
    // safe direction to fail in -- nothing leaks -- and it is still a namespace that does not match the one we
    // lost: every anonymous reader of a public bucket breaks, and the restore reports success while they do.
    it('carries a bucket\'s public-access policy into the snapshot', async () => {
        const b = builderFor(
            [
                { id: 'c1', cid: null, name: 'public-photos', pr: true, pw: false },
                { id: 'c2', cid: null, name: 'private-docs' },
                { id: 'c3', cid: 'c1', name: 'holidays' }        // a FOLDER is not a bucket and has no policy
            ],
            []
        );

        await b.writeTo(file);
        const lines = await readSnapshot(file);
        const byName = new Map(lines.map(l => [l.name, l]));

        expect(byName.get('public-photos')).toMatchObject({ pr: true, pw: false });

        // Absent, not `false`: the snapshot says nothing about a bucket nobody ever made public, and a folder
        // has no policy to say anything about. Writing `false` on all 55,000 folders would be 55,000 lines
        // asserting something that was never true.
        expect(byName.get('private-docs')).not.toHaveProperty('pr');
        expect(byName.get('holidays')).not.toHaveProperty('pr');
    });

    // The whole point: everything Mongo knows, written down where Mongo cannot take it with it.
    it('writes every container and object in the journal\'s own vocabulary', async () => {
        const b = builderFor(
            [{ id: 'c1', cid: null, name: 'photo' }],
            [{ id: 'o1', cid: 'c1', name: 'cat.jpg', mime: 'image/jpeg', md5: 'abc', size: 100, cs: 16384 }]
        );

        const stats = await b.writeTo(file);
        expect(stats).toMatchObject({ containers: 1, objects: 1 });

        const records = await readSnapshot(file);
        expect(records[0]).toEqual({ op: 'container', id: 'c1', cid: null, name: 'photo' });
        expect(records[1]).toMatchObject({ op: 'put', id: 'o1', cid: 'c1', name: 'cat.jpg', md5: 'abc' });
        expect(records[2]).toMatchObject({ op: 'end', containers: 1, objects: 1 });
    });

    // A restore reads this top to bottom in ONE forward pass. It must never meet an object whose container
    // it has not seen, or a container whose parent it has not seen -- otherwise a restore needs a fixup
    // phase, and a fixup phase is a second chance to get it wrong.
    describe('parent-first ordering', () => {
        it('emits a parent before its children whatever order Mongo hands them back in', () => {
            const shuffled = [
                { id: 'spain', cid: '2024', name: 'spain' },
                { id: 'photo', cid: null, name: 'photo' },
                { id: '2024', cid: 'photo', name: '2024' }
            ];
            expect(orderParentsFirst(shuffled).map(c => c.id)).toEqual(['photo', '2024', 'spain']);
        });

        it('still emits a container whose parent is MISSING, rather than dropping its name', () => {
            // A broken chain is exactly the kind of damage a snapshot is taken to survive. Losing the name
            // as well would be adding our own damage on top of it.
            const orphaned = [
                { id: 'lost', cid: 'a-parent-that-is-not-here', name: 'orphaned-folder' },
                { id: 'photo', cid: null, name: 'photo' }
            ];
            const out = orderParentsFirst(orphaned).map(c => c.id);
            expect(out).toContain('lost');
            expect(out).toContain('photo');
        });

        it('does not loop forever on a cycle', () => {
            const cyclic = [
                { id: 'a', cid: 'b', name: 'a' },
                { id: 'b', cid: 'a', name: 'b' }
            ];
            expect(orderParentsFirst(cyclic).map(c => c.id).sort()).toEqual(['a', 'b']);
        });
    });

    // ONE RECORD, ONE LINE. Lose the framing at object two million and every record after it is garbage,
    // whatever the checksum says -- and a snapshot with broken framing is worse than no snapshot, because
    // it looks like one.
    //
    // This is not a theoretical worry. md5 is stored as BINARY, and coercing those bytes to a string
    // decodes them as text: an object whose md5 began f3 c1 e9 e2 80 a8 split its own record in two on the
    // very first real snapshot, because e2 80 a8 is U+2028 -- which JSON leaves unescaped, and which plenty
    // of tools treat as a line terminator.
    it('REFUSES to write a record that would break the NDJSON framing', async () => {
        const b = builderFor([], [
            { id: 'o1', cid: null, name: 'fine.jpg', md5: 'aa', size: 1, cs: 16384 },
            // A name carrying a LINE SEPARATOR. Legal JSON, unescaped, and lethal to line framing.
            { id: 'o2', cid: null, name: 'nasty name.jpg', md5: 'bb', size: 1, cs: 16384 }
        ]);

        await expect(b.writeTo(file)).rejects.toThrow(/framing/);
    });

    it('carries md5 as hex, not as decoded bytes', async () => {
        const b = builderFor([], [
            { id: 'o1', cid: null, name: 'a.jpg', md5: 'f3c1e9e280a868892b3c83f682186ab7', size: 1, cs: 16384 }
        ]);
        await b.writeTo(file);

        const put = (await readSnapshot(file)).find(r => r.op === 'put') as { md5: string };
        expect(put.md5).toBe('f3c1e9e280a868892b3c83f682186ab7');   // the bytes that broke it, safely encoded
    });

    // A snapshot is only worth what it can be TRUSTED to contain.
    describe('verification', () => {
        it('accepts a snapshot it just wrote', async () => {
            const b = builderFor([{ id: 'c1', cid: null, name: 'photo' }], [
                { id: 'o1', cid: 'c1', name: 'a', size: 1, cs: 16384 },
                { id: 'o2', cid: 'c1', name: 'b', size: 2, cs: 16384 }
            ]);
            const stats = await b.writeTo(file);
            await expect(b.verify(file, stats)).resolves.toBeUndefined();
        });

        // THE reason the trailer exists. A gzip stream cut off part-way decompresses cleanly to whole,
        // valid, parseable records -- it just stops. Without something at the end saying "that was all of
        // it", a snapshot missing two million objects is indistinguishable from one that never had them.
        it('REFUSES a truncated snapshot, which parses perfectly right up until it stops', async () => {
            const b = builderFor([{ id: 'c1', cid: null, name: 'photo' }], [
                { id: 'o1', cid: 'c1', name: 'a', size: 1, cs: 16384 }
            ]);
            const stats = await b.writeTo(file);

            // Rewrite it WITHOUT the end trailer. Every line in it is still valid.
            const records = (await readSnapshot(file)).filter(r => r.op !== 'end');
            const truncated = path.join(dir, 'truncated.gz');
            await pipeline(
                Readable.from(records.map(r => JSON.stringify(r) + '\n')),
                createGzip(),
                createWriteStream(truncated)
            );

            await expect(b.verify(truncated, stats)).rejects.toThrow(/TRUNCATED/);
        });

        it('REFUSES a snapshot whose contents do not match its own trailer', async () => {
            const b = builderFor([{ id: 'c1', cid: null, name: 'photo' }], [
                { id: 'o1', cid: 'c1', name: 'a', size: 1, cs: 16384 }
            ]);
            const stats = await b.writeTo(file);

            // Tamper with a name. The counts still agree; only the checksum notices.
            const records = await readSnapshot(file);
            const put = records.find(r => r.op === 'put') as { name: string };
            put.name = 'not-what-was-written';
            const tampered = path.join(dir, 'tampered.gz');
            await pipeline(
                Readable.from(records.map(r => JSON.stringify(r) + '\n')),
                createGzip(),
                createWriteStream(tampered)
            );

            await expect(b.verify(tampered, stats)).rejects.toThrow(/corrupt|does not match/i);
        });
    });

    // The ORDER of the job is the job.
    describe('the job', () => {
        // The staging path is deliberately unpredictable (a mkdtemp per run), so the mocks learn it the
        // same way the real array does: from the file the job hands them.
        let staged: string | null = null;

        const makeJob = (overrides: any = {}) => {
            const published: any[] = [];
            const job = new SnapshotJob({
                builder: builderFor([{ id: 'c1', cid: null, name: 'photo' }], [
                    { id: 'o1', cid: 'c1', name: 'a', size: 1, cs: 16384 }
                ]),
                storeObject: vi.fn(async (from: string) => { staged = from; return { id: 'snap-object-id', md5: 'deadbeef' }; }),
                // The default fetch reads it back OUT of the array. Here: copy the file that was stored,
                // which is what a healthy array would give us back.
                fetchObject: vi.fn(async (_id: string, to: string) => { await fsp.copyFile(staged!, to); }),
                publish: vi.fn(async (s: any, p: any) => { published.push({ snapshot: s, previous: p }); }),
                currentSnapshot: () => null,
                stagingDir: () => dir,
                now: () => new Date('2026-07-13T00:00:00Z'),
                ...overrides
            });
            return { job, published };
        };

        it('publishes the pointer ONLY after reading the snapshot back out of the array', async () => {
            const order: string[] = [];
            const { job } = makeJob({
                storeObject: vi.fn(async (from: string) => { order.push('store'); staged = from; return { id: 'snap-object-id', md5: 'deadbeef' }; }),
                fetchObject: vi.fn(async (_id: string, to: string) => { order.push('read-back'); await fsp.copyFile(staged!, to); }),
                publish: vi.fn(async () => { order.push('publish'); })
            });

            await job.run();

            // Publishing before verifying would mean the manifest points at a snapshot nobody has ever
            // successfully read -- which is exactly the thing you find out about on the worst possible day.
            expect(order).toEqual(['store', 'read-back', 'publish']);
        });

        it('does NOT publish a snapshot that cannot be read back', async () => {
            const publish = vi.fn();
            const { job } = makeJob({
                fetchObject: vi.fn(async () => { throw new Error('slices are unreadable'); }),
                publish
            });

            await expect(job.run()).rejects.toThrow(/unreadable/);
            expect(publish).not.toHaveBeenCalled();     // the old pointer stands; it is still good
        });

        it('does NOT publish a snapshot that reads back TRUNCATED', async () => {
            const publish = vi.fn();
            const { job } = makeJob({
                fetchObject: vi.fn(async (_id: string, to: string) => {
                    // Something came back -- it just is not all of it.
                    await pipeline(
                        Readable.from([JSON.stringify({ op: 'container', id: 'c1', cid: null, name: 'photo' }) + '\n']),
                        createGzip(),
                        createWriteStream(to)
                    );
                }),
                publish
            });

            await expect(job.run()).rejects.toThrow(/TRUNCATED/);
            expect(publish).not.toHaveBeenCalled();
        });

        it('keeps the PREVIOUS snapshot beside the new one, so there is never zero', async () => {
            const previous = { objectId: 'older', md5: 'aa', startedAt: 'T', completedAt: 'T', objects: 5 };
            const { job, published } = makeJob({ currentSnapshot: () => previous });

            await job.run();

            expect(published[0].snapshot.objectId).toBe('snap-object-id');
            expect(published[0].previous).toBe(previous);
        });

        it('refuses to publish an EMPTY snapshot over a real one', async () => {
            const publish = vi.fn();
            const { job } = makeJob({ builder: builderFor([], []), publish });

            await expect(job.run()).rejects.toThrow(/EMPTY/);
            expect(publish).not.toHaveBeenCalled();
        });

        // write() on the manifest is fire-and-forget by design: it swallows every per-volume failure so a
        // manifest refresh can never take down a volume start. Which means it reports a clean success having
        // written the pointer to precisely nowhere -- and a snapshot whose pointer is on no disk is 127MB of
        // erasure-coded namespace that nothing on the platters knows the name of.
        it('fails loudly if the pointer reached no disk at all', async () => {
            const { job } = makeJob({
                publish: vi.fn(async () => {
                    throw new Error('its pointer reached NO bootstrap manifest');
                })
            });
            await expect(job.run()).rejects.toThrow(/NO bootstrap manifest/);
        });

        it('cleans up its staging files, win or lose', async () => {
            const { job } = makeJob({ fetchObject: vi.fn(async () => { throw new Error('nope'); }) });
            await expect(job.run()).rejects.toThrow();

            const left = (await fsp.readdir(dir)).filter(f => f.startsWith('strubs-snapshot-'));
            expect(left).toEqual([]);        // the whole staging DIRECTORY goes, not just the files in it
        });
    });
});

// The projection is part of the snapshot, and it is the part with no safety net. Getting a field NAME
// wrong here does not fail, does not warn, and does not change a single count or checksum -- it just
// silently writes null for every object in the array. My first real snapshot lost all 3.5 million mime
// types this way, and every check it had still passed. So the mapping gets a test of its own, against
// documents shaped the way Mongo actually shapes them.
describe('the Mongo projection (where a typo costs you a field and nothing complains)', () => {
    it('maps every field a restore needs off a real document shape', async () => {
        const { ContentRepository } = await import('../lib/database/content-repository');

        const doc = {
            _id: { toString: () => '5cfde3d63b1e7a451b00bfd2' },
            containerId: { toString: () => '5cfc92799763ca451b2f9bd5' },
            name: 'cat.jpg',
            mime: 'image/jpeg',                                   // `mime`. NOT `mimeType`.
            md5: { buffer: Buffer.from('f3c1e9e280a868892b3c83f682186ab7', 'hex') },  // BINARY, not a string
            size: 124000,
            chunkSize: 16384
        };

        const collection = {
            find: () => ({ sort: () => ({ [Symbol.asyncIterator]: async function* () { yield doc; } }) })
        };
        const repo = new ContentRepository(collection as never, {} as never, (x: never) => x, () => null as never);

        const [out] = await (async () => {
            const acc: any[] = [];
            for await (const o of repo.streamAllObjects()) acc.push(o);
            return acc;
        })();

        expect(out).toEqual({
            id: '5cfde3d63b1e7a451b00bfd2',
            cid: '5cfc92799763ca451b2f9bd5',
            name: 'cat.jpg',
            mime: 'image/jpeg',                                   // would be null if the field name were wrong
            md5: 'f3c1e9e280a868892b3c83f682186ab7',              // hex, not decoded bytes
            size: 124000,
            cs: 16384
        });
    });
});

// A RESTART MUST NOT ERASE THE SNAPSHOT.
//
// The pointer lives in memory in the manifest writer, and the periodic refresh writes memory out to every
// volume in the array. So a process that comes up not knowing about the snapshot does not merely forget it
// -- within a minute it overwrites all 29 manifests with `snapshot: null`, and the 127MB of erasure-coded
// namespace sitting on the platters becomes something nothing on any disk knows the name of. A recovery
// would find nothing, and never suspect there was anything to find.
describe('the snapshot pointer survives a restart', () => {
    it('is read back off the platters before anything writes a manifest', async () => {
        const { BootstrapManifestWriter } = await import('../lib/io/bootstrap-manifest');
        const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-manifest-'));
        const mount = path.join(root, 'vol0');
        await fsp.mkdir(path.join(mount, 'strubs'), { recursive: true });

        const ref = { objectId: '6a5460883b1e7a00ae000001', md5: 'aa', startedAt: '2026-07-13T00:00:00Z', completedAt: '2026-07-13T00:01:00Z', objects: 3545822 };
        await fsp.writeFile(path.join(mount, 'strubs', '.bootstrap.json'), JSON.stringify({
            version: 1, instanceIdentity: 'this-array', geometry: { dataSlices: 4, paritySlices: 2 },
            volumes: [], journalVolumeIds: [4, 10, 13],
            snapshot: ref, previousSnapshot: null, updatedAt: '2026-07-13T00:00:00Z'
        }));

        const writer = new BootstrapManifestWriter({
            // READABLE, not writable: a read-only or draining disk may be the only one still carrying the
            // pointer, and reading from the write set only would let a restart come up believing there is
            // no snapshot -- and then write that belief to every disk in the array.
            getReadableTargets: () => [{ id: 0, mountPoint: mount }],
            getWritableTargets: () => []
        } as never);

        expect(writer.getSnapshot()).toBeNull();       // a fresh process knows nothing
        await writer.hydrateFromDisk();
        expect(writer.getSnapshot()).toEqual(ref);     // ...and now it does, from the platter

        await fsp.rm(root, { recursive: true, force: true });
    });
});

describe('the pointer cannot be lost, faked, or walked backwards', () => {
    const writerOn = async (manifests: Array<{ mount: string; body: any }>) => {
        const { BootstrapManifestWriter } = await import('../lib/io/bootstrap-manifest');
        for (const m of manifests) {
            await fsp.mkdir(path.join(m.mount, 'strubs'), { recursive: true });
            await fsp.writeFile(path.join(m.mount, 'strubs', '.bootstrap.json'), JSON.stringify(m.body));
        }
        return new BootstrapManifestWriter({
            getReadableTargets: () => manifests.map((m, i) => ({ id: i, mountPoint: m.mount })),
            getWritableTargets: () => []
        } as never);
    };
    const manifest = (o: any) => ({
        version: 1, instanceIdentity: 'this-array', geometry: { dataSlices: 4, paritySlices: 2 },
        volumes: [], journalVolumeIds: [], previousSnapshot: null, ...o
    });
    const ref = (id: string) => ({ objectId: id, md5: 'aa', startedAt: '2026-07-13T00:00:00Z', completedAt: '2026-07-13T00:00:00Z', objects: 1 });

    let root: string;
    beforeEach(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-mf-')); });
    afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });
    const vol = (n: number) => path.join(root, 'vol' + n);

    // A read-only or DRAINING disk is a perfectly good place to read the truth from, and may be the only
    // one still carrying it. Reading from the WRITE set only would let a restart come up believing there is
    // no snapshot -- and then write that belief to every disk in the array.
    it('reads the pointer from a disk it would never WRITE to', async () => {
        const w = await writerOn([{ mount: vol(0), body: manifest({ snapshot: ref('6a5460883b1e7a00ae000002'), updatedAt: '2026-07-13T00:00:00Z' }) }]);
        await w.hydrateFromDisk();
        expect(w.getSnapshot()?.objectId).toBe('6a5460883b1e7a00ae000002');
    });

    it('ignores a manifest belonging to a DIFFERENT array, however new it looks', async () => {
        const w = await writerOn([
            { mount: vol(0), body: manifest({ snapshot: ref('6a5460883b1e7a00ae000003'), updatedAt: '2026-07-13T00:00:00Z' }) },
            { mount: vol(1), body: { ...manifest({ snapshot: ref('6a5460883b1e7a00ae000004'), updatedAt: '2099-01-01T00:00:00Z' }), instanceIdentity: 'a-different-array' } }
        ]);
        await w.hydrateFromDisk();
        // Adopting it would hand a recovery an object id that does not exist on these disks.
        expect(w.getSnapshot()?.objectId).toBe('6a5460883b1e7a00ae000003');
    });

    it('ignores a manifest whose timestamp is garbage, rather than letting it win', async () => {
        const w = await writerOn([
            { mount: vol(0), body: manifest({ snapshot: ref('6a5460883b1e7a00ae000005'), updatedAt: '2026-07-13T00:00:00Z' }) },
            // A plain string comparison would rank "zzz" above every real ISO date in existence.
            { mount: vol(1), body: manifest({ snapshot: ref('6a5460883b1e7a00ae000006'), updatedAt: 'zzz-not-a-date' }) }
        ]);
        await w.hydrateFromDisk();
        expect(w.getSnapshot()?.objectId).toBe('6a5460883b1e7a00ae000005');
    });

    // A manifest with `snapshot: null` is NOT evidence that there is no snapshot. It is evidence that
    // whatever wrote it did not know about one -- a volume back from a spell offline, a disk that missed the
    // publish. Letting one win because it is newest would hydrate nothing, and the next refresh would write
    // that nothing to all 29 disks and orphan a perfectly good snapshot.
    it('is not fooled by a NEWER manifest that simply knows nothing about the snapshot', async () => {
        const w = await writerOn([
            { mount: vol(0), body: manifest({ snapshot: ref('6a5460883b1e7a00ae000009'), updatedAt: '2026-07-01T00:00:00Z' }) },
            { mount: vol(1), body: manifest({ snapshot: null, updatedAt: '2026-07-13T00:00:00Z' }) }   // newer, but blank
        ]);
        await w.hydrateFromDisk();
        expect(w.getSnapshot()?.objectId).toBe('6a5460883b1e7a00ae000009');
    });

    // Whatever wins the "newest manifest" contest is loaded into memory and then BROADCAST to all 29 disks.
    // So a manifest carrying a snapshot-shaped object with no real object id in it must not win on timestamp
    // alone -- it would replace a real pointer with a shape. A pointer you cannot use is worse than none,
    // because it looks like one.
    it('ignores a manifest whose snapshot ref is not actually usable', async () => {
        const w = await writerOn([
            { mount: vol(0), body: manifest({ snapshot: ref('6a5460883b1e7a00ae000005'), updatedAt: '2026-07-01T00:00:00Z' }) },
            { mount: vol(1), body: manifest({ snapshot: { objectId: 'not-an-object-id', md5: 'x' }, updatedAt: '2099-01-01T00:00:00Z' }) }
        ]);
        await w.hydrateFromDisk();
        expect(w.getSnapshot()?.objectId).toBe('6a5460883b1e7a00ae000005');
    });

    // Ranked by the SNAPSHOT's completedAt, not the manifest's updatedAt -- and this is the difference that
    // matters. Every routine manifest refresh bumps updatedAt, so a manifest carrying an OLD pointer but
    // rewritten five minutes ago would outrank one carrying the NEW pointer that has not been touched since.
    // A volume rejoining the fleet drops exactly that into the mix: the older pointer wins on freshness,
    // gets broadcast everywhere, is given a fresher updatedAt by that very broadcast, and goes on winning
    // forever while the newer snapshot sits orphaned on the platters.
    it('ranks by which SNAPSHOT is newer, not by which manifest was touched most recently', async () => {
        const older = { ...ref('6a5460883b1e7a00ae000007'), completedAt: '2026-01-01T00:00:00Z' };
        const newer = { ...ref('6a5460883b1e7a00ae000008'), completedAt: '2026-07-13T00:00:00Z' };

        const w = await writerOn([
            // The OLDER snapshot, in a manifest that was rewritten just now.
            { mount: vol(0), body: manifest({ snapshot: older, updatedAt: '2026-07-13T12:00:00Z' }) },
            // The NEWER snapshot, in a manifest nobody has touched since it was published.
            { mount: vol(1), body: manifest({ snapshot: newer, updatedAt: '2026-07-13T00:00:00Z' }) }
        ]);
        await w.hydrateFromDisk();

        expect(w.getSnapshot()?.objectId).toBe('6a5460883b1e7a00ae000008');
    });
});

// The dump takes MINUTES and the array is live throughout. Reading the containers first and the objects
// afterwards means an object created during the dump can name a folder that was also created during the
// dump -- one that is nowhere in the snapshot. The restore then meets a `put` whose container it has never
// seen, which is exactly what the parent-first ordering exists to make impossible.
describe('a live array does not break the snapshot underneath it', () => {
    it('captures a container created DURING the object stream', async () => {
        const containers = [{ id: 'photo', cid: null, name: 'photo' }];

        const b = new SnapshotBuilder({
            // The objects stream first. A new folder (and an object in it) appears while they do.
            streamObjects: () => (async function* () {
                yield { id: 'o1', cid: 'photo', name: 'old.jpg', size: 1, cs: 16384 };
                containers.push({ id: 'brand-new', cid: 'photo', name: 'holiday' });   // created mid-dump
                yield { id: 'o2', cid: 'brand-new', name: 'new.jpg', size: 1, cs: 16384 };
            })(),
            // ...and the containers are listed AFTERWARDS, so the list is a superset.
            listContainers: async () => [...containers],
            now: () => new Date('2026-07-13T00:00:00Z')
        });

        const dir2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-live-'));
        const f = path.join(dir2, 'snap.gz');
        const stats = await b.writeTo(f);

        const records = await readSnapshot(f);
        const ids = records.filter(r => r.op === 'container').map((r: any) => r.id);
        expect(ids).toContain('brand-new');                    // the folder made mid-dump IS in the snapshot

        // ...and it is emitted BEFORE the object that names it, so a restore is still one forward pass.
        const containerAt = records.findIndex((r: any) => r.id === 'brand-new');
        const objectAt = records.findIndex((r: any) => r.id === 'o2');
        expect(containerAt).toBeLessThan(objectAt);
        expect(stats.containers).toBe(2);

        await fsp.rm(dir2, { recursive: true, force: true });
    });

    it('REFUSES a snapshot in which an object names a container that is not in it', async () => {
        const b = new SnapshotBuilder({
            streamObjects: () => (async function* () {
                yield { id: 'o1', cid: 'a-folder-that-was-deleted', name: 'orphan.jpg', size: 1, cs: 16384 };
            })(),
            listContainers: async () => [],
            now: () => new Date('2026-07-13T00:00:00Z')
        });

        const dir2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-live-'));
        await expect(b.writeTo(path.join(dir2, 'snap.gz'))).rejects.toThrow(/nowhere to put them/);
        await fsp.rm(dir2, { recursive: true, force: true });
    });
});

// md5 comes out of Mongo as BINARY, and the encoding of it is the one place a typo silently corrupts every
// record in the file. A Node Buffer HAS a `.buffer` property -- the ArrayBuffer underneath it -- so code
// that reaches for `.buffer` before asking "is this a Buffer?" gets an ArrayBuffer, fails the check on that,
// and falls through to String(). Which decodes the bytes as text. Which is how an md5 beginning
// f3 c1 e9 e2 80 a8 split its own NDJSON record in two.
describe('md5 encoding (the one place a typo silently corrupts every record)', () => {
    const bytes = Buffer.from('f3c1e9e280a868892b3c83f682186ab7', 'hex');   // the md5 that actually broke it

    const streamOne = async (md5: unknown) => {
        const { ContentRepository } = await import('../lib/database/content-repository');
        const doc = { _id: { toString: () => 'a'.repeat(24) }, containerId: null, name: 'x', mime: null, md5, size: 1, chunkSize: 16384 };
        const collection = { find: () => ({ sort: () => ({ [Symbol.asyncIterator]: async function* () { yield doc; } }) }) };
        const repo = new ContentRepository(collection as never, {} as never, (x: never) => x, () => null as never);
        for await (const o of repo.streamAllObjects()) return o;
        throw new Error('nothing streamed');
    };

    it('hex-encodes a raw Node Buffer', async () => {
        expect((await streamOne(bytes)).md5).toBe('f3c1e9e280a868892b3c83f682186ab7');
    });

    it('hex-encodes a Mongo Binary', async () => {
        expect((await streamOne({ buffer: bytes })).md5).toBe('f3c1e9e280a868892b3c83f682186ab7');
    });

    it('passes a string through untouched', async () => {
        expect((await streamOne('f3c1e9e280a868892b3c83f682186ab7')).md5).toBe('f3c1e9e280a868892b3c83f682186ab7');
    });

    it('REFUSES to guess at anything else, rather than coercing bytes into text', async () => {
        await expect(streamOne({ some: 'unexpected shape' })).rejects.toThrow(/refusing to guess/);
    });
});
