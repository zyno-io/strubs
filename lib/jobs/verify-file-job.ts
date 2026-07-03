import { database, type SliceErrorInfo } from '../database';
import { categorizeSliceError } from '../slice-error';
import { createLogger } from '../log';
import { fileObjectService, type FileObjectService } from '../io/file-object/service';
import type { FileObject, StoredObjectRecord } from '../io/file-object';
import { FileObjectSliceVerifier, type VerifyMode } from '../io/file-object/slice-verifier';
import { createError } from '../helpers';
import { buildObjectVerificationStateUpdate } from '../verification-state';
import { isMaintenanceFrozen } from '../maintenance';

type VerifyFileJobDeps = {
    database: typeof database;
    fileObjectService: FileObjectService;
    createLogger: typeof createLogger;
    createSliceVerifier: (object: FileObject, mode: VerifyMode) => { verifySlice: (sliceIndex: number) => Promise<void> };
    // Slices on a draining volume are being relocated by the evict job — the scrub skips them so it
    // doesn't fight the drain or fault a slice that's about to move.
    isVolumeEvicting: (volumeId: number | null) => boolean;
};

type SliceVerifier = ReturnType<VerifyFileJobDeps['createSliceVerifier']>;

type SliceVerificationResult = {
    ok: boolean;
    type: 'data' | 'parity' | 'unknown';
    volumeId: number | null;
    checksum?: boolean;
    error?: string;
};

export type VerifyFileJobResult = Record<string, SliceVerificationResult>;

const defaultDeps: VerifyFileJobDeps = {
    database,
    fileObjectService,
    createLogger,
    createSliceVerifier: (object: FileObject, mode: VerifyMode) => new FileObjectSliceVerifier(object, { mode }),
    isVolumeEvicting: (volumeId: number | null) => {
        if (volumeId === null)
            return false;
        // Lazy require so this module doesn't pull the io manager graph at import for consumers/tests.
        const { ioManager } = require('../io/manager') as typeof import('../io/manager');
        return ioManager.getVolume(volumeId)?.isEvicting === true;
    }
};

export class VerifyFileJob {
    private readonly deps: VerifyFileJobDeps;
    private readonly log: ReturnType<typeof createLogger>;

    constructor(deps?: Partial<VerifyFileJobDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('verify-file');
    }

    async verify(objectId: string, opts?: { mode?: VerifyMode }): Promise<VerifyFileJobResult> {
        const mode: VerifyMode = opts?.mode === 'light' ? 'light' : 'full';
        // Respected by both the on-demand mgmt API and the repair worker's
        // re-verify path: a clear error (rather than a no-op empty result, which
        // would read as "all slices bad") keeps callers from acting on a frozen
        // system.
        if (await isMaintenanceFrozen())
            throw createError('EMAINTENANCE', 'maintenance freeze active; verification disabled');
        const record = await this.loadFileRecord(objectId);
        this.log('verifying object %s', record.id);

        const object = await this.deps.fileObjectService.load(record, {
            requestId: `verify-file:${record.id}`,
            priority: 'low'
        });
        const totalSlices = record.dataVolumes.length + record.parityVolumes.length;
        const sliceResults: VerifyFileJobResult = {};
        const sliceErrors: Record<string, SliceErrorInfo> = {};
        const verifiedAt = new Date();

        const tasks: Promise<void>[] = [];
        for (let sliceIndex = 0; sliceIndex < totalSlices; sliceIndex++) {
            const sliceVolumeId = sliceIndex < record.dataVolumes.length
                ? record.dataVolumes[sliceIndex] ?? null
                : record.parityVolumes[sliceIndex - record.dataVolumes.length] ?? null;
            if (this.deps.isVolumeEvicting(sliceVolumeId)) {
                this.log('skipping slice %d of object %s: volume %s is evicting', sliceIndex, record.id, sliceVolumeId);
                continue;
            }
            tasks.push(
                this.verifySliceIndex(
                    record,
                    () => this.deps.createSliceVerifier(object, mode),
                    sliceIndex,
                    sliceResults,
                    sliceErrors
                )
            );
        }
        await Promise.all(tasks);

        await this.deps.database.updateObjectVerificationState(
            record.id,
            buildObjectVerificationStateUpdate(record, verifiedAt, sliceErrors, new Set(Object.keys(sliceResults)))
        );

        return sliceResults;
    }

    private async loadFileRecord(objectId: string): Promise<StoredObjectRecord> {
        const record = await this.deps.database.getObjectById(objectId);
        if (!this.isStoredObjectRecord(record))
            throw createError('ENOTFILE', 'object is not a file');
        return record;
    }

    private isStoredObjectRecord(record: unknown): record is StoredObjectRecord {
        if (!record || typeof record !== 'object')
            return false;
        const candidate = record as Partial<StoredObjectRecord>;
        return typeof candidate.id === 'string'
            && typeof candidate.size === 'number'
            && typeof candidate.chunkSize === 'number'
            && Array.isArray(candidate.dataVolumes)
            && Array.isArray(candidate.parityVolumes);
    }

    private describeSlice(
        record: StoredObjectRecord,
        sliceIndex: number | null
    ): { key: string; type: 'data' | 'parity' | 'unknown'; volumeId: number | null } {
        if (sliceIndex === null)
            return { key: 'unknown', type: 'unknown', volumeId: null };
        if (sliceIndex < record.dataVolumes.length) {
            return {
                key: String(sliceIndex),
                type: 'data',
                volumeId: record.dataVolumes[sliceIndex] ?? null
            };
        }
        const parityIndex = sliceIndex - record.dataVolumes.length;
        return {
            key: String(sliceIndex),
            type: 'parity',
            volumeId: record.parityVolumes[parityIndex] ?? null
        };
    }

    private normalizeSliceError(
        record: StoredObjectRecord,
        err: unknown
    ): { sliceKey: string; sliceType: 'data' | 'parity' | 'unknown'; info: SliceErrorInfo; volumeId: number | null; isChecksum: boolean } {
        const errorObj = err as Error & { code?: string; sliceIndex?: number; volumeId?: number };
        const sliceIndex = typeof errorObj.sliceIndex === 'number' ? errorObj.sliceIndex : null;
        const descriptor = this.describeSlice(record, sliceIndex);
        const isChecksum = errorObj.code === 'ECHECKSUM';
        const message = errorObj.message ?? String(err);
        const info: SliceErrorInfo = {
            code: errorObj.code,
            category: categorizeSliceError(errorObj.code, message)
        };
        if (isChecksum)
            info.checksum = true;
        else
            info.err = message;
        if (descriptor.type === 'data' || descriptor.type === 'parity')
            info.type = descriptor.type;
        const volumeId = errorObj.volumeId ?? descriptor.volumeId ?? null;
        return {
            sliceKey: descriptor.key,
            sliceType: descriptor.type,
            info,
            volumeId,
            isChecksum
        };
    }

    private async verifySliceIndex(
        record: StoredObjectRecord,
        verifierFactory: () => SliceVerifier,
        sliceIndex: number,
        sliceResults: VerifyFileJobResult,
        sliceErrors: Record<string, SliceErrorInfo>
    ): Promise<void> {
        const verifier = verifierFactory();
        const descriptor = this.describeSlice(record, sliceIndex);
        try {
            await verifier.verifySlice(sliceIndex);
            sliceResults[descriptor.key] = {
                ok: true,
                type: descriptor.type,
                volumeId: descriptor.volumeId
            };
        }
        catch (err) {
            const normalized = this.normalizeSliceError(record, err);
            const message = err instanceof Error ? err.message : String(err);
            sliceResults[descriptor.key] = {
                ok: false,
                type: normalized.sliceType,
                volumeId: normalized.volumeId,
                checksum: normalized.isChecksum || undefined,
                error: message
            };
            sliceErrors[normalized.sliceKey] = normalized.info;
            this.log.error(
                'object %s %s slice %s verification failed: %s',
                record.id,
                normalized.sliceType,
                normalized.sliceKey,
                message
            );
        }
    }
}

export const verifyFileJob = new VerifyFileJob();
