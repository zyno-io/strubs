import type { Collection } from 'mongodb';
import type { StorageStatsDelta, StorageStatsSnapshot } from '../storage/stats';

type StorageStatsDocument = StorageStatsSnapshot & { _id: 'current' };

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
        const inc: Record<string, number> = {};
        this.addCounterIncrements(inc, 'system', delta.system);
        for (const [volumeId, counters] of Object.entries(delta.volumes))
            this.addCounterIncrements(inc, `volumes.${volumeId}`, counters);
        if (!Object.keys(inc).length)
            return;
        await this.collection.updateOne(
            { _id: 'current' },
            {
                $set: { updatedAt },
                $setOnInsert: {
                    'system.unavailableObjectCount': 0,
                    'system.unavailableLogicalBytes': 0
                },
                $inc: inc
            },
            { upsert: true }
        );
    }

    private addCounterIncrements(inc: Record<string, number>, prefix: string, counters: Record<string, number>): void {
        for (const [key, value] of Object.entries(counters)) {
            if (value !== 0)
                inc[`${prefix}.${key}`] = value;
        }
    }
}
