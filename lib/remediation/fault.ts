// A slice-level fault observed by a detector (read path, verify job, or a
// system-log/SMART watcher). This is the common currency the remediation
// pipeline ingests, dedupes, classifies and (later) repairs.

export type FaultSource = 'read' | 'verify' | 'syslog' | 'smart';
export type RepairStatus = 'pending' | 'blocked';
// 'unrecoverable': the object is documented as beyond repair (a recoveryComment) -- reconstruction is
// futile and, with foreign/corrupt surviving slices, actively dangerous (it can overwrite good data
// with self-consistent-but-wrong reconstructed bytes). Never retried.
// 'reconstruction-mismatch': there were enough surviving slices to reconstruct, but the rebuilt object
// did not match its stored whole-object md5 (a foreign/corrupt surviving slice). The repairer refuses
// to commit rather than overwrite a good slice with valid-looking-but-wrong bytes.
export type RepairBlockedReason = 'insufficient-slices' | 'target-unwritable' | 'unrecoverable' | 'reconstruction-mismatch';

export interface RepairBlockDetails {
    requiredSlices?: number;
    availableSlices?: number;
    totalSlices?: number;
    chunkIndex?: number;
    availableSliceIndexes?: number[];
    missingSliceIndexes?: number[];
    failedSliceIndexes?: number[];
    missingVolumeIds?: number[];
    failedVolumeIds?: number[];
    targetVolumeId?: number;
    message?: string;
}

export interface SliceFaultInput {
    objectId: string;
    sliceIndex: number;
    volumeId: number | null;
    source: FaultSource;
    code?: string;
    message?: string;
    isChecksum?: boolean;
}

export interface SliceFault extends SliceFaultInput {
    key: string;
    firstSeen: number;
    lastSeen: number;
    count: number;
    repairStatus?: RepairStatus;
    repairBlockedReason?: RepairBlockedReason;
    repairBlockedAt?: number;
    lastRepairAttemptAt?: number;
    lastRepairError?: string;
    repairDetails?: RepairBlockDetails;
}

// Identity of a fault is (volume, object, slice): the same bad slice seen
// repeatedly coalesces into one fault with a rising count.
export function faultKey(input: Pick<SliceFaultInput, 'objectId' | 'sliceIndex' | 'volumeId'>): string {
    return `${input.volumeId ?? 'unknown'}:${input.objectId}:${input.sliceIndex}`;
}
