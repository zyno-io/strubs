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

    it('persists and clears repair state fields', async () => {
        const { repo, collection } = makeRepo();
        const firstSeen = new Date(1000);
        const lastSeen = new Date(2000);
        const blockedAt = new Date(3000);
        await repo.upsert({
            key: '7:obj:0',
            objectId: 'obj',
            sliceIndex: 0,
            volumeId: 7,
            source: 'read',
            firstSeen,
            lastSeen,
            count: 1,
            repairStatus: 'blocked',
            repairBlockedReason: 'insufficient-slices',
            repairBlockedAt: blockedAt,
            lastRepairAttemptAt: blockedAt,
            lastRepairError: 'insufficient slices',
            repairDetails: { requiredSlices: 4, availableSlices: 3 }
        });

        let update = collection.updateOne.mock.calls[0][1];
        expect(update.$set).toMatchObject({
            repairStatus: 'blocked',
            repairBlockedReason: 'insufficient-slices',
            repairBlockedAt: blockedAt,
            lastRepairAttemptAt: blockedAt,
            lastRepairError: 'insufficient slices',
            repairDetails: { requiredSlices: 4, availableSlices: 3 }
        });

        await repo.upsert({
            key: '7:obj:0',
            objectId: 'obj',
            sliceIndex: 0,
            volumeId: 7,
            source: 'read',
            firstSeen,
            lastSeen,
            count: 1,
            repairStatus: 'pending',
            lastRepairAttemptAt: blockedAt
        });

        update = collection.updateOne.mock.calls[1][1];
        expect(update.$set).toMatchObject({
            repairStatus: 'pending',
            lastRepairAttemptAt: blockedAt
        });
        expect(update.$unset).toMatchObject({
            repairBlockedReason: '',
            repairBlockedAt: '',
            lastRepairError: '',
            repairDetails: ''
        });
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
        expect(collection.updateOne).toHaveBeenCalledWith({ id: 4 }, { $set: { read_only: true, healthy: false, state_updated_at: expect.any(Date) } });
    });

    it('does NOT stamp state_updated_at for a label-only edit (annotation, not state)', async () => {
        const collection = { updateOne: vi.fn().mockResolvedValue(undefined) };
        const repo = new VolumeRepository(collection as any);
        await repo.updateVolumeFlags(4, { label: 'renamed' });
        expect(collection.updateOne).toHaveBeenCalledWith({ id: 4 }, { $set: { label: 'renamed' } });
    });

    it('stamps state_updated_at on soft delete', async () => {
        const collection = { updateOne: vi.fn().mockResolvedValue(undefined) };
        const repo = new VolumeRepository(collection as any);
        await repo.softDeleteVolume(9);
        expect(collection.updateOne).toHaveBeenCalledWith({ id: 9 }, { $set: { enabled: false, is_deleted: true, state_updated_at: expect.any(Date) } });
    });
});
