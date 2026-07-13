import { promises as fsp, createReadStream } from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';

import { config } from '../config';
import { createLogger } from '../log';
import { notificationService } from '../notify/service';
import { snapshotBuilder, SnapshotBuilder, type SnapshotStats } from '../io/snapshot';
import type { ManifestSnapshotRef } from '../io/bootstrap-manifest';

const log = createLogger('snapshot-job');

export type SnapshotJobDeps = {
    builder: SnapshotBuilder;
    // Store the staged file as a STRUBS object and return its id and md5.
    storeObject: (localPath: string, name: string) => Promise<{ id: string; md5: string }>;
    // Read that object back OUT of the array, into a local file. This is what makes the verification real:
    // we check the copy that came off the platters, not the one we still have in our hand.
    fetchObject: (id: string, localPath: string) => Promise<void>;
    // Publish the new snapshot pointer to every volume's bootstrap manifest, keeping the previous one.
    publish: (snapshot: ManifestSnapshotRef, previous: ManifestSnapshotRef | null) => Promise<void>;
    currentSnapshot: () => ManifestSnapshotRef | null;
    stagingDir: () => string;
    now: () => Date;
};

const defaultDeps: SnapshotJobDeps = {
    builder: snapshotBuilder,
    storeObject: async (localPath: string, name: string) => {
        const { FileObject } = require('../io/file-object') as typeof import('../io/file-object');
        const { database } = require('../database') as typeof import('../database');

        const { size } = await fsp.stat(localPath);
        const object = new FileObject();
        await object.createWithSize(size);
        object.name = name;
        // The BUCKET, not just the container. An object inside a container must carry its bucketId or the
        // insert is refused outright -- the snapshot goes in through the same front door as everything else,
        // and gets no exemptions for being important.
        const { containerId, bucketId } = await database.getOrCreateContainerWithBucket(config.snapshotPath);
        object.containerId = containerId;
        object.bucketId = bucketId;
        object.mime = 'application/gzip';

        // FileObject is a Duplex: pipeline drives it exactly as the HTTP PUT path does, backpressure and
        // all, and resolves once the object has emitted 'finish'.
        //
        // ...and it cleans up after itself exactly as the PUT path does, too. A failed write leaves slices
        // reserved on half a dozen disks, and a snapshot that fails every night would quietly fill the array
        // with the wreckage of snapshots that never were.
        try {
            await pipeline(createReadStream(localPath), object as unknown as NodeJS.WritableStream);
            await object.commit();
        }
        catch (err) {
            await object.delete().catch(cleanupErr =>
                log.error('could not clean up a failed snapshot object: %s', cleanupErr));
            throw err;
        }

        // md5 is a Buffer on the object -- the manifest records it as hex, because the manifest is meant to
        // be read by a person on a bad day.
        return { id: object.id as string, md5: (object.md5 as unknown as Buffer).toString('hex') };
    },
    fetchObject: async (id: string, localPath: string) => {
        const { FileObject } = require('../io/file-object') as typeof import('../io/file-object');
        const { database } = require('../database') as typeof import('../database');

        const record = await database.getObjectById(id);
        if (!record) throw new Error(`snapshot object ${id} is not in the database`);

        const object = new FileObject();
        await object.loadFromRecord(record as never);
        await object.prepareForRead();
        object.setReadRange(0, object.size, true);

        await pipeline(object as unknown as NodeJS.ReadableStream, require('fs').createWriteStream(localPath));
        await object.close();
    },
    publish: async (snapshot: ManifestSnapshotRef, previous: ManifestSnapshotRef | null) => {
        const { bootstrapManifestWriter } = require('../io/bootstrap-manifest') as typeof import('../io/bootstrap-manifest');

        // NEVER GO BACKWARDS. `running` is a flag in one process's memory, and it guards the case that
        // actually happens: the nightly job and an operator's manual trigger colliding. It knows nothing
        // about a SECOND STRUBS process -- and two snapshots in flight, with the slower one finishing last,
        // would publish the older namespace over the newer and quietly lose every name written in between.
        // So we go and look at what the disks say, and refuse to replace something newer than we are holding.
        //
        // This is a CHECK, not a lock, and the difference is worth being honest about: two processes could
        // still interleave between this read and the write below. It is not defended further because the
        // defence would be worse than the disease. A lock file on a volume introduces stale-lock recovery --
        // a new way to be unable to snapshot at all -- and a second STRUBS on this array would be fighting
        // the first over mounted volumes, the journal replicas and the object writer long before it got
        // anywhere near the snapshot pointer. The array is single-host and single-process by construction.
        // If that ever stops being true, this is the first thing to come back and fix.
        // withSnapshot, for the same reason hydrate needs it: a NEWER manifest that simply knows nothing
        // about a snapshot would otherwise hide the older-but-real one behind it, and an older publisher
        // would walk the pointer backwards believing the disks were empty.
        const onDisk = (await bootstrapManifestWriter.newestManifestOnDisk({ withSnapshot: true }))?.snapshot ?? null;
        if (onDisk && Date.parse(onDisk.completedAt) > Date.parse(snapshot.completedAt))
            throw new Error(`refusing to publish snapshot ${snapshot.objectId} (taken ${snapshot.completedAt}): the `
                + `disks already carry a NEWER one, ${onDisk.objectId} (taken ${onDisk.completedAt}). Publishing `
                + `would replace a newer namespace with an older one.`);

        // The whole chain, so a failed publish can put it back exactly as it was. Restoring only the current
        // pointer would leave `previous` pointing at the current one, quietly destroying the fallback.
        const rollback = {
            snapshot: bootstrapManifestWriter.getSnapshot(),
            previous: bootstrapManifestWriter.getPreviousSnapshot()
        };

        bootstrapManifestWriter.setSnapshots(snapshot, previous);
        await bootstrapManifestWriter.write();

        // GO AND LOOK. write() cannot fail -- it swallows every per-volume error so that a manifest refresh
        // can never take down a volume start -- so it will report a clean success having written the pointer
        // to precisely nowhere. And a snapshot whose pointer is on no disk at all is not a snapshot a
        // recovery will ever find: it is 127MB of erasure-coded namespace that nothing on the platters
        // knows the name of.
        const landed = await bootstrapManifestWriter.countManifestsNaming(snapshot.objectId);
        if (!landed) {
            bootstrapManifestWriter.setSnapshots(rollback.snapshot, rollback.previous);
            throw new Error(`the snapshot was written and verified, but its pointer reached NO bootstrap manifest: `
                + `no disk in the array knows it exists, so no recovery would ever find it`);
        }
        log('snapshot pointer is on %d volume(s)', landed);
    },
    currentSnapshot: () => {
        const { bootstrapManifestWriter } = require('../io/bootstrap-manifest') as typeof import('../io/bootstrap-manifest');
        return bootstrapManifestWriter.getSnapshot();
    },
    stagingDir: () => os.tmpdir(),
    now: () => new Date()
};

export class SnapshotJob {
    private readonly deps: SnapshotJobDeps;
    private running = false;
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(deps: Partial<SnapshotJobDeps> = {}) {
        this.deps = { ...defaultDeps, ...deps };
    }

    isRunning(): boolean { return this.running; }

    start(intervalMs: number): void {
        if (this.timer || !intervalMs) return;
        this.timer = setInterval(() => {
            void this.run().catch(err => log.error('scheduled snapshot failed: %s', err));
        }, intervalMs);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    // Take a snapshot, store it in the array, PROVE it can be read back, and only then tell the disks it is
    // the one to use.
    //
    // The order is the entire job. A snapshot that has been written but not verified is not a snapshot, it
    // is a rumour -- and the moment to find out that it cannot be read is now, while the thing it is a copy
    // of is still sitting safely in Mongo, and not on the day it is the only copy left.
    //
    // The previous snapshot is kept, and its pointer stays in the manifest alongside the new one. At no
    // point does the array have zero good snapshots: the new pointer is only published once the new snapshot
    // has been read back OUT of the array and found whole, and the old one is still named right beside it.
    async run(): Promise<SnapshotStats & { objectId: string }> {
        if (this.running)
            throw new Error('a snapshot is already running');

        this.running = true;
        const startedAt = this.deps.now();
        const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
        // A UNIQUE staging directory, not a predictable filename in a shared /tmp. The `running` flag guards
        // this process; it says nothing about a second one, and two snapshots truncating each other's
        // staging file would each verify happily against a file the other was writing.
        const stagingRoot = await fsp.mkdtemp(path.join(this.deps.stagingDir(), 'strubs-snapshot-'));
        const staged = path.join(stagingRoot, `${stamp}.ndjson.gz`);
        const readBack = path.join(stagingRoot, `${stamp}.readback.gz`);

        try {
            log('taking a namespace snapshot...');
            const stats = await this.deps.builder.writeTo(staged);
            log('snapshot written: %d containers, %d objects, %d bytes gzipped',
                stats.containers, stats.objects, stats.bytes);

            // A snapshot of NOTHING is not a snapshot to be proud of, and publishing it would quietly
            // replace a real one with an empty one. If the namespace is genuinely empty there is nothing to
            // protect; if it is not, something has gone very wrong upstream and this is not the moment to
            // overwrite the pointer to the last good copy.
            if (!stats.objects && !stats.containers)
                throw new Error('refusing to publish an EMPTY snapshot: the namespace has no containers and no '
                    + 'objects, which is either a brand-new array (nothing to snapshot) or a very bad sign');

            const stored = await this.deps.storeObject(staged, `${stamp}.ndjson.gz`);
            log('snapshot stored as object %s', stored.id);

            // Read it back OUT OF THE ARRAY. Not off the staging file we just wrote -- that would only prove
            // we can read our own memory. This reconstructs it from the slices, exactly as a recovery would.
            await this.deps.fetchObject(stored.id, readBack);
            await this.deps.builder.verify(readBack, stats);

            const ref: ManifestSnapshotRef = {
                objectId: stored.id,
                md5: stored.md5,
                startedAt: startedAt.toISOString(),
                completedAt: this.deps.now().toISOString(),
                objects: stats.objects
            };

            await this.deps.publish(ref, this.deps.currentSnapshot());
            log('snapshot %s published to the bootstrap manifests', stored.id);

            void notificationService.notify({
                severity: 'info',
                title: 'STRUBS took a namespace snapshot',
                body: `${stats.objects.toLocaleString()} objects and ${stats.containers.toLocaleString()} containers are `
                    + `now recorded on the platters as object ${stored.id}, verified by reading it back out of the array. `
                    + `If Mongo were lost right now, every one of those names could be recovered from the disks alone.`,
                dedupeKey: 'snapshot:completed'
            }).catch(() => undefined);

            return { ...stats, objectId: stored.id };
        }
        finally {
            this.running = false;
            // The staging files are OURS and they are large (700MB uncompressed for this array). Leaving
            // them behind fills the root filesystem one snapshot at a time.
            await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
        }
    }
}

export const snapshotJob = new SnapshotJob();
