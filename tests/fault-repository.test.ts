import { describe, expect, it, vi } from 'vitest';

import { FaultRepository } from '../lib/database/fault-repository';
import { VolumeRepository } from '../lib/database/volume-repository';

describe('FaultRepository', () => {
    const makeRepo = () => {
        const collection = {
            updateOne: vi.fn().mockResolvedValue(undefined),
            deleteOne: vi.fn().mockResolvedValue(undefined),
            find: vi.fn(() => ({ sort: vi.fn(() => ({ toArray: vi.fn().mockResolvedValue([{ _id: 'k1' }]) })) }))
        };
        return { repo: new FaultRepository(collection as any), collection };
    };

    it('upserts with absolute fields set and firstSeen only on insert', async () => {
        const { repo, collection } = makeRepo();
        const firstSeen = new Date(1000);
        const lastSeen = new Date(2000);
        await repo.upsert({
            key: '7:obj:0', objectId: 'obj', sliceIndex: 0, volumeId: 7,
            source: 'verify', code: 'EIO', message: 'm', isChecksum: false, firstSeen, lastSeen, count: 3
        });

        expect(collection.updateOne).toHaveBeenCalledTimes(1);
        const [filter, update, options] = collection.updateOne.mock.calls[0];
        expect(filter).toEqual({ _id: '7:obj:0' });
        expect(update.$set).toMatchObject({ objectId: 'obj', volumeId: 7, count: 3, lastSeen });
        expect(update.$setOnInsert).toEqual({ firstSeen });
        expect(options).toEqual({ upsert: true });
    });

    it('lists faults sorted by lastSeen and deletes by key', async () => {
        const { repo, collection } = makeRepo();
        const list = await repo.list();
        expect(list).toEqual([{ _id: 'k1' }]);
        await repo.delete('7:obj:0');
        expect(collection.deleteOne).toHaveBeenCalledWith({ _id: '7:obj:0' });
    });
});

describe('VolumeRepository.updateVolumeFlags', () => {
    it('persists the healthy flag when provided', async () => {
        const collection = { updateOne: vi.fn().mockResolvedValue(undefined) };
        const repo = new VolumeRepository(collection as any);
        await repo.updateVolumeFlags(4, { isReadOnly: true, isHealthy: false });
        expect(collection.updateOne).toHaveBeenCalledWith({ id: 4 }, { $set: { read_only: true, healthy: false } });
    });
});
