import type { Collection } from 'mongodb';

import type { VerifyMode } from '../io/file-object/slice-verifier';

// What caused a verify run to start. Recorded so "why is this drive being scrubbed" never again requires
// grepping journalctl and correlating timestamps against a kernel log by hand.
export type VerifyRunTrigger =
    | { source: 'syslog-watcher'; device: string; volumeId: number; kind: 'pending' | 'ioerror'; detail: string }
    | { source: 'manual' }
    | { source: 'scheduled' };

export type VerifyRunStatus = 'running' | 'completed' | 'stopped';

// One document per run, keyed by its startedAt (already the run's natural identity: the job resumes by
// looking up the same timestamp). A resume does not create a new document -- it is the same run continuing.
export interface VerifyRunDocument {
    _id: string;
    startedAt: Date;
    finishedAt?: Date;
    scope: 'full' | 'targeted';
    mode: VerifyMode;
    volumeIds: number[];
    trigger: VerifyRunTrigger;
    status: VerifyRunStatus;
    objectsVerified?: number;
    checksumErrors?: number;
    totalErrors?: number;
}

export type VerifyRunStart = {
    startedAt: string;
    scope: 'full' | 'targeted';
    mode: VerifyMode;
    volumeIds: number[];
    trigger: VerifyRunTrigger;
};

export type VerifyRunFinish = {
    finishedAt: string;
    status: VerifyRunStatus;
    objectsVerified: number;
    checksumErrors?: number;
    totalErrors: number;
};

export class VerifyRunRepository {
    constructor(private readonly collection: Collection<VerifyRunDocument>) {}

    // Upsert rather than insert: a run that was requested while deferred behind a rebalance, then a
    // second request for an overlapping scope arrives before it actually launches, must not create two
    // documents for what start() already treats as one run.
    async start(run: VerifyRunStart): Promise<void> {
        await this.collection.updateOne(
            { _id: run.startedAt },
            {
                $set: {
                    startedAt: new Date(run.startedAt),
                    scope: run.scope,
                    mode: run.mode,
                    volumeIds: run.volumeIds,
                    trigger: run.trigger,
                    status: 'running' as const
                }
            },
            { upsert: true }
        );
    }

    async finish(startedAt: string, update: VerifyRunFinish): Promise<void> {
        const set: Partial<VerifyRunDocument> = {
            finishedAt: new Date(update.finishedAt),
            status: update.status,
            objectsVerified: update.objectsVerified,
            totalErrors: update.totalErrors
        };
        if (update.checksumErrors !== undefined)
            set.checksumErrors = update.checksumErrors;
        await this.collection.updateOne({ _id: startedAt }, { $set: set });
    }

    async list(limit = 50): Promise<VerifyRunDocument[]> {
        return this.collection.find().sort({ startedAt: -1 }).limit(limit).toArray();
    }
}
