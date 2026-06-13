import type { Collection } from 'mongodb';

// Durable record of a slice fault. _id is the fault key (volume:object:slice)
// so re-observing the same bad slice upserts rather than duplicates.
export interface FaultDocument {
    _id: string;
    objectId: string;
    sliceIndex: number;
    volumeId: number | null;
    source: string;
    code?: string;
    message?: string;
    isChecksum?: boolean;
    firstSeen: Date;
    lastSeen: Date;
    count: number;
}

export type FaultUpsert = {
    key: string;
    objectId: string;
    sliceIndex: number;
    volumeId: number | null;
    source: string;
    code?: string;
    message?: string;
    isChecksum?: boolean;
    firstSeen: Date;
    lastSeen: Date;
    count: number;
};

export class FaultRepository {
    constructor(private readonly collection: Collection<FaultDocument>) {}

    async upsert(fault: FaultUpsert): Promise<void> {
        await this.collection.updateOne(
            { _id: fault.key },
            {
                $set: {
                    objectId: fault.objectId,
                    sliceIndex: fault.sliceIndex,
                    volumeId: fault.volumeId,
                    source: fault.source,
                    code: fault.code,
                    message: fault.message,
                    isChecksum: fault.isChecksum,
                    lastSeen: fault.lastSeen,
                    count: fault.count
                },
                $setOnInsert: { firstSeen: fault.firstSeen }
            },
            { upsert: true }
        );
    }

    async list(): Promise<FaultDocument[]> {
        return this.collection.find().sort({ lastSeen: -1 }).toArray();
    }

    async delete(key: string): Promise<void> {
        await this.collection.deleteOne({ _id: key });
    }
}
