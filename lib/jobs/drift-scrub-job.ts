import { createLogger } from '../log';
import { notificationService } from '../notify/service';
import { allPlattersOrRefuse, buildSliceIndex, synthesiseRecordFromIndex, type Platter, type SliceIndex } from '../recovery/recovery';

const log = createLogger('drift-scrub');

// WHAT MONGO SAYS, AND WHAT IS ACTUALLY THERE.
//
// The rest of this work is about surviving the day the index dies. This is about the years before it -- the
// slow, quiet divergence between what the database believes and what is on the platters, which nobody
// notices because nothing is broken until the moment it matters enormously.
//
// Two directions, and they are NOT the same problem:
//
//   PHANTOM  -- Mongo names an object whose slices are not there. It reads as data loss. Every one of these
//               is a lie the array is telling about itself, and the point of all the write ordering in DR-C
//               is that this should be impossible. If the count is not zero, one of those orderings has a
//               hole in it, and this is how you find out before a customer does.
//
//   ORPHAN   -- slices on the platters that Mongo does not name. Inert, and recoverable: the slice HEADER
//               carries the object's id, size and geometry, so the data can be read back. What is missing is
//               only the name -- and if the object was written after the last snapshot, the journal has it.
//
// Orphans beat phantoms. That has been the rule from the beginning, and this is the job that proves whether
// the array has been keeping it.
//
// WHAT THIS JOB DOES NOT DO, said plainly so nobody has to guess. It checks that the slices EXIST and that
// their headers are STRUCTURALLY sound -- the id matches the filename, the geometry is sane, the slice index
// is inside the object. It does NOT read the chunk bodies or verify their checksums, because that is a
// different job that already exists (the scrub) and it takes days, not minutes: reading 130TB is not something
// to fold into a metadata check.
//
// Nor does it treat the HEADER checksum as a verdict, and that is deliberate -- see readSliceHeader(). This
// array has been running since 2014 and the header scheme changed part-way through 2015, so a large fraction
// of the oldest slices on these platters fail a checksum written by code that did not exist when they were
// stamped. They are fine. A job that counted them as loss would hand an operator a report claiming their
// oldest data was gone, which is worse than handing them no report at all.
//
// So an object can pass this and still have rot inside it. This job answers "does the database agree with the
// platters", and the scrub answers "is what is on the platters still what we wrote". Both questions matter.
// They are not the same question.

export type DriftReport = {
    objectsInDatabase: number;
    objectsOnPlatters: number;

    // COUNTS and SAMPLES are separate, and conflating them is a trap worth naming: the samples are capped, so
    // reporting `phantoms.length` as the number of phantoms would quietly say "1000" to an array with a
    // million of them -- understating a catastrophe by three orders of magnitude, in the one report whose
    // entire job is to tell you how bad things are.
    phantomCount: number;        // named in Mongo, no slices on disk
    orphanCount: number;         // slices on disk, unnamed in Mongo
    belowQuorumCount: number;    // named, but too few slices to reconstruct: real, irreversible loss

    // AND THE ONES WE COULD NOT JUDGE. Slices that EXIST on disks that would not answer -- EIO, a USB drive
    // that dropped off its bus. These are NOT loss, and folding them into belowQuorum would have this report
    // announce irreversible data loss over a drive that needs re-seating. That is the one mistake this job
    // must never make, because this report is the thing an operator believes.
    indeterminateCount: number;

    phantoms: string[];
    orphans: string[];
    belowQuorum: string[];
    indeterminate: string[];
    checkedAt: string;
};

export type DriftScrubDeps = {
    platters: () => Platter[];
    fleetGeometry: () => { dataSlices: number; paritySlices: number };
    streamObjectIds: () => AsyncIterable<string>;
    now: () => Date;
    fleetRestoreIncomplete: () => Promise<{ expected: number; startedAt: string } | null>;
};

const defaultDeps: DriftScrubDeps = {
    platters: allPlattersOrRefuse,
    fleetGeometry: () => {
        const { config } = require('../config') as typeof import('../config');
        return { dataSlices: config.dataSliceCount, paritySlices: config.paritySliceCount };
    },
    streamObjectIds: () => {
        const { database } = require('../database') as typeof import('../database');
        return database.streamAllObjectIds();
    },
    now: () => new Date(),
    fleetRestoreIncomplete: () => {
        const { database } = require('../database') as typeof import('../database');
        return database.fleetRestoreIncomplete();
    }
};

// A cap on what we will hold in memory and hand back. A report listing three million ids is not a report,
// it is a second copy of the problem -- and if the numbers are that large, the ids are not what anybody
// needs to look at first.
const SAMPLE_LIMIT = 1000;

export class DriftScrubJob {
    private readonly deps: DriftScrubDeps;
    private running = false;

    constructor(deps: Partial<DriftScrubDeps> = {}) {
        this.deps = { ...defaultDeps, ...deps };
    }

    isRunning(): boolean { return this.running; }

    async run(): Promise<DriftReport> {
        if (this.running)
            throw new Error('a drift scrub is already running');

        this.running = true;
        try {
            // A HALF-WRITTEN VOLUME TABLE MAKES THIS JOB A LIAR. Every disk missing from the table is a disk
            // this scrub never looks at, and every object living on one would be counted a phantom -- so an
            // interrupted fleet restore would have this report the array as catastrophically lost, in the very
            // report an operator turns to in order to find out how bad things are.
            const interrupted = await this.deps.fleetRestoreIncomplete();
            if (interrupted)
                throw new Error(`refusing to scrub: a fleet restore started ${interrupted.startedAt} did not finish, `
                    + `so the volume table may be missing disks. Every object on a disk that is missing from it `
                    + `would be reported as data loss. Finish the fleet restore first.`);

            const platters = this.deps.platters();
            const geometry = this.deps.fleetGeometry();
            const mounts = new Map(platters.map(p => [p.volumeId, p.mountPoint]));
            const mountOf = (volumeId: number) => mounts.get(volumeId);
            const placeholder = platters[0]?.volumeId ?? 0;

            log('indexing every slice on every disk...');
            const index: SliceIndex = await buildSliceIndex(platters,
                files => log('  ...%s slice files indexed', files.toLocaleString()));
            log('%s objects have at least one slice on the platters', index.size.toLocaleString());

            const report: DriftReport = {
                objectsInDatabase: 0,
                objectsOnPlatters: index.size,
                phantomCount: 0,
                orphanCount: 0,
                belowQuorumCount: 0,
                indeterminateCount: 0,
                phantoms: [],
                orphans: [],
                belowQuorum: [],
                indeterminate: [],
                checkedAt: this.deps.now().toISOString()
            };

            // Walk what Mongo believes, ticking each one off the platters as we go. Whatever is left in the
            // index at the end is, by definition, something the database has never heard of.
            const named = new Set<string>();
            for await (const id of this.deps.streamObjectIds()) {
                report.objectsInDatabase++;
                named.add(id);

                const slots = index.get(id);
                if (!slots) {
                    // A PHANTOM. Mongo swears this object exists and there is not a single slice of it on any
                    // disk in the array. Every write path in DR-C is ordered specifically so that this cannot
                    // happen -- so if this number is not zero, one of those orderings has a hole in it.
                    report.phantomCount++;
                    if (report.phantoms.length < SAMPLE_LIMIT) report.phantoms.push(id);
                    continue;
                }

                const rebuilt = await synthesiseRecordFromIndex(id, slots, mountOf, placeholder, platters, geometry);

                // NULL means the slices are there and NOT ONE of them has a readable header -- every copy is
                // structurally incoherent: no magic, or a geometry that cannot be true, or a lie about which
                // slice it is. The object cannot be DESCRIBED, so it cannot be reconstructed. Falling through
                // here without counting it would report a healthy array to an operator whose data is rotting,
                // which is the one thing this job must never do.
                if (!rebuilt) {
                    report.belowQuorumCount++;
                    if (report.belowQuorum.length < SAMPLE_LIMIT) report.belowQuorum.push(id);
                    continue;
                }

                // A disk that would not answer is not a disk that is empty. Counting this as below quorum would
                // have the notification below tell an operator their data is irreversibly gone, when it is
                // sitting intact on a drive that needs re-seating.
                if (rebuilt.reason === 'indeterminate') {
                    report.indeterminateCount++;
                    if (report.indeterminate.length < SAMPLE_LIMIT) report.indeterminate.push(id);
                    continue;
                }

                if (!rebuilt.recoverable) {
                    report.belowQuorumCount++;
                    if (report.belowQuorum.length < SAMPLE_LIMIT) report.belowQuorum.push(id);
                }
            }

            for (const id of index.keys()) {
                if (named.has(id)) continue;

                // An ORPHAN is data with no NAME -- and the reason that is good news rather than bad is that
                // the data can be read back. So it has to actually be readable before we say so. A stray,
                // corrupt slice file that nothing can decode is not "recoverable unnamed data"; calling it
                // that would tell an operator they have something they do not.
                const rebuilt = await synthesiseRecordFromIndex(id, index.get(id), mountOf, placeholder, platters, geometry);

                if (rebuilt?.reason === 'indeterminate') {
                    report.indeterminateCount++;
                    if (report.indeterminate.length < SAMPLE_LIMIT) report.indeterminate.push(id);
                    continue;
                }

                if (!rebuilt || !rebuilt.recoverable) {
                    report.belowQuorumCount++;
                    if (report.belowQuorum.length < SAMPLE_LIMIT) report.belowQuorum.push(id);
                    continue;
                }

                report.orphanCount++;
                if (report.orphans.length < SAMPLE_LIMIT) report.orphans.push(id);
            }

            log('drift scrub: %s objects in the database, %s on the platters, %d phantom(s), %d orphan(s), '
                + '%d below quorum, %d indeterminate',
                report.objectsInDatabase.toLocaleString(), index.size.toLocaleString(),
                report.phantomCount, report.orphanCount, report.belowQuorumCount, report.indeterminateCount);

            // A DISK THAT WILL NOT ANSWER IS NOT A VERDICT, IT IS A QUESTION -- and it is urgent, because
            // until it is answered we genuinely do not know whether these objects are fine or gone.
            if (report.indeterminateCount)
                void notificationService.notify({
                    severity: 'warning',
                    title: 'STRUBS could not read some slices, and cannot say whether those objects are safe',
                    body: `${report.indeterminateCount} object(s) have slices on disks that would not answer. Those `
                        + `slices EXIST -- this is not data loss, and it has deliberately NOT been counted as any. `
                        + `It means a disk is failing or has dropped off its bus, and until it is fixed nobody can `
                        + `say whether these objects are intact. Fix the disk and scrub again. First: `
                        + `${report.indeterminate.slice(0, 3).join(', ')}`,
                    dedupeKey: 'drift:indeterminate'
                }).catch(() => undefined);

            // A phantom is the array lying about itself, and it is the one thing here that should never
            // happen at all. It gets said louder than the rest.
            if (report.phantomCount)
                void notificationService.notify({
                    severity: 'critical',
                    title: 'STRUBS found objects that do not exist',
                    body: `${report.phantomCount} object(s) are named in the database with NO slices anywhere on the `
                        + `array. They will read as data loss. The write ordering exists specifically to make this `
                        + `impossible, so this is not drift -- it is a bug, and it wants investigating. First: `
                        + `${report.phantoms.slice(0, 3).join(', ')}`,
                    dedupeKey: 'drift:phantoms'
                }).catch(() => undefined);

            if (report.belowQuorumCount)
                void notificationService.notify({
                    severity: 'critical',
                    title: 'STRUBS found objects it can no longer reconstruct',
                    body: `${report.belowQuorumCount} object(s) have fewer surviving slices than they need. This is `
                        + `not drift and not a bug: it is real, irreversible data loss, and it is the number on this `
                        + `report that actually matters. First: ${report.belowQuorum.slice(0, 3).join(', ')}`,
                    dedupeKey: 'drift:below-quorum'
                }).catch(() => undefined);

            if (report.orphanCount)
                void notificationService.notify({
                    severity: 'warning',
                    title: 'STRUBS found unnamed data on the platters',
                    body: `${report.orphanCount} object(s) have slices on the array that the database does not know `
                        + `about. The DATA is fine -- the slice headers describe it completely -- it is the NAME that is `
                        + `missing. This is the failure mode the whole design prefers, and it is recoverable.`,
                    dedupeKey: 'drift:orphans'
                }).catch(() => undefined);

            return report;
        }
        finally {
            this.running = false;
        }
    }
}

export const driftScrubJob = new DriftScrubJob();
