import type { Collection } from 'mongodb';

export type VolumeVerifyErrors = {
    checksum: number;
    total: number;
};

export class VolumeRepository {
    constructor(private readonly collection: Collection<any>) {}

    async getVolumes(): Promise<any[]> {
        return this.collection.find({}).toArray();
    }

    async createVolume(volume: any): Promise<void> {
        await this.collection.insertOne(volume);
    }

    async deleteVolume(id: number): Promise<void> {
        await this.collection.deleteOne({ id });
    }

    async softDeleteVolume(id: number): Promise<void> {
        await this.collection.updateOne(
            { id },
            { $set: { enabled: false, is_deleted: true } }
        );
    }

    async updateVolumeFlags(id: number, changes: { isEnabled?: boolean; isReadOnly?: boolean; isDeleted?: boolean; isHealthy?: boolean; label?: string | null; comment?: string | null }): Promise<void> {
        const set: Record<string, unknown> = {};
        const unset: Record<string, unknown> = {};
        if (changes.isEnabled !== undefined)
            set.enabled = changes.isEnabled;
        if (changes.isReadOnly !== undefined)
            set.read_only = changes.isReadOnly;
        if (changes.isDeleted !== undefined)
            set.is_deleted = changes.isDeleted;
        if (changes.isHealthy !== undefined)
            set.healthy = changes.isHealthy;
        if (changes.label !== undefined) {
            if (changes.label === null)
                unset.label = '';
            else
                set.label = changes.label;
        }
        if (changes.comment !== undefined) {
            if (changes.comment === null)
                unset.comment = '';
            else
                set.comment = changes.comment;
        }
        const update: Record<string, Record<string, unknown>> = {};
        if (Object.keys(set).length)
            update.$set = set;
        if (Object.keys(unset).length)
            update.$unset = unset;
        if (!Object.keys(update).length)
            return;
        await this.collection.updateOne({ id }, update);
    }

    async setVerifyErrors(id: number, errors: VolumeVerifyErrors | null): Promise<void> {
        if (errors) {
            await this.collection.updateOne({ id }, { $set: { verifyErrors: errors } });
            return;
        }
        await this.collection.updateOne({ id }, { $unset: { verifyErrors: '' } });
    }
}
