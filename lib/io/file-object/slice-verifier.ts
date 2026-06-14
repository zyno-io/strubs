import type { FileObject } from '../file-object';
import { Base } from './base';
import { createLogger } from '../../log';
import { volumePriorityManager } from '../volume-priority-manager';
import { config } from '../../config';

type FileObjectSliceVerifierDeps = {
    readDelayMs: number;
    sleep: (ms: number) => Promise<void>;
};

const defaultDeps: FileObjectSliceVerifierDeps = {
    readDelayMs: config.verifyReadDelayMs,
    sleep: (ms: number) => new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    })
};

export class FileObjectSliceVerifier extends Base {
    private readonly deps: FileObjectSliceVerifierDeps;
    private prepared = false;
    private readonly logger: ReturnType<typeof createLogger>;
    private readonly readDelayMs: number;
    private lastLogTimestamp = 0;
    private totalVerifiedBytes = 0;

    constructor(fileObject: FileObject, deps?: Partial<FileObjectSliceVerifierDeps>) {
        super(fileObject);
        this.deps = { ...defaultDeps, ...deps };
        this.readDelayMs = this.normalizeDelayMs(this.deps.readDelayMs);
        this.logger = createLogger(`${this.fileObject.getLoggerPrefix()}:slice-verifier`);
    }

    async verifySlice(sliceIndex: number): Promise<void> {
        await this.prepare();
        const slice = this._slices[sliceIndex];
        if (!slice)
            throw new Error(`slice ${sliceIndex} not available`);

        const descriptor = this.describeSlice(sliceIndex);
        const volumeId = this.resolveVolumeId(sliceIndex);
        this.logger('verifying %s slice %s (volume %s)', descriptor.type, descriptor.key, volumeId ?? 'unknown');

        let opened = false;
        try {
            await this.waitForPriorityWindow(sliceIndex);
            await slice.open();
            opened = true;
            await this.verifyOpenSlice(sliceIndex, slice);
            this.logger('%s slice %s verified', descriptor.type, descriptor.key);
        }
        catch (err) {
            const enriched = err as Error & { sliceIndex?: number; volumeId?: number };
            if (typeof enriched.sliceIndex !== 'number')
                enriched.sliceIndex = sliceIndex;
            if (typeof enriched.volumeId !== 'number')
                enriched.volumeId = volumeId ?? undefined;
            throw err;
        }
        finally {
            if (opened) {
                try {
                    await slice.close();
                }
                catch {
                    // ignore close errors to preserve original failure
                }
            }
        }
    }

    private async prepare(): Promise<void> {
        if (this.prepared)
            return;
        this._configureInternals();
        await this._instantiateSlices();
        this.prepared = true;
    }

    private resolveVolumeId(sliceIndex: number): number | null {
        if (sliceIndex < this.dataSliceCount)
            return this.dataSliceVolumeIds[sliceIndex] ?? null;
        const parityIndex = sliceIndex - this.dataSliceCount;
        return this.paritySliceVolumeIds[parityIndex] ?? null;
    }

    private async waitForPriorityWindow(sliceIndex: number): Promise<void> {
        const volumeId = this.resolveVolumeId(sliceIndex);
        if (volumeId === null)
            return;
        const waitPromise = volumePriorityManager.waitForAccess(volumeId, this.fileObject.getPriority());
        if (waitPromise)
            await waitPromise;
    }

    private async verifyOpenSlice(sliceIndex: number, slice: (typeof this._slices)[number]): Promise<void> {
        if (this.fileObject.size === 0)
            return;

        const plan = this.fileObject.plan;
        if (!plan)
            throw new Error('plan is not configured');

        slice.seekToHead();
        let readCount = 0;
        const readNext = async () => {
            if (readCount > 0)
                await this.delayBetweenReads();
            await this.readAndTrack(sliceIndex, slice);
            readCount++;
        };

        this._configureStartState();
        await readNext();

        const standardChunkCount = plan.standardChunkCountPerSlice ?? 0;
        if (standardChunkCount > 0) {
            this._configureMiddleState();
            for (let index = 0; index < standardChunkCount; index++)
                await readNext();
        }

        const endChunkSize = plan.endChunkDataSize ?? 0;
        if (endChunkSize > 0) {
            this._configureEndState();
            await readNext();
        }
    }

    private async delayBetweenReads(): Promise<void> {
        if (this.readDelayMs <= 0)
            return;
        await this.deps.sleep(this.readDelayMs);
    }

    private async readAndTrack(sliceIndex: number, slice: (typeof this._slices)[number]): Promise<void> {
        const data = await slice.readChunk();
        this.totalVerifiedBytes += data.length;
        this.logProgress(sliceIndex);
    }

    private logProgress(sliceIndex: number): void {
        const now = Date.now();
        if (now - this.lastLogTimestamp < 2000)
            return;
        this.lastLogTimestamp = now;
        const total = this.totalVerifiedBytes;
        const descriptor = this.describeSlice(sliceIndex);
        this.logger('verified %d bytes (last %s slice: %s)', total, descriptor.type, descriptor.key);
    }

    private describeSlice(sliceIndex: number): { key: string; type: 'data' | 'parity' } {
        if (sliceIndex < this.dataSliceCount)
            return { key: String(sliceIndex), type: 'data' };
        return { key: String(sliceIndex), type: 'parity' };
    }

    private normalizeDelayMs(value: number): number {
        const normalized = Math.floor(value);
        return Number.isFinite(normalized) && normalized >= 0 ? normalized : 0;
    }
}
