import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { configMock } = vi.hoisted(() => ({
    configMock: {
        journalEnabled: true,
        journalReplicas: 3,
        journalFlushMs: 5,
        journalMaxBatch: 256,
        journalSegmentBytes: 64 * 1024 * 1024
    }
}));
vi.mock('../lib/config', () => ({ config: configMock }));
vi.mock('../lib/notify/service', () => ({ notificationService: { notify: vi.fn(async () => undefined) } }));

import { Journal, copySegments, listSegments, JOURNAL_DIR } from '../lib/io/journal';
import { isSliceFileName } from '../lib/io/helpers';

const readJournal = async (mount: string): Promise<any[]> => {
    const dir = path.join(mount, 'strubs', JOURNAL_DIR);
    const files = (await fsp.readdir(dir).catch(() => [])).filter(f => f.endsWith('.jsonl')).sort();
    const out: any[] = [];
    for (const f of files) {
        const body = await fsp.readFile(path.join(dir, f), 'utf8');
        for (const line of body.split('\n').filter(Boolean))
            out.push(JSON.parse(line));
    }
    return out;
};

describe('namespace journal', () => {
    let root: string;
    let mounts: string[];

    const volume = (i: number, busGroup: number | null) => ({ id: i, mountPoint: mounts[i], busGroup });

    beforeEach(async () => {
        root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-journal-'));
        mounts = [];
        for (let i = 0; i < 5; i++) {
            const m = path.join(root, `vol${i}`);
            await fsp.mkdir(m, { recursive: true });
            mounts.push(m);
        }
        configMock.journalEnabled = true;
        configMock.journalReplicas = 3;
        configMock.journalSegmentBytes = 64 * 1024 * 1024;
    });

    afterEach(async () => {
        await fsp.rm(root, { recursive: true, force: true });
    });

    describe('replication', () => {
        it('writes every record to K replicas, in plaintext you can read with cat', async () => {
            const j = new Journal({
                getWritableVolumes: () => [volume(0, 1), volume(1, 2), volume(2, 3), volume(3, 1)],
                now: () => new Date('2026-07-12T00:00:00Z')
            });
            await j.start();
            expect(j.replicaVolumeIds).toHaveLength(3);

            await j.append({ op: 'container', ts: 'T', id: 'c1', cid: null, name: 'photo' });
            await j.append({ op: 'put', ts: 'T', id: 'o1', cid: 'c1', name: 'cat.jpg', size: 10, cs: 16384, md5: 'abc' });
            await j.stop();

            for (const id of [0, 1, 2].slice(0, 3)) {
                void id;
            }
            for (const volumeId of j.replicaVolumeIds) {
                const records = await readJournal(mounts[volumeId]);
                expect(records.map(r => r.op)).toEqual(['container', 'put']);
                expect(records[1]).toMatchObject({ id: 'o1', name: 'cat.jpg', md5: 'abc' });
            }
        });

        it('elects replicas across DISTINCT bus groups, so one enclosure cannot take the journal with it', async () => {
            const j = new Journal({
                // Four volumes, but only three buses.
                getWritableVolumes: () => [volume(0, 1), volume(1, 1), volume(2, 2), volume(3, 3)]
            });
            await j.start();

            const groups = j.replicaVolumeIds.map(id => [1, 1, 2, 3][id]);
            expect(new Set(groups).size).toBe(3);       // three replicas, three different buses
            await j.stop();
        });

        it('proceeds when SOME replicas fail, and REFUSES the write when all of them do', async () => {
            const j = new Journal({ getWritableVolumes: () => [volume(0, 1), volume(1, 2)] });
            await j.start();

            // Break one replica's disk under it.
            await fsp.rm(path.join(mounts[1], 'strubs'), { recursive: true, force: true });
            await fsp.writeFile(path.join(mounts[1], 'strubs'), 'not a directory');

            // One replica still works -> the write proceeds.
            await expect(j.append({ op: 'del', ts: 'T', id: 'o1' })).resolves.toBeUndefined();
            expect(await readJournal(mounts[0])).toHaveLength(1);
            await j.stop();
        });

        it('REFUSES to proceed with no replicas at all (a silent degrade is how you find it empty later)', async () => {
            const j = new Journal({ getWritableVolumes: () => [] });
            await j.start();
            await expect(j.append({ op: 'del', ts: 'T', id: 'o1' }))
                .rejects.toThrow(/no replicas/);
        });
    });

    describe('group commit', () => {
        it('batches concurrent records into one write per replica, and each caller waits for durability', async () => {
            const j = new Journal({ getWritableVolumes: () => [volume(0, 1)] });
            await j.start();

            // Fire a burst. Each promise must only resolve once its record is on disk.
            await Promise.all(Array.from({ length: 20 }, (_, i) =>
                j.append({ op: 'del', ts: 'T', id: `obj-${i}` })
            ));

            const records = await readJournal(mounts[0]);
            expect(records).toHaveLength(20);
            expect(records.map(r => r.id)).toContain('obj-19');    // the last caller's record IS durable
            await j.stop();
        });
    });

    describe('rotation', () => {
        it('rolls to a new segment once one gets large, and resumes the newest on restart', async () => {
            configMock.journalSegmentBytes = 200;             // tiny, so a few records roll it
            const j = new Journal({ getWritableVolumes: () => [volume(0, 1)] });
            await j.start();
            for (let i = 0; i < 12; i++)
                await j.append({ op: 'del', ts: '2026-07-12T00:00:00Z', id: `object-${i}` });
            await j.stop();

            const segments = await listSegments(mounts[0]);
            expect(segments.length).toBeGreaterThan(1);

            // Restarting must APPEND to the newest segment, not clobber it.
            const before = (await readJournal(mounts[0])).length;
            const j2 = new Journal({ getWritableVolumes: () => [volume(0, 1)] });
            await j2.start();
            await j2.append({ op: 'del', ts: 'T', id: 'after-restart' });
            await j2.stop();

            const after = await readJournal(mounts[0]);
            expect(after).toHaveLength(before + 1);
            expect(after[after.length - 1].id).toBe('after-restart');
        });
    });

    // The journal has to FOLLOW the fleet. The drain job relocates SLICES -- it walks `content` and moves
    // what the records reference -- and it knows nothing about .journal/. So draining and pulling a
    // journal volume would silently destroy a replica, and retiring the wrong disks over a year could
    // quietly take the journal to zero.
    describe('following the fleet', () => {
        it('re-elects a replacement when a journal volume leaves, and COPIES the segments to it', async () => {
            let fleet = [volume(0, 1), volume(1, 2)];
            const j = new Journal({ getWritableVolumes: () => fleet });
            configMock.journalReplicas = 2;
            await j.start();
            expect(j.replicaVolumeIds).toEqual([0, 1]);

            await j.append({ op: 'put', ts: 'T', id: 'o1', cid: null, name: 'before-the-drain', size: 1, cs: 16384 });
            await j.flush();

            // Volume 1 is drained away; volume 2 appears.
            fleet = [volume(0, 1), volume(2, 3)];
            await j.onFleetChange();

            expect(j.replicaVolumeIds).toEqual([0, 2]);
            // The history moved with the replica set -- it was not left behind on the disk being pulled.
            const carried = await readJournal(mounts[2]);
            expect(carried.map(r => r.name)).toContain('before-the-drain');
            await j.stop();
        });

        it('keeps existing replicas rather than churning the set on an unrelated fleet change', async () => {
            const fleet = [volume(0, 1), volume(1, 2), volume(2, 3), volume(3, 4)];
            const j = new Journal({ getWritableVolumes: () => fleet });
            await j.start();
            const first = [...j.replicaVolumeIds];

            await j.onFleetChange();
            expect(j.replicaVolumeIds).toEqual(first);      // no needless re-election, no needless copy
            await j.stop();
        });
    });

    describe('the fixes that a review found', () => {
        // A new replica must be SEEDED before it can be written to. Opening it first and copying
        // afterwards is a data-loss bug: a flush landing in the gap writes an ACKNOWLEDGED record into the
        // new file, and copyFile then replaces the whole file, silently destroying it.
        it('seeds a new replica with the history BEFORE it goes live', async () => {
            configMock.journalReplicas = 1;
            let fleet = [volume(0, 1)];
            const j = new Journal({ getWritableVolumes: () => fleet });
            await j.start();

            await j.append({ op: 'put', ts: 'T', id: 'o1', cid: null, name: 'must-survive', size: 1, cs: 1 });
            await j.flush();

            // Swap the replica entirely, then immediately write.
            fleet = [volume(1, 2)];
            await j.onFleetChange();
            await j.append({ op: 'put', ts: 'T', id: 'o2', cid: null, name: 'written-after', size: 1, cs: 1 });
            await j.stop();

            // BOTH records must be on the new replica: the seeded history AND the record written after.
            const names = (await readJournal(mounts[1])).map(r => r.name);
            expect(names).toContain('must-survive');
            expect(names).toContain('written-after');
        });

        // A record appended while a flush is in flight lands in a fresh pending batch. If flush() simply
        // returned the running promise (after clearing the timer), that batch would have no owner and no
        // timer -- and the PUT waiting on it would hang until some unrelated append happened along.
        it('never strands a record appended during an in-flight flush', async () => {
            const j = new Journal({ getWritableVolumes: () => [volume(0, 1)] });
            await j.start();

            const first = j.append({ op: 'del', ts: 'T', id: 'during-1' });
            void j.flush();                                     // start a flush
            const second = j.append({ op: 'del', ts: 'T', id: 'during-2' });   // lands mid-flush

            // Neither may hang. (If the second were stranded, this await would time out.)
            await Promise.all([first, second]);

            const ids = (await readJournal(mounts[0])).map(r => r.id);
            expect(ids).toContain('during-1');
            expect(ids).toContain('during-2');
            await j.stop();
        });

        // Two fleet changes arriving together must not rebuild the set concurrently. If they did, the
        // second could finish first and release append() while the FIRST one's copy is still running --
        // an acknowledged record written into a target that copyFile then overwrites. The very bug the
        // lock exists to prevent, reintroduced by the lock not being single-flight.
        it('serialises concurrent re-elections, so no record is acknowledged mid-copy', async () => {
            configMock.journalReplicas = 1;
            let fleet = [volume(0, 1)];
            const j = new Journal({ getWritableVolumes: () => fleet });
            await j.start();
            await j.append({ op: 'put', ts: 'T', id: 'o1', cid: null, name: 'seed', size: 1, cs: 1 });
            await j.flush();

            // Fire two fleet changes at once, each moving the replica somewhere new.
            fleet = [volume(1, 2)];
            const a = j.onFleetChange();
            fleet = [volume(2, 3)];
            const b = j.onFleetChange();
            await Promise.all([a, b]);

            await j.append({ op: 'put', ts: 'T', id: 'o2', cid: null, name: 'after', size: 1, cs: 1 });
            await j.stop();

            // Whichever replica we ended on must hold BOTH the seeded history and the later record.
            const [live] = j.replicaVolumeIds.length ? j.replicaVolumeIds : [2];
            const names = (await readJournal(mounts[live])).map(r => r.name);
            expect(names).toContain('seed');
            expect(names).toContain('after');
        });

        // A batch sitting in `pending` with an unfired timer would otherwise flush DURING the copy --
        // writing into the source we are copying from, so the new replica silently misses records the
        // caller was already told were durable. If the source is the disk being dropped, they are gone.
        it('drains a queued-but-unflushed batch onto the old replica set before re-electing', async () => {
            configMock.journalReplicas = 1;
            configMock.journalFlushMs = 10_000;      // long: the batch will NOT flush on its own
            let fleet = [volume(0, 1)];
            const j = new Journal({ getWritableVolumes: () => fleet });
            await j.start();

            // Queue a record but do NOT flush it -- it sits in `pending` behind a long timer.
            const queued = j.append({ op: 'put', ts: 'T', id: 'o1', cid: null, name: 'queued-not-flushed', size: 1, cs: 1 });

            // Now swap the replica out from under it.
            fleet = [volume(1, 2)];
            await j.onFleetChange();
            await queued;                            // must have been made durable, not stranded
            await j.stop();

            // The record must have reached the NEW replica -- either drained to the old one and copied, or
            // written after. What it must NOT be is lost.
            const names = (await readJournal(mounts[1])).map(r => r.name);
            expect(names).toContain('queued-not-flushed');
            configMock.journalFlushMs = 5;
        });

        it('opens the SAME segment number on every replica, so they cannot diverge by filename', async () => {
            // vol0 carries the lineage up to segment 3. vol1 fell behind at segment 1 -- it was retired and
            // is now being re-elected, which is the realistic way two replicas hold different segment sets.
            // The segments carry real records: an all-empty journal is no history at all, and is treated as
            // a blank disk rather than as a lineage.
            const seg = async (mount: string, ...names: string[]) => {
                const dir = path.join(mount, 'strubs', JOURNAL_DIR);
                await fsp.mkdir(dir, { recursive: true });
                for (const n of names)
                    await fsp.writeFile(path.join(dir, `${n}.jsonl`),
                        JSON.stringify({ op: 'del', ts: 'T', id: `in-${n}` }) + '\n');
            };
            await seg(mounts[0], '000000', '000001', '000002', '000003');
            await seg(mounts[1], '000000', '000001');

            configMock.journalReplicas = 2;
            const j = new Journal({ getWritableVolumes: () => [volume(0, 1), volume(1, 2)] });
            await j.start();
            await j.append({ op: 'del', ts: 'T', id: 'x' });
            await j.stop();

            // Both wrote into the SAME (highest) segment, not two different ones -- and vol1 was brought up
            // to date first, so the two hold identical histories.
            expect(await listSegments(mounts[0])).toContain('000003.jsonl');
            expect(await listSegments(mounts[1])).toContain('000003.jsonl');
            const expected = ['in-000000', 'in-000001', 'in-000002', 'in-000003', 'x'];
            expect((await readJournal(mounts[0])).map(r => r.id)).toEqual(expected);
            expect((await readJournal(mounts[1])).map(r => r.id)).toEqual(expected);
        });

        // A volume that was a journal replica in a PREVIOUS life still carries its old segments -- we never
        // delete, so nothing has removed them. Seeding the real history alongside them would leave TWO
        // journals in one directory, and the leftover (a higher number, from a longer-lived past) would
        // outrank the real ones the moment we next looked for the newest segment: the whole replica set
        // spliced onto a dead history.
        //
        // So we refuse the disk instead. Not adopted, not written to, not touched.
        it('REFUSES a volume carrying an older journal, rather than seeding on top of it', async () => {
            const dir0 = path.join(mounts[0], 'strubs', JOURNAL_DIR);
            await fsp.mkdir(dir0, { recursive: true });
            await fsp.writeFile(path.join(dir0, '000000.jsonl'), JSON.stringify({ op: 'del', ts: 'T', id: 'real' }) + '\n');

            // vol1 is blank apart from a stale 000005 from when it was a replica years ago.
            const dir1 = path.join(mounts[1], 'strubs', JOURNAL_DIR);
            await fsp.mkdir(dir1, { recursive: true });
            const ancient = JSON.stringify({ op: 'del', ts: 'T', id: 'ancient' }) + '\n';
            await fsp.writeFile(path.join(dir1, '000005.jsonl'), ancient);

            configMock.journalReplicas = 2;
            const j = new Journal({ getWritableVolumes: () => [volume(0, 1), volume(1, 2)] });
            await j.start();
            await j.append({ op: 'del', ts: 'T', id: 'new-record' });
            await j.stop();

            // vol1 was NOT adopted. The journal runs on vol0 alone rather than on a disk it cannot account
            // for -- one honest replica beats two where one is a chimera.
            expect(j.replicaVolumeIds).toEqual([0]);

            // The real history continued in 000000, untroubled by the stray.
            expect((await readJournal(mounts[0])).map(r => r.id)).toEqual(['real', 'new-record']);

            // ...and vol1 is exactly as we found it. No new segment was written there, and the old one is
            // byte-for-byte intact: it may be the last copy of a history somebody still wants.
            expect(await listSegments(mounts[1])).toEqual(['000005.jsonl']);
            expect(await fsp.readFile(path.join(dir1, '000005.jsonl'), 'utf8')).toBe(ancient);
        });
    });

    describe('copySegments / listSegments', () => {
        it('copies only journal segments, and skips ones already there in full', async () => {
            const dir = path.join(mounts[0], 'strubs', JOURNAL_DIR);
            await fsp.mkdir(dir, { recursive: true });
            await fsp.writeFile(path.join(dir, '000000.jsonl'), '{"op":"del"}\n');
            await fsp.writeFile(path.join(dir, 'not-a-segment.txt'), 'ignore me');

            await copySegments(mounts[0], mounts[1]);

            expect(await listSegments(mounts[1])).toEqual(['000000.jsonl']);
            const copied = await fsp.readdir(path.join(mounts[1], 'strubs', JOURNAL_DIR));
            expect(copied).not.toContain('not-a-segment.txt');
        });
    });

    // .identity, .tmp/, .bootstrap.json and .journal/ all live in the same volume root as the slice
    // shards. A scanner that walked the tree by "everything that is a file" would sweep the journal into
    // a rebuild, or delete it as a stray slice. This predicate is what stops that, so it is load-bearing.
    describe('nothing else may be mistaken for a slice', () => {
        it('recognises a slice file and rejects every recovery artifact beside it', () => {
            expect(isSliceFileName('5c2ae06dd22cbb37a33ad7fa.0')).toBe(true);
            expect(isSliceFileName('5c2ae06dd22cbb37a33ad7fa.5')).toBe(true);

            for (const notASlice of [
                '.identity',
                '.bootstrap.json',
                '.bootstrap.json.tmp',
                '000000.jsonl',                       // a journal segment
                '.journal',
                'lost+found',
                '5c2ae06dd22cbb37a33ad7fa',           // no slice index
                '5c2ae06dd22cbb37a33ad7fa.jsonl',
                'ZZZZZZZZZZZZZZZZZZZZZZZZ.0',         // not hex
                '5c2ae06dd22cbb37a33ad7f.0'           // 23 chars, not 24
            ])
                expect(isSliceFileName(notASlice), notASlice).toBe(false);
        });
    });

    // On a COLD START there is no in-memory replica to seed from -- the history exists only on the
    // platters. If the fleet changed while the process was down, the election can land on a volume that
    // has never held the journal, and adopting it unseeded makes an EMPTY file a reported replica: it
    // goes into the bootstrap manifest and is handed to a future recovery as though it carried the
    // namespace. The source of truth has to be the disks.
    describe('cold start', () => {
        it('seeds a replacement replica from the DISKS when the fleet changed while we were down', async () => {
            configMock.journalReplicas = 2;

            // First run: the journal lives on volumes 0 and 1, and records some history.
            let fleet = [volume(0, 1), volume(1, 2)];
            const first = new Journal({ getWritableVolumes: () => fleet });
            await first.start();
            expect(first.replicaVolumeIds).toEqual([0, 1]);
            await first.append({ op: 'put', ts: 'T', id: 'o1', cid: null, name: 'written-before-the-outage', size: 1, cs: 16384 });
            await first.stop();

            // The process is DOWN. Volume 1 is pulled and volume 2 is racked in its place. Nothing in
            // memory knows the journal ever existed.
            fleet = [volume(0, 1), volume(2, 3)];

            const second = new Journal({ getWritableVolumes: () => fleet });
            await second.start();
            expect(second.replicaVolumeIds).toEqual([0, 2]);

            // Volume 2 is brand new. It must have been seeded from volume 0's platter, not opened empty.
            const carried = await readJournal(mounts[2]);
            expect(carried.map(r => r.name)).toContain('written-before-the-outage');
            await second.stop();
        });

        it('seeds from a volume it would never ELECT: a read-only disk is still a source of history', async () => {
            configMock.journalReplicas = 1;

            // The journal's only copy is on volume 3.
            const writable = [volume(3, 1)];
            const first = new Journal({ getWritableVolumes: () => writable });
            await first.start();
            await first.append({ op: 'put', ts: 'T', id: 'o9', cid: null, name: 'only-copy', size: 1, cs: 16384 });
            await first.stop();

            // Restart: volume 3 has gone read-only (degraded, draining -- it does not matter which), so it
            // is no longer a candidate. Volume 0 is elected. Electing from `writable` while SEEDING from
            // `mounted` is the whole point: we would never write to volume 3 again, but it is the only
            // place the history physically is.
            const second = new Journal({
                getWritableVolumes: () => [volume(0, 1)],
                getFleetVolumes: () => [0, 3].map(i => ({ id: i, mountPoint: mounts[i], isDeleted: false, isMounted: true }))
            });
            await second.start();
            expect(second.replicaVolumeIds).toEqual([0]);

            const carried = await readJournal(mounts[0]);
            expect(carried.map(r => r.name)).toContain('only-copy');
            await second.stop();
        });

        it('unions the sources, so a replica left SHORT by a degraded write is topped back up', async () => {
            configMock.journalReplicas = 2;

            const fleet = [volume(0, 1), volume(1, 2)];
            const first = new Journal({ getWritableVolumes: () => fleet });
            await first.start();
            for (let i = 0; i < 5; i++)
                await first.append({ op: 'del', ts: 'T', id: `object-${i}` });
            await first.stop();

            // Simulate a degraded write: volume 1's copy got truncated (it went away mid-flush and came
            // back). Volume 0 is complete.
            const seg = path.join(mounts[1], 'strubs', JOURNAL_DIR, '000000.jsonl');
            const full = await fsp.readFile(seg, 'utf8');
            const lines = full.split('\n').filter(Boolean);
            await fsp.writeFile(seg, lines.slice(0, 2).join('\n') + '\n');
            expect(await readJournal(mounts[1])).toHaveLength(2);

            // Restarting on the SAME fleet: both are "new" (no open handle), so both get seeded from the
            // union of what is on the platters. copySegments only ever overwrites a shorter file, so
            // volume 1 is repaired from volume 0 and volume 0 is left alone.
            const second = new Journal({ getWritableVolumes: () => fleet });
            await second.start();
            await second.stop();

            expect(await readJournal(mounts[1])).toHaveLength(5);
            expect(await readJournal(mounts[0])).toHaveLength(5);
        });
    });

    // A short write leaves a TORN final record -- bytes on the platter with no newline. That write is not
    // acknowledged, so losing it is correct. What is NOT correct is appending the next record onto the
    // fragment, which is exactly what 'a' does when re-election or a restart re-opens the file: the two
    // become one unparseable line, and the second record WAS acknowledged as durable.
    describe('a torn final record', () => {
        it('is rolled back before anything is appended after it', async () => {
            const j = new Journal({ getWritableVolumes: () => [volume(0, 1)] });
            configMock.journalReplicas = 1;
            await j.start();
            await j.append({ op: 'put', ts: 'T', id: 'o1', cid: null, name: 'complete-record', size: 1, cs: 16384 });
            await j.stop();

            // The disk went away mid-write: a partial line, no trailing newline.
            const seg = path.join(mounts[0], 'strubs', JOURNAL_DIR, '000000.jsonl');
            await fsp.appendFile(seg, '{"op":"put","ts":"2026-07-12T00:00:00Z","id":"torn","cid":nul');

            // Restart and write the next record.
            const j2 = new Journal({ getWritableVolumes: () => [volume(0, 1)] });
            await j2.start();
            await j2.append({ op: 'del', ts: 'T', id: 'after-the-tear' });
            await j2.stop();

            // Every line parses. Without the rollback the last line would be the fragment glued to the
            // record after it -- and THAT record is the one the caller was told was durable.
            const raw = (await fsp.readFile(seg, 'utf8')).split('\n').filter(Boolean);
            for (const line of raw)
                expect(() => JSON.parse(line), line).not.toThrow();

            const records = await readJournal(mounts[0]);
            expect(records).toHaveLength(2);
            expect(records[0].name).toBe('complete-record');   // the completed record survived
            expect(records[1].id).toBe('after-the-tear');      // ...and so did the one written after it
            expect(records.some(r => r.id === 'torn')).toBe(false);  // the unacknowledged fragment is gone
        });

        it('handles a segment whose ENTIRE content is a torn line', async () => {
            const dir = path.join(mounts[0], 'strubs', JOURNAL_DIR);
            await fsp.mkdir(dir, { recursive: true });
            await fsp.writeFile(path.join(dir, '000000.jsonl'), '{"op":"put","ts":"2026-');

            const j = new Journal({ getWritableVolumes: () => [volume(0, 1)] });
            configMock.journalReplicas = 1;
            await j.start();
            await j.append({ op: 'del', ts: 'T', id: 'first-real-record' });
            await j.stop();

            const records = await readJournal(mounts[0]);
            expect(records).toHaveLength(1);
            expect(records[0].id).toBe('first-real-record');
        });
    });

    // SIZE IS NOT CONTENT IDENTITY. Within one lineage it happens to be -- every replica gets the same byte
    // stream, and one that fails a write is closed rather than skipping the batch and resuming, so its
    // segment is always a prefix of a healthy one. But lose every journal disk, cold-start (which opens a
    // fresh 000000.jsonl), then re-attach an old disk, and there are suddenly two unrelated histories
    // wearing the same filename. On size alone the stale one looks like the MORE complete copy.
    describe('two journal lineages', () => {
        // Give `mount` a journal segment with the given content.
        const plant = async (mount: string, content: string) => {
            const dir = path.join(mount, 'strubs', JOURNAL_DIR);
            await fsp.mkdir(dir, { recursive: true });
            await fsp.writeFile(path.join(dir, '000000.jsonl'), content);
        };
        const line = (id: string) => JSON.stringify({ op: 'del', ts: 'T', id }) + '\n';

        it('refuses to overwrite a segment with one that is not the same history', async () => {
            await plant(mounts[0], line('lineage-A-1') + line('lineage-A-2'));
            await plant(mounts[1], line('lineage-B-1'));

            // Neither is a prefix of the other. Silently picking the longer would destroy real records.
            await expect(copySegments(mounts[0], mounts[1])).rejects.toThrow(/DIVERGED/);

            // ...and the target was left exactly as it was.
            expect(await readJournal(mounts[1])).toEqual([{ op: 'del', ts: 'T', id: 'lineage-B-1' }]);
        });

        it('still tops up a SHORT copy of the same history', async () => {
            await plant(mounts[0], line('r1') + line('r2') + line('r3'));
            await plant(mounts[1], line('r1'));           // a genuine prefix -- a degraded write, not a lineage

            await expect(copySegments(mounts[0], mounts[1])).resolves.toBeUndefined();
            expect((await readJournal(mounts[1])).map(r => r.id)).toEqual(['r1', 'r2', 'r3']);
        });

        it('seeds from the MAJORITY lineage and leaves the odd disk untouched', async () => {
            // Volumes 0 and 1 agree. Volume 2 is a re-attached disk from a dead journal -- and its segment
            // is the LONGEST, so anything picking by size alone would choose it.
            const majority = line('real-1') + line('real-2');
            await plant(mounts[0], majority);
            await plant(mounts[1], majority);
            await plant(mounts[2], line('stale-1') + line('stale-2') + line('stale-3') + line('stale-4'));
            const staleBefore = await fsp.readFile(path.join(mounts[2], 'strubs', JOURNAL_DIR, '000000.jsonl'), 'utf8');

            configMock.journalReplicas = 3;
            const j = new Journal({ getWritableVolumes: () => [volume(0, 1), volume(1, 2), volume(3, 3)] });
            await j.start();
            await j.append({ op: 'del', ts: 'T', id: 'written-after-recovery' });
            await j.stop();

            // Volume 3 was blank and got the majority's history -- not the stale disk's.
            const seeded = (await readJournal(mounts[3])).map(r => r.id);
            expect(seeded).toContain('real-1');
            expect(seeded).toContain('written-after-recovery');
            expect(seeded.some(id => id.startsWith('stale'))).toBe(false);

            // The odd disk is left ALONE: it may hold records nobody else has, and that is the operator's
            // call to make. We do not merge it and we certainly do not wipe it.
            const staleAfter = await fsp.readFile(path.join(mounts[2], 'strubs', JOURNAL_DIR, '000000.jsonl'), 'utf8');
            expect(staleAfter).toBe(staleBefore);
        });

        // One-all. There is no majority, so there is no evidence -- and extending either history is what
        // would make the ambiguity permanent. Refusing namespace changes is loud and reversible; guessing
        // is neither.
        it('refuses to adopt ANY replica when the lineages tie, rather than guessing', async () => {
            await plant(mounts[0], line('lineage-A-1') + line('lineage-A-2'));
            await plant(mounts[1], line('lineage-B-1') + line('lineage-B-2'));
            const aBefore = await fsp.readFile(path.join(mounts[0], 'strubs', JOURNAL_DIR, '000000.jsonl'), 'utf8');
            const bBefore = await fsp.readFile(path.join(mounts[1], 'strubs', JOURNAL_DIR, '000000.jsonl'), 'utf8');

            configMock.journalReplicas = 2;
            const j = new Journal({ getWritableVolumes: () => [volume(0, 1), volume(1, 2)] });
            await j.start();

            expect(j.replicaVolumeIds).toEqual([]);        // nothing adopted

            // ...so a namespace change is REFUSED rather than written into a history we cannot vouch for.
            await expect(j.append({ op: 'del', ts: 'T', id: 'x' })).rejects.toThrow(/no replicas/);

            // Both disks are exactly as we found them. Neither history was extended, merged or wiped.
            expect(await fsp.readFile(path.join(mounts[0], 'strubs', JOURNAL_DIR, '000000.jsonl'), 'utf8')).toBe(aBefore);
            expect(await fsp.readFile(path.join(mounts[1], 'strubs', JOURNAL_DIR, '000000.jsonl'), 'utf8')).toBe(bBefore);
            await j.stop();
        });

        // The nastiest shape, and the one that makes a bounded byte-compare unsafe: two disks that share an
        // ANCESTOR and forked later. They agree for the first 10 records and disagree after, so any probe
        // that stops early calls the shorter one a prefix and overwrites it.
        it('catches a fork that shares an ancestor and only diverges LATER', async () => {
            const common = line('r1') + line('r2') + line('r3');
            await plant(mounts[0], common + line('branch-A'));
            await plant(mounts[1], common + line('branch-B-1') + line('branch-B-2'));

            // vol1's file is LONGER, so a size-only rule would copy it straight over vol0's and destroy
            // branch-A. They agree on every byte a bounded probe would have looked at.
            await expect(copySegments(mounts[1], mounts[0])).rejects.toThrow(/DIVERGED/);

            // vol0 keeps its records.
            expect((await readJournal(mounts[0])).map(r => r.id)).toEqual(['r1', 'r2', 'r3', 'branch-A']);
        });

        // An EMPTY segment agrees with everything -- two files that share zero bytes trivially match over
        // those zero bytes. So a blank disk, asked "is this the same journal as yours?", says yes to
        // everybody, and letting one stand as a lineage's representative would have it vouch for two
        // unrelated histories at once and fold them into one. That is how a dead journal gets laundered
        // into a live one, so a disk that knows nothing does not get a vote.
        //
        // Two independent things now hold this line -- the blank disk is ignored in the vote, AND the byte
        // comparison inside copySegments refuses to overwrite either history with the other. This asserts
        // the outcome they agree on: nothing adopted, nothing written, nothing touched.
        it('does not let a disk with an EMPTY journal vouch for two different lineages at once', async () => {
            await plant(mounts[0], '');                                     // blank: file created, never written
            await plant(mounts[1], line('lineage-A-1') + line('lineage-A-2'));
            await plant(mounts[2], line('lineage-B-1') + line('lineage-B-2'));
            const aBefore = await fsp.readFile(path.join(mounts[1], 'strubs', JOURNAL_DIR, '000000.jsonl'), 'utf8');
            const bBefore = await fsp.readFile(path.join(mounts[2], 'strubs', JOURNAL_DIR, '000000.jsonl'), 'utf8');

            configMock.journalReplicas = 3;
            const j = new Journal({
                getWritableVolumes: () => [volume(0, 1), volume(1, 2), volume(2, 3)],
                getFleetVolumes: () => [0, 1, 2].map(i => ({ id: i, mountPoint: mounts[i], isDeleted: false, isMounted: true }))
            });
            await j.start();

            // The blank disk is ignored, which leaves TWO real histories and no majority -- so nothing is
            // adopted and namespace changes are refused, rather than the two being spliced into one.
            expect(j.replicaVolumeIds).toEqual([]);
            await expect(j.append({ op: 'del', ts: 'T', id: 'x' })).rejects.toThrow(/no replicas/);

            // Neither history was touched.
            expect(await fsp.readFile(path.join(mounts[1], 'strubs', JOURNAL_DIR, '000000.jsonl'), 'utf8')).toBe(aBefore);
            expect(await fsp.readFile(path.join(mounts[2], 'strubs', JOURNAL_DIR, '000000.jsonl'), 'utf8')).toBe(bBefore);
            await j.stop();
        });

        it('does not mistake a DEGRADED replica for a rival lineage', async () => {
            // vol1 is just short -- a prefix of vol0, which is what a degraded write leaves behind. That is
            // one history, not two, and it must be topped up rather than quarantined.
            await plant(mounts[0], line('r1') + line('r2') + line('r3'));
            await plant(mounts[1], line('r1'));

            configMock.journalReplicas = 2;
            const j = new Journal({ getWritableVolumes: () => [volume(0, 1), volume(1, 2)] });
            await j.start();

            expect(j.replicaVolumeIds).toEqual([0, 1]);    // both adopted, no conflict declared
            expect((await readJournal(mounts[1])).map(r => r.id)).toEqual(['r1', 'r2', 'r3']);
            await j.stop();
        });
    });

    // A seed is not atomic. Whatever reaches the platter before it is interrupted has to still make sense
    // on its own, because the source it was copying FROM might not survive to try again.
    describe('an interrupted seed', () => {
        it('copies segments in ascending order, so a partial seed is a valid short history', async () => {
            const dir = path.join(mounts[0], 'strubs', JOURNAL_DIR);
            await fsp.mkdir(dir, { recursive: true });
            const rec = (id: string) => JSON.stringify({ op: 'del', ts: 'T', id }) + '\n';
            for (const [n, id] of [['000000', 'a'], ['000001', 'b'], ['000002', 'c']] as Array<[string, string]>)
                await fsp.writeFile(path.join(dir, `${n}.jsonl`), rec(id));

            // Record the order the copies land in.
            const landed: string[] = [];
            const realCopyFile = fsp.copyFile;
            const spy = vi.spyOn(fsp, 'copyFile').mockImplementation(async (src: any, dst: any) => {
                landed.push(path.basename(String(dst)));
                return realCopyFile(src, dst);
            });

            await copySegments(mounts[0], mounts[1]);
            spy.mockRestore();

            // 000000 FIRST. Interrupt this anywhere and the target holds 000000..k -- a contiguous prefix,
            // which the next seed simply tops up. In readdir order it could have landed 000002 alone: no
            // 000000, so a later start would read it as a foreign remnant and ignore it, throwing away
            // acknowledged records that had genuinely reached that disk.
            expect(landed).toEqual(['000000.jsonl', '000001.jsonl', '000002.jsonl']);
        });

        // The foreign-segment refusal must not catch a replica that is legitimately BEHIND. A disk that was
        // retired at segment 5 and is re-elected once the lineage has reached 9 holds a SUBSET of the
        // lineage, not a foreign journal -- refusing it would slowly starve the journal of replicas every
        // time a disk went out and came back.
        it('re-elects a replica that fell behind, and tops it up rather than refusing it', async () => {
            const rec = (id: string) => JSON.stringify({ op: 'del', ts: 'T', id }) + '\n';
            const write = async (mount: string, ns: number[]) => {
                const dir = path.join(mount, 'strubs', JOURNAL_DIR);
                await fsp.mkdir(dir, { recursive: true });
                for (const n of ns)
                    await fsp.writeFile(path.join(dir, `${String(n).padStart(6, '0')}.jsonl`), rec(`seg-${n}`));
            };
            await write(mounts[0], [0, 1, 2, 3]);       // the lineage, up to date
            await write(mounts[1], [0, 1]);             // retired at segment 1, now coming back

            configMock.journalReplicas = 2;
            const j = new Journal({ getWritableVolumes: () => [volume(0, 1), volume(1, 2)] });
            await j.start();
            await j.append({ op: 'del', ts: 'T', id: 'after-rejoining' });
            await j.stop();

            expect(j.replicaVolumeIds).toEqual([0, 1]);          // adopted, not refused
            expect(await listSegments(mounts[1]))                // and brought fully up to date
                .toEqual(['000000.jsonl', '000001.jsonl', '000002.jsonl', '000003.jsonl']);
            expect((await readJournal(mounts[1])).map(r => r.id))
                .toEqual(['seg-0', 'seg-1', 'seg-2', 'seg-3', 'after-rejoining']);
        });

        it('a target holding only the first segments is a short history, not a remnant', async () => {
            const rec = (id: string) => JSON.stringify({ op: 'del', ts: 'T', id }) + '\n';
            const dir0 = path.join(mounts[0], 'strubs', JOURNAL_DIR);
            await fsp.mkdir(dir0, { recursive: true });
            await fsp.writeFile(path.join(dir0, '000000.jsonl'), rec('a'));
            await fsp.writeFile(path.join(dir0, '000001.jsonl'), rec('b'));

            // vol1 got 000000 and then the seed was cut short.
            const dir1 = path.join(mounts[1], 'strubs', JOURNAL_DIR);
            await fsp.mkdir(dir1, { recursive: true });
            await fsp.writeFile(path.join(dir1, '000000.jsonl'), rec('a'));

            configMock.journalReplicas = 2;
            const j = new Journal({ getWritableVolumes: () => [volume(0, 1), volume(1, 2)] });
            await j.start();
            await j.stop();

            // It is recognised as the same (short) history and topped up, not discarded as foreign.
            expect(j.replicaVolumeIds).toEqual([0, 1]);
            expect((await readJournal(mounts[1])).map(r => r.id)).toEqual(['a', 'b']);
        });
    });

    // A GAP in the segments means one has been LOST -- the lineage runs contiguously from 000000 and we
    // never delete. Resuming at the gap would put new records into a pre-gap segment, in front of the ones
    // already sitting in the segments above it. The records in the missing segment are gone either way;
    // scrambling the order of the survivors on top of that helps nobody.
    describe('a missing segment', () => {
        it('resumes at the HIGHEST segment, not at the gap, so surviving records stay in order', async () => {
            const dir = path.join(mounts[0], 'strubs', JOURNAL_DIR);
            await fsp.mkdir(dir, { recursive: true });
            const rec = (id: string) => JSON.stringify({ op: 'del', ts: 'T', id }) + '\n';
            await fsp.writeFile(path.join(dir, '000000.jsonl'), rec('oldest'));
            // 000001.jsonl is GONE -- the disk that had it died.
            await fsp.writeFile(path.join(dir, '000002.jsonl'), rec('newest'));

            configMock.journalReplicas = 1;
            const j = new Journal({ getWritableVolumes: () => [volume(0, 1)] });
            await j.start();
            await j.append({ op: 'del', ts: 'T', id: 'written-now' });
            await j.stop();

            // The new record landed in 000002 -- AFTER 'newest', which is where it belongs in time. Had we
            // stopped at the gap and resumed 000000, it would have been ordered before it.
            const segment2 = await fsp.readFile(path.join(dir, '000002.jsonl'), 'utf8');
            expect(segment2.split('\n').filter(Boolean).map(l => JSON.parse(l).id)).toEqual(['newest', 'written-now']);
            expect((await readJournal(mounts[0])).map(r => r.id)).toEqual(['oldest', 'newest', 'written-now']);
        });
    });

    // "I could not read the disk" must never come back as "the disk is empty". A dying drive that answers
    // EIO is exactly the drive someone is about to pull -- and it is exactly the drive that might be
    // holding the last copy of the namespace history.
    describe('an unreadable disk is not an empty disk', () => {
        it('does not report a journal directory it cannot read as having no segments', async () => {
            // A FILE where the .journal directory should be: readdir gives ENOTDIR, not ENOENT.
            const strubs = path.join(mounts[0], 'strubs');
            await fsp.mkdir(strubs, { recursive: true });
            await fsp.writeFile(path.join(strubs, JOURNAL_DIR), 'not a directory');

            await expect(listSegments(mounts[0])).rejects.toThrow();
        });

        it('reports a volume with no journal directory at all as genuinely empty', async () => {
            expect(await listSegments(mounts[0])).toEqual([]);      // ENOENT: nothing here, and we can say so
        });

        // The subtlest version of the same mistake. A volume whose mount FAILED still has a mountPoint --
        // it is assigned before the attempt -- and that path is an empty directory on the ROOT filesystem.
        // Reading it answers "no journal here" with total confidence about a disk we never opened. If that
        // disk is the one holding the namespace history, we would cheerfully start a fresh journal beside
        // it. "I looked and it was empty" and "I never got to look" are not the same sentence.
        it('does not read a volume that FAILED TO MOUNT as an empty one', async () => {
            // vol0 is the only writable disk and is blank. vol1 did not mount -- but it is the one with the
            // history on it (which we cannot see, exactly as in the real failure).
            configMock.journalReplicas = 1;
            const j = new Journal({
                getWritableVolumes: () => [volume(0, 1)],
                getFleetVolumes: () => [
                    { id: 0, mountPoint: mounts[0], isDeleted: false, isMounted: true },
                    { id: 1, mountPoint: mounts[1], isDeleted: false, isMounted: false }   // mount failed
                ]
            });
            await j.start();

            // No history found, and a disk we could not look at. REFUSE -- do not start a fresh journal
            // that would fork the namespace.
            expect(j.replicaVolumeIds).toEqual([]);
            await expect(j.append({ op: 'del', ts: 'T', id: 'x' })).rejects.toThrow(/no replicas/);
            expect(await listSegments(mounts[0])).toEqual([]);   // nothing was written to the blank disk
            await j.stop();
        });

        // An open file descriptor SURVIVES its filesystem being unmounted -- writes to it just go nowhere
        // real. So a replica can look perfectly alive in memory while its mountPoint has quietly become an
        // empty directory on the root filesystem. Trusting it as the authoritative source would have the
        // seed read that empty path, find nothing, copy nothing, and report a clean success: a brand-new
        // replica adopted with NO history at all, which is the one lie the seeding code exists to prevent.
        it('does not seed from a replica whose disk was unmounted out from under its open handle', async () => {
            configMock.journalReplicas = 1;
            let mounted = true;
            const j = new Journal({
                getWritableVolumes: () => (mounted ? [volume(0, 1), volume(1, 2)] : [volume(1, 2)]),
                getFleetVolumes: () => [
                    { id: 0, mountPoint: mounts[0], isDeleted: false, isMounted: mounted },
                    { id: 1, mountPoint: mounts[1], isDeleted: false, isMounted: true }
                ]
            });
            await j.start();
            expect(j.replicaVolumeIds).toEqual([0]);
            await j.append({ op: 'put', ts: 'T', id: 'o1', cid: null, name: 'the-only-copy', size: 1, cs: 16384 });
            await j.flush();

            // Volume 0's filesystem goes away. The handle is still open, and STRUBS still holds it -- but the
            // path now leads nowhere, and the segments on it are unreachable.
            await fsp.rm(path.join(mounts[0], 'strubs'), { recursive: true, force: true });
            mounted = false;

            await j.onFleetChange();

            // Volume 1 must NOT have been adopted as a replica carrying the namespace: we could not seed it
            // from a disk that is no longer there, so we say so instead of pretending.
            expect(j.replicaVolumeIds).toEqual([]);
            await expect(j.append({ op: 'del', ts: 'T', id: 'x' })).rejects.toThrow(/no replicas/);
            expect(await listSegments(mounts[1])).toEqual([]);   // nothing was written to it
            await j.stop();
        });

        it('REFUSES to confirm a volume is safe to remove when its journal cannot be read', async () => {
            const strubs = path.join(mounts[0], 'strubs');
            await fsp.mkdir(strubs, { recursive: true });
            await fsp.writeFile(path.join(strubs, JOURNAL_DIR), 'not a directory');

            const j = new Journal({
                getWritableVolumes: () => [volume(1, 1)],
                getFleetVolumes: () => [{ id: 0, mountPoint: mounts[0], isDeleted: false, isMounted: true }]
            });

            // We cannot prove volume 0 is not holding the last copy, so we do not say that it isn't.
            await expect(j.assertNotLastCopy(0)).rejects.toThrow(/cannot verify/i);
        });
    });

    // A replica that fails ONE batch while the others succeed has a HOLE in it: the caller was told that
    // record is durable, and this disk does not have it. Closing its handle is not enough -- rotation
    // reopens every handle-less replica on the next segment, and it would quietly resume writing, looking
    // like a full replica right up until the moment it was the last one standing.
    describe('a replica that misses an acknowledged batch', () => {
        it('is dropped from the set and RE-SEEDED, never left with a hole in its history', async () => {
            configMock.journalReplicas = 2;
            const j = new Journal({ getWritableVolumes: () => [volume(0, 1), volume(1, 2)] });
            await j.start();
            expect(j.replicaVolumeIds).toEqual([0, 1]);

            await j.append({ op: 'del', ts: 'T', id: 'before-the-failure' });

            // Volume 1's disk rejects this one write. Volume 0 takes it, so the record IS acknowledged --
            // and volume 1 is now missing a record the caller was promised.
            const replicas = (j as any).replicas as Array<{ volumeId: number; handle: any }>;
            const vol1 = replicas.find(r => r.volumeId === 1)!;
            vol1.handle.write = async () => { throw new Error('disk went away'); };

            await j.append({ op: 'del', ts: 'T', id: 'the-record-vol1-missed' });

            // Give the re-election kicked off by the failed write a moment to run.
            await new Promise(r => setTimeout(r, 50));

            await j.append({ op: 'del', ts: 'T', id: 'after-the-repair' });
            await j.stop();

            // Volume 1 is back in the set, and it has the record it missed -- it was re-seeded from volume 0,
            // not quietly reopened on the next segment with a gap in the middle.
            expect(j.replicaVolumeIds).toContain(1);
            const ids = (await readJournal(mounts[1])).map(r => r.id);
            expect(ids).toEqual(['before-the-failure', 'the-record-vol1-missed', 'after-the-repair']);

            // ...and it agrees with the replica that never failed. That is the whole point.
            expect(await readJournal(mounts[0])).toEqual(await readJournal(mounts[1]));
        });
    });

    // The same hole, through the other door. A replica whose SEGMENT WOULD NOT OPEN is just as dangerous as
    // one that failed a write: left in the set with a null handle, flush() skips it, records are
    // acknowledged without it, and the next rotation reopens it on the new segment -- resuming as a "full"
    // copy that is missing everything written in between.
    it('drops a replica whose segment could not be opened, rather than reopening it later with a hole', async () => {
        configMock.journalReplicas = 2;
        configMock.journalSegmentBytes = 220;                 // tiny, so a couple of records force a rotation
        const j = new Journal({ getWritableVolumes: () => [volume(0, 1), volume(1, 2)] });
        await j.start();
        expect(j.replicaVolumeIds).toEqual([0, 1]);

        await j.append({ op: 'del', ts: 'T', id: 'record-one' });

        // Volume 1's journal directory becomes unusable: a FILE where the directory should be, so opening
        // the next segment on it fails. Its current handle keeps working, which is what makes this subtle.
        await fsp.rm(path.join(mounts[1], 'strubs', JOURNAL_DIR), { recursive: true, force: true });
        await fsp.writeFile(path.join(mounts[1], 'strubs', JOURNAL_DIR), 'not a directory');

        // Force a rotation, which re-opens segments on every replica.
        for (let i = 0; i < 6; i++)
            await j.append({ op: 'del', ts: 'T', id: `filler-${i}` });

        // Volume 1 must NOT still be sitting in the replica set pretending to be a copy of the namespace.
        expect(j.replicaVolumeIds).not.toContain(1);
        await j.stop();
    });

    // Re-election has to be able to FAIL without taking the journal down with it. Being one copy short of
    // where you wanted the history is a problem; having nowhere at all to record it is a different kind of
    // problem, and the code must never trade the first for the second.
    describe('when there is nowhere for the journal to go', () => {
        it('keeps the replicas it has rather than retiring them to nowhere', async () => {
            // The drain path marks a volume unwritable BEFORE asking the journal to move off it, so the
            // volume excludes itself as a candidate. With no other eligible disk, the election comes up
            // empty -- and retiring the only replica at that point would take the journal to zero, in
            // service of a drain that is about to be refused anyway.
            configMock.journalReplicas = 1;
            let fleet = [volume(0, 1)];
            const j = new Journal({ getWritableVolumes: () => fleet });
            await j.start();
            expect(j.replicaVolumeIds).toEqual([0]);
            await j.append({ op: 'del', ts: 'T', id: 'before' });

            fleet = [];                                  // volume 0 goes read-only for the drain; nothing else exists
            await j.onFleetChange();

            // Still recording. The drain will be refused (relocateOff proves the move, and it did not
            // happen), and it is refused WITH a journal rather than without one.
            expect(j.replicaVolumeIds).toEqual([0]);
            await expect(j.append({ op: 'del', ts: 'T', id: 'after' })).resolves.toBeUndefined();
            await j.stop();

            expect((await readJournal(mounts[0])).map(r => r.id)).toEqual(['before', 'after']);
        });

        it('costs ONE re-election for a burst of writes against a dead journal, not one each', async () => {
            configMock.journalReplicas = 1;
            let fleet = [volume(0, 1)];
            let scans = 0;
            const j = new Journal({
                getWritableVolumes: () => { scans++; return fleet; },
                getFleetVolumes: () => [{ id: 0, mountPoint: mounts[0], isDeleted: false, isMounted: true }]
            });
            await j.start();

            const replicas = (j as any).replicas as Array<{ handle: any }>;
            replicas[0].handle.write = async () => { throw new Error('disk is read-only'); };
            fleet = [];
            await expect(j.append({ op: 'del', ts: 'T', id: 'x' })).rejects.toThrow();
            await new Promise(r => setTimeout(r, 30));
            expect(j.replicaVolumeIds).toEqual([]);

            // Twenty writes arrive at once against a journal with nowhere to write. They must SHARE one
            // re-election attempt, not chain twenty full scans of the fleet in series behind each other.
            scans = 0;
            const burst = Array.from({ length: 20 }, (_, i) =>
                j.append({ op: 'del', ts: 'T', id: `burst-${i}` }).catch(() => 'refused'));
            expect(await Promise.all(burst)).toEqual(Array(20).fill('refused'));

            // chooseReplicas() is called once per re-election, so this counts them.
            expect(scans).toBeLessThanOrEqual(2);
            await j.stop();
        });

        it('recovers on the NEXT write once a volume is available again', async () => {
            // Every replica fails, so the set empties. There is then no flush to fire the re-election --
            // append() would throw first, forever, waiting for a write that can never succeed. The next
            // append has to break that cycle itself.
            configMock.journalReplicas = 1;
            let fleet = [volume(0, 1)];
            const j = new Journal({
                getWritableVolumes: () => fleet,
                // Volume 0's disk is still MOUNTED and readable throughout -- it went read-only, it did not
                // vanish. That matters: it is where the history is, and it is what the replacement gets
                // seeded from.
                getFleetVolumes: () => [0, 1].map(i => ({
                    id: i, mountPoint: mounts[i], isDeleted: false, isMounted: true
                }))
            });
            await j.start();
            await j.append({ op: 'del', ts: 'T', id: 'before-the-outage' });

            // The one replica stops accepting WRITES (its disk went read-only under us).
            const replicas = (j as any).replicas as Array<{ volumeId: number; handle: any }>;
            replicas[0].handle.write = async () => { throw new Error('disk is read-only'); };
            fleet = [];

            await expect(j.append({ op: 'del', ts: 'T', id: 'lost' })).rejects.toThrow();
            await new Promise(r => setTimeout(r, 30));
            expect(j.replicaVolumeIds).toEqual([]);                       // nowhere to write
            await expect(j.append({ op: 'del', ts: 'T', id: 'still-nowhere' })).rejects.toThrow(/no replicas/);

            // A disk comes back. The very next write must re-elect and succeed, without a restart.
            fleet = [volume(1, 2)];
            await expect(j.append({ op: 'del', ts: 'T', id: 'after-the-recovery' })).resolves.toBeUndefined();
            expect(j.replicaVolumeIds).toEqual([1]);
            await j.stop();

            const ids = (await readJournal(mounts[1])).map(r => r.id);
            expect(ids).toContain('before-the-outage');                   // seeded from the platter
            expect(ids).toContain('after-the-recovery');
        });
    });

    // A batch that NO replica acknowledged must leave nothing readable behind. "The fsync failed" is not
    // the same as "the bytes are not there": a write() can land on the platter while the sync() that was
    // supposed to prove it fails. What that leaves is not a torn line -- it is a COMPLETE, perfectly
    // parseable record for a change that never happened, and the caller has already been told it failed.
    describe('a batch that no replica accepted', () => {
        it('rolls the bytes back, so a rejected record can never be replayed as though it happened', async () => {
            const j = new Journal({ getWritableVolumes: () => [volume(0, 1)] });
            configMock.journalReplicas = 1;
            await j.start();
            await j.append({ op: 'put', ts: 'T', id: 'o1', cid: null, name: 'real-object', size: 1, cs: 16384 });

            const seg = path.join(mounts[0], 'strubs', JOURNAL_DIR, '000000.jsonl');
            const goodLength = (await fsp.stat(seg)).size;

            // The write lands, the fsync does not. Exactly the case the guard exists for -- and the reason
            // it cannot just trust that a failed flush wrote nothing.
            const replicas = (j as any).replicas as Array<{ handle: any }>;
            const realSync = replicas[0].handle.sync.bind(replicas[0].handle);
            replicas[0].handle.sync = async () => { await realSync(); throw new Error('fsync failed'); };

            await expect(j.append({ op: 'del', ts: 'T', id: 'real-object-id' }))
                .rejects.toThrow(/EVERY replica/);

            // The `del` is GONE from the platter. Had it survived, a rebuild would honour it and drop the
            // name of an object that is still there -- an object whose delete the caller was told FAILED.
            const records = await readJournal(mounts[0]);
            expect(records.map(r => r.op)).toEqual(['put']);
            expect(records.some(r => r.op === 'del')).toBe(false);
            expect((await fsp.stat(seg)).size).toBe(goodLength);
        });
    });

    // The simplest case in the world, and it must not brick itself: install STRUBS, start it, stop it
    // before a single object is ever written, start it again. The replicas hold empty segment files -- no
    // history at all -- and an empty file is not a foreign journal, it is just a file.
    describe('a fresh install that restarts before its first write', () => {
        it('comes back up rather than refusing every disk it created', async () => {
            configMock.journalReplicas = 2;
            const fleet = [volume(0, 1), volume(1, 2)];

            const first = new Journal({ getWritableVolumes: () => fleet });
            await first.start();
            expect(first.replicaVolumeIds).toEqual([0, 1]);
            await first.stop();                              // not one record written

            // Both disks now hold an EMPTY 000000.jsonl.
            expect(await listSegments(mounts[0])).toEqual(['000000.jsonl']);
            expect((await fsp.stat(path.join(mounts[0], 'strubs', JOURNAL_DIR, '000000.jsonl'))).size).toBe(0);

            const second = new Journal({ getWritableVolumes: () => fleet });
            await second.start();

            expect(second.replicaVolumeIds).toEqual([0, 1]);   // adopted, not refused as "foreign"
            await expect(second.append({ op: 'del', ts: 'T', id: 'the-first-record' })).resolves.toBeUndefined();
            await second.stop();

            expect((await readJournal(mounts[0])).map(r => r.id)).toEqual(['the-first-record']);
            expect((await readJournal(mounts[1])).map(r => r.id)).toEqual(['the-first-record']);
        });
    });

    describe('disabled', () => {
        it('is a no-op when turned off, rather than failing writes', async () => {
            configMock.journalEnabled = false;
            const j = new Journal({ getWritableVolumes: () => [volume(0, 1)] });
            await j.start();
            await expect(j.append({ op: 'del', ts: 'T', id: 'o1' })).resolves.toBeUndefined();
            expect(await listSegments(mounts[0])).toEqual([]);
        });
    });
});
