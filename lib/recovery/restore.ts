import { promises as fsp, createReadStream } from 'fs';
import { createGunzip } from 'zlib';
import { createInterface } from 'readline';
import { pipeline } from 'stream/promises';
import os from 'os';
import path from 'path';

import { createHash } from 'crypto';

import { createLogger } from '../log';
import { allPlattersOrRefuse, buildSliceIndex, locateSlices, synthesiseRecordFromIndex, MAX_SLICES, type Platter } from './recovery';
import type { BootstrapManifest } from '../io/bootstrap-manifest';

const log = createLogger('restore');

// REBUILDING THE INDEX FROM THE PLATTERS.
//
// Mongo is gone. The disks are not. This is the day the entire design gets cashed in, and the order of it
// matters as much as any of it:
//
//   1. The bootstrap manifest gives us the volume table. (Without this the fleet cannot even MOUNT, because
//      the volume config used to live in the database we no longer have. This is the chicken-and-egg the
//      manifest exists to break, and it is why it is written to every disk rather than one.)
//   2. The snapshot object is FOUND by scanning the platters for its slices, and reconstructed through the
//      ordinary reader -- 4+2 and all -- because its geometry is in the slice headers.
//   3. The snapshot is replayed to rebuild the namespace, and the journal is replayed over the top for
//      everything that changed after it was taken.
//   4. And EVERY record is checked against the disks before it is believed.
//
// That last step is not paranoia, it is the whole contract. The journal records INTENT and is made durable
// BEFORE the operation it describes completes -- so it can honestly contain a `put` for an object that was
// abandoned, or a `del` for one whose deletion failed. A restore that trusted it blindly would manufacture
// objects that never existed and delete ones that still do. So:
//
//     a `put` is materialised ONLY IF its slices are actually FOUND on the platters
//     a `del` is honoured     ONLY IF its slices are actually GONE from the platters
//
// The journal supplies the names. The disks supply the truth.

export type RestoreRecord =
    | { op: 'container'; id: string; cid: string | null; name: string; pr?: boolean; pw?: boolean; dp?: boolean }
    | { op: 'put'; id: string; cid: string | null; name: string; mime?: string | null; md5?: string | null; size: number; cs: number }
    | { op: 'del'; id: string }
    | { op: 'policy'; id: string; pr?: boolean; pw?: boolean; dp?: boolean }
    | { op: 'end'; containers: number; objects: number; sha256: string };

export type RestoreSummary = {
    containers: number;
    objectsInNamespace: number;      // what the snapshot + journal SAY exists
    objectsRestored: number;         // ...and what the platters actually back up
    objectsMissing: number;          // named, but no slices at all: the data is genuinely gone
    objectsUnrecoverable: number;    // slices exist but cannot be decoded: below quorum, or no readable header

    // Rows removed because the rebuilt namespace does not contain them. On an empty database this is zero; on
    // a forced or resumed restore it is the deleted objects that would otherwise have come back from the dead.
    rowsPruned: number;

    // Journalled policy records that would have OPENED a bucket, and were refused. A restore may close a
    // bucket, never open one -- see the note in the replay. Surfaced so the operator can re-apply them.
    policiesDeclined: number;


    // Objects we could not JUDGE, because slices of them are on disks that would not answer. Their names are
    // RESTORED -- the slice files exist, and a name whose data may be perfectly fine is not something to throw
    // away over a drive that needs re-seating. Throwing a name away is irreversible; a phantom is not.
    objectsIndeterminate: number;

    // WHICH SNAPSHOT THIS NAMESPACE ACTUALLY CAME FROM, and whether that was the one we meant to use.
    //
    // A restore that quietly fell back to the PREVIOUS snapshot and then returned a cheerful 200 would hide the
    // two things the operator most needs to know: that the current snapshot object is unreadable or below
    // quorum (which is a real fault on the platters, and it will still be there tomorrow), and that the
    // namespace they are now looking at is older than the one they asked for.
    snapshotUsed: string;
    fellBackToPrevious: boolean;
    currentSnapshotError?: string;
    delsIgnored: number;             // journal said deleted, the slices are still there: the delete failed
    putsDropped: number;             // journal said created, no slices: the write was abandoned
};

export type RestoreDeps = {
    platters: () => Platter[];
    // How many objects the database already believes in. A recovery restores into an EMPTY database; if this
    // is not zero, whatever is being run is not a recovery.
    objectsInDatabase: () => Promise<number>;
    // Read the snapshot object out of the array, by scanning for its slices -- no database involved.
    fetchSnapshot: (objectId: string, to: string) => Promise<void>;
    journalSegments: (opts: { force: boolean }) => Promise<string[]>;
    fleetRestoreIncomplete: () => Promise<{ expected: number; startedAt: string } | null>;
    // The array's configured erasure geometry. Needed only to keep the NAME of an object whose every slice is
    // on a disk that will not answer -- there is no header to describe it with, and a record without volumes
    // faults on read.
    fleetGeometry: () => { dataSlices: number; paritySlices: number };
    // Lowered ONLY by a namespace restore that actually applied. Until then STRUBS stays in recovery mode --
    // see the note in core.ts about the snapshot job cheerfully overwriting the pointer to the real namespace.
    namespaceRestored: () => Promise<void>;
    // The restore's own bracket, so a crash halfway through can be RESUMED rather than refused.
    restoreInFlight: () => Promise<{ startedAt: string } | null>;
    // The OTHER half of "this database is not authoritative". Either marker means a restore is a resume.
    namespaceRestorePending: () => Promise<{ startedAt: string } | null>;

    // TRUE when we could not read every manifest while working out WHERE THE JOURNAL LIVES -- so the disk that
    // knows may be one of the ones that would not answer.
    journalLocationUncertain: () => boolean;

    // Remove everything the rebuilt namespace does NOT contain. Upserts only ADD, so without this a deleted
    // object -- which is absent from the snapshot precisely BECAUSE it was deleted -- walks back into the
    // namespace on a forced or resumed restore.
    pruneOutsideNamespace: (keep: Set<string>) => Promise<number>;
    beginRestore: () => Promise<void>;
    endRestore: () => Promise<void>;
    // Write a rebuilt record into Mongo. Injected so a DRY RUN can count without touching anything.
    writeContainer: (r: { id: string; cid: string | null; name: string; bucketId: string | null; pr?: boolean; pw?: boolean; dp?: boolean }) => Promise<void>;
    writeObject: (r: Record<string, unknown>) => Promise<void>;
};

export class NamespaceRestore {
    constructor(private readonly deps: RestoreDeps) {}

    // Rebuild the namespace from a snapshot object plus every journal segment, and return an honest account
    // of what came back and what did not.
    async run(
        snapshot: BootstrapManifest['snapshot'],
        opts: { apply: boolean; force?: boolean; previous?: BootstrapManifest['snapshot'] }
    ): Promise<RestoreSummary> {
        // THE FLEET FIRST, BEFORE ANYTHING ELSE IS DIAGNOSED.
        //
        // This check has to come before the snapshot-pointer check, and not for tidiness. In recovery mode the
        // manifest is never hydrated, so `snapshot` is null -- and asking about it first makes an interrupted
        // fleet restore report "there is no snapshot pointer: there is nothing to restore FROM", which is a
        // sentence that would stop an operator's heart and is not true. The snapshot is fine. The FLEET is
        // half-written, and that is a thing they can actually fix.
        //
        // A RESTORE ON A HALF-WRITTEN FLEET DISCARDS THE NAMES OF EVERY DISK IT CANNOT SEE.
        //
        // This decides, per object, whether the platters back up what the journal claims -- and an object whose
        // slices live only on disks missing from the volume table looks, from here, exactly like an object with
        // no slices at all: an abandoned write, whose name is then thrown away. An interrupted fleet restore
        // would therefore have the namespace restore quietly delete the names of everything on the disks it
        // never finished adding. There is no undo for that: the slices become orphans and the paths are gone.
        const interrupted = await this.deps.fleetRestoreIncomplete();
        if (interrupted)
            throw new Error(`refusing to restore the namespace: a fleet restore started ${interrupted.startedAt} did `
                + `not finish, so the volume table may be missing disks. Objects living only on those disks would `
                + `look like abandoned writes and have their names discarded. Finish the fleet restore first.`);

        // AND WE HAVE TO KNOW WHERE THE JOURNAL IS, not merely where some readable disk last remembered it.
        //
        // The journal is read from the volumes the manifest names, and NOWHERE else. If the manifest that knows
        // the current list was on a disk that would not answer, we will read an OLD replica instead -- and
        // because old journal directories are never deleted, that replica is contiguous, gap-free, and
        // completely convincing. The gap check passes. Every name written since the journal moved is dropped,
        // by a restore that reports success and hands the operator a namespace with a silent hole in it.
        //
        // There is no way to detect that after the fact. The only safe move is not to guess.
        if (this.deps.journalLocationUncertain())
            throw new Error('some bootstrap manifests could not be read, so this host cannot be sure WHERE the '
                + 'namespace journal lives. The disk that knows may be one of the ones that would not answer -- and '
                + 'reading the journal from the wrong volumes would find an old replica that looks perfectly '
                + 'contiguous, pass every check, and silently drop every name written since the journal moved. '
                + 'Refusing to guess. Fix the disks and run this again.');

        // COUNT THE DISKS BEFORE YOU DECLARE THE NAMESPACE GONE.
        //
        // This has to come before the snapshot check, and the reason is the same one, for the sixth time. A
        // volume that failed to MOUNT is not in the readable set, so hydration never tried to read its manifest,
        // so it never recorded a read error -- and the snapshot pointer, which may be sitting right there on
        // that disk, comes back null. The restore would then tell an operator: "there is nothing to restore
        // FROM. The objects are still on the platters, but their names are not."
        //
        // That sentence is the worst thing this system can say, and it would be saying it because a USB cable
        // was loose. `platters()` refuses while any volume is unmounted or unverified -- so ask IT first, and
        // let it say what actually happened.
        this.deps.platters();

        if (!snapshot)
            throw new Error('no snapshot pointer in any bootstrap manifest: there is nothing to restore FROM. The '
                + 'objects are still on the platters, but their names are not.');


        // NOT ON A LIVE ARRAY.
        //
        // A restore rebuilds the namespace from a snapshot plus a journal -- a view of the world that is, by
        // definition, from the past. Pointing that at a database that is currently serving 3.5 million objects
        // does not repair anything; it overwrites live metadata with an older idea of it, and every object
        // written since the snapshot that the journal has not caught would be quietly demoted or dropped.
        //
        // A recovery restores into an EMPTY database. If the database is not empty, whatever is happening is
        // not a recovery -- it is somebody who meant to pass apply:false. The DRY RUN is always allowed,
        // because looking is not touching, and looking is what you want first anyway.
        // ...UNLESS THE THING IN THE DATABASE IS THIS RESTORE'S OWN WRECKAGE.
        //
        // Containers are written before objects, so a crash after the very first container leaves a database
        // that is no longer empty -- and the guard below, meant to protect a LIVE namespace, would then refuse
        // to let the restore finish what it started. The operator would be stranded: a namespace 0.001%
        // rebuilt, and the only tool that can rebuild it declining to touch it.
        //
        // The marker tells the two situations apart. While it is up, a non-empty database is not a live array
        // to be protected; it is the debris of the attempt we are resuming, and every write is an idempotent
        // upsert, so running again simply finishes the job.
        // "IS THIS DATABASE A LIVE NAMESPACE, OR THIS RESTORE'S OWN WRECKAGE?"
        //
        // EITHER marker answers "wreckage", and that matters because the two are cleared one after the other
        // and a process can die in between. Clear the in-flight marker, die before clearing the required one,
        // and the array comes back in recovery mode with a restored-but-non-empty database and no resume
        // marker -- so the next restore hits the live-DB guard and refuses to finish. Stranded again, by the
        // very bracketing meant to prevent it.
        //
        // `namespace-restore-required` MEANS the database is not authoritative. While it is up, a restore into
        // it is never an overwrite of a live array; it is always a resume. So the clear order stops mattering,
        // and there is no window to die in.
        const resuming = (await this.deps.restoreInFlight()) ?? (await this.deps.namespaceRestorePending());

        if (opts.apply && !opts.force && !resuming) {
            const existing = await this.deps.objectsInDatabase();
            if (existing > 0)
                throw new Error(`refusing to restore into a database that already holds ${existing.toLocaleString()} `
                    + `object(s). A restore rebuilds the namespace from a snapshot and a journal -- a view of the past `
                    + `-- and applying it to a live array would overwrite what the array currently knows with something `
                    + `older. Run it with apply:false to see what WOULD be restored. If you genuinely mean to overwrite `
                    + `a live namespace, that has to be forced explicitly.`);
        }

        if (resuming)
            log.error('a namespace restore started %s did not finish. RESUMING it: what is in the database is the '
                + 'wreckage of that attempt, not a live namespace.', resuming.startedAt);

        // Raise it BEFORE the first write, and only for a run that actually writes.
        if (opts.apply) await this.deps.beginRestore();

        const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'strubs-restore-'));
        const local = path.join(staging, 'snapshot.ndjson.gz');

        let fellBack = false;
        let currentError: string | undefined;
        const requested = snapshot.objectId;

        try {
            // THE PREVIOUS SNAPSHOT IS KEPT FOR EXACTLY THIS MOMENT, AND WAS NEVER USED.
            //
            // The manifest deliberately retains the snapshot before the current one, and the restore then
            // ignored it -- so if the newest snapshot object turned out to be below quorum, the array reported
            // its namespace unrecoverable while an intact, slightly older copy of every name sat on the
            // platters, named in the very manifest we had just read. Keeping a spare and refusing to reach for
            // it is worse than not keeping one.
            //
            // The fallback costs a namespace that is a few hours stale -- and the journal replays on top of it
            // to close most of that gap anyway. That is not a hard trade against "everything is gone".
            try {
                log('reconstructing snapshot object %s from the platters...', snapshot.objectId);
                await this.deps.fetchSnapshot(snapshot.objectId, local);
            }
            catch (err) {
                if (!opts.previous?.objectId) throw err;

                log.error('the current snapshot (%s) could not be reconstructed: %s', snapshot.objectId, err);
                log.error('FALLING BACK to the previous snapshot %s, completed %s. The namespace will be as of '
                    + 'THEN, and the journal replays on top of it -- which is a great deal better than nothing.',
                    opts.previous.objectId, opts.previous.completedAt);

                await this.deps.fetchSnapshot(opts.previous.objectId, local);

                fellBack = true;
                currentError = err instanceof Error ? err.message : String(err);
                snapshot = opts.previous;
            }

            // ---- 1. the namespace as it was ----
            const containers = new Map<string,
                { id: string; cid: string | null; name: string; pr?: boolean; pw?: boolean; dp?: boolean }>();
            const objects = new Map<string, RestoreRecord & { op: 'put' }>();
            let trailer: (RestoreRecord & { op: 'end' }) | null = null;
            // Objects the journal says were deleted. Held aside rather than discarded, because a `del` is
            // not believed until the platters confirm it (see below).
            const deleted = new Map<string, RestoreRecord & { op: 'put' }>();
            let delsIgnored = 0;
            let policiesDeclined = 0;

            // The checksum is computed as we read, over exactly the bytes the snapshot writer hashed.
            const hash = createHash('sha256');

            for await (const line of createInterface({ input: createReadStream(local).pipe(createGunzip()), crlfDelay: Infinity })) {
                if (!line) continue;
                const r = JSON.parse(line) as RestoreRecord;
                if (r.op === 'end') { trailer = r; continue; }

                hash.update(line + '\n');

                // THE SNAPSHOT GETS THE SAME SCRUTINY AS THE JOURNAL, and for the same reason.
                //
                // Its sha256 trailer proves the bytes are the bytes we wrote -- it does not prove the RECORDS
                // are coherent, because a record that was malformed when it was written hashes just as happily
                // as one that was not. A `put` with no `name` restores an object nobody can address; a `put`
                // with a `cid` that is not a string restores it into the wrong folder, or into the root of a
                // bucket it was never in, where whoever can read that bucket can now read it. Being misfiled is
                // worse than being missing: the missing object is at least honest about it.
                //
                // This is the ONE artifact standing between an operator and a lost namespace. If it contains a
                // record we do not understand, we say so and stop -- we do not restore three million objects and
                // quietly drop the ones that did not make sense.
                if (!isCoherent(r))
                    throw new Error(`the snapshot contains a record that is not a coherent namespace entry: `
                        + `${line.slice(0, 120)}. Its checksum may still be perfect -- that only proves the bytes `
                        + `survived, not that they made sense when they were written. Refusing to rebuild a `
                        + `namespace from records this cannot understand.`);

                if (r.op === 'container') containers.set(r.id, r);
                else if (r.op === 'put') objects.set(r.id, r);
            }

            // The trailer is what separates a complete snapshot from a truncated one. Restoring from a
            // truncated snapshot would silently leave out however much of the namespace was cut off, and we
            // would never know which part.
            if (!trailer)
                throw new Error('the snapshot has no end trailer: it is TRUNCATED, and restoring from it would '
                    + 'silently omit an unknown amount of the namespace');
            if (containers.size !== trailer.containers || objects.size !== trailer.objects)
                throw new Error(`the snapshot does not contain what it claims: read ${containers.size} containers and `
                    + `${objects.size} objects, trailer says ${trailer.containers} and ${trailer.objects}`);

            // AND THE CHECKSUM. The counts agreeing is not the same as the content being right: a snapshot
            // whose records were altered, or whose bytes rotted on the platter, has exactly the same number
            // of lines in it. This is the last chance anyone gets to notice before 3.5 million names are
            // rebuilt from it, and there is no second copy of the truth to compare against afterwards.
            const digest = hash.digest('hex');
            if (digest !== trailer.sha256)
                throw new Error(`the snapshot does not match its own checksum: computed ${digest.slice(0, 16)}, `
                    + `trailer says ${String(trailer.sha256).slice(0, 16)}. It is CORRUPT, and restoring from it `
                    + `would rebuild the namespace from something that is not the namespace.`);

            log('snapshot: %d containers, %d objects', containers.size, objects.size);

            // WHICH NAMES CAME FROM THE SNAPSHOT. Captured HERE, before the journal is layered on top, because
            // afterwards there is no telling them apart -- and the difference decides whether an object with no
            // slices is a funeral or a bookkeeping entry.
            const inSnapshot = new Set(objects.keys());

            // ---- 2. everything that happened since ----
            let applied = 0;
            const journalFiles = await this.deps.journalSegments({ force: opts.force === true });

            for (const [segmentIndex, segment] of journalFiles.entries()) {
                const lines = (await fsp.readFile(segment, 'utf8')).split('\n');

                for (const [lineIndex, line] of lines.entries()) {
                    if (!line) continue;

                    // A torn last line is the one flavour of damage a journal is ALLOWED to have: it is
                    // append-only, and a crash can cut the record being written in half. Anywhere else, damage
                    // is damage -- so this has to mean the LAST line, exactly, and not "the last line or the one
                    // before it".
                    //
                    // `lines` comes from splitting on \n. A file that ends with a newline -- the normal case --
                    // yields a final empty element, so the last REAL record is at length - 2. A file whose final
                    // record was torn mid-write has no trailing newline, and its last real record is at
                    // length - 1. Forgiving BOTH positions unconditionally, which is what `>= length - 2` did,
                    // means that in the torn case the perfectly intact record BEFORE the torn one is also
                    // forgiven -- and if that record is a `del`, a deleted object walks straight back into the
                    // restored namespace. Work out where the last record actually is, and forgive only that.
                    const lastRecordIndex = lines[lines.length - 1] === '' ? lines.length - 2 : lines.length - 1;
                    const isLastLineOfLastSegment =
                        segmentIndex === journalFiles.length - 1 && lineIndex === lastRecordIndex;

                    let r: RestoreRecord;
                    try { r = JSON.parse(line); }
                    catch {
                        // A TORN LAST LINE is expected: a journal is append-only, and a crash can cut the one
                        // being written in half. That is forgivable, and it is the only unparseable line that
                        // is -- an unreadable record in the MIDDLE of a segment is corruption, and skipping it
                        // means silently applying the history with one operation missing from it. A delete that
                        // goes missing brings an object back from the dead; a create that goes missing leaves
                        // its data on the platters with no name.
                        if (isLastLineOfLastSegment) {
                            log.error('the final journal line is torn (a crash mid-write); ignoring it: %s',
                                line.slice(0, 60));
                            continue;
                        }

                        throw new Error(`journal segment ${segment} has an unreadable record at line ${lineIndex + 1}, `
                            + `and it is not the last one. Skipping it would apply the history with an operation `
                            + `missing from the middle of it -- a lost delete resurrects an object, a lost create `
                            + `orphans one. Refusing to restore from a history with a hole in it.`);
                    }

                    // A RECORD THAT PARSES IS NOT A RECORD WE UNDERSTAND.
                    //
                    // One flipped bit turns "del" into "ddl", and JSON.parse is perfectly happy with that. Fall
                    // through on it and the operation is simply... not applied -- counted, reported as replayed,
                    // and silently absent from the restored namespace. A lost `del` resurrects a deleted object;
                    // a lost `put` leaves its data on the platters with no name. Neither is something to find out
                    // about later, and "we did not recognise it so we ignored it" is not a thing a recovery gets
                    // to say.
                    const shape = r as { op?: unknown; id?: unknown };
                    // THE SAME COHERENCE TEST THE SNAPSHOT USES. One definition, in one place -- because when
                    // the two had their own ideas of what a valid record was, a record the journal would have
                    // rejected sailed straight through the snapshot.
                    if (!isCoherent(r)) {
                        if (isLastLineOfLastSegment) {
                            log.error('the final journal record is malformed (a crash mid-write); ignoring it: %s',
                                line.slice(0, 60));
                            continue;
                        }

                        throw new Error(`journal segment ${segment} has a record at line ${lineIndex + 1} that parses `
                            + `but is not an operation this understands (op=${JSON.stringify(shape.op)}, `
                            + `id=${JSON.stringify(shape.id)}). It is not the last line, so it is not a torn write -- it `
                            + `is corruption, and ignoring it would apply the history with an operation missing from `
                            + `the middle of it. Refusing to restore from a history with a hole in it.`);
                    }

                    applied++;
                    if (r.op === 'container') {
                        // A JOURNAL CONTAINER RECORD DOES NOT GET TO CARRY A POLICY. NOT EVER.
                        //
                        // The journal has a `policy` op for that, and the replay puts it through the close-only
                        // rule: a journalled policy may shut a bucket, never open one. Spreading `...r` here
                        // walked straight around that. A line reading
                        //
                        //     {"op":"container","id":"…","cid":null,"name":"photos","pr":true}
                        //
                        // would restore a brand-new -- or a deliberately closed -- bucket as PUBLICLY READABLE,
                        // without ever touching the policy branch, without being counted, without a word in the
                        // log. Every guard I built for the policy op, bypassed by a different op with the same
                        // two fields on it.
                        //
                        // The live writer never puts pr/pw on a journal container record (see JournalRecord in
                        // journal.ts). Only the SNAPSHOT's container records legitimately carry policy, and they
                        // are the array's own account of itself. So: take the name and the parent from the
                        // journal, and take the POLICY only from what the namespace already knew.
                        const had = containers.get(r.id);

                        containers.set(r.id, {
                            id: r.id,
                            cid: r.cid,
                            name: r.name,
                            ...(had?.pr === undefined ? {} : { pr: had.pr }),
                            ...(had?.pw === undefined ? {} : { pw: had.pw }),
                            ...(had?.dp === undefined ? {} : { dp: had.dp })
                        });
                    }
                    else if (r.op === 'policy') {
                        // The bucket must already be in the namespace -- from the snapshot or from an earlier
                        // `container` record. A policy for a bucket we have never heard of is a policy for a
                        // bucket that no longer exists, and inventing one to hang it on would conjure an empty
                        // bucket into the restored namespace.
                        const bucket = containers.get(r.id);
                        if (!bucket) {
                            log('journal sets a policy on container %s, which is not in the namespace: ignoring it '
                                + '(the bucket it referred to is gone).', r.id);
                            continue;
                        }

                        // A JOURNALLED POLICY MAY CLOSE A BUCKET. IT MAY NEVER OPEN ONE.
                        //
                        // This is the one op the platters cannot arbitrate. A `put` is checked against its
                        // slices, a `del` against theirs -- but a bucket's access flags leave no physical
                        // evidence anywhere, so there is nothing to ask.
                        //
                        // And the journal can hold a record for an operation that never happened. A batch
                        // rejected by every replica is rolled back, but "the fsync failed" is not "the bytes are
                        // not there", and if the rollback cannot be proven either, the record may survive on a
                        // platter for a change whose caller was told it FAILED. That is unavoidable: the two
                        // cases are byte-identical and no local rule distinguishes them. I tried several.
                        //
                        // So make the CONSEQUENCE safe rather than the question decidable. Honour the record
                        // when it RESTRICTS access, refuse it when it GRANTS. An escaped record can then only
                        // ever over-close a bucket -- which an operator notices in a moment (things 404) and
                        // fixes with one call. It can never, under any failure, hand the public a bucket
                        // somebody deliberately closed.
                        //
                        // The price is real and worth stating: a legitimate "make this bucket public" recorded
                        // after the last snapshot is NOT restored, and the operator must re-apply it. That is an
                        // availability annoyance. The alternative is a silent data leak. It is not a close call.
                        // PER FIELD, NOT PER RECORD -- and this distinction is not pedantry.
                        //
                        // A record can do both at once: `{ pr: true, pw: false }` opens READ and closes WRITE.
                        // Declining the whole thing because one half of it opens would throw away the half that
                        // CLOSES -- so a bucket whose write access somebody deliberately shut would come back
                        // WRITABLE. The rule exists to make failure over-restrictive; applying it record-wise
                        // would make it, in exactly this case, over-PERMISSIVE. Judge each flag on its own.
                        const next = { ...bucket };

                        for (const f of ['pr', 'pw'] as const) {
                            const want = r[f];
                            if (want === undefined) continue;

                            if (want === true && bucket[f] !== true) {
                                log.error('journal: a policy record would OPEN %s on bucket %s. A journalled policy '
                                    + 'is the one record the platters cannot vouch for -- a rejected batch whose '
                                    + 'rollback could not be proven may leave one behind -- so a restore may CLOSE '
                                    + 'a bucket but never open one. NOT honouring this flag. Re-apply it '
                                    + 'deliberately if it was real.', f, r.id);
                                policiesDeclined++;
                                continue;
                            }

                            next[f] = want;               // closing, or already open: safe to apply
                        }

                        // deleteProtected INVERTS the polarity: dp=true CLOSES (blocks deletes), dp=false OPENS
                        // (allows them). The close-only rule is the same principle -- a journalled policy may only
                        // ever RESTRICT -- so here it is dp=false, the one that would strip protection off a bucket
                        // somebody locked, that must be refused. An escaped record can then only ever over-protect
                        // (deletes 403; an operator clears it in one call), never silently expose a locked bucket.
                        if (r.dp !== undefined) {
                            if (r.dp === false && bucket.dp === true) {
                                log.error('journal: a policy record would REMOVE delete-protection on bucket %s. A '
                                    + 'journalled policy may only ever ADD protection on restore, never strip it. NOT '
                                    + 'honouring this flag. Re-apply it deliberately if it was real.', r.id);
                                policiesDeclined++;
                            }
                            else {
                                next.dp = r.dp;   // protecting, or already unprotected: safe to apply
                            }
                        }

                        containers.set(r.id, next);
                    }
                    else if (r.op === 'put') { objects.set(r.id, r); deleted.delete(r.id); }
                    else if (r.op === 'del') {
                        // A `del` for a CONTAINER is the compensating record written when a container was
                        // journaled and its Mongo insert then failed. It has no slices to check against --
                        // a folder has none -- so it is simply honoured. Restoring it would recreate an empty
                        // folder that never existed, which is precisely what the compensation was for.
                        if (containers.delete(r.id)) continue;

                        // For an OBJECT, we are not going to take the journal's word for it. See below.
                        const named = objects.get(r.id);
                        if (named) deleted.set(r.id, named);
                        objects.delete(r.id);
                    }
                }
            }
            log('journal: %d records applied on top', applied);

            // THE OTHER RULE, and the symmetry is the point: a `del` is only honoured if the platters agree.
            //
            // The journal makes the delete durable BEFORE the slices are unlinked -- that ordering is what
            // stops a crash from leaving a name pointing at data that is already gone. The price of it is
            // that the journal can honestly say "deleted" about an object whose deletion then FAILED: the
            // slices are still sitting there, whole, and the caller was told the delete did not work.
            //
            // Believing the journal in that case would throw away the name of an object that still exists,
            // turning it into a nameless orphan -- 130TB of anonymous slices is exactly the outcome this
            // entire body of work exists to prevent, and it would be self-inflicted.
            // ONE walk of the disks, for everything. See buildSliceIndex: hunting per object across 34 disks
            // is 119 million directory reads and it does not finish.
            log('indexing every slice on every disk...');
            const platters = this.deps.platters();
            const index = await buildSliceIndex(platters,
                files => log('  ...%s slice files indexed', files.toLocaleString()));
            log('slice index: %s objects have at least one slice on the platters', index.size.toLocaleString());

            // A MAP, not a linear scan. This is called for every slice of every one of 3.5 million objects,
            // and `platters.find(...)` across 34 volumes turns that into hundreds of millions of string
            // comparisons -- which is how a recovery ends up CPU-bound while 34 disks sit idle waiting for it.
            const mounts = new Map(platters.map(p => [p.volumeId, p.mountPoint]));
            const mountOf = (volumeId: number): string | undefined => mounts.get(volumeId);
            // A real volume to stand in for a slice we cannot find. Its file will not be there, which is
            // exactly what a missing slice looks like on an ordinary day -- and the reader reconstructs it.
            const placeholder = platters[0]?.volumeId ?? 0;
            const hasAnySlice = (id: string): boolean => {
                const slots = index.get(id);
                return !!slots && slots.some(v => v !== 0);
            };

            for (const [id, named] of deleted) {
                if (!hasAnySlice(id)) continue;          // genuinely gone: the delete completed. Honour it.

                log('journal says object %s (%s) was deleted, but its slices are still on the platters: the delete '
                    + 'did not complete, so the name is being KEPT', id, named.name);
                objects.set(id, named);
                delsIgnored++;
            }

            // ---- 3. and now: does the namespace agree with the platters? ----
            const summary: RestoreSummary = {
                containers: containers.size,
                objectsInNamespace: objects.size,
                objectsRestored: 0,
                objectsMissing: 0,
                objectsUnrecoverable: 0,
                objectsIndeterminate: 0,
                rowsPruned: 0,
                policiesDeclined: 0,
                snapshotUsed: snapshot.objectId,
                fellBackToPrevious: fellBack,
                ...(currentError ? { currentSnapshotError: currentError } : {}),
                delsIgnored,
                putsDropped: 0
            };

            // EVERY object carries its BUCKET, and it has to be derived here because the snapshot does not
            // record it -- the bucket is the root of an object's container chain, and a chain is exactly what
            // we have just finished rebuilding.
            //
            // This is not cosmetic. Phase 2 denormalised bucketId onto every document precisely so that
            // authorisation and per-bucket stats would not have to walk to the root on every request, and
            // Phase 3's object authorisation reads it directly. A namespace restored without it would come
            // back with every object in an "unknown bucket" -- which the auth model treats as unknown, never
            // as a wildcard, so the array would come up refusing to serve its own data.
            const bucketOf = (cid: string | null): string | null => {
                let current = cid;
                let root: string | null = null;
                const seen = new Set<string>();
                while (current && containers.has(current) && !seen.has(current)) {
                    seen.add(current);
                    root = current;
                    current = containers.get(current)!.cid;
                }
                return root;
            };

            // Every id the rebuilt namespace legitimately contains. Anything in the database that is NOT in
            // here is a row the namespace does not have -- and the most dangerous of those is an object that
            // was DELETED before the snapshot: absent from it precisely because it was deleted, never touched
            // by an upsert, and therefore back from the dead unless we take it out. See pruneOutsideNamespace.
            const keptIds = new Set<string>();

            // Containers first, so nothing is ever written that references a parent that does not exist yet.
            if (opts.apply)
                for (const c of orderParentsFirst([...containers.values()])) {
                    await this.deps.writeContainer({ ...c, bucketId: bucketOf(c.cid) ?? c.id });
                    keptIds.add(c.id);
                }
            else
                for (const c of containers.values()) keptIds.add(c.id);

            // IN PARALLEL. Verifying 3.5 million objects means 3.5 million 48-byte header reads, and doing
            // them one after another across 34 cold spindles leaves the array almost entirely idle while the
            // recovery crawls. These are independent disks; ask them all at once.
            const CONCURRENCY = 64;
            let checked = 0;

            const verify = async ([id, named]: [string, RestoreRecord & { op: 'put' }]): Promise<void> => {
                const rebuilt = await synthesiseRecordFromIndex(id, index.get(id), mountOf, placeholder, platters,
                    this.deps.fleetGeometry());

                if (!rebuilt) {
                    // TWO DIFFERENT THINGS WEAR THE SAME NULL, and telling them apart is the difference
                    // between a bookkeeping entry and a funeral.
                    //
                    // NO SLICES AT ALL: the write was abandoned -- journaled, then it failed. The rule says a
                    // `put` is only believed if the platters back it up, so we drop the name. Materialising it
                    // would be a PHANTOM: a name that reads as data loss for data that never existed.
                    //
                    // SLICES, BUT NOT ONE READABLE HEADER: the data is there and we cannot describe it. That
                    // is not an abandoned write, it is CORRUPTION, and quietly filing it as "never existed"
                    // would tell an operator their array is fine when it is not.
                    if (!hasAnySlice(id)) {
                        // AND WHERE THE NAME CAME FROM DECIDES WHICH OF THOSE IT IS. This is the distinction I
                        // collapsed last round, and collapsing it lies in whichever direction you collapse it.
                        //
                        // A name that appears ONLY IN THE JOURNAL is a put that was recorded and then never
                        // landed: the write was interrupted between the journal and the slices, the client got
                        // an error, and there never was an object. That is an ABANDONED WRITE. Filing it under
                        // "missing" reports a death that never happened and sends somebody hunting for a backup
                        // of something that never existed.
                        //
                        // A name that is IN THE SNAPSHOT existed when the snapshot was taken -- that is what
                        // being in it means. Its slices are gone now. That is not bookkeeping, it is a funeral,
                        // and calling it an abandoned write would tell an operator their array is fine while
                        // somebody's data is actually gone. Of the two lies, this is the one that lets the loss
                        // go unnoticed, which makes it the worse one.
                        if (inSnapshot.has(id)) summary.objectsMissing++;
                        else summary.putsDropped++;
                        return;
                    }

                    log.error('object %s (%s) has slices on the platters but not one readable header: it cannot be '
                        + 'described, so it cannot be restored', id, named.name);
                    summary.objectsUnrecoverable++;
                    return;
                }

                // A DISK THAT WOULD NOT ANSWER IS NOT A REASON TO DELETE SOMEBODY'S FILENAME.
                //
                // The slices are THERE -- we could not read them. Dropping the name here is irreversible: the
                // path is gone, and the data becomes an orphan nobody can find by name again. Keeping it costs
                // nothing that cannot be undone -- if the object really is lost, the next drift scrub says so
                // and the name can be removed then, deliberately, by somebody who knows.
                //
                // Restore the name. Say loudly that it could not be verified. Do not destroy anything.
                if (rebuilt.reason === 'indeterminate') {
                    log.error('object %s (%s): %d of its slices are on disks that would not answer, so it cannot be '
                        + 'verified. Restoring its name anyway -- the slices EXIST, and throwing a name away over a '
                        + 'disk that is not talking cannot be undone.', id, named.name, rebuilt.unknown);
                    // falls through to be written, and counted below -- deliberately NOT as a restore.
                }
                else if (!rebuilt.recoverable) {
                    // Some slices, but not enough of them decode. The name is real and the data is genuinely
                    // gone. This is the one number in this whole report that is a tragedy, and it is counted
                    // separately from the ones that are merely bookkeeping.
                    //
                    // And it is reported for what it IS. "Only 1 of the 1 slices it needs" -- which is what a
                    // lone rotted header produces, because `needed` came from the very header we are refusing
                    // to trust -- describes an object that does not exist and would send somebody hunting for
                    // a bug that is not there.
                    if (rebuilt.reason === 'uncorroborated-geometry')
                        log.error('object %s (%s) has exactly one readable slice header and nothing corroborates '
                            + 'it: its shape cannot be established, so it cannot be rebuilt. UNRECOVERABLE',
                            id, named.name);
                    else
                        log.error('object %s (%s) has only %d of the %d slices it needs: UNRECOVERABLE',
                            id, named.name, rebuilt.found, rebuilt.needed);

                    summary.objectsUnrecoverable++;
                    return;
                }

                // WHERE THE RECORD COMES FROM WHEN THE PLATTERS COULD NOT SPEAK.
                //
                // Normally the platters describe the object and the snapshot supplies its name -- the disks are
                // authoritative, and that is the whole point. But an INDETERMINATE object has no readable header
                // at all: every slice of it is on a disk that will not answer, so there is nothing to describe
                // it with. We still keep its name (throwing one away is irreversible), and the only description
                // we have left is the one the snapshot/journal recorded when the object was written.
                //
                // That is a weaker source and it is used only here, only when the disks are silent, and only to
                // preserve a name we would otherwise destroy. It is never counted as a successful restore.
                // The platters supply the SHAPE (dataVolumes/parityVolumes -- which disks the slices are on),
                // and the snapshot supplies the SIZE. Neither alone is a record the reader can open, and an
                // incomplete one is not a preserved name, it is a landmine: file-object.ts dereferences
                // record.dataVolumes the instant anybody touches the object.
                const record = rebuilt.record
                    ? { ...rebuilt.record, size: rebuilt.record.size ?? named.size, chunkSize: rebuilt.record.chunkSize ?? named.cs }
                    : null;

                if (!record) {
                    log.error('object %s (%s) is on disks that would not answer AND its shape cannot be established '
                        + 'even from the fleet geometry. Its name is being left out rather than written as a record '
                        + 'that would fault the moment anybody opened it.', id, named.name);
                    summary.objectsIndeterminate++;
                    return;
                }

                if (opts.apply)
                    await this.deps.writeObject({
                        ...record,
                        containerId: named.cid,
                        bucketId: bucketOf(named.cid),
                        name: named.name,
                        mime: named.mime ?? null,
                        md5: named.md5 ?? null
                    });

                // AN OBJECT WE COULD NOT VERIFY IS NOT AN OBJECT WE RESTORED.
                //
                // Its name is back, which is what matters and why we kept it. But `objectsRestored` is the
                // number an operator reads as "this much of my array came back, proven against the platters",
                // and an indeterminate object was proven against nothing -- we could not even open it. Folding
                // it into the success count would inflate the one figure that must not be inflated.
                keptIds.add(id);

                if (rebuilt.reason === 'indeterminate') summary.objectsIndeterminate++;
                else summary.objectsRestored++;
            };

            // A WORKER POOL over one iterator, not a Set raced 3.5 million times. Promise.race() on a set of
            // 64 rebuilds 64 promise reactions on every single call -- so the loop that was meant to keep the
            // disks busy ends up burning a core doing bookkeeping instead. Pull from a shared iterator and
            // let each worker just... work.
            const queue = objects.entries();
            const worker = async (): Promise<void> => {
                for (;;) {
                    const next = queue.next();
                    if (next.done) return;
                    await verify(next.value);
                    if (++checked % 500_000 === 0)
                        log('  ...%s of %s objects checked against the platters',
                            checked.toLocaleString(), objects.size.toLocaleString());
                }
            };
            await Promise.all(Array.from({ length: CONCURRENCY }, worker));

            // MAKE THE DATABASE MATCH THE NAMESPACE WE JUST REBUILT -- not merely contain it.
            //
            // Every id we wrote, and every id we deliberately kept (indeterminate objects, whose names we
            // refuse to throw away). Anything else in there is a row the rebuilt namespace does not have, and
            // the most dangerous of those is an object that was DELETED before the snapshot: absent from the
            // snapshot precisely because it was deleted, never overwritten by an upsert, and therefore back --
            // named, in its bucket, readable by whoever can read that bucket.
            if (opts.apply) {
                summary.rowsPruned = await this.deps.pruneOutsideNamespace(keptIds);
                if (summary.rowsPruned)
                    log('removed %s row(s) the rebuilt namespace does not contain (deleted objects that would '
                        + 'otherwise have come back from the dead)', summary.rowsPruned.toLocaleString());
            }

            summary.policiesDeclined = policiesDeclined;
            if (policiesDeclined)
                log.error('%d journalled bucket-policy record(s) would have OPENED a bucket and were refused. If '
                    + 'those were real changes, re-apply them deliberately -- a restore may close a bucket, never '
                    + 'open one.', policiesDeclined);

            if (fellBack)
                log.error('THIS NAMESPACE CAME FROM THE PREVIOUS SNAPSHOT (%s), not the current one (%s), because '
                    + 'the current one could not be reconstructed: %s. Two things follow, and both want acting on: '
                    + 'the namespace you are looking at is OLDER than the one you asked for, and the current '
                    + 'snapshot object is genuinely damaged on the platters -- that fault is still there.',
                    snapshot!.objectId, requested, currentError);

            // THE NAMES ARE BACK. Only now may STRUBS start normally -- and only now may the snapshot job be
            // allowed anywhere near the manifest pointer. A dry run lowers nothing: it wrote nothing.
            if (opts.apply) {
                await this.deps.endRestore();
                await this.deps.namespaceRestored();
                log('the namespace is restored: %s object(s) named, %s container(s). STRUBS will start normally '
                    + 'on the next boot.',
                    summary.objectsRestored.toLocaleString(), summary.containers.toLocaleString());
            }

            return summary;
        }
        finally {
            await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
        }
    }
}

// A parent is always written before its children, so a restore never references a container that does not
// exist yet. (Same rule the snapshot itself is written under; enforced again here because the journal can
// have added containers after the snapshot was taken, and they arrive in whatever order they happened.)
export function orderParentsFirst<T extends { id: string; cid: string | null }>(containers: T[]): T[] {
    const byId = new Map(containers.map(c => [c.id, c]));
    const emitted = new Set<string>();
    const out: T[] = [];

    const visit = (c: T, seen: Set<string>): void => {
        if (emitted.has(c.id) || seen.has(c.id)) {
            if (!emitted.has(c.id)) { emitted.add(c.id); out.push(c); }   // a cycle: emit it rather than loop
            return;
        }
        seen.add(c.id);
        const parent = c.cid ? byId.get(c.cid) : undefined;
        if (parent) visit(parent, seen);
        if (!emitted.has(c.id)) { emitted.add(c.id); out.push(c); }
    };

    for (const c of containers) visit(c, new Set());
    return out;
}

// The real thing, wired to the actual array.
//
// fetchSnapshot is the interesting one: it finds the snapshot object by SCANNING the platters for its
// slices, synthesises the record Mongo would have held from their headers, and then hands that to the
// ordinary FileObject reader. So the recovery decodes 4+2 Reed-Solomon using the same code path that serves
// every GET on an ordinary Tuesday -- which is exactly where you want your erasure coding to come from on
// the day you actually need it, rather than from a second implementation in a recovery tool that nobody has
// run since it was written.
// A GAP IS A HOLE IN HISTORY, AND IT FAILS THE RESTORE.
//
// Segment 000001 is gone, 000002 is here: every put and del recorded in that window is simply absent. The
// objects created in it come back as unnamed orphans -- recoverable, but nameless -- and, far worse, the
// objects DELETED in it come back FROM THE DEAD, with their names, in their buckets, as though nobody had
// ever asked for them to be gone.
//
// This used to log an error and carry on, which is the worst of both worlds: the restore succeeds, the
// operator is handed a namespace that is quietly wrong, and the one line saying so has already scrolled past.
// A recovery may hand back an INCOMPLETE namespace. It may never hand one back while calling it whole.
//
// `force` exists for the operator who knows the segment is gone for good and would rather have most of their
// namespace than none of it. They have to say so, out loud.
// WHAT A NAMESPACE RECORD HAS TO HAVE TO BE ONE.
//
// Shared by the snapshot reader and the journal replay, because a record that is nonsense is nonsense wherever
// it is found, and the two used to disagree about what counted -- which meant a record the journal would have
// rejected sailed through the snapshot untouched.
export function isCoherent(r: unknown): boolean {
    const x = r as { op?: unknown; id?: unknown; name?: unknown; cid?: unknown; size?: unknown; cs?: unknown };
    if (typeof x.id !== 'string' || !x.id) return false;

    const parentOk = x.cid === null || typeof x.cid === 'string';

    if (x.op === 'container') {
        const p = r as { pr?: unknown; pw?: unknown; dp?: unknown };
        if (p.pr !== undefined && typeof p.pr !== 'boolean') return false;
        if (p.pw !== undefined && typeof p.pw !== 'boolean') return false;
        if (p.dp !== undefined && typeof p.dp !== 'boolean') return false;
        return typeof x.name === 'string' && !!x.name && parentOk;
    }
    if (x.op === 'del') return true;                       // an id is all a delete needs

    if (x.op === 'policy') {
        // A BUCKET'S ACCESS POLICY IS NOT A PLACE TO BE RELAXED ABOUT TYPES.
        //
        // The flags are optional -- a policy record may set only one of them -- but if one is PRESENT it has to
        // be an actual boolean. restoreContainer() stores `!!r.pr`, and the string "false" is truthy, so a
        // malformed record reading `pr: "false"` would restore a bucket as PUBLICLY READABLE. That is a
        // corrupt byte turning into an access-control decision, and it fails in the one direction that
        // actually leaks: private becomes public.
        const p = r as { pr?: unknown; pw?: unknown; dp?: unknown };
        if (p.pr !== undefined && typeof p.pr !== 'boolean') return false;
        if (p.pw !== undefined && typeof p.pw !== 'boolean') return false;
        if (p.dp !== undefined && typeof p.dp !== 'boolean') return false;
        return true;
    }
    if (x.op === 'put')
        return typeof x.name === 'string' && !!x.name && parentOk
            && Number.isFinite(x.size) && Number.isFinite(x.cs);

    return false;                                          // an op we do not understand is not a record
}

export function assertNoJournalGaps(segmentNames: string[], force: boolean): void {
    if (!segmentNames.length) return;                  // no journal at all is a different question, asked elsewhere

    const numbers = segmentNames.map(name => parseInt(name, 10)).sort((a, b) => a - b);

    // A name that does not parse is not a segment we can reason about, and quietly dropping it from the
    // sequence would make the gap check agree that a history with a hole in it is contiguous.
    if (numbers.some(n => !Number.isInteger(n)))
        throw new Error(`the journal contains a segment whose name is not a number (${segmentNames.join(', ')}). `
            + `Refusing to guess at the order of a history that cannot be put in order.`);

    const missing: number[] = [];

    // THE HOLE AT THE FRONT is the one the loop below cannot see, because it only looks BETWEEN the segments
    // that are here. Every journal begins at 000000.jsonl and rotation only ever appends the next one (see
    // journal.ts), so a journal that starts at 000001 is not a short journal -- it is a journal whose first
    // segment is GONE, along with every name it recorded. That is precisely as bad as a hole in the middle,
    // and it used to sail straight through.
    for (let n = 0; n < numbers[0]; n++) missing.push(n);

    for (let i = 1; i < numbers.length; i++)
        for (let n = numbers[i - 1] + 1; n < numbers[i]; n++) missing.push(n);

    if (!missing.length) return;

    const list = missing.map(n => String(n).padStart(6, '0')).join(', ');
    if (!force)
        throw new Error(`journal segment(s) ${list} are MISSING from every replica. Everything they recorded is `
            + `gone: objects created in that window would be restored as unnamed orphans, and objects DELETED in `
            + `that window would come back from the dead, named, in their buckets. Refusing to rebuild a namespace `
            + `from a history with a hole in it and call it complete. If those segments are gone for good and a `
            + `partial namespace is better than none, force it deliberately.`);

    log.error('journal segment(s) %s are MISSING and the restore was FORCED past them. The namespace being rebuilt '
        + 'is KNOWINGLY INCOMPLETE: deletes recorded in that window will be undone, and objects created in it will '
        + 'be restored as unnamed orphans.', list);
}

export const namespaceRestore = new NamespaceRestore({
    objectsInDatabase: async () => {
        const { database } = require('../database') as typeof import('../database');
        return database.countObjects();
    },

    platters: allPlattersOrRefuse,

    fetchSnapshot: async (objectId: string, to: string) => {
        const { FileObject } = require('../io/file-object') as typeof import('../io/file-object');
        const { createWriteStream } = require('fs') as typeof import('fs');

        // THE SAME REFUSAL AS EVERYTHING ELSE, and it was not here.
        //
        // This used to build its own platter list by filtering for mounted volumes -- quietly leaving out any
        // disk that failed to mount. That is the fail-open this whole module exists to prevent, and of all the
        // places to put it, it was in front of THE SNAPSHOT: if an unmounted disk held one of its slices, the
        // recovery would announce that the snapshot "cannot be decoded" and abort the entire namespace
        // restore, when the truth is that we did not look at the whole array.
        //
        // "I could not look at that disk" and "that disk does not have it" are different sentences, and only
        // one of them justifies giving up on the namespace.
        const platters = allPlattersOrRefuse();

        // The snapshot object is a SINGLE object, so the targeted search is right here -- it is the 3.5
        // million that need the index, not the one.
        const slices = await locateSlices(objectId, platters);
        const slots = new Uint16Array(MAX_SLICES);
        for (const [idx, s] of slices) slots[idx] = s.volumeId + 1;

        // ...and `platters` goes in, so the RESCUE PASS runs. Without it, the one object the entire recovery
        // stands on is the one object that never gets a second look: an interrupted relocation leaves a bad
        // copy of a slice indexed and an intact copy ignored, the snapshot reports three of the four slices it
        // needs, and the whole namespace is written off over a slice that is sitting right there.
        // ...and the fleet geometry goes in too, so the SNAPSHOT is judged by the same bar as every other
        // object. Without it there is no quorum to test against, and an object with a single unreadable slice
        // falls through to "indeterminate" -- which for the one object the whole recovery stands on is exactly
        // the wrong answer in both directions: it could report a lost snapshot as merely unreadable, or an
        // unreadable disk as a lost snapshot.
        const { config } = require('../config') as typeof import('../config');

        const rebuilt = await synthesiseRecordFromIndex(objectId, slices.size ? slots : undefined,
            (v: number) => platters.find(p => p.volumeId === v)?.mountPoint,
            platters[0]?.volumeId ?? 0,
            platters,
            { dataSlices: config.dataSliceCount, paritySlices: config.paritySliceCount });

        if (!rebuilt)
            throw new Error(`the snapshot object ${objectId} has NO slices anywhere on the array. The bootstrap `
                + `manifest names it, but the platters do not have it: there is nothing to restore from.`);
        if (!rebuilt.recoverable) {
            // WHY it cannot be decoded decides what the operator does next, and getting this wrong sends them
            // to bury a namespace that is fine.
            if (rebuilt.reason === 'indeterminate')
                throw new Error(`the snapshot object ${objectId} has ${rebuilt.unknown} slice(s) on disks that would `
                    + `not answer. They EXIST -- this is not data loss, and the namespace is very probably fine. A `
                    + `disk is failing or has dropped off its bus, and until it is fixed the snapshot cannot be `
                    + `decoded. Fix the disk and run the restore again: do NOT conclude the namespace is gone.`);

            throw new Error(rebuilt.reason === 'uncorroborated-geometry'
                ? `the snapshot object ${objectId} has exactly one readable slice header, and nothing corroborates `
                    + `it -- so its size and geometry cannot be established, and a lone header is not something to `
                    + `decode 4+2 against. The namespace it holds cannot be recovered from it.`
                : `the snapshot object ${objectId} has only ${rebuilt.found} of the ${rebuilt.needed} slices it `
                    + `needs. It cannot be decoded, so the namespace it holds cannot be recovered.`);
        }

        const object = new FileObject();
        await object.loadFromRecord(rebuilt.record as never);
        await object.prepareForRead();
        object.setReadRange(0, object.size, true);
        await pipeline(object as unknown as NodeJS.ReadableStream, createWriteStream(to));
        await object.close();
    },

    fleetRestoreIncomplete: () => {
        const { database } = require('../database') as typeof import('../database');
        return database.fleetRestoreIncomplete();
    },

    fleetGeometry: () => {
        const { config } = require('../config') as typeof import('../config');
        return { dataSlices: config.dataSliceCount, paritySlices: config.paritySliceCount };
    },

    namespaceRestored: () => {
        const { database } = require('../database') as typeof import('../database');
        return database.clearNamespaceRestoreRequired();
    },

    restoreInFlight: () => {
        const { database } = require('../database') as typeof import('../database');
        return database.namespaceRestoreInFlight();
    },

    namespaceRestorePending: async () => {
        const { database } = require('../database') as typeof import('../database');
        const m = await database.namespaceRestoreRequired();
        return m ? { startedAt: m.since } : null;
    },

    journalLocationUncertain: () => {
        const { bootstrapManifestWriter } = require('../io/bootstrap-manifest') as
            typeof import('../io/bootstrap-manifest');
        return bootstrapManifestWriter.journalListWasIncomplete();
    },

    pruneOutsideNamespace: (keep: Set<string>) => {
        const { database } = require('../database') as typeof import('../database');
        return database.pruneOutsideNamespace(keep);
    },

    beginRestore: () => {
        const { database } = require('../database') as typeof import('../database');
        return database.beginNamespaceRestore();
    },

    endRestore: () => {
        const { database } = require('../database') as typeof import('../database');
        return database.endNamespaceRestore();
    },

    journalSegments: async ({ force }) => {
        const { ioManager } = require('../io/manager') as typeof import('../io/manager');
        const { JOURNAL_DIR } = require('../io/journal') as typeof import('../io/journal');
        const { bootstrapManifestWriter } = require('../io/bootstrap-manifest') as typeof import('../io/bootstrap-manifest');

        // THE BEST COPY OF EACH SEGMENT, IN ORDER. Not every replica's files concatenated together.
        //
        // The replicas are meant to be identical, and one of them can legitimately be SHORT -- a degraded
        // write, a disk that dropped out mid-flush leaves a replica missing the tail of a segment. So reading
        // only one risks losing records, and reading all of them one disk after another is worse: replica B's
        // whole history would be replayed AFTER replica A's, so B's older records would land on top of A's
        // newer ones. A `container` that a later `del` compensated would come back. A put that a later del
        // removed would return from the dead. ORDER IS THE WHOLE POINT of a log, and concatenating three
        // copies of one destroys it.
        //
        // A short replica's segment is always a strict PREFIX of a healthy one -- a replica that fails a
        // write is dropped from the set rather than skipping the batch and resuming (see DR-C) -- so the
        // LONGEST copy of each segment number is the most complete one, and replaying segments in ascending
        // order replays the history exactly once, in the order it happened.
        //
        // ...but ONLY from the volumes the manifest says the journal lives on. A disk that carried the
        // journal in some previous life still has its old segments sitting there (we never delete), and a
        // stale 000000.jsonl that happens to be LONGER than the real one would win on size and replace the
        // actual history -- silently dropping every put made since the snapshot. DR-C goes to considerable
        // lengths to keep two journal lineages apart on the live path; a recovery that reads whatever it
        // finds would undo all of it. The manifest names the replicas. Believe it.
        const journalVolumes = new Set(bootstrapManifestWriter.getJournalVolumeIds());
        const best = new Map<string, { path: string; size: number }>();


        // The manifest does not say where the journal lives. On a brand-new array that is simply true -- there
        // is no journal yet, and nothing to replay. But if there ARE journal directories on the platters and
        // nothing tells us which of them is the real one, then reading whatever we find is exactly the mistake
        // DR-C spends so much effort avoiding: a disk that carried the journal in a previous life still has
        // its old segments, and a stale copy that happens to be longer would win and replace the real history.
        if (!journalVolumes.size) {
            const withJournals: number[] = [];
            for (const [, volume] of ioManager.getVolumeEntries()) {
                if (!volume.isMounted || !volume.mountPoint) continue;

                // "IT IS NOT THERE" AND "I COULD NOT LOOK" AGAIN, and here it is at its most expensive: a stat
                // that fails with EIO used to mean "no journal on this disk", so a rack whose journal disks are
                // all failing looks exactly like a brand-new array with no journal at all -- and the restore
                // returns [], replays nothing, and silently drops every name written since the snapshot.
                let has: boolean;
                try {
                    await fsp.stat(`${volume.mountPoint}/strubs/${JOURNAL_DIR}`);
                    has = true;
                }
                catch (err) {
                    const code = (err as NodeJS.ErrnoException).code;
                    if (code === 'ENOENT') has = false;
                    else
                        throw new Error(`volume ${volume.id} would not say whether it carries a namespace journal `
                            + `(${code ?? String(err)}). It may hold the only record of everything written since the `
                            + `snapshot, and treating "I could not look" as "there is nothing there" would drop all `
                            + `of it silently. Fix the disk and run this again.`);
                }

                if (has) withJournals.push(volume.id);
            }
            if (withJournals.length)
                throw new Error(`the bootstrap manifest does not say which volumes carry the namespace journal, but `
                    + `journal directories exist on volume(s) ${withJournals.join(', ')}. There is no way to tell which `
                    + `of them is this array's history and which is a leftover from a previous life, and guessing wrong `
                    + `would replace the real history with a dead one. Refusing.`);
            return [];      // no journal anywhere: a new array, and there is genuinely nothing to replay
        }

        let replicasRead = 0;

        for (const [, volume] of ioManager.getVolumeEntries()) {
            if (!volume.isMounted || !volume.mountPoint) continue;
            if (journalVolumes.size && !journalVolumes.has(volume.id)) continue;

            const dir = `${volume.mountPoint}/strubs/${JOURNAL_DIR}`;
            let files: string[];
            try {
                files = await fsp.readdir(dir);
            }
            catch (err) {
                // ENOENT means this replica genuinely has no journal directory. Anything else means we could
                // not LOOK -- and treating that as "no records here" is how a restore quietly loses every
                // name written since the snapshot and reports success.
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
                throw new Error(`the journal on volume ${volume.id} could not be read (${err}). Restoring without `
                    + `it would silently drop every namespace change since the snapshot.`);
            }

            replicasRead++;
            for (const f of files) {
                // A FILE WE DO NOT RECOGNISE IN THE JOURNAL DIRECTORY IS NOT A FILE TO IGNORE.
                //
                // Skipping it means the gap check never sees it: `000001x.jsonl`, or a segment whose name got
                // mangled, holds real history and would be quietly dropped -- and the segments either side of
                // it look perfectly contiguous, so nothing complains. The journal directory contains segments
                // and nothing else; anything else in there is a question, and it gets asked out loud.
                if (!/^\d+\.jsonl$/.test(f)) {
                    if (f.startsWith('.')) continue;
                    throw new Error(`the journal on volume ${volume.id} contains '${f}', which is not a segment. `
                        + `It may be a segment whose name was mangled -- and it would hold real history that a `
                        + `restore would silently skip, with the segments either side of it looking perfectly `
                        + `contiguous. Refusing to replay a journal directory that has something unexplained in it.`);
                }

                const path = `${dir}/${f}`;
                const size = await fsp.stat(path).then(st => st.size, () => -1);
                if (size < 0)
                    throw new Error(`journal segment ${path} could not be measured: refusing to guess at which copy `
                        + `of the history is the complete one`);

                const current = best.get(f);

                // THE LONGEST COPY WINS -- BUT ONLY IF IT IS THE SAME HISTORY.
                //
                // Taking the biggest file on size alone is how a DIVERGENT segment gets adopted: a disk that
                // carried the journal in a previous life, re-seeded and now longer, would silently replace the
                // real history with a dead one. The journal itself checks this when it elects replicas
                // (agreeOnPrefix, byte-exact); the restore was taking it on faith.
                //
                // The shorter of the two must be a prefix of the longer, to the last shared byte. If it is not,
                // these are two different histories and nothing here can say which is ours.
                if (current) {
                    const [a, b] = size > current.size ? [current.path, path] : [path, current.path];

                    // BYTES, not a decoded string. Two segments that differ only in bytes that are not valid
                    // UTF-8 both decode to U+FFFD and compare EQUAL -- so a genuinely divergent history would
                    // sail through the check written to catch it. The journal's own agreeOnPrefix() compares
                    // bytes; so does this.
                    const shortBuf = await fsp.readFile(a);
                    const longBuf = await fsp.readFile(b);

                    if (!longBuf.subarray(0, shortBuf.length).equals(shortBuf))
                        throw new Error(`two copies of journal segment ${f} DIVERGE: ${a} is not a prefix of ${b}. `
                            + `These are two different histories, and nothing here can say which one is this `
                            + `array's. Replaying the wrong one would rewrite the namespace from a dead lineage. `
                            + `Refusing.`);
                }

                if (!current || size > current.size) best.set(f, { path, size });
            }
        }

        // NOT ONE READABLE REPLICA. The manifest says the journal lives on specific volumes; if none of them
        // will talk to us, the history since the snapshot is not "empty", it is UNREAD -- and a restore that
        // proceeds on that basis rebuilds the array as it was at snapshot time and calls it a success.
        if (journalVolumes.size && !replicasRead)
            throw new Error(`the bootstrap manifest says the namespace journal lives on volume(s) `
                + `${[...journalVolumes].join(', ')}, and not one of them could be read. Everything written since the `
                + `snapshot is recorded there. Refusing to restore a namespace that is knowingly out of date.`);

        // A JOURNAL DIRECTORY THAT OPENS AND IS EMPTY IS NOT A JOURNAL THAT DOES NOT EXIST.
        //
        // The manifest NAMES these volumes as the journal's home. If we can read their .journal directories and
        // find no segments in them at all, that is not "this array has no history" -- every journal begins at
        // 000000.jsonl and rotation only ever appends, so a journal with no 000000 is a journal whose beginning
        // is GONE. Falling through here leaves `best` empty, the gap check has nothing to check, and the restore
        // rebuilds the array as it stood at snapshot time and calls it a success -- silently dropping every name
        // written since.
        if (journalVolumes.size && replicasRead && !best.size)
            throw new Error(`the bootstrap manifest says the namespace journal lives on volume(s) `
                + `${[...journalVolumes].join(', ')}, those disks answered, and there is NOT ONE SEGMENT on any of `
                + `them. A journal always begins at 000000.jsonl and rotation only appends, so this is not an array `
                + `without a history -- it is a history that has been erased. Everything written since the snapshot `
                + `was recorded there. Refusing to rebuild the namespace as it stood at snapshot time and call that `
                + `a success.`);

        const segments = [...best.entries()].sort(([a], [b]) => a.localeCompare(b));

        assertNoJournalGaps(segments.map(([name]) => name), force);

        return segments.map(([, v]) => v.path);       // 000000, 000001, 000002 ... the order it happened
    },

    writeContainer: async (r) => {
        const { database } = require('../database') as typeof import('../database');
        await database.restoreContainer(r);
    },

    writeObject: async (r) => {
        const { database } = require('../database') as typeof import('../database');
        await database.restoreObject(r);
    }
});
