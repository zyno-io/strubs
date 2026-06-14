import { constants } from '../constants';
import type { StoredObjectRecord } from '../io/file-object';

export type StorageCounters = {
    objectCount: number;
    logicalBytes: number;
    dataSliceCount: number;
    paritySliceCount: number;
    dataBytes: number;
    parityBytes: number;
    physicalBytes: number;
};

export type StorageSystemStats = StorageCounters & {
    unavailableObjectCount: number;
    unavailableLogicalBytes: number;
};

export type StorageVolumeStats = StorageCounters;

export type StorageStatsSnapshot = {
    updatedAt: Date;
    system: StorageSystemStats;
    volumes: Record<string, StorageVolumeStats>;
};

export type StorageStatsDelta = {
    system: StorageSystemStats;
    volumes: Record<string, StorageVolumeStats>;
};

type StatsObjectRecord = Pick<StoredObjectRecord, 'size' | 'chunkSize' | 'dataVolumes' | 'parityVolumes' | 'sliceSize'>;

export function createEmptyStorageCounters(): StorageCounters {
    return {
        objectCount: 0,
        logicalBytes: 0,
        dataSliceCount: 0,
        paritySliceCount: 0,
        dataBytes: 0,
        parityBytes: 0,
        physicalBytes: 0
    };
}

export function createEmptyStorageStatsSnapshot(updatedAt = new Date()): StorageStatsSnapshot {
    return {
        updatedAt,
        system: {
            ...createEmptyStorageCounters(),
            unavailableObjectCount: 0,
            unavailableLogicalBytes: 0
        },
        volumes: {}
    };
}

export function createEmptyStorageStatsDelta(): StorageStatsDelta {
    return {
        system: {
            ...createEmptyStorageCounters(),
            unavailableObjectCount: 0,
            unavailableLogicalBytes: 0
        },
        volumes: {}
    };
}

export function buildStorageStatsDeltaForObject(record: StatsObjectRecord, direction: 1 | -1, availableVolumeIds?: number[]): StorageStatsDelta {
    const delta = createEmptyStorageStatsDelta();
    const size = record.size ?? 0;
    const dataVolumes = record.dataVolumes ?? [];
    const parityVolumes = record.parityVolumes ?? [];
    const sliceSize = record.sliceSize ?? computeObjectSliceSize(record);
    const dataBytes = sliceSize * dataVolumes.length;
    const parityBytes = sliceSize * parityVolumes.length;

    delta.system.objectCount += direction;
    delta.system.logicalBytes += direction * size;
    delta.system.dataSliceCount += direction * dataVolumes.length;
    delta.system.paritySliceCount += direction * parityVolumes.length;
    delta.system.dataBytes += direction * dataBytes;
    delta.system.parityBytes += direction * parityBytes;
    delta.system.physicalBytes += direction * (dataBytes + parityBytes);
    if (availableVolumeIds && objectIsUnavailable(dataVolumes, parityVolumes, availableVolumeIds)) {
        delta.system.unavailableObjectCount += direction;
        delta.system.unavailableLogicalBytes += direction * size;
    }

    const uniqueVolumes = new Set<number>([...dataVolumes, ...parityVolumes]);
    for (const volumeId of uniqueVolumes) {
        const entry = getOrCreateVolumeDelta(delta, volumeId);
        entry.objectCount += direction;
        entry.logicalBytes += direction * size;
    }

    for (const volumeId of dataVolumes) {
        const entry = getOrCreateVolumeDelta(delta, volumeId);
        entry.dataSliceCount += direction;
        entry.dataBytes += direction * sliceSize;
        entry.physicalBytes += direction * sliceSize;
    }

    for (const volumeId of parityVolumes) {
        const entry = getOrCreateVolumeDelta(delta, volumeId);
        entry.paritySliceCount += direction;
        entry.parityBytes += direction * sliceSize;
        entry.physicalBytes += direction * sliceSize;
    }

    return delta;
}

export function mergeStorageStatsDelta(target: StorageStatsDelta, source: StorageStatsDelta): void {
    mergeSystemCounters(target.system, source.system);
    for (const [volumeId, counters] of Object.entries(source.volumes))
        mergeCounters(getOrCreateVolumeDelta(target, Number(volumeId)), counters);
}

export function storageStatsDeltaIsEmpty(delta: StorageStatsDelta): boolean {
    return systemCountersAreEmpty(delta.system)
        && Object.values(delta.volumes).every(countersAreEmpty);
}

export function computeObjectSliceSize(record: Pick<StatsObjectRecord, 'size' | 'chunkSize' | 'dataVolumes'>): number {
    const dataSliceCount = Math.max(1, record.dataVolumes?.length ?? 1);
    const size = record.size ?? 0;
    const chunkSize = record.chunkSize ?? 16384;
    const sliceDataSize = Math.ceil(size / dataSliceCount);
    const startChunkSize = chunkSize - constants.FILE_HEADER_SIZE;
    const chunkDataSize = chunkSize - constants.CHUNK_HEADER_SIZE;
    const chunkCount = Math.max(
        1,
        Math.ceil(1 + ((sliceDataSize - startChunkSize + constants.CHUNK_HEADER_SIZE) / chunkDataSize))
    );
    return constants.FILE_HEADER_SIZE + sliceDataSize + (constants.CHUNK_HEADER_SIZE * chunkCount);
}

function getOrCreateVolumeDelta(delta: StorageStatsDelta, volumeId: number): StorageVolumeStats {
    const key = String(volumeId);
    delta.volumes[key] ??= createEmptyStorageCounters();
    return delta.volumes[key];
}

function mergeCounters(target: StorageCounters, source: StorageCounters): void {
    target.objectCount += source.objectCount;
    target.logicalBytes += source.logicalBytes;
    target.dataSliceCount += source.dataSliceCount;
    target.paritySliceCount += source.paritySliceCount;
    target.dataBytes += source.dataBytes;
    target.parityBytes += source.parityBytes;
    target.physicalBytes += source.physicalBytes;
}

function mergeSystemCounters(target: StorageSystemStats, source: StorageSystemStats): void {
    mergeCounters(target, source);
    target.unavailableObjectCount += source.unavailableObjectCount;
    target.unavailableLogicalBytes += source.unavailableLogicalBytes;
}

function countersAreEmpty(counters: StorageCounters): boolean {
    return counters.objectCount === 0
        && counters.logicalBytes === 0
        && counters.dataSliceCount === 0
        && counters.paritySliceCount === 0
        && counters.dataBytes === 0
        && counters.parityBytes === 0
        && counters.physicalBytes === 0;
}

function systemCountersAreEmpty(counters: StorageSystemStats): boolean {
    return countersAreEmpty(counters)
        && counters.unavailableObjectCount === 0
        && counters.unavailableLogicalBytes === 0;
}

function objectIsUnavailable(dataVolumes: number[], parityVolumes: number[], availableVolumeIds: number[]): boolean {
    const available = new Set(availableVolumeIds);
    const availableSlices = dataVolumes.filter(volumeId => available.has(volumeId)).length
        + parityVolumes.filter(volumeId => available.has(volumeId)).length;
    return availableSlices < dataVolumes.length;
}
