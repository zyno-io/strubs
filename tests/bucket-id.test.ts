import { beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';

import { ContentRepository } from '../lib/database/content-repository';
import { ContainerCache } from '../lib/database/container-cache';
import type { ContentDocument } from '../lib/database/types';

// A tiny in-memory stand-in for the `content` collection, implementing exactly the operations that
// resolveContainerWithBucket / backfillBucketIds / computeBucketStats touch, with faithful ObjectId and
// operator semantics. The repository is the real thing; only Mongo is faked.
class FakeContentCollection {
    docs: ContentDocument[] = [];

    private matches(doc: ContentDocument, filter: Record<string, any>): boolean {
        for (const [key, cond] of Object.entries(filter)) {
            const value = (doc as any)[key];
            if (cond && typeof cond === 'object' && !(cond instanceof ObjectId) && !Buffer.isBuffer(cond)) {
                if ('$exists' in cond) {
                    const present = value !== undefined;
                    if (present !== cond.$exists) return false;
                }
                if ('$in' in cond) {
                    const list: any[] = cond.$in;
                    if (!list.some(item => this.eq(value, item))) return false;
                }
                if ('$ne' in cond) {
                    if (this.eq(value, cond.$ne)) return false;
                }
            }
            else if (!this.eq(value, cond)) {
                return false;
            }
        }
        return true;
    }

    private eq(a: any, b: any): boolean {
        if (a instanceof ObjectId && b instanceof ObjectId) return a.equals(b);
        if (a instanceof ObjectId) return b != null && a.equals(b);
        if (b instanceof ObjectId) return a != null && b.equals(a);
        return a === b;
    }

    async findOne(filter: Record<string, any>): Promise<ContentDocument | null> {
        return this.docs.find(doc => this.matches(doc, filter)) ?? null;
    }

    find(filter: Record<string, any>) {
        const matched = this.docs.filter(doc => this.matches(doc, filter));
        return { toArray: async () => matched.map(doc => ({ ...doc })) };
    }

    async insertOne(doc: ContentDocument): Promise<{ insertedId: ObjectId }> {
        const _id = doc._id instanceof ObjectId ? doc._id : new ObjectId();
        this.docs.push({ ...doc, _id });
        return { insertedId: _id };
    }

    async updateOne(filter: Record<string, any>, update: Record<string, any>): Promise<{ modifiedCount: number }> {
        const doc = this.docs.find(d => this.matches(d, filter));
        if (!doc) return { modifiedCount: 0 };
        Object.assign(doc, update.$set ?? {});
        return { modifiedCount: 1 };
    }

    async updateMany(filter: Record<string, any>, update: Record<string, any>): Promise<{ modifiedCount: number }> {
        const matched = this.docs.filter(d => this.matches(d, filter));
        for (const doc of matched) Object.assign(doc, update.$set ?? {});
        return { modifiedCount: matched.length };
    }

    async bulkWrite(ops: any[]): Promise<{ modifiedCount: number }> {
        let modifiedCount = 0;
        for (const op of ops) {
            const { filter, update } = op.updateOne;
            const res = await this.updateOne(filter, update);
            modifiedCount += res.modifiedCount;
        }
        return { modifiedCount };
    }

    async countDocuments(filter: Record<string, any>): Promise<number> {
        return this.docs.filter(doc => this.matches(doc, filter)).length;
    }

    aggregate<T>(pipeline: any[]) {
        // Minimal support for computeBucketStats: $match then $group-by-bucketId with count + size sum.
        let rows = this.docs.slice();
        for (const stage of pipeline) {
            if (stage.$match) rows = rows.filter(doc => this.matches(doc, stage.$match));
        }
        const groups = new Map<string, { _id: ObjectId; objectCount: number; logicalBytes: number }>();
        for (const doc of rows) {
            const bid = (doc.bucketId as ObjectId);
            if (!bid) continue;
            const key = bid.toHexString();
            const g = groups.get(key) ?? { _id: bid, objectCount: 0, logicalBytes: 0 };
            g.objectCount += 1;
            g.logicalBytes += (doc.size ?? 0);
            groups.set(key, g);
        }
        const out = Array.from(groups.values());
        return { toArray: async () => out as unknown as T[] };
    }
}

function toMongoId(id: any): ObjectId | null {
    if (!id) return null;
    if (typeof id === 'string') return new ObjectId(id);
    if (id instanceof ObjectId) return id;
    if (id instanceof Buffer) return new ObjectId(id.toString('hex'));
    throw new Error('unhandled id type');
}

function normalize<T extends ContentDocument>(object: T): T & { id: string; containerId?: string | null } {
    const out = { ...object } as any;
    if (object._id) { out.id = (object._id as ObjectId).toHexString(); delete out._id; }
    else if (object.id) { out.id = object.id; }
    const cid = object.containerId;
    if (cid instanceof ObjectId) out.containerId = cid.toHexString();
    else if (typeof cid === 'string') out.containerId = cid;
    else if (cid === null) out.containerId = null;
    else delete out.containerId;
    return out;
}

describe('bucketId denormalisation', () => {
    let collection: FakeContentCollection;
    let repo: ContentRepository;

    beforeEach(() => {
        collection = new FakeContentCollection();
        repo = new ContentRepository(collection as any, new ContainerCache(), normalize as any, toMongoId);
    });

    describe('resolveContainerWithBucket at creation time', () => {
        it('stamps a brand-new top-level container as its own bucket', async () => {
            const { containerId, bucketId } = await repo.resolveContainerWithBucket('photo', true);
            expect(containerId).toBe(bucketId);                       // the bucket IS the container
            const doc = collection.docs.find(d => d.name === 'photo')!;
            expect((doc.bucketId as ObjectId).toHexString()).toBe(bucketId);
            expect((doc.bucketId as ObjectId).equals(doc._id as ObjectId)).toBe(true);
        });

        it('gives every nested container the top-level bucket, not its immediate parent', async () => {
            const { containerId, bucketId } = await repo.resolveContainerWithBucket('photo/2024/spain', true);
            const photo = collection.docs.find(d => d.name === 'photo')!;
            const y2024 = collection.docs.find(d => d.name === '2024')!;
            const spain = collection.docs.find(d => d.name === 'spain')!;
            expect(bucketId).toBe((photo._id as ObjectId).toHexString());
            expect((y2024.bucketId as ObjectId).equals(photo._id as ObjectId)).toBe(true);
            expect((spain.bucketId as ObjectId).equals(photo._id as ObjectId)).toBe(true);
            expect(containerId).toBe((spain._id as ObjectId).toHexString());
        });

        it('resolves the bucket of an existing path without creating anything', async () => {
            const created = await repo.resolveContainerWithBucket('video/clips', true);
            const before = collection.docs.length;
            const again = await repo.resolveContainerWithBucket('video/clips', false);
            expect(again.bucketId).toBe(created.bucketId);
            expect(collection.docs.length).toBe(before);              // nothing new inserted
        });
    });

    describe('createObjectRecord', () => {
        it('persists the bucketId as an ObjectId on the file document', async () => {
            const bucket = new ObjectId();
            const container = new ObjectId();
            await repo.createObjectRecord({
                id: new ObjectId().toHexString(),
                containerId: container,
                bucketId: bucket.toHexString(),
                isFile: true,
                name: 'cat.jpg'
            } as any);
            const doc = collection.docs.find(d => d.name === 'cat.jpg')!;
            expect(doc.bucketId).toBeInstanceOf(ObjectId);
            expect((doc.bucketId as ObjectId).equals(bucket)).toBe(true);
        });

        it('stores bucketId null for a root object (no bucket)', async () => {
            await repo.createObjectRecord({
                id: new ObjectId().toHexString(),
                containerId: null,
                isFile: true,
                name: 'orphan.bin'
            } as any);
            const doc = collection.docs.find(d => d.name === 'orphan.bin')!;
            expect(doc.bucketId).toBeNull();
        });

        it('refuses to create a contained object without a bucketId (would be lost to backfill)', async () => {
            await expect(repo.createObjectRecord({
                id: new ObjectId().toHexString(),
                containerId: new ObjectId(),        // in a container...
                isFile: true,                        // ...but no bucketId
                name: 'stray.jpg'
            } as any)).rejects.toThrow(/bucketId/);
            expect(collection.docs.find(d => d.name === 'stray.jpg')).toBeUndefined();
        });
    });

    describe('backfillBucketIds', () => {
        // Build a tree: photo/ {2024/ {a.jpg}, b.jpg}, video/ {c.mp4}. Files and nested containers start
        // WITHOUT bucketId, as pre-backfill production documents do.
        function seedLegacyTree() {
            const photo = new ObjectId();
            const y2024 = new ObjectId();
            const video = new ObjectId();
            collection.docs.push(
                { _id: photo, containerId: null, name: 'photo', isContainer: true },
                { _id: y2024, containerId: photo, name: '2024', isContainer: true },
                { _id: video, containerId: null, name: 'video', isContainer: true },
                { _id: new ObjectId(), containerId: y2024, name: 'a.jpg', isFile: true, size: 10 },
                { _id: new ObjectId(), containerId: photo, name: 'b.jpg', isFile: true, size: 20 },
                { _id: new ObjectId(), containerId: video, name: 'c.mp4', isFile: true, size: 100 }
            );
            return { photo, y2024, video };
        }

        it('stamps every container and file with its root bucket', async () => {
            const { photo, video } = seedLegacyTree();
            const res = await repo.backfillBucketIds({ apply: true });
            expect(res.skippedContainers).toBe(0);
            expect(res.containersStamped).toBe(3);
            expect(res.objectsStamped).toBe(3);
            const bucketOf = (name: string) => collection.docs.find(d => d.name === name)!.bucketId as ObjectId;
            expect(bucketOf('photo').equals(photo)).toBe(true);      // bucket == self
            expect(bucketOf('2024').equals(photo)).toBe(true);       // nested -> root
            expect(bucketOf('a.jpg').equals(photo)).toBe(true);      // deep file -> root
            expect(bucketOf('b.jpg').equals(photo)).toBe(true);
            expect(bucketOf('c.mp4').equals(video)).toBe(true);
        });

        it('is additive: a dry run writes nothing and re-running never rewrites an existing value', async () => {
            seedLegacyTree();
            const dry = await repo.backfillBucketIds({ apply: false });
            expect(dry.containersStamped + dry.objectsStamped).toBe(6);
            expect(collection.docs.every(d => d.bucketId === undefined)).toBe(true);   // dry run: no writes

            await repo.backfillBucketIds({ apply: true });
            const snapshot = collection.docs.map(d => (d.bucketId as ObjectId).toHexString());
            const second = await repo.backfillBucketIds({ apply: true });
            expect(second.containersStamped).toBe(0);                 // nothing left to stamp
            expect(second.objectsStamped).toBe(0);
            expect(collection.docs.map(d => (d.bucketId as ObjectId).toHexString())).toEqual(snapshot);
        });

        it('after a full backfill, a dry run reports zero to stamp (accurate re-run count)', async () => {
            seedLegacyTree();
            await repo.backfillBucketIds({ apply: true });
            const dry = await repo.backfillBucketIds({ apply: false });
            expect(dry.containersStamped).toBe(0);      // not the total container count
            expect(dry.objectsStamped).toBe(0);
        });

        it('covers files still unstamped under an already-stamped container (partial re-run)', async () => {
            const { photo } = seedLegacyTree();
            await repo.backfillBucketIds({ apply: true });
            // A new legacy-shaped file appears under the already-stamped photo container, no bucketId.
            collection.docs.push({ _id: new ObjectId(), containerId: photo, name: 'late.jpg', isFile: true, size: 5 });
            const res = await repo.backfillBucketIds({ apply: true });
            expect(res.containersStamped).toBe(0);      // containers already done
            expect(res.objectsStamped).toBe(1);         // the late file gets covered
            expect((collection.docs.find(d => d.name === 'late.jpg')!.bucketId as ObjectId).equals(photo)).toBe(true);
        });

        it('leaves an orphaned subtree unstamped rather than mis-bucketing it', async () => {
            const missingParent = new ObjectId();
            const orphanContainer = new ObjectId();
            collection.docs.push(
                { _id: orphanContainer, containerId: missingParent, name: 'lost', isContainer: true },
                { _id: new ObjectId(), containerId: orphanContainer, name: 'x.bin', isFile: true, size: 1 }
            );
            const res = await repo.backfillBucketIds({ apply: true });
            expect(res.skippedContainers).toBe(1);
            expect(collection.docs.find(d => d.name === 'lost')!.bucketId).toBeUndefined();
            expect(collection.docs.find(d => d.name === 'x.bin')!.bucketId).toBeUndefined();
        });
    });

    describe('computeBucketStats', () => {
        it('groups object count and logical size by bucket', async () => {
            const { photo, video } = (() => {
                const photo = new ObjectId();
                const video = new ObjectId();
                collection.docs.push(
                    { _id: new ObjectId(), containerId: photo, bucketId: photo, name: 'a', isFile: true, size: 10 },
                    { _id: new ObjectId(), containerId: photo, bucketId: photo, name: 'b', isFile: true, size: 20 },
                    { _id: new ObjectId(), containerId: video, bucketId: video, name: 'c', isFile: true, size: 100 },
                    // a container and a not-yet-backfilled file must be excluded
                    { _id: new ObjectId(), containerId: null, bucketId: photo, name: 'sub', isContainer: true },
                    { _id: new ObjectId(), containerId: photo, name: 'nobucket', isFile: true, size: 5 }
                );
                return { photo, video };
            })();
            const stats = await repo.computeBucketStats();
            const byId = new Map(stats.map(s => [s.bucketId, s]));
            expect(byId.get(photo.toHexString())).toEqual({ bucketId: photo.toHexString(), objectCount: 2, logicalBytes: 30 });
            expect(byId.get(video.toHexString())).toEqual({ bucketId: video.toHexString(), objectCount: 1, logicalBytes: 100 });
        });
    });
});
