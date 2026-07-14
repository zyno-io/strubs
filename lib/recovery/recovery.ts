import { promises as fsp } from 'fs';
import { createHash } from 'crypto';

import { constants, SLICE_MAGIC } from '../constants';
import { createLogger } from '../log';
import { isSliceFileName } from '../io/helpers';

const log = createLogger('recovery');

// RECOVERY: REBUILDING EVERYTHING FROM THE DISKS.
//
// A bare host. Mongo is empty or gone. All that exists is a pile of drives. Everything below reads only the
// platters -- and the order it does it in is the order the dependencies actually run:
//
//   1. The BOOTSTRAP MANIFEST (DR-A), which every disk carries, gives us the instance identity, the whole
//      volume table, and the object id of the newest snapshot. This is what breaks the chicken-and-egg:
//      the fleet cannot mount without the volume config, and the volume config lived in Mongo.
//   2. The SNAPSHOT (DR-D), found by scanning the platters for its slices -- because the one thing we cannot
//      do is look up where they are.
//   3. The JOURNAL (DR-C), replayed over the top, for everything that changed since.
//
// And the whole thing hangs on one property of the format: a slice's 48-byte HEADER carries the object's id,
// size, data/parity counts, slice index and chunk size. The geometry is on the platter, next to the data. So
// a recovery does not need to be told how to read an object -- it needs only to FIND the slices, and they
// explain themselves. That is what "the disks are authoritative" actually buys you, and this is the day it
// gets spent.

export type SliceHeader = {
    id: string;
    size: number;
    dataSliceCount: number;
    paritySliceCount: number;
    sliceIndex: number;
    chunkSize: number;
};

// The magic bytes as they ACTUALLY are on the platters -- `01 c3 bb 02`, not the `01 fb 02 fb` the writer
// once appeared to promise. Declared once, in constants.ts, where the whole story is written down. The
// writer and every reader share it, so this can never drift apart again.

// Read the geometry out of a slice, which is the whole trick.
//
// No database, no manifest, no index: the object's id, its size and the exact shape of its erasure coding are
// written in the first 48 bytes of every one of its slices. Six copies of the truth, on six different disks.
// WHAT A HEADER READ CAN ACTUALLY TELL YOU, and it is three things, not two.
//
// Collapsing them into "header or null" is the mistake this module keeps making in new costumes: a slice file
// that EXISTS on a disk that will not answer is UNKNOWN, and treating it as absent is how a dying disk gets
// reported as an empty one -- and then as data loss, in the report the operator believes.
export type HeaderRead =
    | { status: 'ok'; header: SliceHeader }
    | { status: 'absent' }                  // ENOENT. A fact: this disk does not have this slice.
    | { status: 'corrupt' }                 // It opened, and the bytes are not a header. Also a fact.
    | { status: 'unreadable'; why: string }; // It is THERE and the disk would not hand it over. Not a fact.

export async function readSliceHeader(path: string): Promise<SliceHeader | null> {
    const r = await readSliceHeaderResult(path);
    return r.status === 'ok' ? r.header : null;
}

export async function readSliceHeaderResult(path: string): Promise<HeaderRead> {
    let fh;
    try {
        fh = await fsp.open(path, 'r');
    }
    catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return { status: 'absent' };

        // EIO, EACCES, a USB disk that has stopped talking. The slice may be perfectly intact and the drive
        // simply refusing to hand it over -- so this is NOT "the slice is gone", and anything that counts it
        // that way is about to tell somebody their data is lost when it is sitting right there.
        log.error('%s: cannot be opened (%s). This is a DISK NOT ANSWERING, not a slice that was never written.',
            path, code ?? String(err));
        return { status: 'unreadable', why: code ?? String(err) };
    }

    try {
        const buf = Buffer.alloc(constants.FILE_HEADER_SIZE);

        let bytesRead: number;
        try { ({ bytesRead } = await fh.read(buf, 0, buf.length, 0)); }
        catch (err) {
            // The file opened and then would not READ. Same thing: the disk, not the data.
            const code = (err as NodeJS.ErrnoException).code;
            log.error('%s: opened but could not be read (%s). The disk is not answering.', path, code ?? String(err));
            return { status: 'unreadable', why: code ?? String(err) };
        }

        // Short of a header, or no magic: the file is THERE and it is not a slice we can use. That is a fact
        // about the data, not about the disk, and it is safe to count.
        if (bytesRead < buf.length) return { status: 'corrupt' };
        if (!buf.subarray(0, 4).equals(SLICE_MAGIC)) return { status: 'corrupt' };

        // THE HEADER CHECKSUM IS ADVISORY, AND THAT IS NOT A SHORTCUT -- IT IS THE ONLY HONEST THING TO DO.
        //
        // slice.ts writes an md5 of bytes 23..47 into bytes 7..22, and for everything written by the current
        // code it matches. But this array has been running since 2014, and the scheme has not always been the
        // same one. Sampled against the live platters:
        //
        //     2014 objects:   0 pass,  6 fail
        //     2015 objects: 171 pass, 303 fail      <- the scheme changed part-way through this year
        //     2019 objects: 1446 pass, 0 fail
        //     2026 objects:    6 pass, 0 fail
        //
        // Every one of those "failures" is a perfectly healthy slice whose header was written by an older
        // version of this code. REJECTING them -- which is exactly what this function did until the very first
        // run against the real array -- would have a recovery report a large fraction of the oldest data on
        // this machine as unrecoverable. It would tell someone their 2014 photographs were gone while they sat
        // there, intact, on six disks.
        //
        // A recovery tool that condemns healthy data is worse than no recovery tool, because it will be
        // believed. So: a checksum that MATCHES is strong evidence the header is sound. A checksum that does
        // not match proves nothing at all, and the structural checks below -- which do not depend on the
        // format's history -- have to carry the weight instead.
        const checksumOk = buf.subarray(7, 23)
            .equals(createHash('md5').update(buf.subarray(23, 48)).digest());

        const header: SliceHeader = {
            id: buf.subarray(23, 35).toString('hex'),
            size: buf.readIntLE(35, 5),
            dataSliceCount: buf.readUInt8(40),
            paritySliceCount: buf.readUInt8(41),
            sliceIndex: buf.readUInt8(42),
            chunkSize: buf.readIntLE(43, 3)
        };

        // ...and the geometry has to make SENSE. This is what actually guards the recovery, and unlike the
        // checksum it means the same thing for a slice written in 2014 as for one written this morning. A
        // header claiming zero data slices, or a slice index outside its own object, is nonsense whoever
        // wrote it -- and a recovery that believed it would divide by zero somewhere far away from here.
        if (header.dataSliceCount < 1 || header.paritySliceCount < 0) return { status: 'corrupt' };
        if (header.dataSliceCount + header.paritySliceCount > MAX_SLICES) return { status: 'corrupt' };
        if (header.sliceIndex >= header.dataSliceCount + header.paritySliceCount) return { status: 'corrupt' };
        if (header.chunkSize <= 0 || header.size < 0) return { status: 'corrupt' };

        // The FILENAME says which slice this is. If the header disagrees, one of them is lying, and there is
        // no way to know which -- so we believe neither.
        const dot = path.lastIndexOf('.');
        const fromName = parseInt(path.slice(dot + 1), 10);
        if (Number.isInteger(fromName) && fromName !== header.sliceIndex) {
            log.error('%s: the filename says slice %d and the header says slice %d. Refusing to trust either.',
                path, fromName, header.sliceIndex);
            return { status: 'corrupt' };
        }

        // A header that fails its checksum but passes every structural check is almost certainly just OLD.
        // Worth a word in the log -- somebody may one day want to know how much of the array predates the
        // current format -- and emphatically not worth throwing the data away over.
        if (!checksumOk)
            log('%s: header checksum does not match (this predates the current header format); accepting it on the '
                + 'strength of its structure', path);

        return { status: 'ok', header };
    }
    finally {
        await fh.close();
    }
}

export type Platter = { volumeId: number; mountPoint: string };

// EVERY disk the fleet knows about -- and it REFUSES if one of them is missing.
//
// This is the list that decides what "the platters say" means, and everything built on it is a decision to
// throw a name away: an object whose slices are not in the index is dropped by the restore as an abandoned
// write, reported by the drift scrub as a phantom, and has its pending delete honoured. A volume that failed
// to mount contributes NOTHING to that index -- so quietly leaving it out does not produce a slightly
// incomplete answer, it produces a confidently wrong one, about a disk that is sitting right there full of
// data.
//
// "I could not look at that disk" and "that disk is empty" are different sentences, and only one of them is
// safe to act on.
export type FleetVolume = {
    id: number;
    isDeleted: boolean;
    isMounted: boolean;
    // MOUNTED IS NOT VERIFIED. Volume.start() mounts the filesystem and THEN checks the `.identity` stamp -- and
    // when that check fails it throws without unmounting, so the disk sits there, mounted, rejected, and (until
    // this was fixed) counted as one of ours. A disk we could not vouch for must never become evidence about
    // this array: its slices are not our slices, and its silence is not our silence.
    isStarted: boolean;
    mountPoint?: string;
};

export function allPlattersOrRefuse(): Platter[] {
    const { ioManager } = require('../io/manager') as typeof import('../io/manager');
    return plattersOrRefuse([...ioManager.getVolumeEntries()].map(([, v]) => v as unknown as FleetVolume));
}

// The decision itself, separated from where the fleet happens to live so that it can be tested. Both of the
// refusals below were absent from this function until it was run for real, and both are the same mistake.
export function plattersOrRefuse(volumes: FleetVolume[]): Platter[] {
    const platters: Platter[] = [];
    const missing: number[] = [];

    for (const volume of volumes) {
        if (volume.isDeleted) continue;                    // retired on purpose: not expected to be here

        // STARTED, not merely mounted: the volume mounted AND its `.identity` proved it is one of ours. A disk
        // that mounted and failed that check is not a disk we can read conclusions from -- and it is not
        // "missing" either, it is WORSE than missing, because it is sitting there looking available.
        if (volume.isStarted && volume.isMounted && volume.mountPoint)
            platters.push({ volumeId: volume.id, mountPoint: volume.mountPoint });
        else
            missing.push(volume.id);
    }

    // NO VOLUMES AT ALL is not "an empty array", it is a fleet that has not come up -- and it is the most
    // dangerous input this function can be handed, because every caller reads an empty platter list as "not one
    // object on this machine has a single slice anywhere". The drift scrub would report all 3.5M objects as
    // phantoms. A restore would decide every put should be dropped. Both would be acting, with total
    // confidence, on the exact inversion of the truth.
    //
    // The `missing` check below cannot catch this: with no volume entries there is nothing to be missing, and
    // the loop falls straight through to an empty, entirely reassuring answer.
    if (!platters.length && !missing.length)
        throw new Error('refusing to draw conclusions about the array: the fleet reports NO volumes at all. That is '
            + 'not an empty array, it is a fleet that has not come up -- and treating it as an empty array would '
            + 'report every object on this machine as data loss. Bring the fleet up and run this again.');

    if (missing.length)
        throw new Error(`refusing to draw conclusions about the array while volume(s) ${missing.join(', ')} are not `
            + `mounted. Every object whose slices live only on those disks would look like it had none at all -- `
            + `which this would then report as data loss, or act on by throwing its name away. Mount them, or delete `
            + `them from the fleet if they are genuinely gone, and run this again.`);

    return platters;
}

// WHERE EVERYTHING IS, built by walking each disk exactly once.
//
// The obvious way to write a restore is to take each object in turn and go looking for its slices. That is
// 3.5 million objects against 34 disks, which is 119 million directory reads, and it does not finish. The
// disks are the slow part and there are only so many of them, so you walk THEM, not the namespace.
//
// The filename does most of the work: a slice is `<24-hex-id>.<n>`, so the id and the slice index are free.
// The only thing that has to come out of a header is the object's size and erasure geometry -- and one slice
// can say that for all six, so it is one 48-byte read per object rather than one per slice.
// COMPACT, because this has to hold the whole array in memory on a machine with 15GB of it. 21 million
// slice files, one entry each, and a path string per slice would be two gigabytes of nothing but filenames.
// So we store the only thing that cannot be recomputed -- WHICH DISK -- as a single byte per slice index,
// and rebuild the path from the id when we finally need it (which is once per object, not once per slice).
//
// 0 means "not found". Volume ids are stored +1 so that zero can mean absent, which is exactly the kind of
// detail that is fine in a comment and a disaster in an unexplained magic number.
//
// Uint16, not Uint8, and the extra byte is not laziness. Volume ids are a byte on disk, so 255 is a legal
// one -- and 255 + 1 in a Uint8Array is 0, which this encoding reads as "absent". A volume 255 would have
// every one of its slices quietly vanish from the recovery, and the objects on it would be reported as data
// loss by the very tool that was supposed to find them. 42MB of extra memory to make an entire disk
// representable is not a trade, it is a bargain.
export type SliceIndex = Map<string, Uint16Array>;

export const MAX_SLICES = 32;

export async function buildSliceIndex(
    platters: Platter[],
    onProgress?: (files: number) => void
): Promise<SliceIndex> {
    const index: SliceIndex = new Map();
    let files = 0;

    // A DIRECTORY WE COULD NOT READ IS NOT AN EMPTY DIRECTORY.
    //
    // Everything downstream of this index treats an id's absence from it as a fact about the world: the
    // restore drops the object's name as an abandoned write, the drift scrub reports it as a phantom, and a
    // `del` that never completed gets honoured. Every one of those is a decision to THROW A NAME AWAY, made
    // on the strength of a readdir that quietly returned nothing because a disk was too sick to answer.
    //
    // So the errors are collected, and the scan REFUSES to hand back a picture of the array it knows to be
    // incomplete. Being unable to scan is a bad day. Scanning wrong and acting on it is a much worse one.
    const unreadable: string[] = [];

    // IN PARALLEL, because these are 34 independent spindles and walking them one at a time makes the whole
    // recovery as slow as the sum of the disks rather than as slow as the slowest one. On a bad day that is
    // the difference between two hours and four minutes, and a bad day is the only day this ever runs.
    const CONCURRENCY = 12;
    const queue = [...platters];

    const worker = async (): Promise<void> => {
        for (;;) {
            const platter = queue.shift();
            if (!platter) return;

            const root = `${platter.mountPoint}/strubs`;

            // The tree is sharded aa/bb/cc. Walking it explicitly, rather than recursively, keeps us out of
            // .journal/, .tmp/, .bootstrap.json and lost+found -- every one of which is a recovery artifact
            // in its own right, and not one of which is a slice.
            for (const a of await hexDirs(root, unreadable))
                for (const b of await hexDirs(`${root}/${a}`, unreadable))
                    for (const c of await hexDirs(`${root}/${a}/${b}`, unreadable))
                        for (const entry of await readdirStrict(`${root}/${a}/${b}/${c}`, unreadable)) {
                            if (!isSliceFileName(entry)) continue;

                            const dot = entry.lastIndexOf('.');
                            const id = entry.slice(0, dot);
                            const sliceIndex = parseInt(entry.slice(dot + 1), 10);
                            if (!Number.isInteger(sliceIndex) || sliceIndex < 0 || sliceIndex >= MAX_SLICES) continue;

                            let slots = index.get(id);
                            if (!slots) index.set(id, slots = new Uint16Array(MAX_SLICES));

                            // A duplicate slice index across two disks is not impossible: a relocation
                            // interrupted after the copy and before the source was unlinked leaves exactly
                            // that. Either copy decodes -- they are the same bytes -- so the first one found
                            // wins, and carrying a list per slice for 21 million files to record the second
                            // would cost more memory than the case is worth.
                            //
                            // The first copy may of course be the CORRUPT one. That is not resolved here, and
                            // it is not shrugged off either: synthesiseRecordFromIndex() goes and looks for the
                            // other copies -- but only for an object that has actually come up short, which is
                            // the handful of objects where it matters rather than all 3.5 million. Reporting an
                            // object lost while an intact copy of the slice it needs is sitting on the next
                            // disk over is the worst call this code could make, and "we only kept the first
                            // one" would be a poor reason to have made it.
                            if (!slots[sliceIndex]) slots[sliceIndex] = platter.volumeId + 1;

                            // Every 50k rather than every million: at ~23,000 files a second (measured on the
                            // fullest disk in this array) that is a tick roughly every two seconds, which is
                            // what a UI needs to prove it is not wedged. A million-file interval would tick
                            // twice in a 90-second scan.
                            if (++files % 50_000 === 0) onProgress?.(files);
                        }
        }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, platters.length) }, worker));

    if (unreadable.length)
        throw new Error(`refusing to report on the array: ${unreadable.length} director(ies) could not be read `
            + `(first: ${unreadable[0]}). Everything built on this scan treats a missing slice as a decision to `
            + `throw a name away, and a disk that would not answer is not a disk with nothing on it. Fix the disk, `
            + `or take it out of the fleet, and run this again.`);

    onProgress?.(files);
    return index;
}

// ENOENT is a fact (there is nothing here). Anything else is an unanswered question, and it is recorded.
const readdirStrict = async (dir: string, unreadable: string[]): Promise<string[]> => {
    try {
        return await fsp.readdir(dir);
    }
    catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') unreadable.push(dir);
        return [];
    }
};

const hexDirs = async (dir: string, unreadable: string[]): Promise<string[]> =>
    (await readdirStrict(dir, unreadable)).filter(d => /^[0-9a-f]{2}$/.test(d));

export const slicePath = (mountPoint: string, id: string, sliceIndex: number): string =>
    `${mountPoint}/strubs/${id.slice(0, 2)}/${id.slice(2, 4)}/${id.slice(4, 6)}/${id}.${sliceIndex}`;

// Where does object `id` actually live?
//
// The record in Mongo used to tell us. It is gone, so we go and look -- which is precisely what the design
// has always insisted the truth is anyway. dataVolumes/parityVolumes in a journal record are a DIAGNOSTIC
// HINT and are never trusted for exactly this reason: drain and rebalance relocate slices without telling
// anyone, so a recorded placement can name a disk the slice left months ago.
export async function locateSlices(id: string, platters: Platter[]): Promise<Map<number, { volumeId: number; path: string }>> {
    const shard = `${id.slice(0, 2)}/${id.slice(2, 4)}/${id.slice(4, 6)}`;
    const found = new Map<number, { volumeId: number; path: string }>();

    for (const platter of platters) {
        const dir = `${platter.mountPoint}/strubs/${shard}`;

        // ENOENT is the ordinary case and means exactly what it says: this disk holds no slice of this object,
        // because the shard directory was never created on it. Anything ELSE -- EIO, EACCES, a disk that has
        // stopped answering -- means we do not KNOW what this disk holds, and quietly returning "nothing" would
        // subtract its slices from the count. Do that to two disks of a 4+2 object and a perfectly healthy file
        // is declared below quorum: unrecoverable, irreversible, and wrong. Refuse instead of guessing.
        const entries = await fsp.readdir(dir).catch((err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') return [] as string[];
            throw new Error(`cannot read ${dir} on volume ${platter.volumeId} (${err.code ?? err.message}). `
                + `Refusing to report on object ${id} while a disk that may hold its slices cannot be read: `
                + `counting them as absent could declare a healthy object lost.`);
        });

        for (const entry of entries) {
            if (!isSliceFileName(entry) || !entry.startsWith(`${id}.`)) continue;

            const sliceIndex = parseInt(entry.slice(entry.lastIndexOf('.') + 1), 10);

            // A DUPLICATE slice index across two disks is not impossible: a relocation interrupted after the
            // copy and before the source was unlinked leaves exactly that. Either copy decodes -- they are
            // the same bytes -- so take the first and say so rather than fail.
            if (found.has(sliceIndex)) {
                log('object %s has slice %d on more than one volume (%d and %d): using the first',
                    id, sliceIndex, found.get(sliceIndex)!.volumeId, platter.volumeId);
                continue;
            }

            found.set(sliceIndex, { volumeId: platter.volumeId, path: `${dir}/${entry}` });
        }
    }

    return found;
}

// The record Mongo WOULD have held, rebuilt from what the platters say.
//
// This is what lets a recovery reuse the entire existing read path -- the planner, the reader, the
// Reed-Solomon decoder -- instead of reimplementing erasure coding in a recovery tool, which is the last
// place you want a second implementation of anything.
//
// Returns null when the object cannot be read: fewer than dataSliceCount slices survive, so no arrangement
// of what is left can reconstruct it. That is a real, and reportable, loss.
export async function synthesiseRecordFromIndex(
    id: string,
    slots: Uint16Array | undefined,
    mountOf: (volumeId: number) => string | undefined,
    // A REAL volume id to stand in for a slice we could not find. Not -1: the reader builds a Slice for every
    // index before it works out what is available, and Slice's constructor looks the volume up and throws if
    // it does not exist -- so a -1 would blow up the read of every degraded object, which is to say every
    // object a recovery is actually there to rescue. A real volume with no such file on it is precisely what a
    // missing slice looks like on an ordinary day, and the reader already knows what to do about that: it
    // reconstructs it. 4+2 is not a special case here; it is the whole point.
    placeholderVolumeId: number,
    // Every disk in the array, so that an object which comes up short can be checked against the OTHER copies
    // of its slices before it is written off. Optional only because the callers that already know the object
    // is fine have no need to hand it over.
    platters?: Platter[],
    // The array's CONFIGURED geometry (4+2 here). Used for one thing only: when not a single header can be
    // read -- every slice on a disk that will not answer -- there is nothing to describe the object WITH, and
    // yet we still want to keep its name. This supplies the shape so the record we write is one the reader can
    // actually open, instead of a landmine that faults the moment somebody touches it.
    fleetGeometry?: { dataSlices: number; paritySlices: number }
): Promise<{
    // NULL when the object cannot be described -- which now has an innocent cause as well as a guilty one: if
    // every slice is on a disk that would not answer, there is no header to describe it WITH, and that is not
    // the object's fault. Callers must check `reason` before concluding anything from a null record.
    record: Record<string, unknown> | null;
    recoverable: boolean;
    found: number;
    needed: number;
    // WHY it is not recoverable, because "found 1 of the 1 slices it needs" is not a sentence that helps
    // anybody. When the geometry itself is uncorroborated, `needed` is a number we do not believe -- it came
    // from the single rotted header we are refusing to trust -- and reporting the shortfall in terms of it
    // describes an object that does not exist. Say which of the two things actually went wrong.
    // How many of its slices are on disks that would not answer. These EXIST -- we could not look at them --
    // and they are never counted as loss.
    unknown: number;
    reason: 'ok' | 'below-quorum' | 'uncorroborated-geometry' | 'indeterminate';
} | null> {
    if (!slots) return null;

    // THE GEOMETRY HAS TO BE AGREED, NOT MERELY READ.
    //
    // Every slice carries the same geometry -- that is what makes the format self-describing -- so the cheap
    // thing is to read one header and believe it. That was this function's first version, and it is wrong, and
    // it became MORE wrong the moment the header checksum was demoted to advisory (which it had to be: see
    // readSliceHeader). A header can now be structurally plausible, pass every check we make, and still be
    // corrupt -- and this one header decides the object's SIZE and CHUNK SHAPE. Get those wrong and the reader
    // decodes 4+2 against the wrong geometry and produces confident garbage, or nothing, for an object we have
    // just told the operator was successfully restored.
    //
    // So: no single disk gets to decide what an object looks like. Read headers until TWO slices, on two
    // different disks, agree on the WHOLE geometry -- and that is the shape. A single flipped bit cannot
    // manufacture agreement; it can only fail to join it. In the ordinary case this costs exactly two reads.
    const headers = new Map<number, SliceHeader | null>();

    // The slices whose disks WOULD NOT ANSWER. Not corrupt, not missing -- unknown. They are tracked apart
    // from everything else because they are the one category that must never be counted as loss.
    const unknown = new Set<number>();

    const readHeader = async (i: number): Promise<SliceHeader | null> => {
        if (headers.has(i)) return headers.get(i)!;

        const mount = slots[i] ? mountOf(slots[i] - 1) : undefined;
        if (!mount) { headers.set(i, null); return null; }

        const r = await readSliceHeaderResult(slicePath(mount, id, i));
        if (r.status === 'unreadable') unknown.add(i);

        const usable = r.status === 'ok' && r.header.id === id ? r.header : null;
        headers.set(i, usable);
        return usable;
    };

    const shapeOf = (h: SliceHeader) =>
        `${h.size}:${h.dataSliceCount}:${h.paritySliceCount}:${h.chunkSize}`;

    // EVERY header, not the first two that happen to agree.
    //
    // The first version of this stopped as soon as any shape had two votes, which is a rule that hands the
    // object to whichever pair is read FIRST. Corrupt slices 0 and 1 in the same way -- one bad batch, one bad
    // cable, one bad controller writing the same garbage twice -- and they win the vote before slices 2, 3, 4
    // and 5 are ever asked, all four of them agreeing on the truth. Reading them all costs six 48-byte reads
    // on an object we are already about to rebuild; being wrong costs the object.
    //
    // And the votes are counted by VOLUME, not by slice. Two slices agreeing means nothing if they are two
    // files on the SAME disk -- a rebalance that copied a slice and died leaves exactly that -- because the
    // whole point of corroboration is that a second, independent piece of hardware says the same thing. One
    // platter does not get to corroborate itself.
    // ALL OF THEM AT ONCE, and this is not a micro-optimisation -- it is the difference between a tool you
    // would actually run and one you would not.
    //
    // Reading every header is what makes the vote sound, and on this array a cold header read costs ~10ms:
    // these are spinning USB disks and it is a seek, not a transfer. Six of those in a row, 3.5 million times,
    // is FIVE HOURS of pure waiting -- and reading them one after another is a strange way to spend it, because
    // in 4+2 the six slices of an object are on six DIFFERENT SPINDLES. They are not queued behind each other;
    // they are six disks sitting idle while we talk to one of them.
    //
    // Issued together they overlap almost perfectly, and the whole object costs about one seek instead of six.
    // Same reads, same votes, same answer -- roughly an hour instead of five.
    const present: number[] = [];
    for (let i = 0; i < MAX_SLICES; i++) if (slots[i]) present.push(i);

    await Promise.all(present.map(i => readHeader(i)));

    const votes = new Map<string, { header: SliceHeader; volumes: Set<number>; slices: number }>();
    let readable = 0;

    for (const i of present) {
        const h = headers.get(i) ?? null;
        if (!h) continue;
        readable++;

        const shape = shapeOf(h);
        const tally = votes.get(shape) ?? { header: h, volumes: new Set<number>(), slices: 0 };
        tally.volumes.add(slots[i] - 1);
        tally.slices++;
        votes.set(shape, tally);
    }

    // NOT ONE READABLE HEADER -- but WHY?
    //
    // If every slice file is corrupt or absent, that is a fact, and the object is undescribable. If they are
    // all sitting on disks that WOULD NOT ANSWER, that is not a fact about the object at all, and returning
    // null here sends it downstream as "no slices anywhere" -- which the drift scrub escalates as irreversible
    // data loss and the restore acts on by discarding the name.
    //
    // The whole `indeterminate` verdict below is useless if the function bails out in front of it. This is the
    // same bug the verdict exists to fix, hiding one line further up.
    if (!readable) {
        if (!unknown.size) return null;

        // AND IT STILL HAS TO CLEAR QUORUM, even here. An object with ONE unreadable slice, or a single stray
        // unreadable `id.7`, has not become "unknown" -- it is short, and it would be short even if the disk
        // came back and every unreadable slice on it turned out perfect. Calling that indeterminate would keep
        // a name alive for data that cannot be reconstructed under any outcome, which is the comforting lie
        // again: the operator sees "fix the disk" where they should see "this is gone".
        //
        // Without a header we have no geometry of our own, so the array's configured shape is the only bar
        // there is. And if we do not even have THAT, we cannot judge -- which means we do not get to condemn
        // it either. No bar, no verdict: it stays unknown, which is the honest answer and the safe one.
        const couldClear = !fleetGeometry
            || [...unknown].filter(i => i < fleetGeometry.dataSlices + fleetGeometry.paritySlices).length
                >= fleetGeometry.dataSlices;

        if (!couldClear) {
            log.error('object %s: no readable header, and the %d unreadable slice(s) could not reach quorum even if '
                + 'every one of them were perfect. It is not unknown -- it is GONE.', id, unknown.size);
            return null;
        }

        log.error('object %s: NOT ONE of its slice headers could be read, and %d of them are on disks that would '
            + 'not answer. It is not lost -- it is UNKNOWN. Fix the disk and run this again.', id, unknown.size);

        // A RECORD THE READER CAN ACTUALLY OPEN, or none at all.
        //
        // We keep this object's name because throwing a name away is irreversible. But a record without
        // dataVolumes/parityVolumes is not a kept name, it is a booby trap: file-object.ts reads
        // `record.dataVolumes.length` the instant anybody opens it, and faults. The index knows which VOLUMES
        // these slices are on -- it just could not read their headers -- and the array's geometry is known
        // config, so the record can be built honestly from those two facts and nothing else.
        const g = fleetGeometry;
        const record = g
            ? {
                id,
                dataVolumes: Array.from({ length: g.dataSlices },
                    (_, i) => (slots[i] ? slots[i] - 1 : placeholderVolumeId)),
                parityVolumes: Array.from({ length: g.paritySlices },
                    (_, i) => (slots[g.dataSlices + i] ? slots[g.dataSlices + i] - 1 : placeholderVolumeId)),
                isFile: true
            }
            : null;

        return {
            record,
            recoverable: false,
            found: 0,
            needed: g?.dataSlices ?? 0,
            unknown: unknown.size,
            reason: 'indeterminate'
        };
    }

    // The winner is the shape the most DISKS vouch for -- and it has to beat every other shape outright. A tie
    // is not a narrow win, it is the absence of an answer: two disks say the object is 100 bytes, two say it is
    // 999999, and nothing here can tell you which pair is the corrupt one. Restoring on a coin-toss would be a
    // guess handed to an operator as a fact, so we refuse and report it undescribable rather than wrong.
    const rank = (v: { volumes: Set<number>; slices: number }) => [v.volumes.size, v.slices];
    const ranked = [...votes.entries()].sort((a, b) =>
        rank(b[1])[0] - rank(a[1])[0] || rank(b[1])[1] - rank(a[1])[1]);

    const [winningShape, winner] = ranked[0];
    const describe = () => ranked.map(([shape, v]) => `${shape} on ${v.volumes.size} disk(s)`).join(' vs ');

    if (ranked.length > 1
        && rank(ranked[1][1])[0] === rank(winner)[0]
        && rank(ranked[1][1])[1] === rank(winner)[1]) {
        log.error('object %s: its slice headers are SPLIT between shapes with no majority (%s). Its geometry cannot '
            + 'be established, and it will not be restored on a guess.', id, describe());
        return null;
    }

    // CORROBORATION, and what it is actually for: no SINGLE header gets to decide what an object looks like.
    // Two agreeing headers clear that bar, because a corrupt one would need a second, identically corrupt one
    // to match it. Two agreeing DISKS clear it by a mile, and that is the normal case -- 4+2 puts every slice
    // on a different volume -- so it is what we rank by.
    //
    // But agreement confined to one disk is NOT a reason to throw the object away. Refusing there would turn a
    // recoverable object into reported data loss over a redundancy technicality, and that trade is exactly
    // backwards: orphans beat phantoms, and a wrongly-condemned object is the worst phantom of all. Take it,
    // and say out loud that the corroboration was thinner than we would like.
    const agreed = winner.header;

    if (winner.volumes.size < 2 && winner.slices >= 2)
        log('object %s: its shape is agreed by %d slices but they are all on volume %d, so no second disk '
            + 'corroborates it. Accepting it -- an object is not lost because its redundancy is.',
            id, winner.slices, [...winner.volumes][0]);

    if (winner.slices < 2) {
        // A single readable header, uncorroborated by anything. For 4+2 that means the object is below quorum
        // regardless, so its exact shape is academic -- and reporting it "undescribable" rather than "below
        // quorum" would only obscure what actually happened to it.
        if (readable > 1) {
            log.error('object %s: not one of its readable headers is corroborated by any other (%s). Its geometry '
                + 'cannot be established, and it will not be restored on a guess.', id, describe());
            return null;
        }

        log('object %s: only one slice header could be read, so its geometry is UNCORROBORATED. It is below quorum '
            + 'in any case.', id);
    }

    const { size, dataSliceCount, paritySliceCount, chunkSize } = agreed;
    const total = dataSliceCount + paritySliceCount;

    const dataVolumes: number[] = [];
    const parityVolumes: number[] = [];
    for (let i = 0; i < total; i++) {
        const volumeId = slots[i] ? slots[i] - 1 : placeholderVolumeId;
        if (i < dataSliceCount) dataVolumes.push(volumeId);
        else parityVolumes.push(volumeId);
    }

    // QUORUM IS COUNTED IN SLICES THAT ACTUALLY DECODE, and nothing else.
    //
    // The obvious count -- how many slice FILES are there -- is wrong in a way that reports catastrophe as
    // success. A file whose header is unreadable still has a name. A file whose header describes a DIFFERENT
    // shape is not a spare copy of this object; it cannot be decoded with the geometry we are about to write
    // down. Count six filenames on a 4+2 object where only three headers agree with the winner, and we would
    // hand back `recoverable: true` for an object that is below quorum and gone.
    //
    // The vote above already read every header, so the count is free: `winner.slices` IS the number of slices
    // that are readable AND agree with the shape we settled on. That is the only number that means anything.
    let found = winner.slices;

    // ...AND A SINGLE HEADER CANNOT ESTABLISH ITS OWN QUORUM. This is the subtlest way this function could
    // lie, and the most dangerous. `needed` comes from the header's own dataSliceCount -- so one surviving
    // slice, whose header has rotted `4` into `1`, would announce that it needs one slice, observe that it
    // has one slice, and report a 4+2 object as fully recoverable from a single fragment. The restore would
    // write the record, the operator would be told it came back, and the object would be gone.
    //
    // Corroboration is what makes geometry believable, so where there is none, there is no quorum to speak
    // of. Two agreeing headers is the floor: a rotted count would need a second disk to have rotted the same
    // way, and that does not happen.
    let corroborated = found >= 2;
    let recoverable = corroborated && found >= dataSliceCount;

    // BEFORE WE CALL IT LOST, LOOK FOR THE OTHER COPY.
    //
    // The slice index records ONE volume per slice index -- the first disk it was found on -- and throws any
    // duplicate away. But duplicates are not a theoretical curiosity here: a relocation that copied a slice
    // and died before unlinking the source leaves exactly that, and this array has been rebalancing. So the
    // copy the index happens to have picked may be the corrupt one, while an intact copy of the very same
    // slice sits on another disk, unexamined, because it was second in the walk.
    //
    // Declaring an object lost while a good copy of the slice it needs is on a platter a metre away is the
    // worst thing this module can do. So when -- and only when -- an object comes up short, go and look. It
    // costs nothing in the normal case, because in the normal case we never get here.
    if (platters && !recoverable) {
        for (let i = 0; i < total && found < dataSliceCount; i++) {
            const have = headers.get(i) ?? null;
            if (have && shapeOf(have) === winningShape) continue;      // this slice is already good

            const already = slots[i] ? slots[i] - 1 : -1;
            for (const p of platters) {
                if (p.volumeId === already) continue;                  // the copy we already tried

                // The HONEST read, not the lossy wrapper. A duplicate copy sitting on a disk that will not
                // answer is another thing we do not know -- and swallowing it here would let the object be
                // called below-quorum on the strength of a disk nobody could look at.
                const r = await readSliceHeaderResult(slicePath(p.mountPoint, id, i));

                if (r.status === 'unreadable') { unknown.add(i); continue; }
                if (r.status !== 'ok' || r.header.id !== id || shapeOf(r.header) !== winningShape) continue;

                log('object %s: slice %d was no good on volume %d, but an intact copy of it is on volume %d '
                    + '(an interrupted relocation leaves exactly this). Using it.', id, i, already, p.volumeId);

                if (i < dataSliceCount) dataVolumes[i] = p.volumeId;
                else parityVolumes[i - dataSliceCount] = p.volumeId;

                // And it is no longer unknown -- we have it. Leaving it in the set would let a genuinely
                // below-quorum object masquerade as indeterminate, which is the same lie pointing the other
                // way, and the more comforting one: nobody goes looking for a backup.
                unknown.delete(i);
                found++;
                break;
            }
        }

        corroborated = found >= 2;
        recoverable = corroborated && found >= dataSliceCount;
    }

    // AND NOW THE THING WE DO NOT KNOW.
    //
    // Some of this object's slices are on disks that would not answer -- EIO, a USB drive that has dropped off
    // its bus, a controller that has stopped talking. Those slices EXIST. We simply could not look at them.
    //
    // If they would clear quorum, then this object is not lost, and we have no business saying that it is.
    // "Below quorum" means the data is gone; that is a sentence the drift scrub escalates as REAL, IRREVERSIBLE
    // DATA LOSS, and it is exactly the sentence an operator acts on. Saying it about an object whose slices are
    // sitting, intact, on a disk that needs re-seating would be the worst lie this module could tell.
    //
    // So it gets its own answer: INDETERMINATE. Fix the disk, run it again, and then we will know.
    // There has to BE something we could not see. With no unread disks, `found + 0 >= needed` is just the
    // recoverable test wearing a different hat, and it would relabel a genuinely lost object "indeterminate" --
    // which is the mirror of the bug this is here to fix, and every bit as dishonest.
    // ...AND ONLY SLICES THAT BELONG TO THIS OBJECT COUNT AS "UNKNOWN".
    //
    // A stray `id.7` next to a 4+2 object is not a seventh slice, it is somebody's mistake -- and if it happens
    // to be unreadable, counting it here would inflate `unknown` until a genuinely below-quorum object cleared
    // the bar and got reported as merely indeterminate. That is the comforting lie, which is the worse one:
    // nobody goes looking for a backup when they have been told their data is probably fine.
    const unknownInGeometry = [...unknown].filter(i => i < total).length;

    const indeterminate = !recoverable
        && unknownInGeometry > 0
        && (found + unknownInGeometry) >= dataSliceCount;

    if (indeterminate)
        log.error('object %s: %d slice(s) are on disks that would not answer, so it cannot be judged. It is NOT '
            + 'being reported as lost -- fix the disk and run this again.', id, unknownInGeometry);

    return {
        record: {
            id,
            size,
            chunkSize,
            dataVolumes,
            parityVolumes,
            isFile: true
        },
        recoverable,
        found,
        needed: dataSliceCount,
        unknown: unknownInGeometry,
        reason: recoverable ? 'ok'
            : indeterminate ? 'indeterminate'
            : corroborated ? 'below-quorum'
            : 'uncorroborated-geometry'
    };
}
