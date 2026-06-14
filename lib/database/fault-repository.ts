import type { Collection } from 'mongodb';

import type { RepairBlockedReason, RepairStatus, RepairBlockDetails } from '../remediation/fault';

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
    repairStatus?: RepairStatus;
    repairBlockedReason?: RepairBlockedReason;
    repairBlockedAt?: Date;
    lastRepairAttemptAt?: Date;
    lastRepairError?: string;
    repairDetails?: RepairBlockDetails;
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
    repairStatus?: RepairStatus;
    repairBlockedReason?: RepairBlockedReason;
    repairBlockedAt?: Date;
    lastRepairAttemptAt?: Date;
    lastRepairError?: string;
    repairDetails?: RepairBlockDetails;
};

export class FaultRepository {
    constructor(private readonly collection: Collection<FaultDocument>) {}

    async upsert(fault: FaultUpsert): Promise<void> {
        const set: Partial<FaultDocument> = {
            objectId: fault.objectId,
            sliceIndex: fault.sliceIndex,
            volumeId: fault.volumeId,
            source: fault.source,
            code: fault.code,
            message: fault.message,
            isChecksum: fault.isChecksum,
            lastSeen: fault.lastSeen,
            count: fault.count
        };
        const unset: Record<string, ''> = {};

        this.setOptional(set, unset, 'repairStatus', fault.repairStatus);
        this.setOptional(set, unset, 'repairBlockedReason', fault.repairBlockedReason);
        this.setOptional(set, unset, 'repairBlockedAt', fault.repairBlockedAt);
        this.setOptional(set, unset, 'lastRepairAttemptAt', fault.lastRepairAttemptAt);
        this.setOptional(set, unset, 'lastRepairError', fault.lastRepairError);
        this.setOptional(set, unset, 'repairDetails', fault.repairDetails);

        const update: { $set: Partial<FaultDocument>; $setOnInsert: Pick<FaultDocument, 'firstSeen'>; $unset?: Record<string, ''> } = {
            $set: set,
            $setOnInsert: { firstSeen: fault.firstSeen }
        };
        if (Object.keys(unset).length)
            update.$unset = unset;

        await this.collection.updateOne(
            { _id: fault.key },
            update,
            { upsert: true }
        );
    }

    private setOptional<K extends keyof FaultDocument>(
        set: Partial<FaultDocument>,
        unset: Record<string, ''>,
        key: K,
        value: FaultDocument[K] | undefined
    ): void {
        if (value === undefined) {
            unset[String(key)] = '';
            return;
        }
        set[key] = value;
    }

    async list(): Promise<FaultDocument[]> {
        return this.collection.find().sort({ lastSeen: -1 }).toArray();
    }

    async delete(key: string): Promise<void> {
        await this.collection.deleteOne({ _id: key });
    }
}
