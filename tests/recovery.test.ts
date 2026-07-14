import { promises as fsp, createWriteStream } from 'fs';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/log', () => ({
    createLogger: () => Object.assign(() => {}, { error: () => {} })
}));

import { readSliceHeader, buildSliceIndex, synthesiseRecordFromIndex, locateSlices, plattersOrRefuse }
    from '../lib/recovery/recovery';

import { NamespaceRestore, orderParentsFirst, assertNoJournalGaps, isCoherent } from '../lib/recovery/restore';
import { volumeConfigsFromManifest, assertSafeToRestoreFleet } from '../lib/recovery/fleet-restore';
import { reconcileManifests, recoverFleetFromDisks } from '../lib/recovery/bootstrap';

// A slice, written exactly the way slice.ts writes one -- including the magic bytes as they ACTUALLY land on
// disk. See the comment on MAGIC in recovery.ts: `Buffer.write('\x01\xfb\x02\xfb')` is UTF-8, so \xfb becomes
// c3 bb, and what every slice of all 3.5 million objects on the live array actually begins with is
// 01 c3 bb 02. The reader matches the disk, not the source.
const writeSlice = async (
    file: string,
    o: { id: string; size: number; data: number; parity: number; index: number; chunkSize: number }
): Promise<void> => {
    const buf = Buffer.alloc(48);
    Buffer.from([0x01, 0xc3, 0xbb, 0x02]).copy(buf, 0);
    buf.writeUInt8(1, 4);
    buf.writeUInt16LE(48, 5);
    Buffer.from(o.id, 'hex').copy(buf, 23, 0, 12);
    buf.writeIntLE(o.size, 35, 5);
    buf.writeUInt8(o.data, 40);
    buf.writeUInt8(o.parity, 41);
    buf.writeUInt8(o.index, 42);
    buf.writeIntLE(o.chunkSize, 43, 3);
    // The header CHECKSUM as the CURRENT slice.ts writes it: md5 of bytes 23..47, into bytes 7..22. Note that
    // the reader does not GATE on this -- the scheme changed mid-2015 and pre-2015 slices fail it while being
    // perfectly healthy -- so we write it correctly here and test the mismatch case explicitly below.
    createHash('md5').update(buf.subarray(23, 48)).digest().copy(buf, 7);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, buf);
};

describe('recovery: reading the truth off the platters', () => {
    let root: string;
    beforeEach(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-recovery-')); });
    afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

    const platter = (n: number) => ({ volumeId: n, mountPoint: path.join(root, 'vol' + n) });
    const slicePath = (n: number, id: string, idx: number) =>
        path.join(root, 'vol' + n, 'strubs', id.slice(0, 2), id.slice(2, 4), id.slice(4, 6), `${id}.${idx}`);

    const ID = '6a546c8d3b1e7a005a000001';

    // The whole design rests on this: the geometry is on the platter, next to the data. An object does not
    // need to be looked up to be read -- it explains itself.
    it('reads an object\'s id, size and erasure geometry out of a slice header, with no database', async () => {
        await writeSlice(slicePath(0, ID, 3), { id: ID, size: 126814311, data: 4, parity: 2, index: 3, chunkSize: 16384 });

        expect(await readSliceHeader(slicePath(0, ID, 3))).toEqual({
            id: ID,
            size: 126814311,
            dataSliceCount: 4,
            paritySliceCount: 2,
            sliceIndex: 3,
            chunkSize: 16384
        });
    });

    it('rejects a file that is not a slice, rather than inventing geometry from its bytes', async () => {
        const f = path.join(root, 'not-a-slice');
        await fsp.writeFile(f, Buffer.alloc(48, 0xaa));
        expect(await readSliceHeader(f)).toBeNull();
    });

    describe('finding everything, by walking the disks once', () => {
        it('indexes every slice by object id and slice index', async () => {
            for (let i = 0; i < 6; i++)
                await writeSlice(slicePath(i, ID, i), { id: ID, size: 100, data: 4, parity: 2, index: i, chunkSize: 16384 });

            const index = await buildSliceIndex([0, 1, 2, 3, 4, 5].map(platter));
            const slots = index.get(ID)!;
            expect([...slots].filter(v => v !== 0)).toHaveLength(6);
            expect(slots[3] - 1).toBe(3);              // slice 3 is on volume 3 (stored +1 so 0 can mean absent)
        });

        it('ignores the recovery artifacts living beside the slices', async () => {
            // .journal/, .tmp/, .bootstrap.json and lost+found all sit in the same tree. A scanner that
            // swept them up would, at best, invent objects -- and at worst treat the journal as a stray
            // slice.
            await writeSlice(slicePath(0, ID, 0), { id: ID, size: 100, data: 4, parity: 2, index: 0, chunkSize: 16384 });
            const strubs = path.join(root, 'vol0', 'strubs');
            await fsp.mkdir(path.join(strubs, '.journal'), { recursive: true });
            await fsp.writeFile(path.join(strubs, '.journal', '000000.jsonl'), '{"op":"put"}\n');
            await fsp.mkdir(path.join(strubs, 'lost+found'), { recursive: true });
            await fsp.writeFile(path.join(strubs, '.bootstrap.json'), '{}');

            const index = await buildSliceIndex([platter(0)]);
            expect([...index.keys()]).toEqual([ID]);
        });

        it('rebuilds the record Mongo would have held -- placement and all', async () => {
            for (const [vol, idx] of [[19, 0], [33, 1], [10, 2], [8, 3], [30, 4], [14, 5]])
                await writeSlice(slicePath(vol, ID, idx), { id: ID, size: 126814311, data: 4, parity: 2, index: idx, chunkSize: 16384 });

            const index = await buildSliceIndex([19, 33, 10, 8, 30, 14].map(platter));
            const rebuilt = await synthesiseRecordFromIndex(ID, index.get(ID), v => platter(v).mountPoint, 19);

            expect(rebuilt).toMatchObject({
                recoverable: true,
                found: 6,
                needed: 4,
                record: {
                    id: ID,
                    size: 126814311,
                    chunkSize: 16384,
                    dataVolumes: [19, 33, 10, 8],
                    parityVolumes: [30, 14]
                }
            });
        });

        // 4+2 exists precisely so that this is survivable. A recovery gets the same degraded read path as an
        // ordinary Tuesday -- it does not get a special one.
        it('still rebuilds an object with two slices missing, marking the gaps', async () => {
            for (const [vol, idx] of [[19, 0], [33, 1], [30, 4], [14, 5]])
                await writeSlice(slicePath(vol, ID, idx), { id: ID, size: 100, data: 4, parity: 2, index: idx, chunkSize: 16384 });

            const index = await buildSliceIndex([19, 33, 30, 14].map(platter));
            const rebuilt = await synthesiseRecordFromIndex(ID, index.get(ID), v => platter(v).mountPoint, 19);

            expect(rebuilt!.recoverable).toBe(true);                       // 4 of 4 needed
            // A missing slice gets a REAL volume id (the placeholder). Not -1: the reader builds a Slice for
            // every index before it works out what is available, and Slice's constructor looks the volume up
            // and throws if it does not exist -- so -1 would blow up the read of every degraded object, which
            // is to say every object a recovery exists to rescue. A real volume with no such file on it is
            // exactly what a missing slice looks like on an ordinary day, and the reader reconstructs it.
            expect(rebuilt!.record.dataVolumes).toEqual([19, 33, 19, 19]);
        });

        it('says so plainly when an object is BELOW quorum and simply cannot be read', async () => {
            for (const [vol, idx] of [[19, 0], [33, 1], [30, 4]])
                await writeSlice(slicePath(vol, ID, idx), { id: ID, size: 100, data: 4, parity: 2, index: idx, chunkSize: 16384 });

            const index = await buildSliceIndex([19, 33, 30].map(platter));
            const rebuilt = await synthesiseRecordFromIndex(ID, index.get(ID), v => platter(v).mountPoint, 19);

            expect(rebuilt).toMatchObject({ recoverable: false, found: 3, needed: 4 });
        });
    });
});

// THE TWO RULES, and they are the whole reason a restore is not just "replay the log".
//
// The journal records INTENT, and it is made durable BEFORE the operation it describes completes. That
// ordering is what makes the journal worth having -- and the price of it is that the journal can honestly
// contain a `put` for an object that was then abandoned, and a `del` for one whose deletion then failed.
//
// So the disks get the final word. Every time.
describe('recovery: the journal proposes, the platters dispose', () => {
    let root: string;
    let dir: string;

    beforeEach(async () => {
        root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-restore-'));
        dir = path.join(root, 'artifacts');
        await fsp.mkdir(dir, { recursive: true });
    });
    afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

    const ALIVE = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const GHOST = 'bbbbbbbbbbbbbbbbbbbbbbbb';

    // A snapshot with a REAL trailer -- counts AND checksum. The restore verifies both, because counts
    // agreeing is not the same as the content being right: a snapshot whose records were altered, or whose
    // bytes rotted on the platter, has exactly the same number of lines in it.
    const snapshotOf = async (records: any[]): Promise<string> => {
        const body = records.filter(r => r.op !== 'end');
        const hash = createHash('sha256');
        for (const r of body) hash.update(JSON.stringify(r) + '\n');

        const trailer = records.find(r => r.op === 'end');
        const lines = [...body.map(r => JSON.stringify(r) + '\n')];
        if (trailer)
            lines.push(JSON.stringify({ ...trailer, sha256: trailer.sha256 === 'x' ? hash.digest('hex') : trailer.sha256 }) + '\n');

        const f = path.join(dir, 'snap.gz');
        await pipeline(Readable.from(lines), createGzip(), createWriteStream(f));
        return f;
    };

    const journalOf = async (records: unknown[]): Promise<string> => {
        const f = path.join(dir, '000000.jsonl');
        await fsp.writeFile(f, records.map(r => JSON.stringify(r) + '\n').join(''));
        return f;
    };

    // A platter that HAS the given objects' slices, and nothing else.
    const plattersHolding = async (ids: string[]) => {
        for (const id of ids)
            for (let i = 0; i < 6; i++) {
                const p = path.join(root, 'vol0', 'strubs', id.slice(0, 2), id.slice(2, 4), id.slice(4, 6), `${id}.${i}`);
                await writeSlice(p, { id, size: 100, data: 4, parity: 2, index: i, chunkSize: 16384 });
            }
        return [{ volumeId: 0, mountPoint: path.join(root, 'vol0') }];
    };

    const restoreWith = async (opts: {
        snapshot: unknown[];
        journal?: unknown[];
        onDisk: string[];
    }) => {
        const snap = await snapshotOf(opts.snapshot);
        const jrnl = opts.journal ? [await journalOf(opts.journal)] : [];
        const platters = await plattersHolding(opts.onDisk);
        const written: Record<string, unknown>[] = [];

        const restore = new NamespaceRestore({
            pruneOutsideNamespace: async () => 0,
            journalLocationUncertain: () => false,
            namespaceRestorePending: async () => null,
            restoreInFlight: async () => null,
            beginRestore: async () => undefined,
            endRestore: async () => undefined,
            namespaceRestored: async () => undefined,
            fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
            objectsInDatabase: async () => 0,          // an empty database: this IS a recovery
            fleetRestoreIncomplete: async () => null,  // the volume table is whole
            platters: () => platters,
            fetchSnapshot: async (_id, to) => { await fsp.copyFile(snap, to); },
            journalSegments: async () => jrnl,
            writeContainer: async () => undefined,
            writeObject: async r => { written.push(r); }
        });

        const summary = await restore.run(
            { objectId: 'x', md5: 'x', startedAt: 'T', completedAt: 'T', objects: 0 },
            { apply: true }
        );
        return { summary, written };
    };

    const put = (id: string, name: string) => ({ op: 'put', id, cid: 'c1', name, size: 100, cs: 16384, md5: 'aa' });
    const end = (containers: number, objects: number) => ({ op: 'end', containers, objects, sha256: 'x' });

    it('restores an object the platters actually back up', async () => {
        const { summary, written } = await restoreWith({
            snapshot: [{ op: 'container', id: 'c1', cid: null, name: 'photo' }, put(ALIVE, 'cat.jpg'), end(1, 1)],
            onDisk: [ALIVE]
        });

        expect(summary.objectsRestored).toBe(1);
        expect(written[0]).toMatchObject({ id: ALIVE, name: 'cat.jpg', size: 100, chunkSize: 16384 });
    });

    // A PHANTOM is a name pointing at data that is not there. It reads as data loss for data that never
    // existed, and it is the single failure mode this entire body of work is built to prevent -- so a
    // restore does not get to create one either.
    it('DROPS a put whose object has no slices: the write was abandoned, and a name for it is a phantom', async () => {
        const { summary, written } = await restoreWith({
            snapshot: [{ op: 'container', id: 'c1', cid: null, name: 'photo' }, put(ALIVE, 'real.jpg'), end(1, 1)],
            journal: [put(GHOST, 'never-actually-written.jpg')],   // journaled, then the write failed
            onDisk: [ALIVE]                                        // ...so its slices are nowhere
        });

        expect(summary.objectsRestored).toBe(1);
        expect(summary.putsDropped).toBe(1);
        expect(written.map(w => w.id)).toEqual([ALIVE]);
        expect(written.map(w => w.name)).not.toContain('never-actually-written.jpg');
    });

    // ...and the mirror image, which is just as important and much easier to miss. The journal makes the
    // delete durable BEFORE unlinking the slices. So it can say "deleted" about an object whose deletion
    // then FAILED -- the slices are still there, whole, and the caller was told the delete did not work.
    // Believing it would throw away the name of an object that still exists: 130TB of anonymous slices is
    // exactly what this is all for, and it would be self-inflicted.
    it('IGNORES a del whose object is still on the platters: the delete never completed', async () => {
        const { summary, written } = await restoreWith({
            snapshot: [{ op: 'container', id: 'c1', cid: null, name: 'photo' }, put(ALIVE, 'still-here.jpg'), end(1, 1)],
            journal: [{ op: 'del', id: ALIVE }],   // journal says deleted...
            onDisk: [ALIVE]                        // ...but every slice is still sitting right there
        });

        expect(summary.delsIgnored).toBe(1);
        expect(summary.objectsRestored).toBe(1);
        expect(written[0]).toMatchObject({ id: ALIVE, name: 'still-here.jpg' });   // the name is KEPT
    });

    it('HONOURS a del whose object really is gone', async () => {
        const { summary, written } = await restoreWith({
            snapshot: [{ op: 'container', id: 'c1', cid: null, name: 'photo' }, put(ALIVE, 'deleted.jpg'), end(1, 1)],
            journal: [{ op: 'del', id: ALIVE }],
            onDisk: []                             // the slices really were unlinked
        });

        expect(summary.delsIgnored).toBe(0);
        expect(summary.objectsRestored).toBe(0);
        expect(written).toEqual([]);
    });

    it('REFUSES a truncated snapshot rather than silently restoring part of the namespace', async () => {
        await expect(restoreWith({
            snapshot: [{ op: 'container', id: 'c1', cid: null, name: 'photo' }, put(ALIVE, 'a.jpg')],  // no trailer
            onDisk: [ALIVE]
        })).rejects.toThrow(/TRUNCATED/);
    });

    it('REFUSES a snapshot that does not contain what its trailer claims', async () => {
        await expect(restoreWith({
            snapshot: [{ op: 'container', id: 'c1', cid: null, name: 'photo' }, put(ALIVE, 'a.jpg'), end(1, 999)],
            onDisk: [ALIVE]
        })).rejects.toThrow(/does not contain what it claims/);
    });

    it('counts an object that is named but below quorum as a real loss, not as a success', async () => {
        // Three slices of a 4+2 object: the name is real, the data is genuinely gone. This is the one number
        // in the whole report that is a tragedy, and it must not be quietly folded in with the bookkeeping.
        const id = ALIVE;
        for (const i of [0, 1, 4])
            await writeSlice(
                path.join(root, 'vol0', 'strubs', id.slice(0, 2), id.slice(2, 4), id.slice(4, 6), `${id}.${i}`),
                { id, size: 100, data: 4, parity: 2, index: i, chunkSize: 16384 }
            );

        const snap = await snapshotOf([{ op: 'container', id: 'c1', cid: null, name: 'photo' }, put(id, 'lost.jpg'), end(1, 1)]);
        const restore = new NamespaceRestore({
            pruneOutsideNamespace: async () => 0,
            journalLocationUncertain: () => false,
            namespaceRestorePending: async () => null,
            restoreInFlight: async () => null,
            beginRestore: async () => undefined,
            endRestore: async () => undefined,
            namespaceRestored: async () => undefined,
            fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
            objectsInDatabase: async () => 0,
            fleetRestoreIncomplete: async () => null,  // the volume table is whole
            platters: () => [{ volumeId: 0, mountPoint: path.join(root, 'vol0') }],
            fetchSnapshot: async (_i, to) => { await fsp.copyFile(snap, to); },
            journalSegments: async () => [],
            writeContainer: async () => undefined,
            writeObject: async () => undefined
        });

        const summary = await restore.run({ objectId: 'x', md5: 'x', startedAt: 'T', completedAt: 'T', objects: 1 }, { apply: true });
        expect(summary).toMatchObject({ objectsUnrecoverable: 1, objectsRestored: 0 });
    });

    it('writes nothing at all on a dry run', async () => {
        const snap = await snapshotOf([{ op: 'container', id: 'c1', cid: null, name: 'photo' }, put(ALIVE, 'a.jpg'), end(1, 1)]);
        const platters = await plattersHolding([ALIVE]);
        const writeObject = vi.fn();
        const writeContainer = vi.fn();

        const restore = new NamespaceRestore({
            pruneOutsideNamespace: async () => 0,
            journalLocationUncertain: () => false,
            namespaceRestorePending: async () => null,
            restoreInFlight: async () => null,
            beginRestore: async () => undefined,
            endRestore: async () => undefined,
            namespaceRestored: async () => undefined,
            fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
            objectsInDatabase: async () => 0,          // an empty database: this IS a recovery
            fleetRestoreIncomplete: async () => null,  // the volume table is whole
            platters: () => platters,
            fetchSnapshot: async (_i, to) => { await fsp.copyFile(snap, to); },
            journalSegments: async () => [],
            writeContainer,
            writeObject
        });

        const summary = await restore.run({ objectId: 'x', md5: 'x', startedAt: 'T', completedAt: 'T', objects: 1 }, { apply: false });

        expect(summary.objectsRestored).toBe(1);      // it still TELLS you what it would recover...
        expect(writeObject).not.toHaveBeenCalled();   // ...without touching a thing
        expect(writeContainer).not.toHaveBeenCalled();
    });
});

describe('recovery: the fleet, which cannot be read from a database that is gone', () => {
    const manifest = {
        version: 1,
        instanceIdentity: 'x'.repeat(32),
        geometry: { dataSlices: 4, paritySlices: 2 },
        journalVolumeIds: [4, 10, 13],
        snapshot: null,
        previousSnapshot: null,
        updatedAt: '2026-07-13T00:00:00Z',
        volumes: [
            { id: 3, uuid: 'u3', partitionUuid: 'p3', partitionSize: 3000591916544, dataSize: 0, paritySize: 0, enabled: false, healthy: true, readOnly: true, isDeleted: true, isDraining: false, diskSerial: 'WD-1', label: '2.5' },
            { id: 4, uuid: 'u4', partitionUuid: 'p4', partitionSize: 4000787030016, dataSize: 10, paritySize: 5, enabled: true, healthy: true, readOnly: false, isDeleted: false, isDraining: false, diskSerial: 'WD-2', label: null }
        ]
    } as never;

    it('rebuilds the volume table that the fleet cannot mount without', () => {
        const configs = volumeConfigsFromManifest(manifest);
        expect(configs).toHaveLength(2);
        expect(configs[1]).toMatchObject({
            id: 4,
            uuid: 'u4',
            partition_uuid: 'p4',
            partition_size: 4000787030016,   // mandatory: binding rejects a size mismatch
            enabled: true,
            read_only: false
        });
    });

    // A recovery that quietly dropped deleted volumes would produce a fleet that believes a disk full of
    // STRUBS slices is foreign -- and "I don't recognise this, it must be blank" is how you lose 3TB.
    it('restores DELETED volumes too, so the array still recognises its own disks', () => {
        const configs = volumeConfigsFromManifest(manifest);
        expect(configs.find(c => c.id === 3)).toMatchObject({ is_deleted: true });
    });

    it('REFUSES to restore a fleet over a database that already knows about volumes', () => {
        expect(() => assertSafeToRestoreFleet([{ id: 1 }, { id: 2 }], false)).toThrow(/refusing to restore/);
        expect(() => assertSafeToRestoreFleet([{ id: 1 }], true)).not.toThrow();      // ...unless forced
        expect(() => assertSafeToRestoreFleet([], false)).not.toThrow();              // empty: this is a recovery
    });
});

describe('recovery: a restore is a single forward pass', () => {
    it('writes a parent before its children, whatever order they arrive in', () => {
        const shuffled = [
            { id: 'spain', cid: '2024' },
            { id: 'photo', cid: null },
            { id: '2024', cid: 'photo' }
        ];
        expect(orderParentsFirst(shuffled).map(c => c.id)).toEqual(['photo', '2024', 'spain']);
    });

    it('does not loop forever on a cycle', () => {
        const cyclic = [{ id: 'a', cid: 'b' }, { id: 'b', cid: 'a' }];
        expect(orderParentsFirst(cyclic).map(c => c.id).sort()).toEqual(['a', 'b']);
    });
});

describe('recovery: a snapshot that lies about itself', () => {
    let root: string, dir: string;
    beforeEach(async () => {
        root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-corrupt-'));
        dir = path.join(root, 'a'); await fsp.mkdir(dir, { recursive: true });
    });
    afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

    // The counts agreeing is NOT the same as the content being right. A snapshot whose records were altered,
    // or whose bytes rotted on the platter, has exactly the same number of lines in it. This is the last
    // chance anyone gets to notice before 3.5 million names are rebuilt from it -- and afterwards there is no
    // second copy of the truth to compare against.
    it('REFUSES a snapshot whose contents do not match its own checksum', async () => {
        const records = [
            { op: 'container', id: 'c1', cid: null, name: 'photo' },
            { op: 'put', id: 'aaaaaaaaaaaaaaaaaaaaaaaa', cid: 'c1', name: 'TAMPERED', size: 100, cs: 16384 },
            // The counts are right. The checksum is of something else entirely.
            { op: 'end', containers: 1, objects: 1, sha256: 'deadbeef'.repeat(8) }
        ];
        const f = path.join(dir, 'snap.gz');
        await pipeline(Readable.from(records.map(r => JSON.stringify(r) + '\n')), createGzip(), createWriteStream(f));

        const restore = new NamespaceRestore({
            pruneOutsideNamespace: async () => 0,
            journalLocationUncertain: () => false,
            namespaceRestorePending: async () => null,
            restoreInFlight: async () => null,
            beginRestore: async () => undefined,
            endRestore: async () => undefined,
            namespaceRestored: async () => undefined,
            fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
            fleetRestoreIncomplete: async () => null,   // the volume table is whole
            objectsInDatabase: async () => 0,
            platters: () => [],
            fetchSnapshot: async (_i, to) => { await fsp.copyFile(f, to); },
            journalSegments: async () => [],
            writeContainer: async () => undefined,
            writeObject: async () => undefined
        });

        await expect(restore.run({ objectId: 'x', md5: 'x', startedAt: 'T', completedAt: 'T', objects: 1 }, { apply: true }))
            .rejects.toThrow(/CORRUPT|checksum/i);
    });
});

describe('recovery: which array is this, anyway?', () => {
    // On a bare host there is NO identity to compare against -- that is the whole problem, and it is why we
    // are here. So "take the newest manifest and call everything that disagrees foreign" gets it exactly
    // backwards: one disk from somebody else's array, plugged in by mistake and written more recently than
    // ours, would BECOME the array. Every one of our own disks would then be the foreign ones.
    //
    // The disks are the vote. Thirty drives carrying one identity and one carrying another is not an
    // ambiguity; it is a mistake with an obvious answer.
    const mf = (identity: string, updatedAt: string) => ({
        version: 1, instanceIdentity: identity, geometry: { dataSlices: 4, paritySlices: 2 },
        volumes: [], journalVolumeIds: [], snapshot: null, previousSnapshot: null, updatedAt
    });

    it('takes the array the MAJORITY of disks belong to, not the newest manifest in the box', () => {
        const found = [
            { device: '/dev/sdb1', manifest: mf('ours', '2026-07-01T00:00:00Z') as never },
            { device: '/dev/sdc1', manifest: mf('ours', '2026-07-01T00:00:00Z') as never },
            { device: '/dev/sdd1', manifest: mf('ours', '2026-07-01T00:00:00Z') as never },
            // Somebody else's disk, plugged in by mistake, written yesterday.
            { device: '/dev/sde1', manifest: mf('SOMEBODY-ELSES', '2026-07-12T00:00:00Z') as never }
        ];

        const result = reconcileManifests(found);
        expect(result.manifest?.instanceIdentity).toBe('ours');
        expect(result.agreeing).toBe(3);
        expect(result.foreign).toEqual(['/dev/sde1']);
    });

    it('REFUSES to guess when the disks are evenly split between two arrays', () => {
        const found = [
            { device: '/dev/sdb1', manifest: mf('array-a', '2026-07-01T00:00:00Z') as never },
            { device: '/dev/sdc1', manifest: mf('array-b', '2026-07-02T00:00:00Z') as never }
        ];
        // Picking one silently is how a recovery restores the wrong array over the right one.
        expect(() => reconcileManifests(found)).toThrow(/majority/i);
    });

    it('takes the newest manifest from WITHIN our own array', () => {
        const found = [
            { device: '/dev/sdb1', manifest: mf('ours', '2026-01-01T00:00:00Z') as never },   // a disk that was out of the rack
            { device: '/dev/sdc1', manifest: mf('ours', '2026-07-13T00:00:00Z') as never }
        ];
        expect(reconcileManifests(found).manifest?.updatedAt).toBe('2026-07-13T00:00:00Z');
    });
});

// A recovery reads ONE header and believes everything it says about an object: its size, how many slices it
// has, how big its chunks are. A single flipped bit on that one disk, and it writes a record describing an
// object that does not exist in that shape -- and the reader then tries to decode 4+2 with the wrong geometry
// and produces garbage. The checksum is right there in the header. It gets checked.
describe('recovery: a header that lies', () => {
    let root: string;
    beforeEach(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-hdr-')); });
    afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

    const ID = '6a546c8d3b1e7a005a000001';
    const at = (idx: number) => path.join(root, 'vol0', 'strubs', ID.slice(0, 2), ID.slice(2, 4), ID.slice(4, 6), `${ID}.${idx}`);

    // THE CHECKSUM IS ADVISORY, and finding that out cost one run against the real array.
    //
    // This machine has been running since 2014 and the header scheme has not always been the same. Sampled
    // against the live platters: every 2014 slice fails the current checksum, 2015 is split down the middle,
    // and everything from 2019 on passes. Those "failures" are perfectly healthy slices written by older
    // code -- and rejecting them, which is what this function did until it first met real data, would have a
    // recovery report a large fraction of the oldest data on the array as unrecoverable. It would tell
    // someone their 2014 photographs were gone while they sat there, intact, on six disks.
    //
    // A recovery tool that condemns healthy data is worse than none, because it will be believed. So a
    // matching checksum is strong evidence; a mismatch proves nothing, and the STRUCTURE has to carry it.
    it('ACCEPTS a header that fails the current checksum but is structurally sound (it is simply old)', async () => {
        await writeSlice(at(0), { id: ID, size: 100, data: 4, parity: 2, index: 0, chunkSize: 16384 });

        // Scribble over the checksum, exactly as an older format version effectively does.
        const buf = await fsp.readFile(at(0));
        buf.fill(0, 7, 23);
        await fsp.writeFile(at(0), buf);

        const header = await readSliceHeader(at(0));
        expect(header).toMatchObject({ id: ID, size: 100, dataSliceCount: 4, sliceIndex: 0 });
    });

    it('REJECTS a header whose slice index disagrees with its own filename', async () => {
        // The file says .0; the header says slice 3. One of them is lying and there is no way to know which.
        await writeSlice(at(0), { id: ID, size: 100, data: 4, parity: 2, index: 3, chunkSize: 16384 });
        expect(await readSliceHeader(at(0))).toBeNull();
    });

    it('REJECTS geometry that passes its checksum and is still nonsense', async () => {
        // Zero data slices: written correctly, checksummed correctly, and a recovery that believed it would
        // divide by zero somewhere a long way from here.
        await writeSlice(at(0), { id: ID, size: 100, data: 0, parity: 2, index: 0, chunkSize: 16384 });
        expect(await readSliceHeader(at(0))).toBeNull();
    });

    it('counts an object whose slices are ALL undescribable as unrecoverable, not as never having existed', async () => {
        // The data is there. Not one copy can describe it. Filing that as "the write was abandoned" would tell
        // an operator their array is fine while it rots. (Structural nonsense, not a checksum mismatch -- a
        // mismatch only means the slice is old.)
        for (let i = 0; i < 6; i++) {
            await writeSlice(at(i), { id: ID, size: 100, data: 4, parity: 2, index: i, chunkSize: 16384 });
            const b = await fsp.readFile(at(i)); b[40] = 0; await fsp.writeFile(at(i), b);   // zero data slices
        }

        const dir2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-art-'));
        const records: any[] = [
            { op: 'container', id: 'c1', cid: null, name: 'photo' },
            { op: 'put', id: ID, cid: 'c1', name: 'rotten.jpg', size: 100, cs: 16384 }
        ];
        const hash = createHash('sha256');
        for (const r of records) hash.update(JSON.stringify(r) + '\n');
        const lines = [...records.map(r => JSON.stringify(r) + '\n'),
            JSON.stringify({ op: 'end', containers: 1, objects: 1, sha256: hash.digest('hex') }) + '\n'];
        const snap = path.join(dir2, 'snap.gz');
        await pipeline(Readable.from(lines), createGzip(), createWriteStream(snap));

        const restore = new NamespaceRestore({
            pruneOutsideNamespace: async () => 0,
            journalLocationUncertain: () => false,
            namespaceRestorePending: async () => null,
            restoreInFlight: async () => null,
            beginRestore: async () => undefined,
            endRestore: async () => undefined,
            namespaceRestored: async () => undefined,
            fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
            fleetRestoreIncomplete: async () => null,   // the volume table is whole
            objectsInDatabase: async () => 0,
            platters: () => [{ volumeId: 0, mountPoint: path.join(root, 'vol0') }],
            fetchSnapshot: async (_i, to) => { await fsp.copyFile(snap, to); },
            journalSegments: async () => [],
            writeContainer: async () => undefined,
            writeObject: async () => undefined
        });

        const summary = await restore.run({ objectId: 'x', md5: 'x', startedAt: 'T', completedAt: 'T', objects: 1 }, { apply: true });
        expect(summary).toMatchObject({ objectsUnrecoverable: 1, objectsMissing: 0, putsDropped: 0 });

        await fsp.rm(dir2, { recursive: true, force: true });
    });
});

// A restore rebuilds the namespace from a snapshot plus a journal -- a view of the world that is, by
// definition, from the past. Pointing that at a database currently serving 3.5 million objects does not
// repair anything: it overwrites what the array knows with something older.
describe('recovery: not on a live array', () => {
    it('REFUSES to apply a restore into a database that already holds objects', async () => {
        const restore = new NamespaceRestore({
            pruneOutsideNamespace: async () => 0,
            journalLocationUncertain: () => false,
            namespaceRestorePending: async () => null,
            restoreInFlight: async () => null,
            beginRestore: async () => undefined,
            endRestore: async () => undefined,
            namespaceRestored: async () => undefined,
            fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
            fleetRestoreIncomplete: async () => null,   // the volume table is whole
            objectsInDatabase: async () => 3_545_825,          // a live array
            platters: () => [],
            fetchSnapshot: async () => { throw new Error('should never get this far'); },
            journalSegments: async () => [],
            writeContainer: async () => undefined,
            writeObject: async () => undefined
        });

        await expect(restore.run({ objectId: 'x', md5: 'x', startedAt: 'T', completedAt: 'T', objects: 1 }, { apply: true }))
            .rejects.toThrow(/refusing to restore into a database that already holds/);
    });

    it('always allows a DRY RUN, because looking is not touching', async () => {
        const restore = new NamespaceRestore({
            pruneOutsideNamespace: async () => 0,
            journalLocationUncertain: () => false,
            namespaceRestorePending: async () => null,
            restoreInFlight: async () => null,
            beginRestore: async () => undefined,
            endRestore: async () => undefined,
            namespaceRestored: async () => undefined,
            fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
            fleetRestoreIncomplete: async () => null,   // the volume table is whole
            objectsInDatabase: async () => 3_545_825,
            platters: () => [],
            fetchSnapshot: async () => { throw new Error('reached the snapshot, so the guard let us through'); },
            journalSegments: async () => [],
            writeContainer: async () => undefined,
            writeObject: async () => undefined
        });

        await expect(restore.run({ objectId: 'x', md5: 'x', startedAt: 'T', completedAt: 'T', objects: 1 }, { apply: false }))
            .rejects.toThrow(/reached the snapshot/);      // it got PAST the live-array guard
    });
});

// Everything downstream of the slice index treats an id's absence from it as a FACT about the world: the
// restore drops the name as an abandoned write, the drift scrub calls it a phantom, a `del` that never
// completed gets honoured. Every one of those is a decision to throw a name away -- made, if we are not
// careful, on the strength of a readdir that quietly returned nothing because a disk was too sick to answer.
describe('recovery: a disk that will not answer is not a disk with nothing on it', () => {
    let root: string;
    beforeEach(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-eio-')); });
    afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

    it('REFUSES to hand back a picture of the array it knows is incomplete', async () => {
        const ID = '6a546c8d3b1e7a005a000001';
        const vol0 = path.join(root, 'vol0');
        await writeSlice(path.join(vol0, 'strubs', '6a', '54', '6c', `${ID}.0`),
            { id: ID, size: 100, data: 4, parity: 2, index: 0, chunkSize: 16384 });

        // A FILE where a shard directory should be: readdir gives ENOTDIR, not ENOENT. "I could not look" is
        // not "there was nothing there".
        await fsp.mkdir(path.join(vol0, 'strubs', 'aa', 'bb'), { recursive: true });
        await fsp.writeFile(path.join(vol0, 'strubs', 'aa', 'bb', 'cc'), 'not a directory');

        await expect(buildSliceIndex([{ volumeId: 0, mountPoint: vol0 }]))
            .rejects.toThrow(/refusing to report on the array/);
    });

    it('is untroubled by a shard directory that genuinely does not exist', async () => {
        const ID = '6a546c8d3b1e7a005a000001';
        const vol0 = path.join(root, 'vol0');
        await writeSlice(path.join(vol0, 'strubs', '6a', '54', '6c', `${ID}.0`),
            { id: ID, size: 100, data: 4, parity: 2, index: 0, chunkSize: 16384 });

        const index = await buildSliceIndex([{ volumeId: 0, mountPoint: vol0 }]);
        expect([...index.keys()]).toEqual([ID]);      // ENOENT is a fact, and the fact is "nothing here"
    });

    // `found` counts FILENAMES, and a rotten file still has a name. An object with exactly four surviving
    // files -- one of them corrupt -- would be counted as recoverable and reported as restored, right up
    // until somebody tried to read it. Checking all six headers of 3.5 million objects is hours; checking
    // them only where a single bad slice would tip the object below quorum costs almost nothing, because
    // almost nothing is that close to the edge.
    it('checks EVERY copy when a single bad slice would tip the object below quorum', async () => {
        const ID = '6a546c8d3b1e7a005a000001';
        const vol0 = path.join(root, 'vol0');
        const at = (i: number) => path.join(vol0, 'strubs', '6a', '54', '6c', `${ID}.${i}`);

        // Exactly four slices -- no margin at all -- and one of them is structurally broken.
        for (const i of [0, 1, 2, 3])
            await writeSlice(at(i), { id: ID, size: 100, data: 4, parity: 2, index: i, chunkSize: 16384 });
        const bad = await fsp.readFile(at(2)); bad[40] = 0; await fsp.writeFile(at(2), bad);

        const index = await buildSliceIndex([{ volumeId: 0, mountPoint: vol0 }]);
        const rebuilt = await synthesiseRecordFromIndex(ID, index.get(ID), () => vol0, 0);

        // Four files, three readable. It is NOT recoverable, and saying otherwise would be a promise the
        // array cannot keep.
        expect(rebuilt).toMatchObject({ recoverable: false, found: 3, needed: 4 });
    });
});

// A journal is append-only, and a crash can cut the record being written in half. That torn LAST line is
// forgivable -- and it is the only unparseable line that is. An unreadable record in the MIDDLE of a segment
// is corruption, and skipping it applies the history with an operation missing from it: a lost delete brings
// an object back from the dead, a lost create leaves its data on the platters with no name.
describe('recovery: a history with a hole in it', () => {
    let root: string, dir: string;
    beforeEach(async () => {
        root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-jrnl-'));
        dir = path.join(root, 'a'); await fsp.mkdir(dir, { recursive: true });
    });
    afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

    const ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

    const restoreWith = async (journalBody: string) => {
        const records: any[] = [{ op: 'container', id: 'c1', cid: null, name: 'photo' }];
        const hash = createHash('sha256');
        for (const r of records) hash.update(JSON.stringify(r) + '\n');
        const lines = [...records.map(r => JSON.stringify(r) + '\n'),
            JSON.stringify({ op: 'end', containers: 1, objects: 0, sha256: hash.digest('hex') }) + '\n'];
        const snap = path.join(dir, 'snap.gz');
        await pipeline(Readable.from(lines), createGzip(), createWriteStream(snap));

        const seg = path.join(dir, '000000.jsonl');
        await fsp.writeFile(seg, journalBody);

        const restore = new NamespaceRestore({
            pruneOutsideNamespace: async () => 0,
            journalLocationUncertain: () => false,
            namespaceRestorePending: async () => null,
            restoreInFlight: async () => null,
            beginRestore: async () => undefined,
            endRestore: async () => undefined,
            namespaceRestored: async () => undefined,
            fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
            fleetRestoreIncomplete: async () => null,   // the volume table is whole
            objectsInDatabase: async () => 0,
            platters: () => [{ volumeId: 0, mountPoint: path.join(root, 'vol0') }],
            fetchSnapshot: async (_i, to) => { await fsp.copyFile(snap, to); },
            journalSegments: async () => [seg],
            writeContainer: async () => undefined,
            writeObject: async () => undefined
        });

        return restore.run({ objectId: 'x', md5: 'x', startedAt: 'T', completedAt: 'T', objects: 0 }, { apply: true });
    };

    it('forgives a TORN LAST LINE, which is just a crash mid-write', async () => {
        const good = JSON.stringify({ op: 'del', ts: 'T', id: ID }) + '\n';
        await expect(restoreWith(good + '{"op":"put","id":"bbbb')).resolves.toBeDefined();
    });

    it('REFUSES a corrupt record in the MIDDLE, rather than applying a history with an operation missing', async () => {
        const torn = '{"op":"del","id":"aaaa';
        const good = JSON.stringify({ op: 'del', ts: 'T', id: ID }) + '\n';
        await expect(restoreWith(torn + '\n' + good + good)).rejects.toThrow(/hole in it/);
    });
});


// "I COULD NOT TELL" IS NOT "THERE IS NOTHING THERE".
//
// Both bugs below were real, and both were in this code until it was run in anger. They are the same mistake
// wearing two hats: a failure to READ the array being silently reported as a fact ABOUT the array. It is the
// single most dangerous thing this module can do, because the answer it produces -- "no slices anywhere" -- is
// indistinguishable from catastrophic data loss, and an operator will act on it.
describe('recovery: refusing to mistake a failure to look for an absence of data', () => {
    let root: string;
    beforeEach(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-failopen-')); });
    afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

    const ID = '53ba9b5e3b1e7a6144152e6b';

    it('REFUSES to report on an object when a disk that might hold its slices cannot be read', async () => {
        // Volume 1 is healthy and holds slice 0. Volume 2's shard path cannot be listed -- on the real array
        // that is EIO from a dying disk; here it is ENOTDIR, which reaches the same catch by the same door.
        const good = `${root}/v1`;
        const bad = `${root}/v2`;
        await writeSlice(`${good}/strubs/53/ba/9b/${ID}.0`, { id: ID, size: 100, data: 4, parity: 2, index: 0, chunkSize: 16384 });
        await fsp.mkdir(`${bad}/strubs/53/ba`, { recursive: true });
        await fsp.writeFile(`${bad}/strubs/53/ba/9b`, 'not a directory');

        const platters = [
            { volumeId: 1, mountPoint: good },
            { volumeId: 2, mountPoint: bad }
        ];

        // The tempting, catastrophic behaviour is to shrug and return the one slice it could find. Do that to
        // two disks of a 4+2 object and a healthy file is declared below quorum -- unrecoverable, and wrong.
        await expect(locateSlices(ID, platters)).rejects.toThrow(/cannot read .* on volume 2/);
    });

    it('still reports an object normally when a disk simply has no shard directory (ENOENT is a FACT)', async () => {
        // The ordinary case, and it must not be swallowed by the guard above: most disks hold no slice of any
        // given object, and their shard directory was simply never created.
        const a = `${root}/v1`;
        const b = `${root}/v2`;
        await writeSlice(`${a}/strubs/53/ba/9b/${ID}.0`, { id: ID, size: 100, data: 4, parity: 2, index: 0, chunkSize: 16384 });
        await fsp.mkdir(`${b}/strubs`, { recursive: true });

        const found = await locateSlices(ID, [{ volumeId: 1, mountPoint: a }, { volumeId: 2, mountPoint: b }]);
        expect(found.size).toBe(1);
        expect(found.get(0)?.volumeId).toBe(1);
    });

    it('REFUSES to draw conclusions when the fleet reports no volumes at all', () => {
        // A fleet that has not come up yields an empty volume list, and the `missing` check cannot catch it:
        // with no volume entries there is nothing to BE missing, so the loop falls through to an empty and
        // entirely reassuring answer. A drift scrub handed that would report all 3.5M objects as phantoms --
        // the array announcing total data loss because it asked the question before it was ready to answer it.
        expect(() => plattersOrRefuse([])).toThrow(/NO volumes at all/);
    });

    it('REFUSES to draw conclusions while a volume that is supposed to be there is not mounted', () => {
        expect(() => plattersOrRefuse([
            { id: 1, isDeleted: false, isMounted: true, isStarted: true, mountPoint: '/mnt/a' },
            { id: 7, isDeleted: false, isMounted: false, isStarted: false }
        ])).toThrow(/volume\(s\) 7 are not/);
    });

    it('does NOT refuse over a volume that was deliberately retired', () => {
        // A deleted volume is not expected to be here and its absence proves nothing. Refusing over it would
        // make the whole guard un-satisfiable on any array that has ever retired a disk -- which is all of them.
        const platters = plattersOrRefuse([
            { id: 1, isDeleted: false, isMounted: true, isStarted: true, mountPoint: '/mnt/a' },
            { id: 2, isDeleted: true, isMounted: false, isStarted: false }
        ]);
        expect(platters).toEqual([{ volumeId: 1, mountPoint: '/mnt/a' }]);
    });
});


// THE SIX THINGS A SECOND PAIR OF EYES FOUND, each of which produces a recovery that is WRONG and says it is
// fine. Not one of them crashes; that is what makes them worth a test apiece.
describe('recovery: a wrong answer delivered confidently is the whole failure mode', () => {
    let root: string;
    beforeEach(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-confident-')); });
    afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

    const ID = '6a546c1e7b1e7a6144152e6b';
    const OLD_SNAP = '5f5f5f5f5f5f5f5f5f5f5f5f';     // a real object id: isUsableSnapshotRef checks the shape
    const mountOf = () => path.join(root, 'vol0');
    const at = (i: number) => path.join(root, 'vol0', 'strubs', '6a', '54', '6c', `${ID}.${i}`);
    const slots = (n: number) => { const u = new Uint16Array(32); for (let i = 0; i < n; i++) u[i] = 1; return u; };

    // 1. GEOMETRY BY AGREEMENT, not by whichever header happened to be read first.
    it('will not let ONE corrupt header dictate an object\'s size', async () => {
        // Six healthy slices, all saying the object is 100 bytes -- except slice 0, which says 999999. That is
        // structurally plausible: right id, right geometry, sane chunk size. Read it first and believe it, and
        // the restore records an object of the wrong SIZE, the reader decodes against the wrong shape, and the
        // operator is told the recovery succeeded.
        for (let i = 0; i < 6; i++)
            await writeSlice(at(i), { id: ID, size: 100, data: 4, parity: 2, index: i, chunkSize: 16384 });
        const bad = await fsp.readFile(at(0));
        bad.writeIntLE(999999, 35, 5);
        await fsp.writeFile(at(0), bad);

        const rebuilt = await synthesiseRecordFromIndex(ID, slots(6), mountOf, 0);

        // The five that agree outvote the one that does not. No quorum, no shape.
        expect(rebuilt?.record.size).toBe(100);
        expect(rebuilt?.recoverable).toBe(true);
    });

    it('REFUSES to describe an object whose headers disagree and none corroborates another', async () => {
        // Two slices, two different stories, no tie-breaker. We do not know this object's shape, and restoring
        // it on a coin-toss would be a guess presented to an operator as a fact.
        await writeSlice(at(0), { id: ID, size: 100, data: 4, parity: 2, index: 0, chunkSize: 16384 });
        await writeSlice(at(1), { id: ID, size: 100, data: 4, parity: 2, index: 1, chunkSize: 16384 });
        const bad = await fsp.readFile(at(1));
        bad.writeIntLE(999999, 35, 5);
        await fsp.writeFile(at(1), bad);

        expect(await synthesiseRecordFromIndex(ID, slots(2), mountOf, 0)).toBeNull();
    });

    // 2 + 3. THE JOURNAL IS A HISTORY, and a history with a hole in it is not a shorter history.
    it('REFUSES to replay a journal with a missing segment', () => {
        // 000000 and 000002 are here. 000001 is not -- and every delete it recorded would be UNDONE, bringing
        // objects somebody asked to be rid of back from the dead, named, in their buckets.
        expect(() => assertNoJournalGaps(['000000.jsonl', '000002.jsonl'], false))
            .toThrow(/000001.*MISSING/s);

        // ...and an operator who knows the segment is gone for good may force it -- deliberately, out loud.
        expect(() => assertNoJournalGaps(['000000.jsonl', '000002.jsonl'], true)).not.toThrow();
        expect(() => assertNoJournalGaps(['000000.jsonl', '000001.jsonl'], false)).not.toThrow();
    });

    it('REFUSES a journal record that parses but is not an operation it understands', async () => {
        // One flipped bit turns "del" into "ddl". JSON.parse is perfectly happy; the delete simply never
        // happens, and the object it should have removed is restored as though it had never been deleted.
        const restore = new NamespaceRestore({
            pruneOutsideNamespace: async () => 0,
            journalLocationUncertain: () => false,
            namespaceRestorePending: async () => null,
            restoreInFlight: async () => null,
            beginRestore: async () => undefined,
            endRestore: async () => undefined,
            namespaceRestored: async () => undefined,
            fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
            objectsInDatabase: async () => 0,
            fleetRestoreIncomplete: async () => null,
            platters: () => [{ volumeId: 0, mountPoint: path.join(root, 'vol0') }],
            fetchSnapshot: async (_i, to) => {
                const lines = [JSON.stringify({ op: 'end', containers: 0, objects: 0, sha256: createHash('sha256').digest('hex') }) + '\n'];
                await pipeline(Readable.from(lines), createGzip(), createWriteStream(to));
            },
            journalSegments: async () => {
                const f = path.join(root, 'j.jsonl');
                await fsp.writeFile(f,
                    JSON.stringify({ op: 'ddl', id: ID }) + '\n'
                    + JSON.stringify({ op: 'container', id: 'c'.repeat(24), cid: null, name: 'x' }) + '\n');
                return [f];
            },
            writeContainer: async () => undefined,
            writeObject: async () => undefined
        });

        await expect(restore.run({ objectId: 'x', md5: 'x', startedAt: 'T', completedAt: 'T', objects: 0 }, { apply: false }))
            .rejects.toThrow(/not an operation this understands/);
    });

    // 5. A HALF-WRITTEN VOLUME TABLE must not be allowed to become the array's idea of itself.
    it('REFUSES to restore the namespace while the volume table is half-written', async () => {
        // Every disk missing from the table is a disk the platter scan never looks at -- so objects living only
        // on those disks look like abandoned writes, and the restore DISCARDS THEIR NAMES. There is no undo.
        const restore = new NamespaceRestore({
            pruneOutsideNamespace: async () => 0,
            journalLocationUncertain: () => false,
            namespaceRestorePending: async () => null,
            restoreInFlight: async () => null,
            beginRestore: async () => undefined,
            endRestore: async () => undefined,
            namespaceRestored: async () => undefined,
            fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
            objectsInDatabase: async () => 0,
            fleetRestoreIncomplete: async () => ({ expected: 30, startedAt: '2026-07-13T00:00:00Z' }),
            platters: () => [{ volumeId: 0, mountPoint: path.join(root, 'vol0') }],
            fetchSnapshot: async () => undefined as never,
            journalSegments: async () => [],
            writeContainer: async () => undefined,
            writeObject: async () => undefined
        });

        await expect(restore.run({ objectId: 'x', md5: 'x', startedAt: 'T', completedAt: 'T', objects: 1 }, { apply: false }))
            .rejects.toThrow(/did not finish/);
    });

    it('lets an INTERRUPTED fleet restore resume over its own wreckage', () => {
        // The volume documents already in the database are the debris of the attempt we are resuming, not a
        // live fleet's opinion of itself. Refusing here would strand the array: unable to finish, unable to
        // start, because the table has holes in it.
        expect(() => assertSafeToRestoreFleet([{ id: 1 }, { id: 2 }], false,
            { expected: 30, startedAt: '2026-07-13T00:00:00Z' })).not.toThrow();

        // ...but with no interrupted restore, an existing table is a LIVE fleet and is not to be overwritten.
        expect(() => assertSafeToRestoreFleet([{ id: 1 }], false, null)).toThrow(/already knows about/);
    });

    // 4. ONE MANIFEST CANNOT ANSWER BOTH QUESTIONS.
    it('does not let a stale disk carrying an old snapshot roll back the VOLUME TABLE', async () => {
        // The stale disk has been out of the rack for a month. It carries an old snapshot pointer -- which makes
        // it win `newestManifest()`, by design -- and a volume table that predates half the array. Take the whole
        // manifest from it and every disk added since is silently dropped from the fleet, which makes every
        // object living on those disks read as data loss.
        const vol = (id: number) => ({
            id, uuid: `u${id}`, enabled: true, healthy: true, readOnly: false,
            partitionSize: 1, dataSize: 1, paritySize: 1, isDeleted: false, isDraining: false
        });
        const base = {
            instanceIdentity: 'i'.repeat(32),
            geometry: { dataSlices: 4, paritySlices: 2 },
            journalVolumeIds: [1]
        };

        const stale = {
            ...base, updatedAt: '2026-06-01T00:00:00Z', volumes: [vol(1)],
            snapshot: { objectId: OLD_SNAP, md5: 'm', startedAt: 'T', completedAt: '2026-06-01T00:00:00Z', objects: 1 }
        };
        const fresh = { ...base, updatedAt: '2026-07-01T00:00:00Z', volumes: [vol(1), vol(2), vol(3)], snapshot: null };

        const { manifest } = reconcileManifests([
            { device: '/dev/sda1', manifest: stale as never },
            { device: '/dev/sdb1', manifest: fresh as never },
            { device: '/dev/sdc1', manifest: fresh as never }
        ]);

        // The VOLUME TABLE comes from the newest manifest...
        expect(manifest?.volumes.map(v => v.id)).toEqual([1, 2, 3]);
        // ...and the SNAPSHOT still comes from the only disk that has one, because otherwise the recovery
        // concludes there is no namespace to restore while 127MB of it sits on the platters.
        expect(manifest?.snapshot?.objectId).toBe(OLD_SNAP);
    });
});


// ROUND TWO: the bugs the FIXES introduced. Every one of these was created by the change made to close the
// previous finding, which is worth saying plainly -- a fix written in a hurry to shut a hole is the most
// reliable way to open a new one, and in a recovery tool nobody notices until the day it matters.
describe('recovery: the bugs that the fixes brought with them', () => {
    let root: string;
    beforeEach(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-round2-')); });
    afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

    const ID = '6a546c1e7b1e7a6144152e6b';

    // Six slices, each on its OWN volume -- which is what 4+2 actually does, and what the earlier fixtures
    // (all six on one disk) quietly failed to model.
    const spread = async (corrupt: number[], size = 999999) => {
        for (let i = 0; i < 6; i++) {
            const p = path.join(root, `vol${i}`, 'strubs', '6a', '54', '6c', `${ID}.${i}`);
            await writeSlice(p, { id: ID, size: 100, data: 4, parity: 2, index: i, chunkSize: 16384 });
            if (corrupt.includes(i)) {
                const b = await fsp.readFile(p);
                b.writeIntLE(size, 35, 5);
                await fsp.writeFile(p, b);
            }
        }
        const mounts = new Map(Array.from({ length: 6 }, (_, i) => [i, path.join(root, `vol${i}`)]));
        const slots = new Uint16Array(32);
        for (let i = 0; i < 6; i++) slots[i] = i + 1;      // volumeId + 1
        return { slots, mountOf: (v: number) => mounts.get(v) };
    };

    it('does not let the first agreeing PAIR outvote the four good headers behind it', async () => {
        // Slices 0 and 1 are corrupt IN THE SAME WAY -- one bad batch, one bad cable, the same garbage written
        // twice. The original rule stopped at the first shape to reach two votes, so this pair won before
        // slices 2-5 were ever asked. Four disks say 100 bytes. Two say 999999. The four win.
        const { slots, mountOf } = await spread([0, 1]);
        const rebuilt = await synthesiseRecordFromIndex(ID, slots, mountOf, 0);

        expect(rebuilt?.record.size).toBe(100);
        expect(rebuilt?.recoverable).toBe(true);
    });

    it('REFUSES when the disks are evenly split on the shape, rather than picking a side', async () => {
        // Three disks say 100 bytes, three say 999999. Nothing here can tell you which trio is the corrupt one,
        // and restoring on a coin-toss would hand an operator a guess dressed up as a fact.
        const { slots, mountOf } = await spread([0, 1, 2]);
        expect(await synthesiseRecordFromIndex(ID, slots, mountOf, 0)).toBeNull();
    });

    // A HOLE AT THE FRONT of the journal is exactly as bad as a hole in the middle, and the first version of
    // the gap check could only see the middle -- it compared the segments that were present to each other.
    it('REFUSES a journal whose FIRST segment is missing', () => {
        // Every journal begins at 000000 and rotation only ever appends (see journal.ts), so a journal that
        // starts at 000001 is not a short journal. It is a journal whose first segment is GONE.
        expect(() => assertNoJournalGaps(['000001.jsonl', '000002.jsonl'], false))
            .toThrow(/000000.*MISSING/s);

        expect(() => assertNoJournalGaps(['000000.jsonl', '000001.jsonl'], false)).not.toThrow();
    });

    it('REFUSES a journal segment whose name is not a number', () => {
        // Dropping it silently would let the gap check agree that a history with a hole in it is contiguous.
        expect(() => assertNoJournalGaps(['000000.jsonl', 'banana.jsonl'], false)).toThrow(/not a number/);
    });

    // THE TORN-LINE FORGIVENESS WAS FORGIVING TWO LINES.
    //
    // `lines` comes from splitting on \n. When the final record is torn there IS no trailing newline, so the
    // last real record sits at length - 1 -- and the old test, `lineIndex >= lines.length - 2`, therefore also
    // forgave the record BEFORE it. That record is intact. If it is a `del`, forgiving it walks a deleted
    // object straight back into the restored namespace, with its name, in its bucket.
    it('does NOT forgive the intact record sitting just before a torn final one', async () => {
        const restore = new NamespaceRestore({
            pruneOutsideNamespace: async () => 0,
            journalLocationUncertain: () => false,
            namespaceRestorePending: async () => null,
            restoreInFlight: async () => null,
            beginRestore: async () => undefined,
            endRestore: async () => undefined,
            namespaceRestored: async () => undefined,
            fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
            objectsInDatabase: async () => 0,
            fleetRestoreIncomplete: async () => null,
            platters: () => [{ volumeId: 0, mountPoint: path.join(root, 'vol0') }],
            fetchSnapshot: async (_i, to) => {
                const lines = [JSON.stringify({ op: 'end', containers: 0, objects: 0,
                    sha256: createHash('sha256').digest('hex') }) + '\n'];
                await pipeline(Readable.from(lines), createGzip(), createWriteStream(to));
            },
            journalSegments: async () => {
                const f = path.join(root, '000000.jsonl');
                // A corrupt record, then a valid one, and NO trailing newline -- the shape a crash leaves.
                // The corrupt record is not the last line, so it is not a torn write: it is corruption.
                await fsp.writeFile(f, '{"op":"del","id":"tru'
                    + '\n' + JSON.stringify({ op: 'container', id: 'c'.repeat(24), cid: null, name: 'x' }));
                return [f];
            },
            writeContainer: async () => undefined,
            writeObject: async () => undefined
        });

        await expect(restore.run(
            { objectId: 'x', md5: 'x', startedAt: 'T', completedAt: 'T', objects: 0 }, { apply: false }))
            .rejects.toThrow(/unreadable record|not the last one/);
    });

    // NaN LOSES EVERY COMPARISON -- which means it WINS the reduce.
    it('does not let a manifest with a garbage updatedAt pin the volume table', () => {
        // `finite > NaN` is false, so a manifest with an unparseable updatedAt, if it happens to be the one the
        // reduce starts with, rejects every genuinely newer table in turn and adopts its own stale one. Disks
        // added since would vanish from the fleet, and every object living only on them would read as loss.
        const vol = (id: number) => ({
            id, uuid: `u${id}`, enabled: true, healthy: true, readOnly: false,
            partitionSize: 1, dataSize: 1, paritySize: 1, isDeleted: false, isDraining: false
        });
        const base = {
            instanceIdentity: 'i'.repeat(32),
            geometry: { dataSlices: 4, paritySlices: 2 },
            journalVolumeIds: [1],
            snapshot: null
        };

        const { manifest } = reconcileManifests([
            { device: '/dev/sda1', manifest: { ...base, updatedAt: 'garbage', volumes: [vol(1)] } as never },
            { device: '/dev/sdb1', manifest: { ...base, updatedAt: '2026-07-01T00:00:00Z', volumes: [vol(1), vol(2), vol(3)] } as never },
            { device: '/dev/sdc1', manifest: { ...base, updatedAt: '2026-06-01T00:00:00Z', volumes: [vol(1), vol(2)] } as never }
        ]);

        expect(manifest?.volumes.map(v => v.id)).toEqual([1, 2, 3]);
    });

    // A BUCKET CLOSED AFTER THE SNAPSHOT MUST NOT REOPEN ON RESTORE.
    it('replays a bucket policy set after the snapshot, rather than restoring the older permissive one', async () => {
        const BUCKET = 'c'.repeat(24);
        const written: Record<string, unknown>[] = [];

        const restore = new NamespaceRestore({
            pruneOutsideNamespace: async () => 0,
            journalLocationUncertain: () => false,
            namespaceRestorePending: async () => null,
            restoreInFlight: async () => null,
            beginRestore: async () => undefined,
            endRestore: async () => undefined,
            namespaceRestored: async () => undefined,
            fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
            objectsInDatabase: async () => 0,
            fleetRestoreIncomplete: async () => null,
            platters: () => [{ volumeId: 0, mountPoint: path.join(root, 'vol0') }],
            fetchSnapshot: async (_i, to) => {
                // The snapshot froze this bucket as PUBLIC.
                const body = [{ op: 'container', id: BUCKET, cid: null, name: 'photos', pr: true }];
                const hash = createHash('sha256');
                const lines = body.map(r => JSON.stringify(r) + '\n');
                for (const l of lines) hash.update(l);
                lines.push(JSON.stringify({ op: 'end', containers: 1, objects: 0, sha256: hash.digest('hex') }) + '\n');
                await pipeline(Readable.from(lines), createGzip(), createWriteStream(to));
            },
            // ...and then somebody CLOSED it. Lose that and the recovery re-opens a bucket its owner shut.
            journalSegments: async () => {
                const f = path.join(root, '000000.jsonl');
                await fsp.writeFile(f, JSON.stringify({ op: 'policy', id: BUCKET, pr: false }) + '\n');
                return [f];
            },
            writeContainer: async r => { written.push(r); },
            writeObject: async () => undefined
        });

        await restore.run({ objectId: 'x', md5: 'x', startedAt: 'T', completedAt: 'T', objects: 0 }, { apply: true });

        expect(written).toHaveLength(1);
        expect(written[0]).toMatchObject({ id: BUCKET, pr: false });
    });
});


// ROUND THREE. The geometry vote written to fix round two had two ways of announcing that a lost object had
// been recovered, which is the single worst sentence this code could utter.
describe('recovery: quorum is counted in slices that actually decode', () => {
    let root: string;
    beforeEach(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-quorum-')); });
    afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

    const ID = '6a546c1e7b1e7a6144152e6b';
    const sliceAt = (vol: number, i: number) =>
        path.join(root, `vol${vol}`, 'strubs', '6a', '54', '6c', `${ID}.${i}`);
    const mountOf = (v: number) => path.join(root, `vol${v}`);
    const plattersOf = (n: number) =>
        Array.from({ length: n }, (_, v) => ({ volumeId: v, mountPoint: path.join(root, `vol${v}`) }));

    it('reports an uncorroborated geometry as exactly that, not as "1 of the 1 slices it needs"', async () => {
        // `needed` comes from the very header we are refusing to trust, so reporting the shortfall in terms of
        // it describes an object that does not exist -- and sends somebody hunting a bug that is not there.
        await writeSlice(sliceAt(0, 0), { id: ID, size: 100, data: 1, parity: 2, index: 0, chunkSize: 16384 });
        const slots = new Uint16Array(32);
        slots[0] = 1;

        const rebuilt = await synthesiseRecordFromIndex(ID, slots, mountOf, 0);
        expect(rebuilt?.reason).toBe('uncorroborated-geometry');
    });

    it('reports a genuinely below-quorum object as below quorum', async () => {
        for (let i = 0; i < 3; i++)
            await writeSlice(sliceAt(i, i), { id: ID, size: 100, data: 4, parity: 2, index: i, chunkSize: 16384 });
        const slots = new Uint16Array(32);
        for (let i = 0; i < 3; i++) slots[i] = i + 1;

        const rebuilt = await synthesiseRecordFromIndex(ID, slots, mountOf, 0);
        expect(rebuilt?.reason).toBe('below-quorum');
        expect(rebuilt?.found).toBe(3);
        expect(rebuilt?.needed).toBe(4);
    });

    it('does NOT let one rotted header invent a quorum of one', async () => {
        // A 4+2 object down to a single surviving slice -- and that slice's header has rotted `dataSliceCount`
        // from 4 to 1. Left alone it announces that it needs one slice, observes that it has one slice, and
        // reports itself fully recoverable. The restore would write the record; the object is GONE.
        await writeSlice(sliceAt(0, 0), { id: ID, size: 100, data: 1, parity: 2, index: 0, chunkSize: 16384 });

        const slots = new Uint16Array(32);
        slots[0] = 1;

        const rebuilt = await synthesiseRecordFromIndex(ID, slots, mountOf, 0);

        // It may be DESCRIBED -- we have a header, and saying "below quorum" is more use than "undescribable".
        // It may not be called recoverable. One header corroborates nothing, least of all itself.
        expect(rebuilt?.recoverable).toBe(false);
        expect(rebuilt?.found).toBe(1);
    });

    it('counts only the slices that agree with the winning shape, not the filenames', async () => {
        // Six files on six disks. Three headers agree on the truth, two agree on a corrupt shape, one is
        // unreadable. Counting FILENAMES gives six -- comfortably above quorum -- and reports success for a
        // 4+2 object that has three usable slices and is gone.
        for (let i = 0; i < 6; i++)
            await writeSlice(sliceAt(i, i), { id: ID, size: 100, data: 4, parity: 2, index: i, chunkSize: 16384 });

        for (const i of [3, 4]) {                        // two slices, corrupted to a DIFFERENT shape
            const b = await fsp.readFile(sliceAt(i, i));
            b.writeIntLE(999999, 35, 5);
            await fsp.writeFile(sliceAt(i, i), b);
        }
        const dead = await fsp.readFile(sliceAt(5, 5));   // and one whose magic is gone entirely
        dead.fill(0, 0, 4);
        await fsp.writeFile(sliceAt(5, 5), dead);

        const slots = new Uint16Array(32);
        for (let i = 0; i < 6; i++) slots[i] = i + 1;

        const rebuilt = await synthesiseRecordFromIndex(ID, slots, mountOf, 0);

        expect(rebuilt?.record.size).toBe(100);          // the three honest headers still win the shape...
        expect(rebuilt?.found).toBe(3);                  // ...and three is what we have.
        expect(rebuilt?.needed).toBe(4);
        expect(rebuilt?.recoverable).toBe(false);        // three of four. It is below quorum, and it is lost.
    });

    // AND THE OTHER DIRECTION, which matters just as much: do not report loss that is not real.
    it('finds the intact DUPLICATE of a slice that an interrupted rebalance left behind', async () => {
        // The index records one volume per slice index -- the first disk the walk happened to find it on --
        // and throws duplicates away. A relocation that copied a slice and died before unlinking the source
        // leaves two copies, and the index may well have picked the corrupt one. Declaring the object lost
        // while an intact copy of the slice it needs sits on the next disk over is the worst call this code
        // could make.
        for (let i = 0; i < 4; i++)
            await writeSlice(sliceAt(i, i), { id: ID, size: 100, data: 4, parity: 2, index: i, chunkSize: 16384 });

        // Slice 3's indexed copy is ruined -- exactly four slices, no margin, so this sinks the object...
        const b = await fsp.readFile(sliceAt(3, 3));
        b.fill(0, 0, 4);
        await fsp.writeFile(sliceAt(3, 3), b);

        // ...but the relocation's other copy of slice 3 is sitting, perfectly intact, on volume 6.
        await writeSlice(sliceAt(6, 3), { id: ID, size: 100, data: 4, parity: 2, index: 3, chunkSize: 16384 });

        const slots = new Uint16Array(32);
        for (let i = 0; i < 4; i++) slots[i] = i + 1;     // the index only knows about the corrupt copy

        const rebuilt = await synthesiseRecordFromIndex(ID, slots, mountOf, 0, plattersOf(7));

        expect(rebuilt?.found).toBe(4);
        expect(rebuilt?.recoverable).toBe(true);
        // ...and the record points at the disk the good copy is actually ON, or the reader would go back to
        // the corrupt one and the rescue would have been for nothing.
        expect((rebuilt?.record.dataVolumes as number[])[3]).toBe(6);
    });
});


// THE BRACKET HAS TO ENCLOSE EVERY MUTATION, and for one round it enclosed only the second one.
describe('recovery: a fleet restore raises its flag before it touches anything', () => {
    it('marks the restore in progress BEFORE adopting the identity, not after', async () => {
        const order: string[] = [];

        const vol = {
            id: 1, uuid: 'u1', enabled: true, healthy: true, readOnly: false,
            partitionSize: 1, dataSize: 1, paritySize: 1, isDeleted: false, isDraining: false
        };
        const manifest = {
            instanceIdentity: 'i'.repeat(32),
            updatedAt: '2026-07-13T00:00:00Z',
            geometry: { dataSlices: 4, paritySlices: 2 },
            journalVolumeIds: [1],
            volumes: [vol],
            snapshot: null
        };

        await recoverFleetFromDisks({
            findManifests: async () => [{ device: '/dev/sda1', manifest: manifest as never }],
            restoreInterrupted: async () => null,
            existingVolumes: async () => [],
            beginRestore: async () => { order.push('mark'); },
            adoptIdentity: async () => { order.push('identity'); },
            writeVolumes: async () => { order.push('volumes'); }
        });

        // Crash between `identity` and `volumes` with no mark ahead of them, and the next boot has an identity,
        // no marker, and no volume table -- which walks past the "no identity" guard AND the "restore
        // incomplete" guard, and brings the fleet up believing in whatever disks Mongo lists. After a wiped
        // database, that is none of them.
        expect(order).toEqual(['mark', 'identity', 'volumes']);
    });

    // RECOVERING AN ENCRYPTED FLEET, WHICH IS THE ONLY KIND OF RECOVERY ENCRYPTION MAKES HARDER.
    //
    // The passphrase keyslot exists for exactly one day: the OS disk is gone, the keyfile with it, and thirty
    // encrypted disks are still in the rack. If the recovery path cannot USE that passphrase, the keyslot is
    // decoration and the array is scrap.
    describe('with an encrypted fleet', () => {
        const manifest = {
            instanceIdentity: 'i'.repeat(32),
            updatedAt: '2026-07-13T00:00:00Z',
            geometry: { dataSlices: 4, paritySlices: 2 },
            journalVolumeIds: [1],
            volumes: [{
                id: 1, uuid: 'u1', enabled: true, healthy: true, readOnly: false,
                partitionSize: 1, dataSize: 1, paritySize: 1, isDeleted: false, isDraining: false
            }],
            snapshot: null
        };

        const deps = (overrides: Record<string, unknown> = {}) => ({
            findManifests: async () => [
                { device: '/dev/sdf1', manifest: manifest as never },
                { device: '/dev/sdg1', manifest: manifest as never }
            ],
            restoreInterrupted: async () => null,
            existingVolumes: async () => [],
            beginRestore: async () => undefined,
            adoptIdentity: async () => undefined,
            writeVolumes: async () => undefined,
            keyfileReadable: async () => true,
            ...overrides
        });

        // THE TRAP AT THE END OF A RECOVERY. Having got in with the passphrase, every encrypted volume now
        // unlocks only when a human types it -- and `Restart=always` has nobody to ask. The array would come
        // back, serve, and never survive a reboot. So the keyfile goes back into a keyslot on every disk.
        it('puts the keyfile back into a keyslot on every disk it recovered', async () => {
            const ensured: string[] = [];

            const summary = await recoverFleetFromDisks(deps({
                ensureKeyfileSlot: async (partition: string, passphrase: string) => {
                    expect(passphrase).toBe('the fleet recovery passphrase');
                    ensured.push(partition);
                    return 'added' as const;
                }
            }) as never, { recoveryPassphrase: 'the fleet recovery passphrase' });

            expect(ensured).toEqual(['/dev/sdf1', '/dev/sdg1']);
            expect(summary.keyfileRestoredOn).toEqual(['/dev/sdf1', '/dev/sdg1']);
        });

        // A recovery that did not need the passphrase (the keyfile is still here; only Mongo died) must not go
        // rewriting LUKS headers it has no reason to touch.
        it('touches no keyslot when the recovery did not need the passphrase', async () => {
            const ensure = vi.fn();

            const summary = await recoverFleetFromDisks(deps({ ensureKeyfileSlot: ensure }) as never, {});

            expect(ensure).not.toHaveBeenCalled();
            expect(summary.keyfileRestoredOn).toEqual([]);
        });

        // Best-effort, per disk. A slot that could not be restored means that ONE volume needs a hand at the
        // next boot -- it is not a reason to fail a recovery that has otherwise brought the array back.
        it('completes the recovery even if a keyslot cannot be restored', async () => {
            const summary = await recoverFleetFromDisks(deps({
                ensureKeyfileSlot: async (partition: string) => {
                    if (partition === '/dev/sdf1') throw new Error('header is read-only');
                    return 'added' as const;
                }
            }) as never, { recoveryPassphrase: 'the fleet recovery passphrase' });

            expect(summary.volumesRestored).toBe(1);
            expect(summary.keyfileRestoredOn).toEqual(['/dev/sdg1']);
        });

        // ⚠️ NEVER WRITE OUR KEYFILE ONTO SOMEBODY ELSE'S DISK.
        //
        // The scan reports every disk that gave up a manifest, INCLUDING a stranger's array plugged into this
        // host -- that is why reconcileManifests keeps a `foreign` list at all. Handing all of them to the
        // keyslot restorer would add THIS host's keyfile to ANOTHER array's LUKS header, provided the
        // operator's passphrase happened to open it: writing to a disk we have just finished establishing is
        // not ours, in the one tool whose entire promise is that it does not touch what it has not identified.
        it('does not touch a keyslot on a FOREIGN array\'s disk', async () => {
            const foreign = {
                ...manifest,
                instanceIdentity: 'f'.repeat(32)   // somebody else's array, plugged into this host
            };
            const ensured: string[] = [];

            const summary = await recoverFleetFromDisks(deps({
                findManifests: async () => [
                    { device: '/dev/sdf1', manifest: manifest as never },
                    { device: '/dev/sdg1', manifest: manifest as never },
                    { device: '/dev/sdz1', manifest: foreign as never }      // <- not ours
                ],
                ensureKeyfileSlot: async (partition: string) => {
                    ensured.push(partition);
                    return 'added' as const;
                }
            }) as never, { recoveryPassphrase: 'the fleet recovery passphrase' });

            expect(ensured).toEqual(['/dev/sdf1', '/dev/sdg1']);
            expect(ensured).not.toContain('/dev/sdz1');
            expect(summary.keyfileRestoredOn).not.toContain('/dev/sdz1');
        });

        // No keyfile on the host to put back. Say so loudly rather than reporting a restored keyslot that does
        // not exist.
        it('does not claim to have restored a keyfile it does not have', async () => {
            const ensure = vi.fn();

            const summary = await recoverFleetFromDisks(deps({
                keyfileReadable: async () => false,
                ensureKeyfileSlot: ensure
            }) as never, { recoveryPassphrase: 'the fleet recovery passphrase' });

            expect(ensure).not.toHaveBeenCalled();
            expect(summary.keyfileRestoredOn).toEqual([]);
        });
    });
});


// A DISK THAT WILL NOT ANSWER IS NOT A DISK THAT IS EMPTY.
//
// This is the same mistake as the header checksum, as the empty platter list, as the swallowed EIO in
// locateSlices -- the fourth costume it has worn. A failure to LOOK is being reported as a fact about the
// DATA, and the fact it reports is "your files are gone". It is the only bug in this module that produces a
// notification titled "real, irreversible data loss" about an array that has lost nothing.
describe('recovery: a disk that will not answer is not data loss', () => {
    let root: string;
    beforeEach(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-eio-')); });
    afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

    // A slice file the disk will not hand over. The tests run as root, so chmod proves nothing -- root walks
    // straight through it. EISDIR does the job honestly: the path EXISTS, and open() fails with something that
    // is not ENOENT, which is exactly the shape of an EIO from a dying drive.
    const willNotOpen = async (file: string) => {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.rm(file, { force: true });
        await fsp.mkdir(file);
    };

    const ID = '6a546c1e7b1e7a6144152e6b';
    const dirOf = (v: number) => path.join(root, `vol${v}`, 'strubs', '6a', '54', '6c');
    const mountOf = (v: number) => path.join(root, `vol${v}`);

    it('reports an object as INDETERMINATE, not below quorum, when disks will not hand over its slices', async () => {
        // A healthy 4+2 object. Then three of its six disks stop answering -- which leaves three readable
        // slices, one short of the four it needs. The naive read of that is "below quorum: irreversible data
        // loss", and it would be a lie: the slices are RIGHT THERE, on drives that need re-seating.
        for (let i = 0; i < 6; i++)
            await writeSlice(path.join(dirOf(i), `${ID}.${i}`),
                { id: ID, size: 100, data: 4, parity: 2, index: i, chunkSize: 16384 });

        const slots = new Uint16Array(32);
        for (let i = 0; i < 6; i++) slots[i] = i + 1;

        for (const v of [3, 4, 5]) await willNotOpen(path.join(dirOf(v), `${ID}.${v}`));

        const rebuilt = await synthesiseRecordFromIndex(ID, slots, mountOf, 0);

        expect(rebuilt?.reason).toBe('indeterminate');
        expect(rebuilt?.unknown).toBe(3);
        expect(rebuilt?.recoverable).toBe(false);   // we cannot claim it IS fine either -- we did not look
    });

    it('does not call an object lost when NOT ONE of its slices could be read', async () => {
        // Every slice is on a disk that will not answer. There is no header, so the object cannot be DESCRIBED
        // -- and the early "no readable header, give up" return sent that downstream as "no slices anywhere",
        // which the drift scrub escalates as irreversible loss and the restore acts on by discarding the name.
        // The whole indeterminate verdict was useless because the function bailed out in front of it.
        for (let i = 0; i < 6; i++)
            await writeSlice(path.join(dirOf(i), `${ID}.${i}`),
                { id: ID, size: 100, data: 4, parity: 2, index: i, chunkSize: 16384 });

        const slots = new Uint16Array(32);
        for (let i = 0; i < 6; i++) slots[i] = i + 1;
        for (let v = 0; v < 6; v++) await willNotOpen(path.join(dirOf(v), `${ID}.${v}`));

        const rebuilt = await synthesiseRecordFromIndex(ID, slots, mountOf, 0);

        expect(rebuilt).not.toBeNull();
        expect(rebuilt?.reason).toBe('indeterminate');
        expect(rebuilt?.unknown).toBe(6);
        expect(rebuilt?.record).toBeNull();      // nothing readable to describe it WITH -- yet
    });

    it('keeps the name of an unreadable object as a record the reader can actually OPEN', async () => {
        // Keeping a name is the whole point -- throwing one away is irreversible. But a record with no
        // dataVolumes is not a kept name, it is a booby trap: file-object.ts dereferences record.dataVolumes
        // the instant anybody opens the object. The index still knows which DISKS the slices are on; it just
        // could not read their headers. That plus the array's known geometry is enough to write an honest one.
        for (let i = 0; i < 6; i++)
            await writeSlice(path.join(dirOf(i), `${ID}.${i}`),
                { id: ID, size: 100, data: 4, parity: 2, index: i, chunkSize: 16384 });

        const slots = new Uint16Array(32);
        for (let i = 0; i < 6; i++) slots[i] = i + 1;
        for (let v = 0; v < 6; v++) await willNotOpen(path.join(dirOf(v), `${ID}.${v}`));

        const rebuilt = await synthesiseRecordFromIndex(ID, slots, mountOf, 0, undefined,
            { dataSlices: 4, paritySlices: 2 });

        expect(rebuilt?.reason).toBe('indeterminate');
        expect(rebuilt?.record?.dataVolumes).toEqual([0, 1, 2, 3]);
        expect(rebuilt?.record?.parityVolumes).toEqual([4, 5]);
    });

    it('does not let a stray unreadable slice inflate an object out of below-quorum', async () => {
        // A `.7` next to a 4+2 object is not a seventh slice, it is somebody's mistake. If it happens to be
        // unreadable, counting it as "unknown" would push a genuinely lost object over the bar and report it as
        // merely indeterminate -- the comforting lie, which is the worse one, because nobody goes looking for a
        // backup when they have been told their data is probably fine.
        for (const i of [0, 1])
            await writeSlice(path.join(dirOf(i), `${ID}.${i}`),
                { id: ID, size: 100, data: 4, parity: 2, index: i, chunkSize: 16384 });

        // Two stray slice indexes outside the 4+2 geometry, both unreadable.
        for (const i of [7, 8]) await willNotOpen(path.join(dirOf(2), `${ID}.${i}`));

        const slots = new Uint16Array(32);
        slots[0] = 1; slots[1] = 2; slots[7] = 3; slots[8] = 3;

        const rebuilt = await synthesiseRecordFromIndex(ID, slots, mountOf, 0);

        expect(rebuilt?.unknown).toBe(0);            // neither stray is a slice of this object
        expect(rebuilt?.reason).toBe('below-quorum'); // two of four. It is gone, and we say so.
    });

    it('does not keep the name of an object the unreadable disks could never have saved', async () => {
        // ONE unreadable slice and nothing else. Even if that disk came back and the slice were perfect, that
        // is one of the four a 4+2 object needs. It is not "unknown", it is GONE -- and calling it
        // indeterminate would keep a name alive for data that cannot be reconstructed under any outcome, and
        // show the operator "fix the disk" where they should be seeing "this one is lost".
        await willNotOpen(path.join(dirOf(0), `${ID}.0`));

        const slots = new Uint16Array(32);
        slots[0] = 1;

        const rebuilt = await synthesiseRecordFromIndex(ID, slots, mountOf, 0, undefined,
            { dataSlices: 4, paritySlices: 2 });

        expect(rebuilt).toBeNull();
    });

    it('still calls it LOST when the unreadable disks could not have saved it anyway', async () => {
        // Two readable slices, one unreadable, three simply absent. Even if the unreadable one is perfect,
        // that is three of the four it needs. This object is GONE, and calling it "indeterminate" would be its
        // own kind of dishonesty -- a comforting one, which is worse, because nobody goes looking for a backup.
        for (const i of [0, 1, 2])
            await writeSlice(path.join(dirOf(i), `${ID}.${i}`),
                { id: ID, size: 100, data: 4, parity: 2, index: i, chunkSize: 16384 });

        const slots = new Uint16Array(32);
        slots[0] = 1; slots[1] = 2; slots[2] = 3;

        await willNotOpen(path.join(dirOf(2), `${ID}.2`));

        const rebuilt = await synthesiseRecordFromIndex(ID, slots, mountOf, 0);
        expect(rebuilt?.found).toBe(2);
        expect(rebuilt?.unknown).toBe(1);
        expect(rebuilt?.reason).toBe('below-quorum');
    });
});


// THE FIVE GAPS THE REVIEW LOOP LEFT OPEN, closed. Each of these is a way for a recovery to do the wrong thing
// and report that it did the right one.
describe('recovery: closing the last gaps', () => {
    const vol = (id: number) => ({
        id, uuid: `u${id}`, enabled: true, healthy: true, readOnly: false,
        partitionSize: 1, dataSize: 1, paritySize: 1, isDeleted: false, isDraining: false
    });
    const manifestFor = (identity: string, volumes: number[]) => ({
        instanceIdentity: identity,
        updatedAt: '2026-07-13T00:00:00Z',
        geometry: { dataSlices: 4, paritySlices: 2 },
        journalVolumeIds: [1],
        volumes: volumes.map(vol),
        snapshot: null
    });

    // FORCE MAY SAY "THOSE DEAD DISKS DON'T GET A VOTE". IT MAY NOT SAY "AND A STRANGER'S DISK MAY BECOME US".
    it('will NOT let force adopt a foreign array, however hard it is forced', () => {
        // One disk of ours, one from somebody else's array, nothing silent. There is no majority, and forcing
        // is not the answer: adopting the wrong IDENTITY does not give a degraded recovery, it gives you
        // somebody else's array -- every disk of yours becomes foreign to it, the volume table is a stranger's,
        // and the snapshot pointer names an object that is not on these platters.
        const found = [
            { device: '/dev/sda1', manifest: manifestFor('a'.repeat(32), [1]) as never },
            { device: '/dev/sdb1', manifest: manifestFor('b'.repeat(32), [9]) as never }
        ];

        expect(() => reconcileManifests(found, false)).toThrow(/majority/);
        expect(() => reconcileManifests(found, true)).toThrow(/NOT forceable/);
    });

    it('DOES let force past disks that would not answer, because in a real disaster they are dead', () => {
        // Two of ours answered; five disks are silent. Not a majority of seven -- and an operator who knows
        // those five are in a skip is allowed to say so. The identity is not in doubt; only how much of the
        // array we can see.
        const found = Object.assign([
            { device: '/dev/sda1', manifest: manifestFor('a'.repeat(32), [1, 2]) as never },
            { device: '/dev/sdb1', manifest: manifestFor('a'.repeat(32), [1, 2]) as never }
        ], { silent: ['/dev/sdc1', '/dev/sdd1', '/dev/sde1', '/dev/sdf1', '/dev/sdg1'] });

        expect(() => reconcileManifests(found as never, false)).toThrow(/would not give up a manifest/);
        expect(() => reconcileManifests(found as never, true)).not.toThrow();
    });

    // A RESTORE THAT CANNOT RESUME IS A RESTORE THAT STRANDS YOU.
    it('RESUMES a namespace restore that died after writing its first container', async () => {
        // Containers are written before objects, so a crash after the very first one leaves a database that is
        // no longer empty -- and the guard that protects a LIVE namespace would then refuse to let the restore
        // finish what it started. The operator is left with a namespace 0.001% rebuilt and the only tool that
        // could finish it declining to touch it.
        const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-resume-'));
        try {
            const restore = new NamespaceRestore({
            pruneOutsideNamespace: async () => 0,
            journalLocationUncertain: () => false,
            namespaceRestorePending: async () => null,
                objectsInDatabase: async () => 1,              // NOT empty: the wreckage of the last attempt
                restoreInFlight: async () => ({ startedAt: '2026-07-13T00:00:00Z' }),   // ...and it was ours
                beginRestore: async () => undefined,
                endRestore: async () => undefined,
                namespaceRestored: async () => undefined,
                fleetRestoreIncomplete: async () => null,
                fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
                platters: () => [{ volumeId: 0, mountPoint: path.join(root, 'vol0') }],
                fetchSnapshot: async (_i, to) => {
                    const lines = [JSON.stringify({ op: 'end', containers: 0, objects: 0,
                        sha256: createHash('sha256').digest('hex') }) + '\n'];
                    await pipeline(Readable.from(lines), createGzip(), createWriteStream(to));
                },
                journalSegments: async () => [],
                writeContainer: async () => undefined,
                writeObject: async () => undefined
            });

            // It does NOT refuse. It picks up where it left off.
            const summary = await restore.run(
                { objectId: 'x', md5: 'x', startedAt: 'T', completedAt: 'T', objects: 0 }, { apply: true });
            expect(summary.objectsRestored).toBe(0);
        }
        finally { await fsp.rm(root, { recursive: true, force: true }); }
    });

    // A SAFETY NET YOU CANNOT CLIMB OUT OF IS A TRAP.
    //
    // The two markers are cleared one after the other, and a process can die in between. Clear the in-flight
    // one, die before clearing the required one, and the array comes back in recovery mode with a
    // restored-but-non-empty database and no resume marker -- so the next restore hits the live-DB guard and
    // refuses to finish. Stranded, by the very bracketing that was meant to prevent it.
    it('still RESUMES when the in-flight marker was cleared but the namespace is still marked required', async () => {
        const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-halfclear-'));
        try {
            const restore = new NamespaceRestore({
            pruneOutsideNamespace: async () => 0,
            journalLocationUncertain: () => false,
                objectsInDatabase: async () => 3_000_000,        // a fully restored DB -- and NOT a live one
                restoreInFlight: async () => null,               // this marker was already cleared...
                namespaceRestorePending: async () => ({ startedAt: 'T' }),   // ...but this one says: not live
                beginRestore: async () => undefined,
                endRestore: async () => undefined,
                namespaceRestored: async () => undefined,
                fleetRestoreIncomplete: async () => null,
                fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
                platters: () => [{ volumeId: 0, mountPoint: path.join(root, 'vol0') }],
                fetchSnapshot: async (_i, to) => {
                    const lines = [JSON.stringify({ op: 'end', containers: 0, objects: 0,
                        sha256: createHash('sha256').digest('hex') }) + '\n'];
                    await pipeline(Readable.from(lines), createGzip(), createWriteStream(to));
                },
                journalSegments: async () => [],
                writeContainer: async () => undefined,
                writeObject: async () => undefined
            });

            // It does not refuse. `namespace-restore-required` MEANS this database is not authoritative, so a
            // restore into it is a resume, never an overwrite -- and the clear order stops mattering.
            await expect(restore.run(
                { objectId: 'x', md5: 'x', startedAt: 'T', completedAt: 'T', objects: 0 }, { apply: true }))
                .resolves.toBeTruthy();
        }
        finally { await fsp.rm(root, { recursive: true, force: true }); }
    });

    // ONE DEFINITION OF A VALID RECORD, SHARED. When the snapshot and the journal each had their own, a record
    // the journal would have thrown out sailed straight through the snapshot.
    it('rejects a namespace record that parses but has lost its name or its parent', () => {
        expect(isCoherent({ op: 'put', id: 'a', name: 'x.jpg', cid: null, size: 10, cs: 16384 })).toBe(true);
        expect(isCoherent({ op: 'container', id: 'a', name: 'photo', cid: null })).toBe(true);
        expect(isCoherent({ op: 'del', id: 'a' })).toBe(true);

        // No NAME: restored as an object nobody can address.
        expect(isCoherent({ op: 'put', id: 'a', cid: null, size: 10, cs: 16384 })).toBe(false);
        // A PARENT that is not a string: restored into the wrong folder -- or the root of a bucket it was
        // never in, where whoever can read that bucket can now read it. Misfiled is worse than missing.
        expect(isCoherent({ op: 'put', id: 'a', name: 'x', cid: 7, size: 10, cs: 16384 })).toBe(false);
        // No SIZE: a document that faults the instant the reader dereferences it.
        expect(isCoherent({ op: 'put', id: 'a', name: 'x', cid: null, cs: 16384 })).toBe(false);
        // An op nobody understands is not a record.
        expect(isCoherent({ op: 'ddl', id: 'a' })).toBe(false);
        expect(isCoherent({ op: 'container', id: 'a', cid: null })).toBe(false);
    });

    // A CORRUPT BYTE MUST NOT BECOME AN ACCESS-CONTROL DECISION.
    it('rejects a bucket policy whose flags are not actually booleans', () => {
        expect(isCoherent({ op: 'policy', id: 'a', pr: true })).toBe(true);
        expect(isCoherent({ op: 'policy', id: 'a', pw: false })).toBe(true);
        expect(isCoherent({ op: 'policy', id: 'a' })).toBe(true);            // both optional, by design

        // restoreContainer() stores `!!r.pr`, and the STRING "false" is truthy. A malformed record reading
        // `pr: "false"` would restore the bucket as PUBLICLY READABLE -- a corrupt byte failing in the one
        // direction that actually leaks: private becomes public.
        expect(isCoherent({ op: 'policy', id: 'a', pr: 'false' })).toBe(false);
        expect(isCoherent({ op: 'policy', id: 'a', pw: 1 })).toBe(false);
        expect(isCoherent({ op: 'container', id: 'a', name: 'b', cid: null, pr: 'false' })).toBe(false);
    });
});


// A DISK WE COULD NOT VOUCH FOR MUST NEVER BECOME EVIDENCE ABOUT THIS ARRAY.
describe('recovery: mounted is not verified', () => {
    it('REFUSES over a volume that mounted but FAILED its identity check', () => {
        // Volume.start() mounts the filesystem and THEN reads the `.identity` stamp. When that check fails it
        // throws -- without unmounting. So the disk sits there, mounted, rejected, and looking for all the world
        // like one of ours. Reading its slices as ours is how a stranger's data joins your array; counting its
        // silence as our silence is how yours leaves it.
        expect(() => plattersOrRefuse([
            { id: 1, isDeleted: false, isMounted: true, isStarted: true, mountPoint: '/mnt/a' },
            { id: 2, isDeleted: false, isMounted: true, isStarted: false, mountPoint: '/mnt/b' }   // mounted, NOT ours
        ])).toThrow(/volume\(s\) 2 are not/);
    });
});


// A SPARE YOU REFUSE TO REACH FOR IS WORSE THAN NO SPARE AT ALL.
describe('recovery: the previous snapshot exists to be used', () => {
    let root: string;
    beforeEach(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-prev-')); });
    afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

    it('FALLS BACK to the previous snapshot when the current one cannot be reconstructed', async () => {
        // The manifest deliberately keeps the snapshot before the current one. The restore then ignored it --
        // so a below-quorum newest snapshot meant "your namespace is unrecoverable", while an intact copy of
        // every name sat on the platters, named in the very manifest we had just read.
        const asked: string[] = [];
        const written: Record<string, unknown>[] = [];

        const restore = new NamespaceRestore({
            pruneOutsideNamespace: async () => 0,
            journalLocationUncertain: () => false,
            objectsInDatabase: async () => 0,
            restoreInFlight: async () => null,
            namespaceRestorePending: async () => null,
            beginRestore: async () => undefined,
            endRestore: async () => undefined,
            namespaceRestored: async () => undefined,
            fleetRestoreIncomplete: async () => null,
            fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
            platters: () => [{ volumeId: 0, mountPoint: path.join(root, 'vol0') }],
            fetchSnapshot: async (id, to) => {
                asked.push(id);
                // The CURRENT snapshot is below quorum and cannot be rebuilt...
                if (id === 'current') throw new Error('only 3 of the 4 slices it needs');

                // ...but the PREVIOUS one is intact, and it still holds every name.
                const body = [{ op: 'container', id: 'c'.repeat(24), cid: null, name: 'photo' }];
                const h = createHash('sha256');
                const lines = body.map(r => JSON.stringify(r) + '\n');
                for (const l of lines) h.update(l);
                lines.push(JSON.stringify({ op: 'end', containers: 1, objects: 0, sha256: h.digest('hex') }) + '\n');
                await pipeline(Readable.from(lines), createGzip(), createWriteStream(to));
            },
            journalSegments: async () => [],
            writeContainer: async r => { written.push(r); },
            writeObject: async () => undefined
        });

        const summary = await restore.run(
            { objectId: 'current', md5: 'm', startedAt: 'T', completedAt: '2026-07-13T00:00:00Z', objects: 1 },
            { apply: true, previous: { objectId: 'previous', md5: 'm', startedAt: 'T',
                completedAt: '2026-07-12T00:00:00Z', objects: 1 } });

        expect(asked).toEqual(['current', 'previous']);   // it tried the newest first, then reached for the spare
        expect(summary.containers).toBe(1);               // ...and the namespace came back

        // AND IT SAYS SO. A cheerful 200 that hid the fallback would conceal the two things the operator most
        // needs: the namespace is OLDER than the one they asked for, and the current snapshot object is
        // genuinely damaged on the platters -- a fault that is still there tomorrow.
        expect(summary.fellBackToPrevious).toBe(true);
        expect(summary.snapshotUsed).toBe('previous');
        expect(summary.currentSnapshotError).toMatch(/3 of the 4 slices/);
        expect(written).toHaveLength(1);
    });

    it('still fails honestly when there is no previous snapshot to fall back to', async () => {
        const restore = new NamespaceRestore({
            pruneOutsideNamespace: async () => 0,
            journalLocationUncertain: () => false,
            objectsInDatabase: async () => 0,
            restoreInFlight: async () => null,
            namespaceRestorePending: async () => null,
            beginRestore: async () => undefined,
            endRestore: async () => undefined,
            namespaceRestored: async () => undefined,
            fleetRestoreIncomplete: async () => null,
            fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
            platters: () => [{ volumeId: 0, mountPoint: path.join(root, 'vol0') }],
            fetchSnapshot: async () => { throw new Error('only 3 of the 4 slices it needs'); },
            journalSegments: async () => [],
            writeContainer: async () => undefined,
            writeObject: async () => undefined
        });

        await expect(restore.run(
            { objectId: 'current', md5: 'm', startedAt: 'T', completedAt: 'T', objects: 1 }, { apply: true }))
            .rejects.toThrow(/3 of the 4 slices/);
    });
});


// WE DO NOT GUESS WHERE THE JOURNAL IS.
describe('recovery: not knowing where the journal lives is a refusal, not a shrug', () => {
    it('REFUSES to restore when some manifests were unreadable while locating the journal', async () => {
        // The journal is read from the volumes the manifest names, and NOWHERE else. If the manifest that knows
        // the current list was on a disk that would not answer, we read an OLD replica instead -- and because
        // old journal directories are never deleted, that replica is contiguous, gap-free and utterly
        // convincing. The gap check passes. Every name written since the journal moved is dropped, by a restore
        // that reports success and hands back a namespace with a silent hole in it.
        //
        // Nothing downstream can detect that. The only safe move is to refuse.
        const restore = new NamespaceRestore({
            pruneOutsideNamespace: async () => 0,
            objectsInDatabase: async () => 0,
            restoreInFlight: async () => null,
            namespaceRestorePending: async () => null,
            journalLocationUncertain: () => true,          // a manifest would not answer
            beginRestore: async () => undefined,
            endRestore: async () => undefined,
            namespaceRestored: async () => undefined,
            fleetRestoreIncomplete: async () => null,
            fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
            platters: () => [{ volumeId: 0, mountPoint: '/nope' }],
            fetchSnapshot: async () => undefined as never,
            journalSegments: async () => [],
            writeContainer: async () => undefined,
            writeObject: async () => undefined
        });

        await expect(restore.run(
            { objectId: 'x', md5: 'x', startedAt: 'T', completedAt: 'T', objects: 1 }, { apply: false }))
            .rejects.toThrow(/cannot be sure WHERE the namespace journal lives/);
    });
});


// A RESTORE MUST MAKE THE DATABASE *MATCH* THE NAMESPACE, NOT MERELY CONTAIN IT.
describe('recovery: the dead stay dead', () => {
    let root: string;
    beforeEach(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-prune-')); });
    afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

    it('PRUNES rows the rebuilt namespace does not contain', async () => {
        // The restore writes with upserts, which is right -- it has to be idempotent so an interrupted run can
        // be resumed. But upserts only ADD. Run one over a database that already holds rows (a forced
        // overwrite, or the wreckage of an earlier attempt) and every row the new namespace does NOT have just
        // stays -- and the worst of those is an object DELETED before the snapshot. It is absent from the
        // snapshot precisely BECAUSE it was deleted, so nothing overwrites it, and it walks back into the
        // namespace with its name, in its bucket, readable by whoever can read that bucket. Somebody asked for
        // that data to be gone.
        let pruned: Set<string> | null = null;

        const restore = new NamespaceRestore({
            objectsInDatabase: async () => 5,
            restoreInFlight: async () => ({ startedAt: 'T' }),     // resuming our own wreckage
            namespaceRestorePending: async () => null,
            journalLocationUncertain: () => false,
            beginRestore: async () => undefined,
            endRestore: async () => undefined,
            namespaceRestored: async () => undefined,
            fleetRestoreIncomplete: async () => null,
            fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
            platters: () => [{ volumeId: 0, mountPoint: path.join(root, 'vol0') }],
            pruneOutsideNamespace: async keep => { pruned = keep; return 3; },
            fetchSnapshot: async (_i, to) => {
                const body = [{ op: 'container', id: 'c'.repeat(24), cid: null, name: 'photo' }];
                const h = createHash('sha256');
                const lines = body.map(r => JSON.stringify(r) + '\n');
                for (const l of lines) h.update(l);
                lines.push(JSON.stringify({ op: 'end', containers: 1, objects: 0, sha256: h.digest('hex') }) + '\n');
                await pipeline(Readable.from(lines), createGzip(), createWriteStream(to));
            },
            journalSegments: async () => [],
            writeContainer: async () => undefined,
            writeObject: async () => undefined
        });

        const summary = await restore.run(
            { objectId: 'x', md5: 'x', startedAt: 'T', completedAt: 'T', objects: 0 }, { apply: true });

        // It handed the pruner exactly the ids the namespace legitimately has -- and nothing else survives.
        expect(pruned).not.toBeNull();
        expect([...pruned!]).toEqual(['c'.repeat(24)]);
        expect(summary.rowsPruned).toBe(3);
    });

    it('prunes NOTHING on a dry run: looking is not touching', async () => {
        let called = false;
        const restore = new NamespaceRestore({
            objectsInDatabase: async () => 0,
            restoreInFlight: async () => null,
            namespaceRestorePending: async () => null,
            journalLocationUncertain: () => false,
            beginRestore: async () => undefined,
            endRestore: async () => undefined,
            namespaceRestored: async () => undefined,
            fleetRestoreIncomplete: async () => null,
            fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
            platters: () => [{ volumeId: 0, mountPoint: path.join(root, 'vol0') }],
            pruneOutsideNamespace: async () => { called = true; return 0; },
            fetchSnapshot: async (_i, to) => {
                const lines = [JSON.stringify({ op: 'end', containers: 0, objects: 0,
                    sha256: createHash('sha256').digest('hex') }) + '\n'];
                await pipeline(Readable.from(lines), createGzip(), createWriteStream(to));
            },
            journalSegments: async () => [],
            writeContainer: async () => undefined,
            writeObject: async () => undefined
        });

        await restore.run({ objectId: 'x', md5: 'x', startedAt: 'T', completedAt: 'T', objects: 0 },
            { apply: false });

        expect(called).toBe(false);
    });
});


// A FUNERAL AND A BOOKKEEPING ENTRY LOOK IDENTICAL FROM THE PLATTERS. Only the NAME's provenance tells them
// apart -- and I collapsed that distinction twice, once in each direction, before getting it right.
describe('recovery: an abandoned write is not a death, and a death is not bookkeeping', () => {
    let root: string;
    beforeEach(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-prov-')); });
    afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

    const GONE = 'dddddddddddddddddddddddd';

    const runWith = async (opts: { inSnapshot: boolean }) => {
        const rec = { op: 'put', id: GONE, cid: null, name: 'gone.jpg', size: 100, cs: 16384 };

        const restore = new NamespaceRestore({
            objectsInDatabase: async () => 0,
            restoreInFlight: async () => null,
            namespaceRestorePending: async () => null,
            journalLocationUncertain: () => false,
            beginRestore: async () => undefined,
            endRestore: async () => undefined,
            namespaceRestored: async () => undefined,
            fleetRestoreIncomplete: async () => null,
            fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
            platters: () => [{ volumeId: 0, mountPoint: path.join(root, 'vol0') }],
            pruneOutsideNamespace: async () => 0,
            fetchSnapshot: async (_i, to) => {
                const body = opts.inSnapshot ? [rec] : [];
                const h = createHash('sha256');
                const lines = body.map(r => JSON.stringify(r) + '\n');
                for (const l of lines) h.update(l);
                lines.push(JSON.stringify({ op: 'end', containers: 0, objects: body.length,
                    sha256: h.digest('hex') }) + '\n');
                await pipeline(Readable.from(lines), createGzip(), createWriteStream(to));
            },
            journalSegments: async () => {
                if (opts.inSnapshot) return [];
                const f = path.join(root, '000000.jsonl');
                await fsp.writeFile(f, JSON.stringify(rec) + '\n');
                return [f];
            },
            writeContainer: async () => undefined,
            writeObject: async () => undefined
        });

        return restore.run({ objectId: 'x', md5: 'x', startedAt: 'T', completedAt: 'T', objects: 1 },
            { apply: false });
    };

    it('a name that was only ever in the JOURNAL, with no slices, is an ABANDONED WRITE', async () => {
        // Journaled, then the write failed before the slices landed. The client got an error. There never was
        // an object. Filing this as "missing" reports a death that never happened, and sends somebody hunting
        // for a backup of something that never existed.
        const s = await runWith({ inSnapshot: false });
        expect(s.putsDropped).toBe(1);
        expect(s.objectsMissing).toBe(0);
    });

    it('a name that was in the SNAPSHOT, with no slices, is REAL LOSS', async () => {
        // It was in the snapshot, so it existed when the snapshot was taken -- that is what being in it means.
        // Its slices are gone now. Calling that an abandoned write would tell an operator their array is fine
        // while somebody's data is actually gone. Of the two lies this is the worse one: it lets the loss go
        // unnoticed.
        const s = await runWith({ inSnapshot: true });
        expect(s.objectsMissing).toBe(1);
        expect(s.putsDropped).toBe(0);
    });
});


// A BUCKET THE NAMESPACE SAYS IS PRIVATE MUST NOT COME BACK PUBLIC.
describe('recovery: absent means absent, which means private', () => {
    it('UNSETS a stale public flag rather than merely failing to set it', async () => {
        // Omitting the field from `$set` only fails to SET it. On a forced or resumed restore, over a row that
        // already exists, the OLD value survives -- so a bucket the rebuilt namespace says is private stays
        // PUBLIC, and the restore reports success. A restore's job is to make the database MATCH the namespace,
        // and for an access flag, matching has to include taking it away.
        const ops: unknown[] = [];
        const fake = {
            collection: {
                updateOne: async (_f: unknown, op: unknown) => { ops.push(op); }
            }
        } as never;

        const { ContentRepository } = await import('../lib/database/content-repository');
        const repo = Object.create(ContentRepository.prototype);
        Object.assign(repo, fake);

        // No pr/pw in the restored record: the namespace says this bucket is private.
        await repo.restoreContainer({ id: 'c'.repeat(24), cid: null, name: 'photo', bucketId: null });

        const op = ops[0] as { $set: Record<string, unknown>; $unset?: Record<string, unknown> };
        expect(op.$unset).toEqual({ publicRead: '', publicWrite: '' });

        // ...and when the namespace DOES say public, it is set, and Mongo is never handed an empty $unset.
        ops.length = 0;
        await repo.restoreContainer({ id: 'c'.repeat(24), cid: null, name: 'photo', bucketId: null, pr: true, pw: false });
        const op2 = ops[0] as { $set: Record<string, unknown>; $unset?: Record<string, unknown> };
        expect(op2.$set.publicRead).toBe(true);
        expect(op2.$set.publicWrite).toBe(false);
        expect(op2.$unset).toBeUndefined();
    });
});


// THE ONE OP THE PLATTERS CANNOT ARBITRATE -- MADE SAFE INSTEAD OF DECIDABLE.
describe('recovery: a restore may CLOSE a bucket, never OPEN one', () => {
    let root: string;
    beforeEach(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-pol-')); });
    afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

    const BUCKET = 'c'.repeat(24);

    const run = async (snapshotPublic: boolean, journalled: Record<string, unknown>) => {
        const written: Record<string, unknown>[] = [];
        const seg = path.join(root, '000000.jsonl');
        await fsp.writeFile(seg, JSON.stringify({ op: 'policy', id: BUCKET, ...journalled }) + '\n');

        const restore = new NamespaceRestore({
            objectsInDatabase: async () => 0,
            restoreInFlight: async () => null,
            namespaceRestorePending: async () => null,
            journalLocationUncertain: () => false,
            beginRestore: async () => undefined,
            endRestore: async () => undefined,
            namespaceRestored: async () => undefined,
            fleetRestoreIncomplete: async () => null,
            fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
            platters: () => [{ volumeId: 0, mountPoint: path.join(root, 'vol0') }],
            pruneOutsideNamespace: async () => 0,
            fetchSnapshot: async (_i, to) => {
                const body = [{ op: 'container', id: BUCKET, cid: null, name: 'photos',
                    ...(snapshotPublic ? { pr: true } : {}) }];
                const h = createHash('sha256');
                const lines = body.map(r => JSON.stringify(r) + '\n');
                for (const l of lines) h.update(l);
                lines.push(JSON.stringify({ op: 'end', containers: 1, objects: 0, sha256: h.digest('hex') }) + '\n');
                await pipeline(Readable.from(lines), createGzip(), createWriteStream(to));
            },
            journalSegments: async () => [seg],
            writeContainer: async r => { written.push(r); },
            writeObject: async () => undefined
        });

        const summary = await restore.run(
            { objectId: 'x', md5: 'x', startedAt: 'T', completedAt: 'T', objects: 0 }, { apply: true });
        return { summary, written };
    };

    it('HONOURS a journalled policy that CLOSES a public bucket', async () => {
        // The operator shut a public bucket. That must survive the restore -- and if the record turns out to be
        // an escaped one from a rejected batch, the worst that happens is a bucket is closed that need not be.
        // Somebody notices in a moment and re-opens it.
        const { summary, written } = await run(true, { pr: false });
        expect(written[0]).toMatchObject({ id: BUCKET, pr: false });
        expect(summary.policiesDeclined).toBe(0);
    });

    it('judges each FLAG on its own: applies the close, refuses the open, in the same record', async () => {
        // A record can do both at once. `{ pr: true, pw: false }` OPENS read and CLOSES write. Declining the
        // whole record because half of it opens would throw away the half that CLOSES -- so a bucket whose write
        // access somebody deliberately shut would come back WRITABLE. The rule exists to make failure
        // over-restrictive; applied record-wise it would, in exactly this case, make it over-PERMISSIVE.
        const written: Record<string, unknown>[] = [];
        const seg = path.join(root, '000000.jsonl');
        await fsp.writeFile(seg, JSON.stringify({ op: 'policy', id: BUCKET, pr: true, pw: false }) + '\n');

        const restore = new NamespaceRestore({
            objectsInDatabase: async () => 0,
            restoreInFlight: async () => null,
            namespaceRestorePending: async () => null,
            journalLocationUncertain: () => false,
            beginRestore: async () => undefined,
            endRestore: async () => undefined,
            namespaceRestored: async () => undefined,
            fleetRestoreIncomplete: async () => null,
            fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
            platters: () => [{ volumeId: 0, mountPoint: path.join(root, 'vol0') }],
            pruneOutsideNamespace: async () => 0,
            fetchSnapshot: async (_i, to) => {
                // The snapshot has the bucket publicly WRITABLE and not readable.
                const body = [{ op: 'container', id: BUCKET, cid: null, name: 'photos', pw: true }];
                const h = createHash('sha256');
                const lines = body.map(r => JSON.stringify(r) + '\n');
                for (const l of lines) h.update(l);
                lines.push(JSON.stringify({ op: 'end', containers: 1, objects: 0, sha256: h.digest('hex') }) + '\n');
                await pipeline(Readable.from(lines), createGzip(), createWriteStream(to));
            },
            journalSegments: async () => [seg],
            writeContainer: async r => { written.push(r); },
            writeObject: async () => undefined
        });

        const summary = await restore.run(
            { objectId: 'x', md5: 'x', startedAt: 'T', completedAt: 'T', objects: 0 }, { apply: true });

        expect(written[0].pw).toBe(false);          // the CLOSE was applied
        expect(written[0].pr ?? false).toBe(false); // the OPEN was refused
        expect(summary.policiesDeclined).toBe(1);
    });

    it('IGNORES pr/pw smuggled onto a JOURNAL container record', async () => {
        // The journal has a `policy` op, and the replay puts it through the close-only rule. A `container`
        // record with pr/pw on it walks straight around that -- restoring a brand-new or deliberately closed
        // bucket as PUBLICLY READABLE, without touching the policy branch, without being counted, without a word
        // in the log. Every guard built for the policy op, bypassed by a different op carrying the same two
        // fields.
        //
        // The live writer never puts pr/pw on a journal container record. Only the SNAPSHOT's containers carry
        // policy. So the journal supplies the name and the parent; the policy comes from what the namespace
        // already knew, and nowhere else.
        const written: Record<string, unknown>[] = [];
        const seg = path.join(root, '000000.jsonl');
        await fsp.writeFile(seg,
            JSON.stringify({ op: 'container', id: BUCKET, cid: null, name: 'photos', pr: true, pw: true }) + '\n');

        const restore = new NamespaceRestore({
            objectsInDatabase: async () => 0,
            restoreInFlight: async () => null,
            namespaceRestorePending: async () => null,
            journalLocationUncertain: () => false,
            beginRestore: async () => undefined,
            endRestore: async () => undefined,
            namespaceRestored: async () => undefined,
            fleetRestoreIncomplete: async () => null,
            fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
            platters: () => [{ volumeId: 0, mountPoint: path.join(root, 'vol0') }],
            pruneOutsideNamespace: async () => 0,
            fetchSnapshot: async (_i, to) => {
                const lines = [JSON.stringify({ op: 'end', containers: 0, objects: 0,
                    sha256: createHash('sha256').digest('hex') }) + '\n'];
                await pipeline(Readable.from(lines), createGzip(), createWriteStream(to));
            },
            journalSegments: async () => [seg],
            writeContainer: async r => { written.push(r); },
            writeObject: async () => undefined
        });

        await restore.run({ objectId: 'x', md5: 'x', startedAt: 'T', completedAt: 'T', objects: 0 },
            { apply: true });

        expect(written[0]).toMatchObject({ id: BUCKET, name: 'photos' });
        expect(written[0].pr).toBeUndefined();     // the smuggled flags are gone
        expect(written[0].pw).toBeUndefined();
    });

    it('REFUSES a journalled policy that would OPEN a private bucket', async () => {
        // The journal can hold a record for an operation that never happened: a batch rejected by every replica
        // is rolled back, but "the fsync failed" is not "the bytes are not there", and if the rollback cannot be
        // proven either, the record may survive for a change whose caller was told it FAILED. The two cases are
        // byte-identical; no local rule tells them apart.
        //
        // A `put` or `del` is settled against the platters. A bucket's access flags leave no physical evidence
        // anywhere. So the consequence is made safe instead: an escaped record can only ever over-close. It can
        // never hand the public a bucket somebody deliberately shut.
        const { summary, written } = await run(false, { pr: true });
        expect(written[0].pr ?? false).toBe(false);      // still private
        expect(summary.policiesDeclined).toBe(1);
    });
});
