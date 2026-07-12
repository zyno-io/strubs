import type { Collection } from 'mongodb';

// A long-lived admin bearer token. The presented token is `selector.secret`: the selector is stored
// plaintext and indexed so a token can be found in one lookup (a fully-opaque token would require
// scrypt-ing against every row); only the secret is hashed. See admin-auth.ts.
export type AdminTokenDocument = {
    selector: string;
    secretHash: string;
    name: string;
    disabled?: boolean;
    createdAt: Date;
    lastUsedAt?: Date;
};

export class AdminTokenRepository {
    constructor(private readonly collection: Collection<AdminTokenDocument>) {}

    async ensureIndexes(): Promise<void> {
        await this.collection.createIndex({ selector: 1 }, { unique: true, name: 'selector' });
    }

    async create(doc: { selector: string; secretHash: string; name: string }): Promise<void> {
        await this.collection.insertOne({ ...doc, createdAt: new Date() });
    }

    async getBySelector(selector: string): Promise<AdminTokenDocument | null> {
        return this.collection.findOne({ selector });
    }

    async touch(selector: string): Promise<void> {
        await this.collection.updateOne({ selector }, { $set: { lastUsedAt: new Date() } });
    }

    async list(): Promise<AdminTokenDocument[]> {
        return this.collection.find({}, { projection: { secretHash: 0 } }).sort({ createdAt: -1 }).toArray();
    }

    async setDisabled(selector: string, disabled: boolean): Promise<boolean> {
        const res = await this.collection.updateOne({ selector }, { $set: { disabled } });
        return res.matchedCount > 0;
    }

    async remove(selector: string): Promise<boolean> {
        const res = await this.collection.deleteOne({ selector });
        return res.deletedCount > 0;
    }

    async removeAll(): Promise<number> {
        const res = await this.collection.deleteMany({});
        return res.deletedCount ?? 0;
    }
}
