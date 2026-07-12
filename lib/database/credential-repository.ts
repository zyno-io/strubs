import { Collection, ObjectId } from 'mongodb';

// An object-API credential: HTTP Basic (accessKeyId as username, secret as password). The secret is
// scrypt-HASHED -- we only ever verify it, never reproduce it, so it can be shown exactly once at
// creation. accessKeyId is opaque, unique, and indexed so the per-request lookup is a single point read
// (never a table scan / never scrypt-per-row).
export type Grant = {
    bucket: string;      // a bucket name, or '*' for all buckets
    read: boolean;
    write: boolean;
};

export interface CredentialDocument {
    _id?: ObjectId;
    accessKeyId: string;
    secretHash: string;
    name: string;
    grants: Grant[];
    enabled: boolean;
    createdAt: Date;
    lastUsedAt?: Date | null;
    expiresAt?: Date | null;
}

export class CredentialRepository {
    constructor(private readonly collection: Collection<CredentialDocument>) {}

    async ensureIndexes(): Promise<void> {
        await this.collection.createIndexes([
            { key: { accessKeyId: 1 }, name: 'accessKeyId', unique: true }
        ]);
    }

    async create(doc: CredentialDocument): Promise<void> {
        await this.collection.insertOne(doc);
    }

    async getByAccessKeyId(accessKeyId: string): Promise<CredentialDocument | null> {
        return this.collection.findOne({ accessKeyId });
    }

    async list(): Promise<CredentialDocument[]> {
        // Never project secretHash to callers -- it never needs to leave this layer.
        return this.collection
            .find({}, { projection: { secretHash: 0 } })
            .sort({ createdAt: 1 })
            .toArray();
    }

    async setEnabled(accessKeyId: string, enabled: boolean): Promise<boolean> {
        const res = await this.collection.updateOne({ accessKeyId }, { $set: { enabled } });
        return res.matchedCount === 1;
    }

    async setGrants(accessKeyId: string, grants: Grant[]): Promise<boolean> {
        const res = await this.collection.updateOne({ accessKeyId }, { $set: { grants } });
        return res.matchedCount === 1;
    }

    async setSecretHash(accessKeyId: string, secretHash: string): Promise<boolean> {
        const res = await this.collection.updateOne({ accessKeyId }, { $set: { secretHash } });
        return res.matchedCount === 1;
    }

    async touch(accessKeyId: string, when: Date): Promise<void> {
        await this.collection.updateOne({ accessKeyId }, { $set: { lastUsedAt: when } });
    }

    async remove(accessKeyId: string): Promise<boolean> {
        const res = await this.collection.deleteOne({ accessKeyId });
        return res.deletedCount === 1;
    }
}
