import type { Collection } from 'mongodb';

export type RuntimeConfigEntry = {
    key: string;
    value: unknown;
};

export class RuntimeConfigRepository {
    constructor(private readonly collection: Collection<RuntimeConfigEntry>) {}

    async get(key: string): Promise<unknown> {
        const entry = await this.collection.findOne({ key });
        return entry?.value ?? null;
    }

    async set(key: string, value: unknown): Promise<void> {
        await this.collection.updateOne(
            { key },
            { $set: { value } },
            { upsert: true }
        );
    }

    // CREATE ONLY IF IT IS NOT THERE. Returns true if THIS caller created it.
    //
    // insertOne, NOT an upsert-and-guess.
    //
    // The previous attempt used `updateOne({key}, {$setOnInsert}, {upsert:true})` and then tried to work out
    // whether it had won -- first from `upsertedCount`, then by reading the value back. Both are wrong:
    // `upsertedCount === 1` is not exclusive without a unique index, and the read-back returns TRUE for a
    // caller that inserted nothing at all when an identical value happened to be there already. A function
    // whose entire contract is "did I create this?" must not answer by inference.
    //
    // insertOne has no such ambiguity. It either inserts -- and it is the only call that did -- or it raises
    // E11000 against the unique index on `key`, which is a definitive "no, you did not".
    //
    // ⚠️ THE UNIQUE INDEX IS LOAD-BEARING (see database.ensureRuntimeConfigIndexes). Without it, concurrent
    // inserts BOTH succeed and leave duplicate rows -- and a later findOne() then returns whichever one Mongo
    // feels like. Callers that cannot tolerate that must check `keyIsUnique()` first; the LUKS recovery
    // verifier does exactly that, and refuses to record a first passphrase without it.
    async setIfAbsent(key: string, value: unknown): Promise<boolean> {
        try {
            await this.collection.insertOne({ key, value } as RuntimeConfigEntry);
            return true;
        }
        catch (err) {
            if ((err as { code?: number }).code === 11000)   // duplicate key: it was already there
                return false;
            throw err;
        }
    }

    // Is the unique index on `key` actually in place? Asked, not assumed -- the index creation is deliberately
    // non-fatal (a guard that refuses to start a 130TB array is a guard that has failed), so the guarantee it
    // provides has to be something callers can VERIFY rather than take on trust.
    async keyIsUnique(): Promise<boolean> {
        try {
            const indexes = await this.collection.indexes();
            return indexes.some(index => index.unique === true && index.key?.key === 1);
        }
        catch {
            return false;   // could not tell => do not claim the guarantee
        }
    }

    async delete(key: string): Promise<void> {
        await this.collection.deleteOne({ key });
    }
}
