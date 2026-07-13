import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/log', () => ({ createLogger: () => Object.assign(() => {}, { error: () => {} }) }));
vi.mock('../lib/notify/service', () => ({ notificationService: { notify: vi.fn(async () => undefined) } }));

import { DriftScrubJob } from '../lib/jobs/drift-scrub-job';

const writeSlice = async (file: string, o: { id: string; index: number }): Promise<void> => {
    const buf = Buffer.alloc(48);
    Buffer.from([0x01, 0xc3, 0xbb, 0x02]).copy(buf, 0);   // the magic as it ACTUALLY lands on disk
    buf.writeUInt8(1, 4);
    buf.writeUInt16LE(48, 5);
    Buffer.from(o.id, 'hex').copy(buf, 23, 0, 12);
    buf.writeIntLE(100, 35, 5);
    buf.writeUInt8(4, 40);
    buf.writeUInt8(2, 41);
    buf.writeUInt8(o.index, 42);
    buf.writeIntLE(16384, 43, 3);
    createHash('md5').update(buf.subarray(23, 48)).digest().copy(buf, 7);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, buf);
};

// The slow, quiet divergence between what the database believes and what is on the platters. Nobody notices,
// because nothing is broken -- until the moment it matters enormously.
describe('drift scrub: what Mongo says, against what is actually there', () => {
    let root: string;
    beforeEach(async () => { root = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-drift-')); });
    afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

    const NAMED_AND_PRESENT = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const NAMED_NOT_PRESENT = 'bbbbbbbbbbbbbbbbbbbbbbbb';
    const PRESENT_NOT_NAMED = 'cccccccccccccccccccccccc';
    const BELOW_QUORUM      = 'dddddddddddddddddddddddd';

    const put = async (id: string, slices: number[]) => {
        for (const i of slices)
            await writeSlice(path.join(root, 'vol0', 'strubs', id.slice(0, 2), id.slice(2, 4), id.slice(4, 6), `${id}.${i}`), { id, index: i });
    };

    const scrub = (inDatabase: string[]) => new DriftScrubJob({
            fleetGeometry: () => ({ dataSlices: 4, paritySlices: 2 }),
            fleetRestoreIncomplete: async () => null,   // the volume table is whole
        platters: () => [{ volumeId: 0, mountPoint: path.join(root, 'vol0') }],
        streamObjectIds: () => (async function* () { for (const id of inDatabase) yield id; })(),
        now: () => new Date('2026-07-13T00:00:00Z')
    });

    it('finds nothing to report on a healthy array', async () => {
        await put(NAMED_AND_PRESENT, [0, 1, 2, 3, 4, 5]);
        const report = await scrub([NAMED_AND_PRESENT]).run();

        expect(report).toMatchObject({
            objectsInDatabase: 1,
            objectsOnPlatters: 1,
            phantomCount: 0,
            orphanCount: 0,
            belowQuorumCount: 0
        });
    });

    // A PHANTOM is the array lying about itself. Every write path in DR-C is ordered specifically so that
    // this cannot happen, so a non-zero count here is not drift -- it is a bug in one of those orderings.
    it('finds a PHANTOM: Mongo names an object with no slices anywhere', async () => {
        await put(NAMED_AND_PRESENT, [0, 1, 2, 3, 4, 5]);
        const report = await scrub([NAMED_AND_PRESENT, NAMED_NOT_PRESENT]).run();

        expect(report.phantomCount).toBe(1);
        expect(report.phantoms).toEqual([NAMED_NOT_PRESENT]);
        expect(report.orphanCount).toBe(0);
    });

    // An ORPHAN is data with no name. The header describes it completely, so it is recoverable -- and this is
    // the failure mode the whole design deliberately prefers.
    it('finds an ORPHAN: slices on the platters that Mongo has never heard of', async () => {
        await put(NAMED_AND_PRESENT, [0, 1, 2, 3, 4, 5]);
        await put(PRESENT_NOT_NAMED, [0, 1, 2, 3, 4, 5]);
        const report = await scrub([NAMED_AND_PRESENT]).run();

        expect(report.orphanCount).toBe(1);
        expect(report.orphans).toEqual([PRESENT_NOT_NAMED]);
        expect(report.phantomCount).toBe(0);
    });

    // The one number on the report that is a tragedy rather than bookkeeping.
    it('finds an object that can no longer be reconstructed at all', async () => {
        await put(BELOW_QUORUM, [0, 1]);                  // 2 slices of a 4+2 object
        const report = await scrub([BELOW_QUORUM]).run();

        expect(report.belowQuorumCount).toBe(1);
        expect(report.belowQuorum).toEqual([BELOW_QUORUM]);
    });

    // The samples are capped. Reporting the sample LENGTH as the count would tell an array with a million
    // phantoms that it has a thousand -- understating a catastrophe by three orders of magnitude, in the one
    // report whose whole job is to say how bad things are.
    it('counts everything even though it only SAMPLES the ids', async () => {
        const ids = Array.from({ length: 1500 }, (_, i) => i.toString(16).padStart(24, '0'));
        const report = await scrub(ids).run();

        expect(report.phantomCount).toBe(1500);       // the truth
        expect(report.phantoms).toHaveLength(1000);   // ...and a manageable sample of it
    });
});
