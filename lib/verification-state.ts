import type {
    ObjectVerificationStateUpdate,
    SliceErrorInfo,
    SliceVerificationTimes
} from './database/types';

type VerificationRecord = {
    dataVolumes: number[];
    parityVolumes: number[];
    lastVerifiedAt?: Date | string | null;
    sliceErrors?: Record<string, SliceErrorInfo>;
    sliceVerificationTimes?: SliceVerificationTimes;
};

export function buildObjectVerificationStateUpdate(
    record: VerificationRecord,
    verifiedAt: Date,
    sliceErrors: Record<string, SliceErrorInfo>,
    processedSliceKeys: Set<string>
): ObjectVerificationStateUpdate {
    const mergedErrors: Record<string, SliceErrorInfo> = { ...(record.sliceErrors ?? {}) };
    for (const key of processedSliceKeys)
        delete mergedErrors[key];
    Object.assign(mergedErrors, sliceErrors);

    const sliceVerificationTimes = mergeSliceVerificationTimes(record, verifiedAt, processedSliceKeys);
    const lastVerifiedAt = deriveLastVerifiedAt(sliceVerificationTimes);
    const update: ObjectVerificationStateUpdate = {
        sliceErrors: Object.keys(mergedErrors).length ? mergedErrors : null,
        sliceVerificationTimes
    };
    if (lastVerifiedAt)
        update.lastVerifiedAt = lastVerifiedAt;
    return update;
}

function mergeSliceVerificationTimes(
    record: VerificationRecord,
    verifiedAt: Date,
    processedSliceKeys: Set<string>
): SliceVerificationTimes {
    const baseline = coerceDate(record.lastVerifiedAt);
    const data = createBaselineArray(record.dataVolumes.length, baseline);
    const parity = createBaselineArray(record.parityVolumes.length, baseline);

    overlayExistingTimes(data, record.sliceVerificationTimes?.data, baseline);
    overlayExistingTimes(parity, record.sliceVerificationTimes?.parity, baseline);

    for (const key of processedSliceKeys)
        markSliceVerified(data, parity, record.dataVolumes.length, key, verifiedAt);

    return { data, parity };
}

function createBaselineArray(length: number, baseline: Date | null): Array<Date | null> {
    return Array.from({ length }, () => baseline ? cloneDate(baseline) : null);
}

function overlayExistingTimes(
    target: Array<Date | null>,
    existing: Array<Date | string | null | undefined> | undefined,
    baseline: Date | null
): void {
    if (!existing)
        return;
    for (let index = 0; index < target.length; index++) {
        const value = coerceDate(existing[index]);
        if (!value)
            continue;
        if (baseline && value.getTime() < baseline.getTime())
            continue;
        target[index] = value;
    }
}

function markSliceVerified(
    data: Array<Date | null>,
    parity: Array<Date | null>,
    dataSliceCount: number,
    key: string,
    verifiedAt: Date
): void {
    const sliceIndex = Number.parseInt(key, 10);
    if (!Number.isFinite(sliceIndex) || sliceIndex < 0)
        return;
    if (sliceIndex < dataSliceCount) {
        if (sliceIndex < data.length)
            data[sliceIndex] = cloneDate(verifiedAt);
        return;
    }
    const parityIndex = sliceIndex - dataSliceCount;
    if (parityIndex >= 0 && parityIndex < parity.length)
        parity[parityIndex] = cloneDate(verifiedAt);
}

function deriveLastVerifiedAt(times: SliceVerificationTimes): Date | null {
    const values = [ ...(times.data ?? []), ...(times.parity ?? []) ];
    if (!values.length)
        return null;
    let min = Number.POSITIVE_INFINITY;
    for (const value of values) {
        const date = coerceDate(value);
        if (!date)
            return null;
        min = Math.min(min, date.getTime());
    }
    return new Date(min);
}

function coerceDate(value: Date | string | null | undefined): Date | null {
    if (!value)
        return null;
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime()))
        return null;
    return cloneDate(date);
}

function cloneDate(date: Date): Date {
    return new Date(date.getTime());
}
