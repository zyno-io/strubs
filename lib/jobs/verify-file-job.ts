import { database, type SliceErrorInfo } from '../database';
import { createLogger } from '../log';
import { fileObjectService, type FileObjectService } from '../io/file-object/service';
import type { FileObject, StoredObjectRecord } from '../io/file-object';
import { FileObjectSliceVerifier } from '../io/file-object/slice-verifier';
import { createError } from '../helpers';
import { buildObjectVerificationStateUpdate } from '../verification-state';

type VerifyFileJobDeps = {
    database: typeof database;
    fileObjectService: FileObjectService;
    createLogger: typeof createLogger;
    createSliceVerifier: (object: FileObject) => { verifySlice: (sliceIndex: number) => Promise<void> };
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
    createSliceVerifier: (object: FileObject) => new FileObjectSliceVerifier(object)
};

export class VerifyFileJob {
    private readonly deps: VerifyFileJobDeps;
    private readonly log: ReturnType<typeof createLogger>;

    constructor(deps?: Partial<VerifyFileJobDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('verify-file');
    }

    async verify(objectId: string): Promise<VerifyFileJobResult> {
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
            tasks.push(
                this.verifySliceIndex(
                    record,
                    () => this.deps.createSliceVerifier(object),
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
        const info: SliceErrorInfo = isChecksum
            ? { checksum: true }
            : { err: errorObj.message ?? String(err) };
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
