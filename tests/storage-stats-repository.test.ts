import { describe, expect, it, vi } from 'vitest';

import { StorageStatsRepository } from '../lib/database/storage-stats-repository';
import { createEmptyStorageStatsDelta } from '../lib/storage/stats';

const COUNTER_KEYS = [
    'objectCount',
    'logicalBytes',
    'dataSliceCount',
    'paritySliceCount',
    'dataBytes',
    'parityBytes',
    'physicalBytes'
] as const;

describe('StorageStatsRepository.applyDelta', () => {
    const makeRepo = () => {
        const collection = { updateOne: vi.fn().mockResolvedValue(undefined) };
        return { repo: new StorageStatsRepository(collection as any), collection };
    };

    const incFor = (collection: { updateOne: ReturnType<typeof vi.fn> }) =>
        collection.updateOne.mock.calls[0][1].$inc as Record<string, number>;

    it('increments every counter of a touched volume, including the zero-valued ones', async () => {
        const { repo, collection } = makeRepo();
        const delta = createEmptyStorageStatsDelta();
        // A volume that only ever receives data slices: its parity counters stay at zero.
        delta.system.objectCount = 1;
        delta.volumes['59'] = {
            objectCount: 1,
            logicalBytes: 100,
            dataSliceCount: 1,
            paritySliceCount: 0,
            dataBytes: 40,
            parityBytes: 0,
            physicalBytes: 40
        };

        await repo.applyDelta(delta, new Date(1000));

        const inc = incFor(collection);
        // The zeroed parity paths must still be present, otherwise an upsert-insert
        // creates volumes.59 without them and the UI reads undefined.
        for (const key of COUNTER_KEYS)
            expect(inc).toHaveProperty(`volumes.59.${key}`);
        expect(inc['volumes.59.paritySliceCount']).toBe(0);
        expect(inc['volumes.59.parityBytes']).toBe(0);
        expect(inc['volumes.59.dataSliceCount']).toBe(1);
    });

    it('always writes a complete system subdocument, even for a relocation-only delta', async () => {
        const { repo, collection } = makeRepo();
        const delta = createEmptyStorageStatsDelta();
        // Relocation moves a slice between volumes; system totals do not change.
        delta.volumes['7'] = {
            objectCount: -1, logicalBytes: -100, dataSliceCount: -1,
            paritySliceCount: 0, dataBytes: -40, parityBytes: 0, physicalBytes: -40
        };
        delta.volumes['8'] = {
            objectCount: 1, logicalBytes: 100, dataSliceCount: 1,
            paritySliceCount: 0, dataBytes: 40, parityBytes: 0, physicalBytes: 40
        };

        await repo.applyDelta(delta, new Date(1000));

        const inc = incFor(collection);
        for (const key of COUNTER_KEYS)
            expect(inc[`system.${key}`]).toBe(0);
        expect(inc['system.unavailableObjectCount']).toBe(0);
        expect(inc['system.unavailableLogicalBytes']).toBe(0);
    });

    it('never targets the same path from two update operators', async () => {
        const { repo, collection } = makeRepo();
        const delta = createEmptyStorageStatsDelta();
        // Mongo rejects an update whose operators overlap on a path (error 40), so an
        // unavailable-object delta must not be both $inc'd and $setOnInsert'd.
        delta.system.objectCount = 1;
        delta.system.unavailableObjectCount = 1;
        delta.system.unavailableLogicalBytes = 100;

        await repo.applyDelta(delta, new Date(1000));

        const update = collection.updateOne.mock.calls[0][1];
        const paths = Object.keys(update.$inc).concat(Object.keys(update.$setOnInsert ?? {}));
        expect(new Set(paths).size).toBe(paths.length);
        expect(update.$inc['system.unavailableObjectCount']).toBe(1);
    });

    it('omits volumes with no activity', async () => {
        const { repo, collection } = makeRepo();
        const delta = createEmptyStorageStatsDelta();
        delta.system.objectCount = 1;
        delta.volumes['3'] = {
            objectCount: 0, logicalBytes: 0, dataSliceCount: 0,
            paritySliceCount: 0, dataBytes: 0, parityBytes: 0, physicalBytes: 0
        };

        await repo.applyDelta(delta, new Date(1000));

        const inc = incFor(collection);
        expect(Object.keys(inc).some(path => path.startsWith('volumes.3.'))).toBe(false);
    });

    it('does not write at all for a fully empty delta', async () => {
        const { repo, collection } = makeRepo();

        await repo.applyDelta(createEmptyStorageStatsDelta(), new Date(1000));

        expect(collection.updateOne).not.toHaveBeenCalled();
    });
});
