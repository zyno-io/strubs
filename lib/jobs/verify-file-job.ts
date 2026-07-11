import { database, type SliceErrorInfo } from '../database';
import { categorizeSliceError, isIOAbort } from '../slice-error';
import { createLogger } from '../log';
import { fileObjectService, type FileObjectService } from '../io/file-object/service';
import type { FileObject, StoredObjectRecord } from '../io/file-object';
import { FileObjectSliceVerifier, type VerifyMode } from '../io/file-object/slice-verifier';
import { createError } from '../helpers';
import { config } from '../config';
import { buildObjectVerificationStateUpdate } from '../verification-state';
import { isMaintenanceFrozen } from '../maintenance';

type VerifyFileJobDeps = {
    database: typeof database;
    fileObjectService: FileObjectService;
    createLogger: typeof createLogger;
    createSliceVerifier: (object: FileObject, mode: VerifyMode) => { verifySlice: (sliceIndex: number) => Promise<void> };
    // Slices on a draining volume are being relocated by the drain job — the scrub skips them so it
    // doesn't fight the drain or fault a slice that's about to move.
    isVolumeDraining: (volumeId: number | null) => boolean;
    // Full-mode scrub validates parity: recompute the correct parity from the data and compare to the
    // stored parity. Returns the parity slice indices whose stored value is FOREIGN (self-consistent but
    // wrong) -- the incident failure mode that per-chunk checksums can't catch.
    verifyParity: boolean;
    verifyObjectParity: (object: FileObject) => Promise<number[]>;
    reportParityFault: (input: { objectId: string; sliceIndex: number; volumeId: number | null }) => void;
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
    isVolumeDraining: (volumeId: number | null) => {
        if (volumeId === null)
            return false;
        // Lazy require so this module doesn't pull the io manager graph at import for consumers/tests.
        const { ioManager } = require('../io/manager') as typeof import('../io/manager');
        return ioManager.getVolume(volumeId)?.isDraining === true;
    },
    verifyParity: config.verifyParity,
    verifyObjectParity: async (object: FileObject) => {
        const { FileObjectReader } = require('../io/file-object/reader') as typeof import('../io/file-object/reader');
        const reader = new FileObjectReader(object);
        const mismatched = new Set<number>();
        try {
            await reader.prepare();
            for (let result; (result = await reader.verifyChunkSetParity()) !== null; )
                result.mismatched.forEach(index => mismatched.add(index));
        }
        finally { await reader.close().catch(() => undefined); }
        return [...mismatched];
    },
    reportParityFault: (input) => {
        const { remediationService } = require('../remediation/service') as typeof import('../remediation/service');
        remediationService.reportSliceFault({
            objectId: input.objectId, sliceIndex: input.sliceIndex, volumeId: input.volumeId,
            source: 'verify', code: 'EPARITY', message: 'stored parity does not match recomputed parity (foreign/stale)', isChecksum: false
        });
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
        let drainingSkipped = false;

        const tasks: Promise<void>[] = [];
        for (let sliceIndex = 0; sliceIndex < totalSlices; sliceIndex++) {
            const sliceVolumeId = sliceIndex < record.dataVolumes.length
                ? record.dataVolumes[sliceIndex] ?? null
                : record.parityVolumes[sliceIndex - record.dataVolumes.length] ?? null;
            if (this.deps.isVolumeDraining(sliceVolumeId)) {
                this.log('skipping slice %d of object %s: volume %s is draining', sliceIndex, record.id, sliceVolumeId);
                // Still mark it verified-now so lastVerifiedAt (the min across slices) advances and the
                // object doesn't churn to the front of the scrub queue for the whole drain; the slice
                // is re-verified on its new volume after the drain relocates it.
                sliceResults[String(sliceIndex)] = { ok: true, type: sliceIndex < record.dataVolumes.length ? 'data' : 'parity', volumeId: sliceVolumeId };
                drainingSkipped = true;
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

        // Parity verification: recompute the correct parity from the data and compare to what's stored.
        // Only when the data verified clean and nothing was drain-skipped -- recomputing needs
        // authoritative data. A foreign parity slice passes the per-chunk checks above but fails here, so
        // flag it and fault it -> the repair worker re-verifies (this same check) and recomputes the
        // correct parity in place.
        if (this.deps.verifyParity && mode === 'full' && !drainingSkipped && Object.keys(sliceErrors).length === 0) {
            let mismatched: number[] = [];
            try { mismatched = await this.deps.verifyObjectParity(object); }
            catch (err) { this.log('parity verify errored for %s: %s', record.id, err instanceof Error ? err.message : String(err)); }
            for (const sliceIndex of mismatched) {
                const key = String(sliceIndex);
                const volumeId = record.parityVolumes[sliceIndex - record.dataVolumes.length] ?? null;
                this.log('object %s parity slice %d is FOREIGN (recomputed != stored)', record.id, sliceIndex);
                sliceResults[key] = { ok: false, type: 'parity', volumeId, error: 'parity-mismatch' };
                sliceErrors[key] = { code: 'EPARITY', category: 'parity-mismatch', err: 'stored parity does not match recomputed value', type: 'parity' };
                this.deps.reportParityFault({ objectId: record.id, sliceIndex, volumeId });
            }
        }

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
            // Our own shutdown cancelled the read -- we learned nothing about this slice. Abort the
            // whole verify (matching verify-volumes-job) so the caller sees a clear error and we
            // persist NO verification state: recording it would flag a healthy slice permanently.
            if (isIOAbort(err))
                throw err;
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
