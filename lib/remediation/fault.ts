// A slice-level fault observed by a detector (read path, verify job, or a
// system-log/SMART watcher). This is the common currency the remediation
// pipeline ingests, dedupes, classifies and (later) repairs.

export type FaultSource = 'read' | 'verify' | 'syslog' | 'smart';

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
}

// Identity of a fault is (volume, object, slice): the same bad slice seen
// repeatedly coalesces into one fault with a rising count.
export function faultKey(input: Pick<SliceFaultInput, 'objectId' | 'sliceIndex' | 'volumeId'>): string {
    return `${input.volumeId ?? 'unknown'}:${input.objectId}:${input.sliceIndex}`;
}
