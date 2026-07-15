import { createGzip, createGunzip } from 'zlib';
import { createReadStream, createWriteStream, promises as fsp } from 'fs';
import { createHash } from 'crypto';
import { createInterface } from 'readline';
import { pipeline } from 'stream/promises';
import { once } from 'events';

import { config } from '../config';
import { createLogger } from '../log';
import { notificationService } from '../notify/service';

const log = createLogger('snapshot');

// THE NAMESPACE, WRITTEN DOWN WHERE MONGO CANNOT TAKE IT WITH IT.
//
// The journal (DR-C) records every namespace change from the moment it started running. That is the right
// thing for everything written from now on -- and it is worth nothing at all for the 3.5 million objects
// that were already here when it started. Their names exist in exactly one place: Mongo. Lose it and the
// disks still hold every byte of every one of them, perfectly intact and completely anonymous.
//
// This is the artifact that fixes that. It is a full dump of the namespace -- every container, every object,
// with its name, its parent, its mime and its md5 -- in the SAME record vocabulary the journal speaks, so a
// restore is one idea and not two: apply the snapshot, then replay the journal over the top. Gzipped NDJSON,
// which you can read with `zcat` and no infrastructure whatsoever.
//
// It is stored as a STRUBS OBJECT, erasure-coded across the whole array, so it survives losing disks the way
// everything else does -- and unlike the journal, which lives in full on three specific volumes, it does not
// care which three. The bootstrapping trap ("you need the index to find the thing that rebuilds the index")
// is closed by the bootstrap manifest: it records the snapshot's OBJECT ID, and a recovery finds the slices
// by scanning the platters for `<id>.<n>`. Their headers carry the geometry. The disks tell you the rest.
//
// CONTAINERS COME FIRST, AND PARENT BEFORE CHILD. A restore reading this top to bottom never meets an object
// whose container it has not already seen, and never meets a container whose parent it has not already seen.
// That is not a nicety: it is what lets a restore be a single forward pass with no fixup phase.
export type SnapshotRecord =
    // A BUCKET'S ACCESS POLICY IS PART OF THE NAMESPACE, not a detail of it. Restore a bucket without its
    // publicRead/publicWrite and it comes back PRIVATE -- which is the safe direction, and still wrong: every
    // anonymous reader of a public bucket breaks, and the restore reports success while they do. Only top-level
    // containers are buckets, so `pr`/`pw` are absent on everything else.
    | { op: 'container'; id: string; cid: string | null; name: string; pr?: boolean; pw?: boolean; dp?: boolean }
    | { op: 'put'; id: string; cid: string | null; name: string; mime?: string | null; md5?: string | null; size: number; cs: number }
    // The last line, and the reason a truncated snapshot cannot be mistaken for a complete one. A gzip
    // stream that was cut off mid-write still decompresses to something that parses perfectly, line after
    // line, right up until it stops -- and nothing about the records themselves says whether more were meant
    // to follow. Only a trailer can say "this is all of it", so nothing is trusted without one.
    | { op: 'end'; containers: number; objects: number; sha256: string };

export type SnapshotStats = {
    containers: number;
    objects: number;
    bytes: number;
    sha256: string;
};

export type SnapshotDeps = {
    // Every container, in any order. Small enough to hold (tens of thousands): they have to be sorted
    // parent-first before they can be written, and you cannot sort a stream you have not seen the end of.
    listContainers: () => Promise<Array<{ id: string; cid: string | null; name: string; pr?: boolean; pw?: boolean; dp?: boolean }>>;
    // Every object, streamed. There are millions, so this must never be materialised.
    streamObjects: () => AsyncIterable<{ id: string; cid: string | null; name: string; mime?: string | null; md5?: string | null; size: number; cs: number }>;
    now: () => Date;
};

const defaultDeps: SnapshotDeps = {
    listContainers: async () => {
        const { database } = require('../database') as typeof import('../database');
        return database.listAllContainers();
    },
    streamObjects: () => {
        const { database } = require('../database') as typeof import('../database');
        return database.streamAllObjects();
    },
    now: () => new Date()
};

// One record, one line -- and nothing else, ever.
//
// That is the entire contract of NDJSON, and it is the only thing holding this file together: lose the
// framing at object two million and every record after it is garbage, whatever the checksum says. A snapshot
// with broken framing is worse than no snapshot, because it looks like one.
//
// JSON.stringify escapes \n and \r, so this cannot happen by accident with well-formed strings. It CAN
// happen with bytes pretending to be a string -- an md5 read as text rather than hex -- and U+2028, U+2029
// and U+0085 are the trap, because JSON leaves them unescaped and plenty of tools treat them as line
// terminators. Not hypothetical: an md5 whose bytes began f3 c1 e9 e2 80 a8 split its own record in two on
// the very first real snapshot. e2 80 a8 is U+2028.
function serialise(record: SnapshotRecord): string {
    const line = JSON.stringify(record);
    if (/[\n\r\u0085\u2028\u2029]/.test(line))
        throw new Error(`snapshot record for ${'id' in record ? record.id : record.op} contains a line terminator `
            + `and would break the NDJSON framing of every record after it`);
    return line + '\n';
}

export class SnapshotBuilder {
    private readonly deps: SnapshotDeps;

    constructor(deps: Partial<SnapshotDeps> = {}) {
        this.deps = { ...defaultDeps, ...deps };
    }

    // Write the snapshot to `path` as gzipped NDJSON, and return what went into it.
    //
    // Staged to a local file rather than held in memory: at 3.5M objects this is hundreds of megabytes, and
    // the object writer needs to know the final size before it can plan a single slice. Streaming it to disk
    // costs a temp file and bounds the memory at one batch.
    async writeTo(path: string): Promise<SnapshotStats> {
        // OBJECTS FIRST, CONTAINERS SECOND -- and then written the other way round.
        //
        // This is not fussiness, it is the only ordering that makes the file's own promise true. The dump
        // takes minutes, and the array is live throughout: objects are being created in it the whole time.
        // Read the containers first and an object created two minutes later can name a folder that was
        // created two minutes later too -- one that is nowhere in the snapshot. The restore then meets a
        // `put` whose `cid` it has never seen, which is precisely the situation the parent-first ordering
        // exists to make impossible.
        //
        // Reading the containers AFTER the objects makes the list a SUPERSET: an object exists, therefore
        // its container was created before it, therefore it is in a list taken after that object was read.
        // So the objects are staged to a scratch file while they stream, the containers are listed once the
        // stream is done, and the final file is assembled containers-first. The restore still gets its
        // single forward pass; it just costs one more pass over a temp file to earn it honestly.
        const scratch = `${path}.objects`;
        try {
            return await this.assemble(path, scratch);
        }
        finally {
            // writeTo() cleans up after ITSELF, whatever happened. The job's staging directory would sweep
            // this up on the scheduled path, but a function that leaves a 700MB file behind on failure and
            // relies on somebody else noticing is a function with a bug in it.
            await fsp.rm(scratch, { force: true }).catch(() => undefined);
        }
    }

    private async assemble(path: string, scratch: string): Promise<SnapshotStats> {
        const objectLines = createWriteStream(scratch);

        let objects = 0;
        const seenContainers = new Set<string>();
        for await (const o of this.deps.streamObjects()) {
            objects++;
            if (o.cid) seenContainers.add(o.cid);
            const line = serialise({ op: 'put', id: o.id, cid: o.cid, name: o.name, mime: o.mime ?? null, md5: o.md5 ?? null, size: o.size, cs: o.cs });
            if (!objectLines.write(line))
                await once(objectLines, 'drain');
        }
        objectLines.end();
        await once(objectLines, 'finish');

        const containers = await this.deps.listContainers();
        const ordered = orderParentsFirst(containers);

        // Every container an object actually NAMES had better be in here. If it is not, the file cannot keep
        // its own promise, and the restore would meet an object it cannot place.
        const known = new Set(ordered.map(c => c.id));
        const dangling = [...seenContainers].filter(id => !known.has(id));
        if (dangling.length)
            throw new Error(`refusing to write a snapshot in which ${dangling.length} object(s) name a container `
                + `that is not in it (e.g. ${dangling[0]}): a restore would have nowhere to put them`);

        // Hash the RECORDS, not the gzip. The compressed bytes are an encoding detail -- two runs can
        // legitimately produce different bytes for identical content -- and what a restore needs to know is
        // that the namespace it read is the namespace that was written.
        const hash = createHash('sha256');
        const gzip = createGzip();
        const done = pipeline(gzip, createWriteStream(path));

        // Waiting for 'drain' ALONE is a hang waiting to happen. If the pipeline fails while we are parked
        // here -- the staging disk fills, which is exactly what a 700MB dump does to a disk that is nearly
        // full -- there will never be a drain event, and we would wait for it forever with the job's
        // `running` flag stuck true. Race the failure against the drain and let the failure win.
        const drain = (): Promise<void> => Promise.race([
            new Promise<void>(resolve => gzip.once('drain', () => resolve())),
            done.then(
                () => { throw new Error('the snapshot output stream closed while records were still being written'); },
                (err: unknown) => { throw err instanceof Error ? err : new Error(String(err)); }
            )
        ]);

        for (const c of ordered) {
            const line = serialise({
                op: 'container', id: c.id, cid: c.cid, name: c.name,
                ...(c.pr === undefined ? {} : { pr: c.pr }),
                ...(c.pw === undefined ? {} : { pw: c.pw }),
                ...(c.dp === undefined ? {} : { dp: c.dp })
            });
            hash.update(line);
            if (!gzip.write(line)) await drain();
        }

        // The staged objects, streamed straight through -- never materialised.
        for await (const chunk of createReadStream(scratch, { encoding: 'utf8' })) {
            hash.update(chunk as string);
            if (!gzip.write(chunk)) await drain();
        }

        const sha256 = hash.digest('hex');
        gzip.write(serialise({ op: 'end', containers: ordered.length, objects, sha256 }));

        gzip.end();
        await done;

        const { size } = await fsp.stat(path);
        return { containers: ordered.length, objects, bytes: size, sha256 };
    }

    // Read a snapshot back and PROVE it is whole.
    //
    // A snapshot is only worth what it can be trusted to contain, and the moment to find out that it cannot
    // be trusted is now -- while the thing it is a copy of is still sitting right there in Mongo -- not on
    // the day it is the only copy left. So nothing is ever recorded as the current snapshot until it has been
    // read back from the platters, decompressed, parsed line by line, counted, hashed, and found to end where
    // it said it would.
    async verify(path: string, expected: SnapshotStats): Promise<void> {
        const hash = createHash('sha256');
        let containers = 0;
        let objects = 0;
        let trailer: SnapshotRecord | null = null;
        let lineNumber = 0;

        const lines = createInterface({
            input: createReadStream(path).pipe(createGunzip()),
            crlfDelay: Infinity
        });

        for await (const line of lines) {
            lineNumber++;
            if (!line) continue;

            if (trailer)
                throw new Error(`snapshot has records AFTER its end trailer (line ${lineNumber})`);

            let record: SnapshotRecord;
            try {
                record = JSON.parse(line);
            }
            catch (err) {
                throw new Error(`snapshot line ${lineNumber} does not parse: ${err instanceof Error ? err.message : String(err)}`);
            }

            if (record.op === 'end') { trailer = record; continue; }

            hash.update(line + '\n');
            if (record.op === 'container') containers++;
            else if (record.op === 'put') objects++;
            else throw new Error(`snapshot line ${lineNumber} has an unknown op`);
        }

        // NO TRAILER MEANS TRUNCATED. This is the whole reason the trailer exists: a gzip stream cut off
        // part-way still decompresses cleanly to whole, valid, parseable records -- it simply stops. Without
        // something at the end saying "that was all of it", a snapshot missing its last two million objects
        // is indistinguishable from one that never had them.
        if (!trailer || trailer.op !== 'end')
            throw new Error('snapshot has no end trailer: it is TRUNCATED, and there is no way to tell how much of '
                + 'the namespace is missing from it');

        if (containers !== trailer.containers || objects !== trailer.objects)
            throw new Error(`snapshot does not contain what it says it does: read ${containers} containers and `
                + `${objects} objects, trailer claims ${trailer.containers} and ${trailer.objects}`);

        if (hash.digest('hex') !== trailer.sha256)
            throw new Error('snapshot content does not match the checksum in its own trailer: it is corrupt');

        if (containers !== expected.containers || objects !== expected.objects || trailer.sha256 !== expected.sha256)
            throw new Error(`snapshot read back from the platters is not the one we wrote: got ${containers}/${objects} `
                + `(${trailer.sha256.slice(0, 12)}), wrote ${expected.containers}/${expected.objects} `
                + `(${expected.sha256.slice(0, 12)})`);

        log('snapshot verified: %d containers, %d objects, sha256 %s', containers, objects, trailer.sha256.slice(0, 12));
    }
}

// Sort containers so that a parent always precedes its children.
//
// Mongo hands them back in whatever order it likes, and a restore reading the file top to bottom must never
// meet a container whose parent it has not seen -- that is what makes a restore a single forward pass. A
// container whose parent is MISSING entirely (a broken chain, which is exactly the kind of damage a snapshot
// gets taken to survive) is not dropped: it is emitted after everything it could possibly depend on, so the
// restore still gets the name and the operator still gets to decide what to do with it.
export function orderParentsFirst<T extends { id: string; cid: string | null }>(containers: T[]): T[] {
    const byId = new Map(containers.map(c => [c.id, c]));
    const emitted = new Set<string>();
    const out: T[] = [];

    const visit = (c: T, seen: Set<string>): void => {
        if (emitted.has(c.id)) return;
        // A cycle cannot exist in a container tree, and if one does, following it is how a snapshot turns
        // into an infinite loop instead of a recovery artifact.
        if (seen.has(c.id)) {
            log.error('container %s is part of a CYCLE in the container tree; emitting it without its parent', c.id);
            emitted.add(c.id);
            out.push(c);
            return;
        }
        seen.add(c.id);

        const parent = c.cid ? byId.get(c.cid) : undefined;
        if (parent) visit(parent, seen);

        if (!emitted.has(c.id)) {
            emitted.add(c.id);
            out.push(c);
        }
    };

    for (const c of containers) visit(c, new Set());
    return out;
}

export const snapshotBuilder = new SnapshotBuilder();
