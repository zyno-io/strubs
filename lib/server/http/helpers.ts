import { database } from '../../database';
import type { ContentDocument } from '../../database';
import { bucketRefFromPath, isValidBucketName } from './object-authz';

export class HttpHelpers {
    static async getObjectMeta(path: string): Promise<ContentDocument | null> {
        try {
            let objectMeta: ContentDocument;
            if (path.length === 26 && /^\/\$[0-9a-f]{24}$/i.test(path))
                objectMeta = await database.getObjectById(path.slice(2));
            else
                objectMeta = await database.getObjectByPath(path.slice(1));
            return objectMeta;
        }
        catch (err) {
            if ((err as { code?: string })?.code === 'ENOENT')
                return null;
            else
                throw err;
        }
    }

    // Is the bucket this DELETE targets protected? Resolve the bucket the same way the request addresses the
    // object. Prefer the bucket NAMED IN THE PATH: it is robust even for a pre-backfill object that carries no
    // bucketId (the sparse-index legacy state -- see backfillBucketIds). Only an id-addressed delete (`/$<id>`)
    // has no bucket name to lean on; there it falls back to the object's denormalised bucketId.
    static async isBucketDeleteProtected(url: string, bucketId: unknown): Promise<boolean> {
        const ref = bucketRefFromPath(url);
        let bucket: ContentDocument | null = null;
        if (ref.form === 'path' && isValidBucketName(ref.bucket))
            bucket = await database.getBucketByName(ref.bucket);
        else if (bucketId !== null && bucketId !== undefined)
            bucket = await database.getBucketById(String(bucketId));
        return bucket?.deleteProtected === true;
    }
}
