import type { ObjectId } from 'mongodb';

export type ObjectIdentifier = string | ObjectId | Buffer | null | undefined;
export type ContainerPath = string | string[];

export interface ContentDocument {
    _id?: ObjectId;
    id?: string;
    containerId?: ObjectId | string | null;
    // Top-level container (the bucket) this document belongs to, denormalised so authorisation and
    // per-bucket stats don't have to walk the container chain to the root on every request. For a
    // top-level container it is the document's own _id; for everything nested it is the root ancestor.
    // Additive: absent on pre-backfill documents (treated as "unknown bucket", never as a wildcard).
    bucketId?: ObjectId | string | null;
    name: string;
    isContainer?: boolean;
    isFile?: boolean;
    // Bucket access policy, meaningful only on a top-level container (the bucket itself). Absent means
    // "default" -- interpreted as open (public) while authEnforced is false, so behaviour is unchanged
    // until the policy is explicitly set. publicWrite grants anonymous PUT *and DELETE*.
    publicRead?: boolean;
    publicWrite?: boolean;
    // Delete protection: when true on a bucket, ALL object deletes within it are refused (403). A
    // "more-closed" flag, so like publicRead/publicWrite it may only ever be tightened by a restore, never
    // loosened -- a restore may ADD protection but never silently REMOVE it. Absent means not protected.
    deleteProtected?: boolean;
    size?: number;
    chunkSize?: number;
    sliceSize?: number | null;
    dataVolumes?: number[];
    parityVolumes?: number[];
    unavailableSlices?: number[];
    damagedSlices?: number[];
    md5?: Buffer | null;
    mime?: string | null;
    lastVerifiedAt?: Date | null;
    sliceVerificationTimes?: SliceVerificationTimes;
    sliceErrors?: Record<string, SliceErrorInfo>;
    [key: string]: any;
}

// Coarse cause of a slice failure, derived from the error code at the source.
// Lets analysis/remediation separate recoverable mis-stamps and transient
// volume outages from genuine data corruption or loss without parsing messages.
export type SliceErrorCategory =
    | 'checksum'            // ECHECKSUM — chunk data failed its stored hash
    | 'header-mismatch'     // EHEADER — header intact but describes another object/slice
    | 'volume-unavailable'  // EUNAVAIL — volume offline/unmounted (transient, clears on remount)
    | 'missing'             // ENOENT — slice file absent on a mounted volume
    | 'io'                  // EIO and other native read errors
    | 'timeout'             // ETIMEOUT — slice I/O timed out
    | 'parity-mismatch'     // EPARITY — parity self-consistent but != recomputed (foreign/stale)
    | 'header-checksum'     // EHDRSUM — advisory header md5 mismatch (post-restamp = genuine header corruption)
    | 'unknown';            // EOPEN/unclassified

export type SliceErrorInfo = {
    checksum?: boolean;
    code?: string;
    category?: SliceErrorCategory;
    err?: string;
    type?: 'data' | 'parity';
};

export type SliceVerificationTimes = {
    data?: Array<Date | null>;
    parity?: Array<Date | null>;
};

export type ObjectVerificationStateUpdate = {
    lastVerifiedAt?: Date | null;
    sliceErrors?: Record<string, SliceErrorInfo> | null;
    sliceVerificationTimes?: SliceVerificationTimes | null;
};

// "Documented dead": an operator has recorded this object as accepted loss (its surviving slices are
// foreign or below quorum, so any reconstruction from them would be self-consistent-but-wrong).
//
// This MUST mean the same thing everywhere. Three call sites had drifted to three different tests --
// `!= null`, `!= null && !== ''`, and a Mongo `$exists` -- which combined into a data-loss path: an
// object with an EMPTY recoveryComment was skipped by the drain (so its slice stayed on the volume) yet
// excluded from the volume's live-slice count (so the volume was declared fully drained and its removal
// unblocked). Pulling that disk would have silently lost the slice. One predicate, used by all of them.
export function isDocumentedDead(doc: unknown): boolean {
    const comment = (doc as { recoveryComment?: unknown } | null | undefined)?.recoveryComment;
    return typeof comment === 'string' && comment.length > 0;
}
