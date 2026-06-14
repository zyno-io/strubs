// A slice-level fault observed by a detector (read path, verify job, or a
// system-log/SMART watcher). This is the common currency the remediation
// pipeline ingests, dedupes, classifies and (later) repairs.

export type FaultSource = 'read' | 'verify' | 'syslog' | 'smart';
export type RepairStatus = 'pending' | 'blocked';
export type RepairBlockedReason = 'insufficient-slices';

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
