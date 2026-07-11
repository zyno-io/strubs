import type { Collection } from 'mongodb';
import { storageStatsDeltaIsEmpty } from '../storage/stats';
import type { StorageStatsDelta, StorageStatsSnapshot } from '../storage/stats';

type StorageStatsDocument = StorageStatsSnapshot & { _id: 'current' };

function countersAreEmpty(counters: Record<string, number>): boolean {
    return Object.values(counters).every(value => value === 0);
}

export class StorageStatsRepository {
    constructor(private readonly collection: Collection<StorageStatsDocument>) {}

    async get(): Promise<StorageStatsSnapshot | null> {
        const doc = await this.collection.findOne({ _id: 'current' });
        if (!doc)
            return null;
        const { _id, ...snapshot } = doc;
        return snapshot;
    }

    async replace(snapshot: StorageStatsSnapshot): Promise<void> {
        await this.collection.updateOne(
            { _id: 'current' },
            { $set: snapshot },
            { upsert: true }
        );
    }

    async updateUnavailable(
        unavailable: Pick<StorageStatsSnapshot['system'], 'unavailableObjectCount' | 'unavailableLogicalBytes'>,
        readableVolumeIds: number[],
        updatedAt = new Date()
    ): Promise<void> {
        await this.collection.updateOne(
            { _id: 'current' },
            {
                $set: {
                    updatedAt,
                    unavailableUpdatedAt: updatedAt,
                    readableVolumeIds,
                    'system.unavailableObjectCount': unavailable.unavailableObjectCount,
                    'system.unavailableLogicalBytes': unavailable.unavailableLogicalBytes
                }
            }
        );
    }

    async applyDelta(delta: StorageStatsDelta, updatedAt = new Date()): Promise<void> {
        if (storageStatsDeltaIsEmpty(delta))
            return;
        const inc: Record<string, number> = {};
        // System counters go in unconditionally, even when every one of them is zero: a
        // pure relocation shifts slices between volumes without moving system totals, and
        // an upsert-inserted document must still come out with a complete system subdocument.
        this.addCounterIncrements(inc, 'system', delta.system);
        for (const [volumeId, counters] of Object.entries(delta.volumes)) {
            // Skip untouched volumes so a no-op delta can't conjure a row for a volume
            // that holds nothing (or was deleted).
            if (!countersAreEmpty(counters))
                this.addCounterIncrements(inc, `volumes.${volumeId}`, counters);
        }
        await this.collection.updateOne(
            { _id: 'current' },
            { $set: { updatedAt }, $inc: inc },
            { upsert: true }
        );
    }

    // Every counter is emitted, including the zero-valued ones. On an upsert-insert $inc
    // creates each path it touches, so writing the full set is what stops a subdocument
    // from being born missing whichever fields happened to be zero in its first delta --
    // a volume that initially receives only data slices still gets paritySliceCount and
    // parityBytes initialized to 0. Zero increments are no-ops on every write after that.
    private addCounterIncrements(inc: Record<string, number>, prefix: string, counters: Record<string, number>): void {
        for (const [key, value] of Object.entries(counters))
            inc[`${prefix}.${key}`] = value;
    }
}
