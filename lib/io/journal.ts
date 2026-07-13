import { promises as fsp } from 'fs';
import type { FileHandle } from 'fs/promises';

import { config } from '../config';
import { createLogger } from '../log';
import { notificationService } from '../notify/service';
import { ensureDirectoryDurable, fsyncDirectory } from './helpers';

const log = createLogger('journal');

export const JOURNAL_DIR = '.journal';


// How long stop() waits for an in-flight re-election before closing the segments anyway.
const STOP_RECONFIGURE_WAIT_MS = 10_000;

// The journal is REPLICATED PLAINTEXT, not erasure-coded, and that is deliberate. The whole value of a
// recovery artifact is that you can read it with `cat` and zero infrastructure. Erasure-coding it would
// mean needing a working decoder before you could read the thing that tells you how to recover -- a
// bootstrapping trap. It is ~200 bytes per object; replicate it three times and stop thinking about it.
//
// It records the NAMESPACE, which is the only thing the disks cannot tell us themselves: an object's
// name, its container, its mime and its md5. Placement (which volume holds which slice) is deliberately
// NOT trusted from here -- drain and rebalance move slices without journaling, so a recorded placement
// can be stale, and the slice it names may already be deleted. Restore always re-derives placement by
// scanning the disks. dv/pv appear in the record because they are free and they make it readable by a
// human at 3am, not because anything reads them back.
//
// TWO RULES FOR THE REPLAY (DR-E), and neither is optional. Both say the same thing: THE DISKS DECIDE.
//
//   1. A `put` is materialised into a Mongo row ONLY IF the object's slices are FOUND on the platters.
//   2. A `del` is honoured ONLY IF the object's slices are GONE from the platters.
//
// The journal records INTENT, and it is made durable BEFORE the operation completes -- that ordering is the
// whole design, and the price of it is that the journal can contain records for things that never actually
// happened. A batch rejected on every replica can still leave a complete, perfectly parseable line on one
// platter (a write() that lands while the sync() meant to prove it fails), and the caller correctly gave up.
// A journal that is trusted blindly would then either manufacture a row pointing at nothing (a PHANTOM --
// the one failure this whole design exists to avoid) or delete the name of an object that is still sitting
// there, alive, whose delete the caller was told had FAILED.
//
// Neither rule needs the journal to be perfect. They need it to be CHECKED, against the only thing that
// cannot lie: what is actually on the platters. The journal supplies the names. The disks supply the truth.
//
// AND THE ONE THING THAT CANNOT BE CHECKED THAT WAY: a `container`. A folder has no slices, so the platters
// have nothing to say about whether it should exist. A replay can therefore restore an empty container that
// never really existed -- if its Mongo insert failed AND the compensating `del` failed too, or if it was in
// a rejected batch whose bytes could not be taken back off the disk.
//
// This is the accepted residue of the design, and it is worth being plain about why it is accepted: the
// damage is a STRAY EMPTY FOLDER. Not lost data, not a phantom object, and nothing can hide behind it --
// the objects that would have lived in it were never created either, since the same failure stopped them.
// The alternative is a two-phase commit between Mongo and a file, on the hot path of every write, to prevent
// a directory. That is not a trade worth making. It is logged, it is notified, and the drift scrub (DR-F)
// surfaces it. Anyone can delete an empty folder.
export type JournalRecord =
    | { op: 'put'; ts: string; id: string; cid: string | null; name: string; mime?: string | null; md5?: string | null; size: number; cs: number; dv?: number[]; pv?: number[] }
    | { op: 'del'; ts: string; id: string }
    | { op: 'container'; ts: string; id: string; cid: string | null; name: string }
    // A BUCKET'S ACCESS POLICY IS A NAMESPACE CHANGE, and leaving it out of the journal has a direction to it
    // that matters: the snapshot records the policy as it was when the snapshot ran, so a bucket made PRIVATE
    // afterwards would be restored PUBLIC. The recovery would quietly re-open a bucket somebody deliberately
    // closed, and report success. Every other namespace change is journaled; so is this one.
    | { op: 'policy'; ts: string; id: string; pr?: boolean; pw?: boolean };

type Replica = {
    volumeId: number;
    mountPoint: string;
    handle: FileHandle | null;
    bytes: number;
};

type PendingRecord = {
    line: string;
    resolve: () => void;
    reject: (err: Error) => void;
};

export type JournalDeps = {
    // Candidate volumes, newest fleet state. Lazily resolved to avoid an import cycle (ioManager hooks
    // the journal on fleet changes).
    getWritableVolumes: () => Array<{ id: number; mountPoint: string; busGroup: number | null }>;
    // The WHOLE fleet, with its mount state -- not just the writable volumes, and not just the ones that
    // came up. A disk that is read-only, draining or degraded can still be the last place the journal's
    // history physically exists, and on a cold start the platters are the only source there is. Electing
    // from `writable` but SEEDING from the whole fleet is deliberate.
    //
    // `isMounted` is carried explicitly and it MATTERS. A volume whose mount FAILED still has a mountPoint
    // (it is assigned before the attempt), and that path is an empty directory on the ROOT filesystem --
    // so reading it answers "no journal here" with total confidence about a disk we never actually opened.
    // That is the difference between "I looked and it was empty" and "I never got to look", and conflating
    // them is how you start a fresh journal on top of a real one.
    getFleetVolumes: () => Array<{ id: number; mountPoint: string | null; isDeleted: boolean; isMounted: boolean }>;
    now: () => Date;
};

const defaultDeps: JournalDeps = {
    getWritableVolumes: () => {
        const { ioManager } = require('./manager') as typeof import('./manager');
        return ioManager.getVolumeEntries()
            .map(([, volume]) => volume)
            .filter(volume => volume.isWritable && volume.mountPoint)
            .map(volume => ({ id: volume.id, mountPoint: volume.mountPoint as string, busGroup: volume.deviceGroup }));
    },
    getFleetVolumes: () => {
        const { ioManager } = require('./manager') as typeof import('./manager');
        return ioManager.getVolumeEntries()
            .map(([, volume]) => volume)
            .map(volume => ({
                id: volume.id,
                mountPoint: volume.mountPoint ?? null,
                isDeleted: !!volume.isDeleted,
                isMounted: !!volume.isMounted
            }));
    },
    now: () => new Date()
};

export class Journal {
    private readonly deps: JournalDeps;
    private replicas: Replica[] = [];
    private segment = 0;
    private started = false;
    // Set the instant stop() begins, so no new re-election can start reopening what it is closing. Distinct
    // from `started`, which start() only sets once its first reconfigure has already run.
    private stopping = false;

    // Group commit: accumulate records for a short window, then ONE fsync per replica for the batch. A
    // put waits on its own flush before its Mongo insert, so durability is preserved -- we just stop
    // paying an fsync per record when writes arrive together.
    private pending: PendingRecord[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private flushing: Promise<void> | null = null;
    // Held while the replica set is being rebuilt. append() waits on it, so no record can be acknowledged
    // on a replica whose history is still being copied in.
    private reconfiguring: Promise<void> | null = null;
    // Set whenever a replica is DROPPED from the set (a failed write, a segment that would not open). It
    // can only come back re-seeded, so the set has to be rebuilt -- but never from inside the flush that
    // discovered it, which is why this is a flag rather than a call.
    private reelectionNeeded = false;
    // Volumes whose journal segment may end in a record for an operation that never happened, because a
    // REJECTED batch could not be rolled back off them. In-process only, and deliberately so: it is a
    // suspicion, not a fact about the disk, and it must never survive to become a permanent verdict on
    // hardware that is probably fine. We change nothing on them -- we simply stop trusting them as a copy
    // of the namespace, so the doubtful tail cannot be seeded onto anything healthy.

    constructor(deps: Partial<JournalDeps> = {}) {
        this.deps = { ...defaultDeps, ...deps };
        // A caller that injects its own fleet view but no mounted-volume view means "this is the fleet".
        // Letting getMountedVolumes fall through to the default would reach for the real ioManager behind
        // that caller's back -- so mirror what it did give us.
        if (deps.getWritableVolumes && !deps.getFleetVolumes) {
            const writable = deps.getWritableVolumes;
            this.deps.getFleetVolumes = () =>
                writable().map(v => ({ id: v.id, mountPoint: v.mountPoint, isDeleted: false, isMounted: true }));
        }
    }

    get enabled(): boolean {
        return config.journalEnabled;
    }

    // Say, on every disk, where the journal now lives. Called whenever the replica set actually changes -- not
    // merely when the fleet does. Deliberately fire-and-forget: the bootstrap manifest is a convenience for a
    // future recovery, and it must never be able to stall or fail a namespace write happening right now.
    private publishReplicaLocation(): void {
        const ids = this.replicaVolumeIds;
        if (!ids.length) return;                     // an empty list is not an answer; the sink refuses it anyway

        // NOTHING IN HERE MAY TAKE THE JOURNAL DOWN WITH IT.
        //
        // The bootstrap manifest is a convenience for a future recovery. The journal is the thing standing
        // between this array and losing names RIGHT NOW. If publishing fails, we log loudly and keep writing --
        // the first version of this had the publish inside the try that guards segment discovery, so a failure
        // to update a JSON file would have made the journal drop every replica and refuse every namespace
        // write. The cure would have been considerably worse than the disease.
        try {
            const { bootstrapManifestWriter } = require('./bootstrap-manifest') as
                typeof import('./bootstrap-manifest');

            bootstrapManifestWriter.setJournalVolumeIds(ids);
            void bootstrapManifestWriter.write().catch(err =>
                log.error('the journal moved to volume(s) %s but the manifests could not be updated (%s). A recovery '
                    + 'would look in the OLD place -- and find an old, contiguous, entirely convincing history with '
                    + 'every recent name missing from it.', ids.join(', '), err));

            log('the journal now lives on volume(s) %s; the manifests have been told', ids.join(', '));
        }
        catch (err) {
            log.error('could not tell the bootstrap manifests that the journal moved to volume(s) %s: %s. The '
                + 'journal is still writing -- names are safe right now -- but a RECOVERY would look for them in '
                + 'the wrong place. This wants fixing before the next disaster, not during it.', ids.join(', '), err);
        }
    }

    get replicaVolumeIds(): number[] {
        return this.replicas.map(r => r.volumeId);
    }

    // Elect the replica set and open a segment on each. Safe to call repeatedly (fleet changes re-run it).
    async start(): Promise<void> {
        if (!this.enabled) {
            log('journal is DISABLED (STRUBS_JOURNAL_ENABLED=false): namespace changes are not being recorded');
            return;
        }
        this.stopping = false;

        await this.reconfigure();
        this.started = true;
    }

    async stop(): Promise<void> {
        // Shut the door on NEW re-elections first, then wait out any that is already running.
        //
        // The fleet-change hooks are fire-and-forget: ioManager and the device reconciler both kick
        // onFleetChange() without awaiting it. Closing the handles while one of those is mid-flight is
        // pointless -- it walks on to openSegments() and reopens every one of them, and the process exits
        // with the journal still open. Worse, it can reopen a file we have already flushed and closed.
        this.stopping = true;
        this.started = false;                      // append() stops accepting from this moment

        // Bounded. A re-election can be parked in disk I/O on a mount that has stopped answering, and this
        // runs AFTER the listeners are down -- so waiting forever would wedge the shutdown on exactly the
        // sick disk we are trying to get away from. Give it a fair chance to finish, then go anyway: the
        // records we are about to flush matter more than a tidy exit.
        const settled = await Promise.race([
            (async () => { await this.awaitReconfigure(); return true; })(),
            new Promise<boolean>(resolve => setTimeout(() => resolve(false), STOP_RECONFIGURE_WAIT_MS).unref?.())
        ]);
        if (!settled)
            log.error('a journal re-election is still running after %dms; closing anyway. It may have reopened a '
                + 'segment handle -- harmless, since nothing can append once the journal is stopped.',
                STOP_RECONFIGURE_WAIT_MS);

        if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
        await this.flush().catch(() => undefined);
        await this.closeAll();
    }

    // Pick K volumes across DISTINCT bus groups, so one enclosure dropping cannot take the whole journal
    // with it. Keeps any currently-elected replica that is still eligible, so a routine fleet change does
    // not churn the set (and force a needless segment copy). Pure: it only chooses, it does not open.
    private chooseReplicas(): Array<{ id: number; mountPoint: string; busGroup: number | null }> {
        const candidates = this.deps.getWritableVolumes();
        const wanted = config.journalReplicas;

        const chosen: typeof candidates = [];
        const usedGroups = new Set<number>();

        for (const existing of this.replicas) {
            const still = candidates.find(c => c.id === existing.volumeId);
            if (!still) continue;
            const group = still.busGroup ?? -still.id;      // ungrouped disks count as their own group
            if (usedGroups.has(group)) continue;
            chosen.push(still);
            usedGroups.add(group);
            if (chosen.length === wanted) break;
        }

        for (const candidate of candidates) {
            if (chosen.length === wanted) break;
            if (chosen.some(c => c.id === candidate.id)) continue;
            const group = candidate.busGroup ?? -candidate.id;
            if (usedGroups.has(group)) continue;
            chosen.push(candidate);
            usedGroups.add(group);
        }

        // Not enough distinct bus groups: fall back to any remaining writable volume rather than run with
        // fewer copies. Being on the same bus is worse than being one copy short, but not by much.
        for (const candidate of candidates) {
            if (chosen.length === wanted) break;
            if (chosen.some(c => c.id === candidate.id)) continue;
            chosen.push(candidate);
        }

        return chosen;
    }

    // Rebuild the replica set. Serialised by `reconfiguring`, which append() waits on -- a record must
    // never be acknowledged on a replica whose history is still being copied in, because the copy would
    // then overwrite it.
    //
    // A NEW replica is populated with the existing history BEFORE it goes live. Opening it first and
    // copying afterwards (the obvious order) is a data-loss bug: a flush landing in the gap writes an
    // ACKNOWLEDGED record into the new file, and copyFile then replaces the whole file. A replica whose
    // copy fails is not adopted at all -- an empty "replica" that reports success is worse than one fewer.
    // SERIALISED against itself. Two fleet changes arriving together must not rebuild the set
    // concurrently: the second would replace `reconfiguring`, finish first, and release append() while the
    // FIRST one's copy is still running -- which is precisely the bug the lock exists to prevent (an
    // acknowledged record written into a target that copyFile then overwrites). So each reconfigure chains
    // onto the previous one, and append() waits on the tail of the chain.
    private reconfigure(): Promise<void> {
        // Once stop() has begun, a re-election would only reopen what it is closing.
        if (this.stopping)
            return Promise.resolve();

        const chained = (this.reconfiguring ?? Promise.resolve())
            .catch(() => undefined)
            .then(() => this.reconfigureOnce());

        const mine = chained.catch(() => undefined);
        this.reconfiguring = mine;
        void mine.finally(() => {
            if (this.reconfiguring === mine)
                this.reconfiguring = null;
        });
        return chained;
    }

    private async reconfigureOnce(): Promise<void> {
        {
            // THIS is the re-election that the flag was asking for, so the request is now spent. Clearing it
            // here rather than at the end is deliberate: if a disk fails to open during the rebuild below,
            // openSegments() sets the flag again and we WILL come back for it -- but on the next write, not
            // in a tight loop against a disk that is failing right now.
            this.reelectionNeeded = false;

            // DRAIN the queue onto the CURRENT replicas before touching the set.
            //
            // Waiting only for an in-flight flush is not enough. A batch can be sitting in `pending` with
            // a timer that has not fired yet; that timer would then fire DURING the copy, write into the
            // source we are copying FROM, and the new replica would silently miss those records -- records
            // the caller was already told were durable. If the source is the disk being dropped, they are
            // simply gone.
            //
            // flush() clears the timer, chains onto any in-flight flush, and empties `pending`. append()
            // is already blocked on `reconfiguring`, so nothing new can arrive behind it: after this
            // returns, the queue stays empty for the duration of the copy.
            await this.flush().catch(() => undefined);

            const chosen = this.chooseReplicas();
            const previous = new Map(this.replicas.map(r => [r.volumeId, r]));

            const { sources, ambiguous } = await this.seedSources();

            if (ambiguous) {
                // We cannot tell which of two histories is the real one. Adopting an unseeded replica here
                // would open a fresh empty segment and start a THIRD lineage on top of the mess. Run with no
                // replicas instead: reads are untouched, and append() refuses -- which is the whole point.
                await this.closeAll();
                this.replicas = [];
                log.error('NO journal replicas: two conflicting namespace journals are present and namespace '
                    + 'changes are being REFUSED until an operator resolves it');
                return;
            }

            // Every segment the lineage has, anywhere. This is what "ours" means for the rest of this
            // function -- a disk holding a segment that is NOT in here is holding somebody else's journal.
            const lineageSegments = new Set<string>();
            for (const source of sources)
                for (const file of await listSegments(source.mountPoint))
                    lineageSegments.add(file);

            const kept: Replica[] = [];
            const adopted: Replica[] = [];

            for (const c of chosen) {
                const existing = previous.get(c.id);
                if (existing && existing.handle) {
                    kept.push(existing);
                    previous.delete(c.id);
                    continue;
                }
                // A target holding segments the LINEAGE DOES NOT HAVE is not a blank disk we can seed -- it
                // is a disk with somebody else's journal on it. Seeding it would leave two histories
                // interleaved in one directory, and the foreign segment (typically a higher number, from a
                // longer-lived previous life) would outrank the real ones the moment we next looked for the
                // newest: the whole replica set spliced onto a dead history, one restart later.
                //
                // Checked against the union of the WHOLE lineage, not against one source. A short source is
                // still a member -- that is the entire point of seeding from all of them -- so "not on this
                // particular disk" is not the same as "not ours".
                //
                // We touch none of it. Not moved, not deleted; those files may be the last copy of a history
                // somebody still wants. We simply refuse the disk, loudly, and leave the call to a human.
                // An EMPTY segment is never foreign. It holds no history, so there is nothing in it to
                // splice into ours and nothing in it to lose -- it is just a file. Judging it as foreign
                // would brick the simplest case there is: a fresh install creates empty segments on its
                // replicas, and if it restarts before anything is ever written, every disk in the array
                // would be refused for carrying a journal that consists of nothing at all.
                let seeded = true;
                try {
                    const foreign = [...(await listSegmentSizes(c.mountPoint)).entries()]
                        .filter(([name, size]) => size > 0 && !lineageSegments.has(name))
                        .map(([name]) => name);
                    if (foreign.length)
                        throw new JournalForeignSegmentsError(foreign, `${c.mountPoint}/strubs/${JOURNAL_DIR}`);
                }
                catch (err) {
                    log.error('volume%d: refusing to adopt as a journal replica -- %s', c.id, err);
                    if (err instanceof JournalForeignSegmentsError)
                        void notificationService.notify({
                            severity: 'critical',
                            title: 'STRUBS refused to use a volume for the namespace journal',
                            body: `Volume ${c.id} cannot be used as a journal replica: ${err.message} Until this is `
                                + `resolved the journal is running with fewer copies than configured.`,
                            dedupeKey: `journal:foreign:${c.id}`
                        }).catch(() => undefined);
                    continue;
                }

                // Seed it BEFORE it can be written to. Copying from EVERY source is safe and deliberate --
                // copySegments() only ever overwrites a segment that is shorter than the one it is copying,
                // so each pass can only grow the target. That makes the seed a union rather than a bet on
                // picking the right disk, and it quietly repairs a replica left short by a degraded write. A
                // source that fails to copy means we cannot prove the target has the full history, so we do
                // not adopt it: an empty "replica" that reports success is worse than one fewer, because it
                // is only discovered during the recovery it was supposed to serve.
                for (const source of sources) {
                    if (source.mountPoint === c.mountPoint) continue;
                    try {
                        await copySegments(source.mountPoint, c.mountPoint);
                    }
                    catch (err) {
                        log.error('volume%d: refusing to adopt as a journal replica -- segment copy from volume%d failed: %s',
                            c.id, source.volumeId, err);
                        seeded = false;
                        // Ask to be re-elected again. The seed may have failed for a passing reason (a busy
                        // disk, a transient read error), and without this the set would just stay short --
                        // the flag was cleared on the way into this rebuild, and nothing else would set it.
                        this.reelectionNeeded = true;

                        // A disk carrying somebody else's journal is not a transient failure -- it will be
                        // refused on every restart, forever, until a human looks at it. That deserves more
                        // than a log line, because the array is quietly running with fewer journal copies
                        // than it thinks it has.
                        if (err instanceof JournalForeignSegmentsError || err instanceof JournalDivergenceError)
                            void notificationService.notify({
                                severity: 'critical',
                                title: 'STRUBS refused to use a volume for the namespace journal',
                                body: `Volume ${c.id} cannot be used as a journal replica: ${err.message} Until this is `
                                    + `resolved the journal is running with fewer copies than configured.`,
                                dedupeKey: `journal:foreign:${c.id}`
                            }).catch(() => undefined);
                        break;
                    }
                }
                if (!seeded) continue;
                if (sources.length)
                    log('seeded journal replica on volume%d from volume(s) %s',
                        c.id, sources.map(s => s.volumeId).join(', '));
                adopted.push({ volumeId: c.id, mountPoint: c.mountPoint, handle: null, bytes: 0 });
            }

            // NEVER RETIRE THE LAST COPY TO NOWHERE.
            //
            // The election can legitimately come up empty: a drain marks its volume unwritable BEFORE asking
            // the journal to move off it, so the volume excludes itself as a candidate -- and if there is no
            // other eligible disk, `chosen` is empty. Closing the replicas we have at that point would take
            // the journal to ZERO and refuse every namespace change from here on, in service of a drain that
            // is about to be REFUSED anyway (relocateOff proves the move happened, and it did not).
            //
            // So if the rebuild found nowhere for the journal to live, we leave it exactly where it is. The
            // drain still fails, and it fails with a journal instead of without one. Being one disk short of
            // where you wanted the history is a problem; having nowhere at all to record it is a different
            // kind of problem entirely.
            const next = [...kept, ...adopted];
            const survivors = [...previous.values()].filter(r => r.handle);
            if (!next.length && survivors.length) {
                log.error('journal re-election found NO eligible volume to move to: KEEPING the existing replica(s) on '
                    + 'volume(s) %s rather than leaving namespace changes unrecorded.',
                    survivors.map(r => r.volumeId).join(', '));
                void notificationService.notify({
                    severity: 'critical',
                    title: 'STRUBS has nowhere to move the namespace journal',
                    body: `The journal needed to be re-elected but no eligible volume could take it, so it has been left `
                        + `on volume(s) ${survivors.map(r => r.volumeId).join(', ')}. If you are draining one of those, the `
                        + `drain will be refused: add a writable volume on another bus first.`,
                    dedupeKey: 'journal:nowhere-to-go'
                }).catch(() => undefined);
                this.replicas = survivors;
                return;
            }

            for (const dropped of previous.values()) {
                await this.closeReplica(dropped);
                log('journal replica on volume%d retired', dropped.volumeId);
            }

            this.replicas = next;
            // Discover the active segment from the LINEAGE (the disks we just seeded from), never from
            // whatever files happen to be lying around on the volumes we elected.
            try {
                await this.openSegments(sources.map(s => s.mountPoint));
            }
            catch (err) {
                // We could not read the lineage well enough to know WHICH segment is the live one. Opening
                // a guess would append new records into an old segment, ahead of records that came before
                // them. Run with no replicas instead: reads and the admin surface are untouched, and
                // append() refuses -- which is the honest answer to "I do not know where to write".
                log.error('could not determine the active journal segment (%s): refusing to adopt any replica', err);
                await this.closeAll();
                this.replicas = [];
                void notificationService.notify({
                    severity: 'critical',
                    title: 'STRUBS cannot determine the active journal segment',
                    body: `The disks carrying the namespace journal could not be read well enough to tell which segment `
                        + `is the live one (${err instanceof Error ? err.message : String(err)}). Namespace changes are being `
                        + `REFUSED rather than written into a guess. Reads are unaffected.`,
                    dedupeKey: 'journal:segment:undeterminable'
                }).catch(() => undefined);
                return;
            }

            // THE SEGMENTS ARE OPEN, SO THIS IS WHERE THE JOURNAL NOW LIVES -- AND THE MANIFESTS HAVE TO KNOW.
            //
            // A recovery reads the journal from the volumes the bootstrap manifest names, and NOWHERE else. We
            // re-elect replicas in here, on our own, after a degraded write, with nobody asking -- and if we say
            // nothing, every name written from this moment lands on volumes a recovery will never look at.
            //
            // And it would not even look wrong. The OLD journal directories are never deleted, so a recovery
            // finds them, reads a history that is contiguous, gap-free and utterly convincing, passes every
            // check, and hands the operator a namespace missing every name written since the move. Nothing can
            // detect that afterwards, which is exactly why it has to be impossible beforehand.
            //
            // Deliberately AFTER the try above and unable to throw: publishing a JSON file must never be able to
            // make the journal drop its replicas and refuse namespace writes.
            this.publishReplicaLocation();

            // A re-election that ends UNDER-STRENGTH does not retry itself, and that is deliberate: the
            // reason it came up short is almost always a disk that is failing right now, and hammering it
            // with a fresh segment copy on every subsequent write would be worse than being one copy down.
            // The next fleet change, or the next write that fails, will try again. What we do instead is
            // SAY so -- at a severity that matches how far down we are -- because a journal quietly running
            // on fewer copies than it was asked for is exactly the thing you want to find out about before
            // the day you need it, not on it.
            if (!this.replicas.length)
                log.error('NO journal replicas: namespace changes are NOT being recorded');
            else if (this.replicas.length < 2)
                void notificationService.notify({
                    severity: 'critical',
                    title: 'STRUBS journal is down to one replica',
                    body: `Only volume ${this.replicas[0].volumeId} carries the namespace journal. Losing it loses the `
                        + `names of everything written since the last snapshot.`,
                    dedupeKey: 'journal:replicas:low'
                }).catch(() => undefined);
            else if (this.replicas.length < config.journalReplicas)
                void notificationService.notify({
                    severity: 'warning',
                    title: 'STRUBS journal is running with fewer copies than configured',
                    body: `The namespace journal is on ${this.replicas.length} volume(s) `
                        + `(${this.replicaVolumeIds.join(', ')}), not the ${config.journalReplicas} it is configured for. `
                        + `It is still being recorded, but with less margin than you asked for.`,
                    dedupeKey: 'journal:replicas:under-strength'
                }).catch(() => undefined);

            log('journal replicas: %s', this.replicaVolumeIds.join(', ') || '(none)');
        }
    }

    // Where a new replica's history comes from.
    //
    // A live, open replica is authoritative: every replica is kept in lockstep, so one is enough.
    //
    // But on a COLD START there is no live replica -- `this.replicas` is empty, and memory knows nothing.
    // If the fleet changed while we were down (a journal disk pulled, a new one racked), the election can
    // land on a volume that has never held the journal. Adopting it unseeded would open an EMPTY file,
    // report it as a replica, write it into the bootstrap manifest, and hand it to a future recovery as
    // though it carried the namespace. So when memory has nothing, we go and read the platters: every
    // mounted volume that carries journal data is a source, writable or not. A disk that is read-only or
    // mid-drain is a perfectly good place to read history FROM even though we would never elect it.
    private async seedSources(): Promise<{ sources: Array<{ volumeId: number; mountPoint: string }>; ambiguous: boolean }> {
        // An open HANDLE is not proof the disk is still there. A file descriptor survives its filesystem
        // being unmounted -- writes to it just go nowhere real -- so a replica can look perfectly alive in
        // memory while its mountPoint has quietly become an empty directory on the root filesystem. Trusting
        // that replica as the authoritative source would have copySegments() read the empty path, find
        // nothing, copy nothing, and report a clean success: a brand-new replica adopted with NO history at
        // all. So a live replica only counts if the fleet still says its disk is mounted.
        // Only an EXPLICIT "isMounted: false" counts. A volume that is simply absent from the fleet listing
        // is not evidence of an unmounted disk -- it is the absence of evidence -- and closing a healthy
        // replica's handle on that would throw away the very source the seed needs. The fleet reports every
        // volume it knows about, mounted or not, so the disk we are worried about is listed and says so.
        const unmounted = new Set(this.deps.getFleetVolumes().filter(v => !v.isMounted).map(v => v.id));

        for (const replica of this.replicas) {
            if (replica.handle && unmounted.has(replica.volumeId)) {
                log.error('volume%d is no longer mounted but still had an open journal handle: closing it. Its '
                    + 'segments are not readable and it must not be used as a source.', replica.volumeId);
                await this.closeReplica(replica);
            }
        }

        const live = this.replicas.filter(r => r.handle);
        if (live.length)
            return { sources: [{ volumeId: live[0].volumeId, mountPoint: live[0].mountPoint }], ambiguous: false };

        const found: Array<{ volumeId: number; mountPoint: string }> = [];
        const unreadable: number[] = [];
        for (const volume of this.deps.getFleetVolumes()) {
            if (volume.isDeleted) continue;
            // NOT MOUNTED is not the same as EMPTY. The disk may be sitting right there with the whole
            // namespace history on it and a filesystem that would not mount -- and its mountPoint is an
            // empty directory on the root filesystem, which reads back as a confident "nothing here". A
            // volume we never opened cannot testify to anything, so it goes on the unreadable list and the
            // fail-closed rule below decides what that means.
            // Routine on a live array (retired disks, a drive out for replacement), so this is not shouted
            // about on its own -- it only matters if we ALSO fail to find any history, and the refusal
            // below is where that gets said loudly.
            if (!volume.isMounted || !volume.mountPoint) {
                log('volume%d is not mounted, so it could not be searched for journal history: unknown, not empty',
                    volume.id);
                unreadable.push(volume.id);
                continue;
            }

            let segments: Map<string, number>;
            try {
                segments = await listSegmentSizes(volume.mountPoint);
            }
            catch (err) {
                // We cannot read this disk, so we do not know whether it holds the journal. That is NOT the
                // same as it holding nothing.
                log.error('volume%d: could NOT be read while looking for journal history (%s). Treating it as '
                    + 'unknown, NOT as empty.', volume.id, err);
                void notificationService.notify({
                    severity: 'critical',
                    title: 'STRUBS could not read a volume while looking for the namespace journal',
                    body: `Volume ${volume.id} could not be scanned for journal segments (${err instanceof Error ? err.message : String(err)}). `
                        + `If that disk is the one carrying the namespace history, STRUBS has just started without it. `
                        + `Check the drive before writing anything you cannot afford to lose the name of.`,
                    dedupeKey: `journal:source:unreadable:${volume.id}`
                }).catch(() => undefined);
                unreadable.push(volume.id);
                continue;
            }
            if (!segments.size) continue;

            // NO HISTORY IS NOT A HISTORY. A disk whose segments are all EMPTY carries nothing -- it is a
            // replica whose file was created and never written to. It must not be a source, and above all it
            // must not be a class REPRESENTATIVE in the lineage vote: an empty file agrees with every other
            // file (they share zero bytes, and zero bytes always match), so it would vouch for two unrelated
            // journals at once and fold them into a single lineage. That is how a dead history gets laundered
            // into a live one -- via a disk that knows nothing agreeing with everybody.
            //
            // It costs us nothing to drop it. A blank replica needs seeding, not consulting.
            if (![...segments.values()].some(size => size > 0))
                continue;

            // A REMNANT, not a history. Every journal begins at 000000.jsonl, rotation only ever adds the
            // next number, and a seed copies the whole set -- so a disk that is a member of any lineage has
            // 000000.jsonl. Segments without it are leftovers from some previous life of the disk, and they
            // must not get a vote: letting one stand as a rival "lineage" would deadlock the tie-break
            // against the real journal, and letting it seed would splice a dead history into a live one.
            // We leave the files exactly where they are -- just not as evidence of anything.
            if (!segments.has('000000.jsonl')) {
                log.error('volume%d: has journal segments (%s) but no 000000.jsonl. Treating them as a REMNANT of an '
                    + 'older journal, not as this array\'s history. The files are being left untouched.',
                    volume.id, [...segments.keys()].join(', '));
                void notificationService.notify({
                    severity: 'warning',
                    title: 'STRUBS found leftover journal segments on a volume',
                    body: `Volume ${volume.id} carries journal segments (${[...segments.keys()].join(', ')}) but not `
                        + `000000.jsonl, so they cannot be part of this array's journal. STRUBS is ignoring them and has `
                        + `left them untouched. If you were expecting that disk to carry the namespace history, stop and `
                        + `look at it -- something has removed the start of it.`,
                    dedupeKey: `journal:remnant:${volume.id}`
                }).catch(() => undefined);
                continue;
            }

            found.push({ volumeId: volume.id, mountPoint: volume.mountPoint });
        }

        const { sources, excluded, ambiguous } = await this.majorityLineage(found);

        if (ambiguous) {
            // Two lineages, same size, no way to tell which is the real one. Extending EITHER makes the
            // ambiguity permanent, so we extend neither: adopt no replicas, refuse writes, and wait for a
            // human. Refusing namespace changes is loud and recoverable; guessing is neither.
            log.error('journal LINEAGE CONFLICT with NO MAJORITY across volume(s) %s: refusing to adopt any '
                + 'replica. Namespace changes will be REFUSED until this is resolved.',
                excluded.map(s => s.volumeId).join(', '));
            void notificationService.notify({
                severity: 'critical',
                title: 'STRUBS found two namespace journals and cannot tell which is real',
                body: `Volume(s) ${excluded.map(s => s.volumeId).join(', ')} carry journal segments belonging to more `
                    + `than one history, with no majority to break the tie. STRUBS has NOT merged them, has NOT touched `
                    + `them, and is REFUSING namespace changes rather than extending a history it cannot vouch for. `
                    + `Reads are unaffected. Detach the disks that do not belong to this array and restart.`,
                dedupeKey: 'journal:lineage:ambiguous'
            }).catch(() => undefined);
            return { sources: [], ambiguous: true };
        }

        if (excluded.length) {
            // Two journal LINEAGES are physically present. Seeding from both would splice unrelated
            // histories into one file, so we take the majority and leave the odd one out ALONE (untouched,
            // unread, still on its disk for an operator to look at). Loud, because the excluded disk may be
            // the one carrying records nobody else has.
            log.error('journal LINEAGE CONFLICT: volume(s) %s carry a journal that disagrees with the majority '
                + 'on volume(s) %s. Seeding from the majority ONLY; the others are being left untouched.',
                excluded.map(s => s.volumeId).join(', '), sources.map(s => s.volumeId).join(', '));
            void notificationService.notify({
                severity: 'critical',
                title: 'STRUBS found two different namespace journals',
                body: `Volume(s) ${excluded.map(s => s.volumeId).join(', ')} carry journal segments that are not part `
                    + `of the same history as volume(s) ${sources.map(s => s.volumeId).join(', ')}. This usually means a `
                    + `disk from an older instance of the journal has been re-attached. STRUBS has NOT merged them and `
                    + `has NOT touched the odd disks -- inspect them before doing anything else; they may hold records `
                    + `no other disk has.`,
                dedupeKey: 'journal:lineage:conflict'
            }).catch(() => undefined);
        }

        // NO history found, and a disk we could NOT READ. Those two facts together are the one combination we
        // must never shrug off: the history may be sitting on the disk that would not answer, and carrying on
        // means electing blank replicas and writing a brand-new journal while the real one lies unread a foot
        // away. "I found nothing" is only trustworthy if we managed to LOOK everywhere.
        //
        // So we refuse. No replicas, no writes, reads and the admin surface untouched. If the disk really is
        // dead and empty, an operator removes it from the fleet and we start clean on the next boot -- one
        // deliberate action, instead of a silent fork of the namespace.
        if (!sources.length && unreadable.length) {
            log.error('cold start found NO journal history, but volume(s) %s could not be read. REFUSING to start a '
                + 'fresh journal: the history may be on one of them.', unreadable.join(', '));
            void notificationService.notify({
                severity: 'critical',
                title: 'STRUBS will not start a new namespace journal while a disk is unreadable',
                body: `No journal history was found, but volume(s) ${unreadable.join(', ')} could not be read. Starting a `
                    + `fresh journal now would fork the namespace if one of those disks is the one carrying it. STRUBS is `
                    + `REFUSING namespace changes until the disk is readable or removed from the fleet. Reads are unaffected.`,
                dedupeKey: 'journal:cold-start:unreadable'
            }).catch(() => undefined);
            return { sources: [], ambiguous: true };     // same fail-closed path as an unresolvable lineage
        }

        if (sources.length)
            log('cold start: journal history found on volume(s) %s', sources.map(s => s.volumeId).join(', '));
        else
            // Either a genuinely fresh install, or every disk that held the journal is gone. We cannot tell
            // the two apart from in here -- and the second one is a silent catastrophe, because we would
            // cheerfully start a brand-new empty journal over the top of it. So say so, loudly, once.
            void notificationService.notify({
                severity: 'warning',
                title: 'STRUBS journal is starting EMPTY',
                body: 'No journal history was found on any mounted volume. This is expected on a first start. '
                    + 'On an existing array it means every disk that carried the namespace journal is missing -- '
                    + 'do NOT let it write a fresh one over the top; stop STRUBS and re-attach the disks.',
                dedupeKey: 'journal:cold-start:empty'
            }).catch(() => undefined);

        return { sources, ambiguous: false };
    }

    // Split candidate sources into journal LINEAGES.
    //
    // Every disk in ONE lineage agrees. Each replica receives the same byte stream, and a replica that
    // fails a write is CLOSED rather than skipping the batch and resuming -- so its segment is always a
    // strict PREFIX of a healthier copy, and two prefixes of the same stream always agree over the bytes
    // they share. A disagreement is therefore never "a degraded replica": it is a different history
    // wearing the same filenames.
    //
    // The LARGEST group wins -- a plurality, not a strict majority, and deliberately so. Rival groups
    // disagree with each other as much as they disagree with the winner (they are separate histories, not
    // one opposition bloc), so "3 disks agree, and two strays disagree with everyone including each other"
    // has an obvious answer. What has no answer is a TIE for largest: there we refuse to seed from ANY of
    // them, because with no evidence for either history, extending one is how you make the ambiguity
    // permanent. The journal then has no replicas, so writes are refused until a human decides.
    //
    // The losers are left strictly alone either way. We never merge (that would splice unrelated records
    // into one file) and we never wipe (the odd disk may be the only one holding real records -- the
    // operator's call, with the notification in front of them).
    private async majorityLineage<T extends { volumeId: number; mountPoint: string }>(
        candidates: T[]
    ): Promise<{ sources: T[]; excluded: T[]; ambiguous: boolean }> {
        if (candidates.length < 2)
            return { sources: candidates, excluded: [], ambiguous: false };

        const classes: T[][] = [];
        for (const candidate of candidates) {
            let placed = false;
            for (const lineage of classes) {
                if (await sameLineage(lineage[0].mountPoint, candidate.mountPoint)) {
                    lineage.push(candidate);
                    placed = true;
                    break;
                }
            }
            if (!placed) classes.push([candidate]);
        }

        if (classes.length === 1)
            return { sources: classes[0], excluded: [], ambiguous: false };

        classes.sort((a, b) => b.length - a.length);
        if (classes[0].length === classes[1].length)
            return { sources: [], excluded: candidates, ambiguous: true };

        return { sources: classes[0], excluded: classes.slice(1).flat(), ambiguous: false };
    }

    // Open the SAME segment number on every replica. Deciding it per-replica while mutating shared state
    // lets an early replica open 000005 and a later one push the shared counter to 000007, after which the
    // replicas append to different filenames and diverge -- a replay would then have to guess.
    private async openSegments(discoverFrom: string[] = []): Promise<void> {
        // FENCE. A re-election that outran stop()'s bounded wait must not walk on and reopen every handle
        // that stop() has just closed -- Core is on its way to unmounting these volumes, and reopening
        // files underneath that is how a shutdown races the journal it thinks it already stopped.
        if (this.stopping)
            return;

        // Which segment is the active one?
        //
        // ONLY THE LINEAGE GETS A VOTE. The old rule -- "the highest number that exists anywhere on any
        // replica" -- read files that have nothing to do with us. A volume elected today may have been a
        // journal replica in a previous life and still carry its old segments (seeding does not remove
        // them; we never delete). A stale 000005.jsonl would then outrank the real 000001, every replica
        // would open 000005, and the set would splice itself onto a dead history while the live one sat
        // there ignored. So we look only at the disks we just seeded FROM -- which have already had to
        // agree on 000000.jsonl to be called a lineage at all.
        //
        // A listing failure here is not survivable: choosing the active segment from a partial view of the
        // lineage could land us on an OLD segment and append new records in front of existing ones. Let it
        // throw; the caller drops to zero replicas and refuses writes.
        const present = new Set<number>();
        for (const mount of discoverFrom) {
            for (const file of await listSegments(mount)) {
                const m = /^(\d+)\.jsonl$/.exec(file);
                if (m) present.add(parseInt(m[1], 10));
            }
        }

        // The lineage's segments run CONTIGUOUSLY from 000000 -- rotation adds exactly one, a seed copies
        // the whole set, nothing is ever removed. So a GAP means a segment has been LOST, and that changes
        // the answer: stopping at the gap would put us on a pre-gap segment and interleave new records
        // ahead of the ones in the segments above it. Take the highest either way; the ordering of what
        // survives is worth more than tidiness about what does not.
        const top = present.size ? Math.max(...present) : 0;
        if (present.size && [...Array(top + 1).keys()].some(n => !present.has(n))) {
            const missing = [...Array(top + 1).keys()].filter(n => !present.has(n));
            log.error('journal segments are MISSING from the history: %s. The namespace changes they recorded are '
                + 'gone. Continuing on segment %d so that what survives stays in order.',
                missing.map(n => String(n).padStart(6, '0')).join(', '), top);
            void notificationService.notify({
                severity: 'critical',
                title: 'STRUBS namespace journal has missing segments',
                body: `Journal segment(s) ${missing.map(n => String(n).padStart(6, '0')).join(', ')} are absent from every `
                    + `disk carrying the journal. The namespace changes recorded in them cannot be recovered from the `
                    + `journal. Objects written in that window will still be found on the platters, but as unnamed orphans.`,
                dedupeKey: 'journal:segments:missing'
            }).catch(() => undefined);
        }

        // ...and never go BACKWARDS: this.segment is already past `top` right after a rotation, whose new
        // file does not exist anywhere yet.
        const highest = Math.max(this.segment, top);

        // If the active segment MOVED -- e.g. a newly-adopted replica turned out to carry a higher segment
        // than the ones we already have open -- then every replica must move with it, including the ones
        // already open on the older file. Leaving them where they are splits the set across two filenames
        // and a replay would have to guess which is the real tail.
        if (highest !== this.segment) {
            this.segment = highest;
            await this.closeAll();
        }

        const filename = `${String(this.segment).padStart(6, '0')}.jsonl`;
        const unopenable: Replica[] = [];
        for (const replica of this.replicas) {
            if (replica.handle) continue;
            try {
                const dir = `${replica.mountPoint}/strubs/${JOURNAL_DIR}`;

                await ensureDirectoryDurable(dir);
                await rollBackTornTail(`${dir}/${filename}`, replica.volumeId);
                // 'a' (append), never 'w' -- an existing segment must never be truncated on restart.
                replica.handle = await fsp.open(`${dir}/${filename}`, 'a');
                const stat = await replica.handle.stat();
                replica.bytes = stat.size;

                // The segment's DIRECTORY ENTRY has to be on the platter, not just its contents. flush()
                // fsyncs the file, which is what makes a record durable -- but an fsync on a file says
                // nothing about the directory that names it. Lose power after acknowledging records into a
                // segment whose entry never reached the disk and the whole file goes with it, records and
                // all. This runs on the first write of a fresh install and on every rotation, which is
                // precisely when the journal is most likely to be all there is.
                //
                // UNCONDITIONALLY, not just when the file is new. "The file already exists" does not mean
                // "its name is durable" -- it can equally mean a previous attempt created it and then FAILED
                // this very fsync, and skipping it on that basis would mean the one segment whose entry we
                // know to be unproven is the one we never try to prove again. An fsync of a directory with
                // nothing dirty in it costs nothing.
                await fsyncDirectory(dir);
            }
            catch (err) {
                log.error('volume%d: could not open a journal segment: %s', replica.volumeId, err);
                replica.handle = null;
                unopenable.push(replica);
            }
        }

        // A replica we could not OPEN is not a replica, and leaving it in the set with a null handle is the
        // same trap as leaving one that failed a write. flush() would skip it and acknowledge records on the
        // others; the next rotation would call back into here and reopen it on the NEW segment; and it would
        // resume looking like a full copy while missing everything written in between.
        //
        // Out of the set. It comes back the only way anything comes back: re-elected and re-seeded, with
        // whatever it missed copied in before it is allowed to accept a single record.
        if (unopenable.length) {
            this.replicas = this.replicas.filter(r => !unopenable.includes(r));
            this.reelectionNeeded = true;
        }
    }

    private async closeReplica(replica: Replica): Promise<void> {
        if (!replica.handle) return;
        try { await replica.handle.close(); }
        catch { /* closing a dead disk can fail; nothing to do */ }
        replica.handle = null;
    }

    private async closeAll(): Promise<void> {
        for (const replica of this.replicas)
            await this.closeReplica(replica);
    }

    // Append a record and RESOLVE ONLY ONCE IT IS DURABLE on at least one replica. The caller (a PUT, a
    // DELETE, a container create) then proceeds to Mongo. That ordering is the entire point of the
    // journal, so this must never resolve early.
    // Wait until no re-election is in flight.
    //
    // A LOOP, not a single await. Reconfigurations chain: while we are parked on the one we observed, a
    // second fleet change can install a new tail behind it. Waking on the old head and walking straight into
    // the queue would drop us INSIDE the next reconfigure's copy window -- the record gets fsynced and
    // acknowledged on the source that copySegments() has already read, so it reaches the caller as durable
    // and never reaches the new replica. Re-check until the field is genuinely clear.
    private async awaitReconfigure(): Promise<void> {
        while (this.reconfiguring)
            await this.reconfiguring.catch(() => undefined);
    }

    async append(record: JournalRecord): Promise<void> {
        if (!this.enabled || !this.started)
            return;

        // Never write into a replica set that is being rebuilt underneath us -- a record acknowledged on a
        // replica whose history is still being copied in would be overwritten by that copy.
        await this.awaitReconfigure();

        // NO REPLICAS: try to get some, right now, before giving up on this write.
        //
        // The re-election that follows a failed write is fired from the flush -- and when the set is empty
        // there is no flush to reach, because we throw below first. Left alone, the journal would sit there
        // dead forever, refusing every namespace change while waiting for a re-election that only a
        // successful write could trigger. Nothing would ever break the cycle but a restart.
        //
        // So at zero we always try. Not gated on the reelectionNeeded flag: that flag gets consumed by a
        // rebuild which then legitimately finds nowhere to go (every disk busy, the fleet mid-refresh), and
        // the need is still very much there afterwards. And there is nothing to lose by trying -- every
        // write is already failing.
        if (!this.replicas.length) {
            // One attempt, shared. If another append already has a re-election in flight, WAIT for that one
            // rather than chaining a second full scan of the fleet behind it: a hundred writes arriving
            // against a dead journal should cost one attempt between them, not a hundred in series.
            if (!this.reconfiguring)
                void this.reconfigure().catch(err =>
                    log.error('re-election before an append with no replicas failed: %s', err));
            await this.awaitReconfigure();
        }

        if (!this.replicas.length) {
            // The journal is a durability guarantee. Silently degrading it is how you discover it was
            // empty on the day you needed it.
            throw new Error('journal has no replicas: refusing to proceed with an unjournaled namespace change');
        }

        const line = JSON.stringify(record) + '\n';
        return new Promise<void>((resolve, reject) => {
            this.pending.push({ line, resolve, reject });
            if (this.pending.length >= config.journalMaxBatch) {
                void this.flush().catch(() => undefined);
                return;
            }
            if (!this.flushTimer)
                this.flushTimer = setTimeout(() => { void this.flush().catch(() => undefined); }, config.journalFlushMs);
        });
    }

    // One write + one fsync per replica for the whole batch.
    async flush(): Promise<void> {
        // A flush is already running. Do NOT just return its promise: records appended since it started
        // are in a fresh `pending` batch that has no owner and (if we cleared the timer) no timer either,
        // so they would sit unflushed until some later append happened to trigger one -- stranding a PUT
        // that is blocking on durability. Chain a follow-up flush instead.
        if (this.flushing)
            return this.flushing.then(() => this.flush(), () => this.flush());

        if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
        if (!this.pending.length) return;

        const batch = this.pending;
        this.pending = [];

        this.flushing = (async () => {
            const body = Buffer.from(batch.map(p => p.line).join(''), 'utf8');
            const filename = `${String(this.segment).padStart(6, '0')}.jsonl`;
            // Where each OPEN replica's file ended before this batch. If the batch is rejected we roll them
            // back to exactly here (see below). Only the ones we are about to write to: a replica that is
            // already closed is not ours to truncate, and its `bytes` is a stale number that would cut real
            // records off its platter.
            const before = new Map(this.replicas
                .filter(r => r.handle)
                .map(r => [r.volumeId, { mountPoint: r.mountPoint, bytes: r.bytes }]));
            const failed: Replica[] = [];
            let durable = 0;

            for (const replica of this.replicas) {
                if (!replica.handle) continue;
                try {
                    const { bytesWritten } = await replica.handle.write(body);
                    // A SHORT write leaves a truncated NDJSON line -- an unparseable record at exactly the
                    // moment you need to read it. Treat the replica as failed rather than counting it
                    // durable and letting the caller proceed on a half-written record.
                    if (bytesWritten !== body.length)
                        throw new Error(`short write: ${bytesWritten} of ${body.length} bytes`);
                    await replica.handle.sync();
                    replica.bytes += body.length;
                    durable++;
                }
                catch (err) {
                    log.error('volume%d: journal write failed: %s', replica.volumeId, err);
                    await this.closeReplica(replica);
                    failed.push(replica);
                }
            }

            // A replica that failed this batch now has a HOLE in it. If the others accepted the batch, the
            // caller was told the record is durable -- and this disk does not have it. Closing the handle is
            // not enough: rotation calls openSegments(), which reopens every handle-less replica on the NEXT
            // segment, and this one would quietly resume writing with an acknowledged record missing from its
            // history. It would look like a full replica right up until it was the last one standing.
            //
            // So take it OUT of the set. Re-election puts it back the only way it is allowed back: RE-SEEDED
            // from a healthy replica, with the hole filled.
            if (failed.length) {
                this.replicas = this.replicas.filter(r => !failed.includes(r));
                this.reelectionNeeded = true;
            }

            if (durable === 0) {
                // NOBODY acknowledged this batch, and the caller is about to be told so -- it will abandon
                // the operation. But "the fsync failed" does not mean "the bytes are not there": a write()
                // can succeed and land on the platter while the sync() that was supposed to prove it fails.
                // What that leaves behind is far nastier than a torn line, because it is not torn at all --
                // it is a COMPLETE, perfectly parseable record for a change that never happened. A `del`
                // like that would have a rebuild drop the name of an object that is still sitting there,
                // very much alive, whose delete the caller was told had FAILED.
                //
                // So roll every replica back to exactly where it was before we tried. These bytes were
                // never acknowledged to anyone, and nothing may ever read them as though they were.
                const stuck: number[] = [];

                for (const [volumeId, { mountPoint, bytes }] of before) {
                    const path = `${mountPoint}/strubs/${JOURNAL_DIR}/${filename}`;
                    try {
                        await truncateSegmentTo(path, bytes);
                    }
                    catch (truncErr) {
                        stuck.push(volumeId);
                        log.error('volume%d: could NOT roll back a REJECTED journal batch (%s). Its segment may now '
                            + 'end with a complete, parseable record for a change we were about to call FAILED.',
                            volumeId, truncErr);
                    }
                }

                // WE MAY NOT KNOW WHETHER THE BYTES ARE GONE, AND NO LOCAL RULE CAN TELL US.
                //
                // The truncate can fail AFTER doing its work -- the file is back at the old length and only the
                // sync() that would prove it failed. Or it can fail before touching anything. From here the two
                // are indistinguishable, so the record may be on the platter or may not.
                //
                // I tried both answers and both are wrong. REJECT, and a record for an operation the caller
                // abandoned may survive in the history. PROMOTE it to success, and the caller may unlink an
                // object's slices on the strength of a `del` that is not actually in any journal -- and the
                // restore then reports a deliberately-deleted object as MISSING DATA.
                //
                // So the batch is REJECTED (the caller must not believe a write that reached no replica), and
                // the ambiguity is dealt with where it can actually be settled: at REPLAY.
                //
                //   `put`  -- the platters settle it: no slices, no name. Dropped.
                //   `del`  -- the platters settle it: slices still there, delete never completed. Ignored.
                //   `container` -- accepted residue, and always was: a stray empty folder.
                //   `policy` -- has no physical evidence anywhere, so replay makes it SAFE INSTEAD OF CERTAIN:
                //               a journalled policy record may CLOSE a bucket, never OPEN one. An escaped record
                //               can then only ever over-restrict, which an operator notices and fixes in a
                //               moment. It can never leak.
                if (stuck.length)
                    log.error('journal: a rejected batch could not be provably rolled back off volume(s) %s. Its '
                        + 'records may or may not be on those platters -- there is no way to tell from here. The '
                        + 'batch is REJECTED (the caller must not believe it), and the replay rules settle the rest: '
                        + 'a put with no slices is dropped, a del whose slices survive is ignored, and a bucket '
                        + 'policy may only ever CLOSE a bucket, never open one.', stuck.join(', '));

                const err = new Error('journal write failed on EVERY replica');
                for (const p of batch) p.reject(err);
                void notificationService.notify({
                    severity: 'critical',
                    title: 'STRUBS journal write failed',
                    body: 'No replica accepted the write. Namespace changes are being REFUSED rather than silently unjournaled.',
                    dedupeKey: 'journal:write:failed'
                }).catch(() => undefined);
                return;
            }

            if (failed.length) {
                log.error('journal write landed on only %d replica(s); volume(s) %s dropped out of the set and must '
                    + 'be re-seeded before they can carry the history again',
                    durable, failed.map(r => r.volumeId).join(', '));
                void notificationService.notify({
                    severity: 'warning',
                    title: 'STRUBS journal is degraded',
                    body: `A journal write failed on volume(s) ${failed.map(r => r.volumeId).join(', ')} and landed on `
                        + `${durable}. Those volumes have been dropped from the journal and will be re-seeded.`,
                    dedupeKey: 'journal:write:degraded'
                }).catch(() => undefined);
            }

            for (const p of batch) p.resolve();

            await this.rotateIfNeeded();
        })().finally(() => {
            this.flushing = null;
            // Re-elect AFTER the flush has fully settled, never from inside it: reconfigureOnce() drains the
            // queue with its own flush() first, and calling it from in here would have that chain onto the
            // very flush that is still finishing. Fire-and-forget is right -- the caller's record is already
            // durable on the replicas that accepted it, and the re-seed is repair work, not part of the write.
            if (this.reelectionNeeded)
                void this.reconfigure().catch(err =>
                    log.error('re-election after a degraded journal write failed: %s', err));
        });

        return this.flushing;
    }

    private async rotateIfNeeded(): Promise<void> {
        const full = this.replicas.some(r => r.handle && r.bytes >= config.journalSegmentBytes);
        if (!full) return;
        this.segment++;
        log('rotating journal to segment %d', this.segment);
        await this.closeAll();
        await this.openSegments();
    }

    // A fleet change may have taken a journal volume away (drained, disabled, pulled). Re-elect and, if
    // the set changed, copy the existing segments onto any new replica so the history is not left behind
    // on a disk that is about to leave. The journal has to FOLLOW the fleet: the drain job relocates
    // SLICES, and it knows nothing about .journal/, so nothing else does this.
    async onFleetChange(): Promise<void> {
        if (!this.enabled || !this.started) return;

        // Go STRAIGHT to reconfigure(), which installs the exclusion lock synchronously and only then
        // drains the queue. Flushing here first would look prudent and be a hole: during that await the
        // lock is not yet held, so an append could arrive, queue a batch and arm a timer -- and that timer
        // would fire during copySegments(), writing an acknowledged record into the source we are copying
        // FROM. The exclusion window has to open BEFORE we do anything that yields.
        await this.reconfigure();
    }

    // Move the journal off a volume that is on its way out, and PROVE that it left. THROWS if it did not.
    //
    // The proof is the point. Re-election deliberately does not adopt a replica whose segment copy failed
    // -- it logs and carries on with one fewer -- so onFleetChange() RESOLVING tells us nothing about where
    // the journal ended up. Every caller here is a step an operator reads as "this disk is now safe to
    // pull", so the postcondition is checked, not assumed.
    //
    // Two things must hold: the volume is no longer elected, and it does not hold the last complete copy of
    // any segment. The second is not implied by the first -- a retired replica keeps its files.
    async relocateOff(volumeId: number): Promise<void> {
        await this.onFleetChange();

        if (this.replicaVolumeIds.includes(volumeId))
            throw new Error(
                `the namespace journal is still replicated on volume ${volumeId} (no eligible replacement volume `
                + `was adopted). Add a writable volume on another bus, then retry.`
            );

        await this.assertNotLastCopy(volumeId);
    }

    // Segments whose only COMPLETE copy is on this volume. Comparing filenames is not enough: a journal
    // write is allowed to proceed having landed on only some replicas, so another disk holding a file of
    // the same name may hold a SHORTER one. If the only full copy of a segment's tail is here, losing this
    // disk destroys those records -- and a name-only check would wave it through.
    //
    // Neither is comparing SIZES enough. A same-sized file elsewhere is only reassuring if it is the same
    // HISTORY: a disk carrying an unrelated journal lineage of a similar length would otherwise stand in as
    // the safe copy, and we would wave through the removal of the last disk that actually had the records.
    // So a copy only counts if this volume's segment is a genuine prefix of it.
    async assertNotLastCopy(volumeId: number): Promise<void> {
        if (!this.enabled) return;

        // Only a MOUNTED volume can be read, and only a mounted volume can be vouched for. A volume whose
        // mount failed still has a mountPoint -- an empty directory on the root filesystem -- so reading it
        // would answer "no journal here" about a disk we never opened.
        const volumes = this.deps.getFleetVolumes()
            .filter((v): v is typeof v & { mountPoint: string } => v.isMounted && !!v.mountPoint);

        const mine = volumes.find(v => v.id === volumeId);
        if (!mine) {
            // NOT MOUNTED, so we cannot read what it is holding -- and everywhere else in this file that
            // means UNKNOWN, not empty. But it does not have to mean "refuse", either.
            //
            // Every live replica carries the WHOLE history: a seed copies every segment, and a replica that
            // fails a write is dropped from the set rather than left with a hole. So if the journal is
            // healthy right now, whatever is on this unreadable disk is also on the disks that are open in
            // front of us, and letting it go cannot cost us a record.
            //
            // "Healthy" excludes the volume being removed -- its own file descriptor survives its filesystem
            // being unmounted, so it would otherwise stand there vouching for itself -- and excludes any
            // replica whose disk the fleet no longer reports as mounted, for exactly the same reason.
            const healthyElsewhere = this.replicas.some(r =>
                r.handle && r.volumeId !== volumeId && volumes.some(v => v.id === r.volumeId));

            if (!healthyElsewhere)
                throw new Error(
                    `cannot confirm that volume ${volumeId} is safe to remove: it is not mounted, so its journal `
                    + `segments cannot be read, and the journal currently has NO healthy replica to vouch for the `
                    + `namespace history. That disk may be the only place it exists. Mount it, or get the journal `
                    + `healthy on other volumes, before removing it.`
                );
            return;
        }

        // An unreadable disk is NOT a disk with no journal on it. If we cannot enumerate what this volume
        // is holding, we cannot prove it is safe to pull -- and "the drive is too sick to answer" is
        // exactly the situation in which someone is standing in front of the rack about to pull it. Throw:
        // the caller turns this into a refusal.
        let segments: Map<string, number>;
        try {
            segments = await listSegmentSizes(mine.mountPoint);
        }
        catch (err) {
            throw new Error(
                `cannot verify whether volume ${volumeId} holds the last copy of any journal segment: its journal `
                + `directory could not be read (${err instanceof Error ? err.message : String(err)}). Refusing rather `
                + `than assuming it holds nothing.`
            );
        }
        if (!segments.size) return;

        const dir = (mount: string) => `${mount}/strubs/${JOURNAL_DIR}`;
        const atRisk: string[] = [];

        for (const [segment, size] of segments) {
            let safeElsewhere = false;
            for (const other of volumes) {
                // A soft-deleted volume is not a safe home: it is on its way out too.
                if (other.id === volumeId || other.isDeleted) continue;

                // A volume we cannot READ cannot vouch for anything. Skipping it (rather than letting the
                // error escape) is the fail-CLOSED direction here: one fewer candidate safe copy can only
                // make us refuse the removal, never allow it.
                let theirs: number | undefined;
                try {
                    theirs = (await listSegmentSizes(other.mountPoint)).get(segment);
                }
                catch (err) {
                    log.error('volume%d could not be read while checking whether volume%d holds the last copy of '
                        + 'journal segment %s; it does NOT count as a safe copy: %s', other.id, volumeId, segment, err);
                    continue;
                }
                if (theirs === undefined || theirs < size) continue;

                // Same name, at least as long -- but is it the same history? Checked in FULL, for the same
                // reason copySegments is: a disk that forked from ours long ago agrees for as far as any
                // bounded probe would look, and mistaking it for a safe copy is how you wave through the
                // removal of the last disk that actually holds these records.
                if (await agreeOnPrefix(`${dir(mine.mountPoint)}/${segment}`, `${dir(other.mountPoint)}/${segment}`, size)
                        .catch(() => false)) {
                    safeElsewhere = true;
                    break;
                }
                log.error('volume%d and volume%d both hold journal segment %s but they DISAGREE: volume%d is not '
                    + 'a safe copy of it', volumeId, other.id, segment, other.id);
            }
            if (!safeElsewhere) atRisk.push(segment);
        }

        if (atRisk.length)
            throw new Error(
                `volume ${volumeId} holds the only complete copy of ${atRisk.length} journal segment(s) `
                + `(${atRisk.slice(0, 3).join(', ')}${atRisk.length > 3 ? ', …' : ''}). Removing it would destroy the `
                + `namespace history they carry. Wait for the journal to re-elect a replica and copy them, or add a `
                + `writable volume.`
            );
    }
}

// Roll a segment file back to a known-good length, and make the truncation itself durable.
//
// Used to erase a batch that NO replica acknowledged. The bytes may or may not have reached the platter --
// that is exactly the point: we cannot tell, so we remove them either way, because a record nobody
// acknowledged must never be readable as though somebody had.
async function truncateSegmentTo(path: string, bytes: number): Promise<void> {
    const fh = await fsp.open(path, 'r+').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null;
        throw err;
    });
    if (!fh) return;

    try {
        const { size } = await fh.stat();
        if (size <= bytes) return;
        await fh.truncate(bytes);
        await fh.sync();
    }
    finally {
        await fh.close();
    }
}

// Roll a segment back to its last COMPLETE line before it is opened for append.
//
// A short write leaves a torn final record: bytes on the platter with no terminating newline. That write
// is treated as a replica failure and the replica is closed -- but it is re-opened by the very next
// re-election, or by a restart, and 'a' appends straight onto the fragment:
//
//     {"op":"put","ts":"2026-{"op":"del","ts":"...","id":"abc"}
//
// One unparseable line. The torn record is no loss (a short write is never acknowledged as durable), but
// the record GLUED ONTO IT was, and it is now unreadable -- on precisely the disk that a recovery would be
// leaning on if it were the last one standing. So we do what a write-ahead log does: discard the partial
// tail before writing anything after it. Only ever removes bytes that were never acknowledged.
export async function rollBackTornTail(path: string, volumeId?: number): Promise<void> {
    const fh = await fsp.open(path, 'r+').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null;      // nothing written yet: nothing to roll back
        throw err;
    });
    if (!fh) return;

    try {
        const { size } = await fh.stat();
        if (size === 0) return;

        // Walk backwards for the last newline. Records are ~200 bytes, so this reads one chunk in
        // practice -- but a segment whose ENTIRE content is one torn line is a real (if odd) state, so it
        // has to be able to walk all the way to the start rather than assume.
        const CHUNK = 64 * 1024;
        let end = size;                       // exclusive
        let lastNewline = -1;
        while (end > 0 && lastNewline < 0) {
            const start = Math.max(0, end - CHUNK);
            const buf = Buffer.alloc(end - start);
            await fh.read(buf, 0, buf.length, start);
            const idx = buf.lastIndexOf(0x0a);          // '\n'
            if (idx >= 0) lastNewline = start + idx;
            end = start;
        }

        const complete = lastNewline + 1;     // 0 if there is no newline at all: the whole file is torn
        if (complete === size) return;        // already ends on a record boundary -- the normal case

        log.error('volume%s: journal segment %s has a torn final record (%d bytes past the last complete '
            + 'line); rolling it back before appending', volumeId ?? '?', path, size - complete);
        await fh.truncate(complete);
        await fh.sync();
    }
    finally {
        await fh.close();
    }
}

// Do `a` and `b` agree on their first `length` bytes?
//
// SIZE IS NOT CONTENT IDENTITY, and the journal leans on the difference. Within one lineage it happens to
// be: every replica receives the same byte stream, and a replica that fails a write is CLOSED rather than
// skipping the batch and resuming, so its segment is always a strict prefix of a healthy one -- two equal
// sizes mean equal bytes. But a second lineage can appear under the same filename. Lose every journal disk,
// cold-start (which warns and opens a fresh 000000.jsonl), then re-attach one of the old disks: its
// 000000.jsonl is longer and entirely unrelated. On size alone it looks like the MORE complete copy, so it
// would be appended to and then seeded over the real one. Comparing the bytes is what tells the two apart.
async function agreeOnPrefix(a: string, b: string, length: number): Promise<boolean> {
    if (length === 0) return true;

    const fa = await fsp.open(a, 'r');
    try {
        const fb = await fsp.open(b, 'r');
        try {
            const CHUNK = 1024 * 1024;
            const bufA = Buffer.alloc(Math.min(CHUNK, length));
            const bufB = Buffer.alloc(bufA.length);
            for (let offset = 0; offset < length;) {
                const want = Math.min(bufA.length, length - offset);
                const [readA, readB] = await Promise.all([
                    fa.read(bufA, 0, want, offset),
                    fb.read(bufB, 0, want, offset)
                ]);
                if (readA.bytesRead !== want || readB.bytesRead !== want)
                    return false;                        // shorter than advertised: treat as disagreement
                if (!bufA.subarray(0, want).equals(bufB.subarray(0, want)))
                    return false;
                offset += want;
            }
            return true;
        }
        finally { await fb.close(); }
    }
    finally { await fa.close(); }
}

// A CHEAP probe used only to GROUP disks into lineages -- never to authorise a write.
//
// The bound is safe here and nowhere else, and the distinction matters. Grouping only has to separate
// unrelated journals, which differ within their first records (different object ids, different timestamps),
// and a wrong guess here costs nothing: the uncapped, exact check inside copySegments() runs before any
// byte is overwritten and refuses the copy. So this is allowed to be a heuristic, and it keeps a cold start
// from byte-comparing gigabytes of segments pairwise before the array will come up.
//
// It would NOT be safe as the guard itself, because two disks can share an ancestor and diverge later:
// pull a journal disk, keep writing to the others, lose them, re-adopt the old disk alone, then re-attach
// one of the newer ones -- they agree for 10MB and disagree after. A capped compare would call that a
// prefix and overwrite the shorter one. That is why the real guard reads to the end of the shared bytes.
const LINEAGE_PROBE_BYTES = 4 * 1024 * 1024;

// Do two volumes look like the same journal history? Decided on the LOWEST segment they both have: it is
// the closest thing to the origin that they share, so it is where two unrelated lineages differ.
async function sameLineage(mountA: string, mountB: string): Promise<boolean> {
    const [a, b] = [await listSegmentSizes(mountA), await listSegmentSizes(mountB)];

    const shared = [...a.keys()].filter(segment => b.has(segment)).sort();
    if (!shared.length)
        return false;
        // NOT the same lineage. Every journal starts at 000000.jsonl, rotation only ever adds the next
        // number, and a seed copies the whole set -- so any two disks of ONE lineage share at least
        // 000000.jsonl. Sharing nothing means the other disk is from some other life entirely (a long-
        // retired replica still carrying its old segments). Calling that "nothing to disagree about" would
        // fold it into the current lineage and let its stale segments be treated as our history.

    const segment = shared[0];
    const length = Math.min(a.get(segment)!, b.get(segment)!, LINEAGE_PROBE_BYTES);
    return agreeOnPrefix(
        `${mountA}/strubs/${JOURNAL_DIR}/${segment}`,
        `${mountB}/strubs/${JOURNAL_DIR}/${segment}`,
        length
    );
}


// Two same-named segments have DIVERGED: neither is a prefix of the other, so they carry different
// histories and there is no safe way to pick one. Never silently resolved -- picking the longer would
// overwrite real records, and picking either hides that the array has two journal lineages in it.
export class JournalDivergenceError extends Error {
    constructor(segment: string, a: string, b: string) {
        super(`journal segment ${segment} has DIVERGED between ${a} and ${b}: neither is a prefix of the other, `
            + `so they carry different histories. This means two journal lineages exist in the array (most likely `
            + `a disk from an older instance of the journal was re-attached). REFUSING to merge them.`);
        this.name = 'JournalDivergenceError';
    }
}

// The target already holds journal segments that the lineage does not have -- an older journal, from a
// previous life of this disk. Seeding on top would leave two histories in one directory, and the foreign
// segment would outrank the real ones the moment we looked for the newest.
export class JournalForeignSegmentsError extends Error {
    constructor(segments: string[], dir: string) {
        super(`${dir} holds journal segment(s) ${segments.join(', ')} that are not part of this array's journal. `
            + `That disk carries an older journal. REFUSING to seed on top of it -- the files have been left exactly `
            + `as they are. Move or remove ${dir} if you are certain those records are not needed.`);
        this.name = 'JournalForeignSegmentsError';
    }
}

// Copy every segment from one volume's journal directory to another's, skipping any the target already
// has in full. Used when a replica is re-elected so the history moves with the replica set.
export async function copySegments(fromMount: string, toMount: string): Promise<void> {
    const fromDir = `${fromMount}/strubs/${JOURNAL_DIR}`;
    const toDir = `${toMount}/strubs/${JOURNAL_DIR}`;

    // listSegments(), NOT a raw readdir with the error swallowed. A source we cannot read must FAIL the
    // copy: swallowing it produces an empty, entirely successful-looking seed, and the caller then adopts a
    // replica carrying none of the history. That is the worst possible outcome -- a disk that reports
    // itself as a full copy of the namespace and is blank -- and it would only be discovered during the
    // recovery it was supposed to serve.
    //
    // SORTED, so 000000 lands first. A seed is not atomic: if it is interrupted, whatever reached the
    // platter has to still make sense. Copying in ascending order means an interrupted seed leaves a
    // contiguous prefix of the history (000000..00000k), which is a legitimate short lineage that the next
    // seed simply tops up. Copying in readdir order could leave 000005 sitting there alone -- no 000000,
    // so a later start would read it as a foreign REMNANT and ignore it, discarding records that had
    // already been acknowledged and had genuinely reached that disk.
    const files = (await listSegments(fromMount)).sort();

    // A source with NOTHING on it is a contradiction, and a dangerous one. Every caller picks its sources
    // from disks it has just confirmed carry history -- so finding none now means the disk changed under us
    // (unmounted, and we are reading the empty directory its mountPoint left behind). Copying nothing and
    // reporting success would hand back a replica adopted with no history whatsoever, which is the exact
    // lie this function exists to prevent. Fail instead.
    if (!files.length)
        throw new Error(`refusing to seed from ${fromDir}: it has no journal segments. It was chosen as a source `
            + `because it HAD history, so it has changed underneath us -- most likely the disk is no longer mounted.`);

    await ensureDirectoryDurable(toDir);

    let copied = 0;
    for (const file of files) {
        const src = `${fromDir}/${file}`;
        const dst = `${toDir}/${file}`;
        const srcStat = await fsp.stat(src);
        const dstStat = await fsp.stat(dst).catch(() => null);

        if (dstStat) {
            // The shorter of the two must be a prefix of the longer, and this is checked to the LAST BYTE
            // they share -- no sampling, no cap. This is the line between "top up a degraded replica" and
            // "destroy records", and the dangerous case hides at the end: two disks that share an ancestor
            // and forked later agree for as far as any bounded probe would look. Read all of it, and if
            // they disagree anywhere, refuse -- the caller declines to adopt the replica rather than
            // overwrite a history it cannot account for.
            const shared = Math.min(srcStat.size, dstStat.size);
            if (!await agreeOnPrefix(src, dst, shared))
                throw new JournalDivergenceError(file, fromDir, toDir);

            if (dstStat.size >= srcStat.size) {
                // Already there in full, and verified to be the same history -- but "the file is there" is
                // not "the file is on the platter". It could equally be the wreckage of an earlier copy that
                // got as far as writing the bytes and then failed at the fsync, and skipping the fsync on the
                // strength of its existence would mean the one copy we know to be unproven is the one we
                // never prove. Adoption hangs on this being true, so make it true. Fsyncing a file with
                // nothing dirty in it costs nothing.
                const clean = await fsp.open(dst, 'r+');
                try { await clean.sync(); }
                finally { await clean.close(); }
                copied++;                 // ...so the directory entry gets its fsync at the end too
                continue;
            }
        }

        await fsp.copyFile(src, dst);

        // copyFile RETURNING is not a durability boundary -- the bytes may still be only in page cache.
        // This copy exists precisely so the history survives losing the source disk, so it has to be on
        // the platter before we call the new replica seeded.
        const fh = await fsp.open(dst, 'r+');
        try { await fh.sync(); }
        finally { await fh.close(); }
        copied++;
    }

    // ...and fsync the directory, so the new directory entries themselves survive a power cut. A failure
    // here is a failed durability boundary and must NOT be swallowed: copySegments() returning success is
    // what causes the replica to be adopted, and adopting a replica whose history may not be on the platter
    // defeats the only reason the copy exists.
    if (copied)
        await fsyncDirectory(toDir);
}

// Which journal segments does this volume hold? Used to refuse removing a volume that carries the last
// surviving copy of one -- the same shape as refusing to delete a volume that still holds live slices.
//
// "I could not read the disk" MUST NOT come back as "the disk is empty". Only ENOENT -- there is no journal
// directory here -- means empty. An EIO off a failing drive, an EACCES, a half-mounted filesystem: those
// mean we do not KNOW, and answering "nothing here" is precisely how you end up seeding an empty replica
// over a live one, picking the wrong lineage, or waving through the removal of the last copy of the
// namespace history because the dying disk holding it would not talk to us. Fail closed; let the caller
// decide what an unreadable disk means for what it is trying to do.
export async function listSegments(mountPoint: string): Promise<string[]> {
    const dir = `${mountPoint}/strubs/${JOURNAL_DIR}`;
    try {
        return (await fsp.readdir(dir)).filter(f => /^\d+\.jsonl$/.test(f));
    }
    catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT')
            return [];
        throw err;
    }
}

// Segments WITH their sizes. Size matters: a write can land on some replicas and not others (that is the
// degraded path, and it is allowed to proceed), so another disk having a file of the same NAME does not
// mean it has the same CONTENT. If the only full copy of a segment's tail is on the disk being pulled,
// removing it destroys those records -- and the filename check would have said it was safe.
export async function listSegmentSizes(mountPoint: string): Promise<Map<string, number>> {
    const dir = `${mountPoint}/strubs/${JOURNAL_DIR}`;
    const out = new Map<string, number>();
    for (const file of await listSegments(mountPoint)) {
        try {
            out.set(file, (await fsp.stat(`${dir}/${file}`)).size);
        }
        catch (err) {
            // ENOENT only: the file was there a moment ago and is not now, which a rotation can do.
            // Anything else means we cannot read a segment we know EXISTS, and quietly dropping it from
            // the list would understate what this disk is holding -- see listSegments above.
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
                throw err;
        }
    }
    return out;
}

export const journal = new Journal();
