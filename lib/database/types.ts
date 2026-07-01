import type { ObjectId } from 'mongodb';

export type ObjectIdentifier = string | ObjectId | Buffer | null | undefined;
export type ContainerPath = string | string[];

export interface ContentDocument {
    _id?: ObjectId;
    id?: string;
    containerId?: ObjectId | string | null;
    name: string;
    isContainer?: boolean;
    isFile?: boolean;
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
