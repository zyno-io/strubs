import { createLogger } from '../../log';
import type { FileObject } from '../file-object';
import { remediationService } from '../../remediation/service';
import type { RepairBlockDetails } from '../../remediation/fault';
import { Base } from './base';

// After this many fresh read faults on one slice within a single read, stop
// re-attempting it and reconstruct it from parity for the rest of the read
// ("reconstruct the whole slice"). Below the threshold each fault is repaired
// for just that chunk set ("reconstruct that part") and the slice is retried.
const ESCALATE_THRESHOLD = 2;
// Codes that mean the slice is unusable for the rest of this read — escalate
// immediately rather than re-probing a dead handle every chunk set. EHEADER
// (mis-attributed header), EUNAVAIL (volume offline) and ENOENT (slice file
// gone) can never succeed on retry, so they are hard faults too.
const HARD_FAULT_CODES = new Set(['EOPEN', 'ETIMEOUT', 'EHEADER', 'EUNAVAIL', 'ENOENT']);

export class FileObjectReader extends Base {
    private logger: ReturnType<typeof createLogger>;

    private _hasReadSegment = false;
    private _startOffset = 0;
    private _endOffset = 0;
    private _lastReadLogTimestamp = 0;

    private _openSliceIdxs: number[] = [];
    private _availableParityIdxs: number[] = [];
    private readonly _failedSlices = new Set<number>();
    private readonly _faultCounts = new Map<number, number>();
    private _currentChunkSetIndex = 0;

    constructor(fileObject: FileObject) {
        super(fileObject);
        this.logger = this.buildLogger();
    }

    onRequestContextChanged(): void {
        this.logger = this.buildLogger();
    }

    private buildLogger(): ReturnType<typeof createLogger> {
        const prefix = `${this.fileObject.getLoggerPrefix()}:reader`;
        return createLogger(prefix);
    }

    async prepare(): Promise<void> {
        this._configureInternals();
        this._configureStartState();
        await this._instantiateSlices();

        this._startOffset = 0;
        this._endOffset = this.size;

        // A slice that is already known bad (volume offline or marked
        // damaged/unavailable) starts out failed and is reconstructed from the
        // outset — no fresh fault is raised for it. Parity is recorded as
        // available but only opened lazily, when reconstruction needs it.
        const dataCandidates: number[] = [];
        for (let index = 0; index < this.dataSliceCount; index++) {
            if (this._slices[index].isAvailable())
                dataCandidates.push(index);
            else
                this._failedSlices.add(index);
        }
        for (let index = this.dataSliceCount; index < this._totalSliceCount; index++) {
            if (this._slices[index].isAvailable())
                this._availableParityIdxs.push(index);
            else
                this._failedSlices.add(index);
        }

        if (dataCandidates.length + this._availableParityIdxs.length < this.dataSliceCount)
            throw this._quorumError();

        // Open the data slices. Open failures become slice faults and fall back
        // to parity reconstruction.
        const openResults = await Promise.allSettled(dataCandidates.map(index => this._slices[index].open()));
        openResults.forEach((result, position) => {
            const index = dataCandidates[position];
            if (result.status === 'fulfilled') {
                this._openSliceIdxs.push(index);
                return;
            }
            if (this.isIOAbortError(result.reason))
                throw result.reason;
            this.handleSliceFault(index, result.reason);
            this._failedSlices.add(index);
        });

        if (this._openSliceIdxs.length + this._availableParityIdxs.length < this.dataSliceCount)
            throw this._quorumError();

        this._currentChunkSetIndex = 0;
    }

    private _quorumError(sources?: Set<number>): Error {
        const err = new Error('insufficient slices available to reconstruct file') as Error & { code?: string; repairDetails?: RepairBlockDetails };
        err.code = 'EQUORUM';
        err.repairDetails = this._quorumDetails(sources);
        return err;
    }

    private async ensureSliceOpen(index: number): Promise<void> {
        if (this._openSliceIdxs.includes(index))
            return;
        await this._slices[index].open();
        this._openSliceIdxs.push(index);
    }

    setReadRange(start: number, end: number): void {
        this._hasReadSegment = false;
        this._startOffset = start;
        this._endOffset = end;

        let chunkSetIndex: number;

        if (this._startOffset < this._standardChunkSetOffset) {
            chunkSetIndex = 0;
            this._dataOffset = 0;
            this._configureStartState();
        }
        else {
            const offsetWithinStandardChunkSet = this._startOffset - this._standardChunkSetOffset;
            const standardChunkSetCount = Math.floor(offsetWithinStandardChunkSet / this._standardChunkSetDataSize);
            this._dataOffset = this._standardChunkSetOffset + standardChunkSetCount * this._standardChunkSetDataSize;
            chunkSetIndex = 1 + standardChunkSetCount;

            if (this._startOffset < this._endChunkSetDataOffset)
                this._configureMiddleState();
            else
                this._configureEndState();
        }

        this._currentChunkSetIndex = chunkSetIndex;
        for (const index of this._openSliceIdxs)
            this._slices[index].seekToChunkIndex(chunkSetIndex);
    }

    async readChunk(): Promise<Buffer | null> {
        if (this._hasReadSegment)
            return null;
        if (this._startOffset >= this._endOffset || this._dataOffset >= this._endOffset) {
            this._hasReadSegment = true;
            return null;
        }

        const readOffset = this._dataOffset;
        this._logReadProgress(readOffset);
        let data = await this._readNextChunkSet();

        if (this._startOffset > readOffset) {
            if (this._dataOffset < this._startOffset)
                throw new Error('reader not properly aligned to start chunk');
            data = data.slice(this._startOffset - readOffset);
        }

        if (this._dataOffset >= this._endOffset) {
            if (this._dataOffset > this._endOffset) {
                const overageByteCount = this._dataOffset - this._endOffset;
                data = data.slice(0, data.length - overageByteCount);
            }
            this._hasReadSegment = true;
        }

        return Buffer.from(data);
    }

    // Reads one chunk set (one chunk per slice at the current chunk index),
    // tolerating per-slice faults: surviving data chunks are used directly, and
    // missing/failed data chunks are reconstructed from parity. A read only
    // fails when fewer than dataSliceCount sources can be assembled (genuine
    // loss of redundancy).
    private async _readNextChunkSet(): Promise<Buffer> {
        const filled = await this._assembleDataRegion(false);
        const data = Buffer.from(filled.slice(0, this._chunkSetDataSize));
        this._advanceChunkSet();
        return data;
    }

    // Fills the data region of the chunk-set buffer for the current chunk index.
    // For a normal read (fullRegion=false) only the data slices overlapping the
    // requested byte range are required: if those are all readable we return
    // immediately without touching unrelated slices or parity (so a range read
    // of healthy bytes never fails because some other slice is dead). Only when
    // a *needed* slice is missing do we read the rest and reconstruct from
    // parity. fullRegion=true (repair) assembles every data slice. Does not
    // advance the read position.
    private async _assembleDataRegion(fullRegion: boolean): Promise<Buffer> {
        const buffer = this._chunkSetBuffer;
        if (!buffer)
            throw new Error('chunk set buffer not initialized');

        const chunkIndex = this._currentChunkSetIndex;
        const chunkDataSize = this._chunkDataSize;
        const sources = new Set<number>();
        const tried = new Set<number>();

        // 1) Attempt the data slices the caller actually needs.
        const needed: number[] = [];
        for (let index = 0; index < this.dataSliceCount; index++) {
            if (fullRegion || this._sliceOverlapsRange(index, chunkDataSize))
                needed.push(index);
        }
        let missingNeeded = false;
        const neededAttempts = needed.filter(index => !this._failedSlices.has(index));
        for (const index of needed)
            if (this._failedSlices.has(index))
                missingNeeded = true;
        const results = await Promise.allSettled(neededAttempts.map(index => this._readSliceChunk(index, chunkIndex)));
        results.forEach((result, position) => {
            const index = neededAttempts[position];
            tried.add(index);
            if (result.status === 'fulfilled') {
                result.value.copy(buffer, index * chunkDataSize);
                sources.add(index);
                return;
            }
            if (this.isIOAbortError(result.reason))
                throw result.reason;
            this.handleSliceFault(index, result.reason);
            missingNeeded = true;
        });

        // 2) If every needed data slice is present, we're done.
        if (!missingNeeded)
            return buffer;

        // 3) A needed slice is missing → reconstruct. Read the remaining data
        // slices we haven't tried, then parity, until we have a full set of
        // dataSliceCount sources.
        const remaining: number[] = [];
        for (let index = 0; index < this.dataSliceCount; index++) {
            if (sources.has(index) || tried.has(index) || this._failedSlices.has(index))
                continue;
            remaining.push(index);
        }
        const remainingResults = await Promise.allSettled(remaining.map(index => this._readSliceChunk(index, chunkIndex)));
        remainingResults.forEach((result, position) => {
            const index = remaining[position];
            if (result.status === 'fulfilled') {
                result.value.copy(buffer, index * chunkDataSize);
                sources.add(index);
                return;
            }
            if (this.isIOAbortError(result.reason))
                throw result.reason;
            this.handleSliceFault(index, result.reason);
        });

        for (const index of this._availableParityIdxs) {
            if (sources.size >= this.dataSliceCount)
                break;
            if (this._failedSlices.has(index))
                continue;
            try {
                await this.ensureSliceOpen(index);
                const chunk = await this._readSliceChunk(index, chunkIndex);
                chunk.copy(buffer, index * chunkDataSize);
                sources.add(index);
            }
            catch (err) {
                if (this.isIOAbortError(err))
                    throw err;
                this.handleSliceFault(index, err);
            }
        }

        if (sources.size < this.dataSliceCount)
            throw this._quorumError(sources);

        // Targets are the data slices we could not read directly.
        const targets: number[] = [];
        for (let index = 0; index < this.dataSliceCount; index++)
            if (!sources.has(index))
                targets.push(index);

        this._rsSourcesBits = Array.from(sources).reduce((bits, index) => bits | (1 << index), 0);
        this._rsTargetsBits = targets.reduce((bits, index) => bits | (1 << index), 0);
        await this._computeParity();

        return buffer;
    }

    private _sliceOverlapsRange(sliceIndex: number, chunkDataSize: number): boolean {
        const sliceStart = this._dataOffset + sliceIndex * chunkDataSize;
        const sliceEnd = sliceStart + chunkDataSize;
        return sliceStart < this._endOffset && sliceEnd > this._startOffset;
    }

    private _advanceChunkSet(): void {
        this._dataOffset += this._chunkSetDataSize;
        this._currentChunkSetIndex += 1;
        if (this._dataOffset === this._nextChunkGroupOffset)
            this._configureNextChunkGroup();
    }

    // Repair hook: reconstruct the FULL chunk set (all data and all parity
    // chunks) for the current position and return a snapshot plus chunk size,
    // so a single slice can be rebuilt byte-for-byte. Returns null at EOF.
    async reconstructFullChunkSet(): Promise<{ buffer: Buffer; chunkDataSize: number } | null> {
        if (this.hasReachedEOF)
            return null;
        const chunkDataSize = this._chunkDataSize;
        const buffer = await this._assembleDataRegion(true);
        // Recompute every parity chunk from the now-complete data region.
        this._rsSourcesBits = this.dataIndices().reduce((bits, index) => bits | (1 << index), 0);
        this._rsTargetsBits = this.parityIndices().reduce((bits, index) => bits | (1 << index), 0);
        await this._computeParity();
        const snapshot = Buffer.from(buffer.slice(0, this._totalSliceCount * chunkDataSize));
        this._advanceChunkSet();
        return { buffer: snapshot, chunkDataSize };
    }

    private dataIndices(): number[] {
        return Array.from({ length: this.dataSliceCount }, (_unused, index) => index);
    }

    private parityIndices(): number[] {
        return Array.from({ length: this.paritySliceCount }, (_unused, index) => this.dataSliceCount + index);
    }

    private async _readSliceChunk(index: number, chunkIndex: number): Promise<Buffer> {
        const slice = this._slices[index];
        slice.seekToChunkIndex(chunkIndex);
        return slice.readChunk();
    }

    private handleSliceFault(index: number, err: unknown): void {
        const errorObj = err as { code?: string; message?: string } | undefined;
        const code = errorObj?.code;
        const volumeId = this.volumeIdForSlice(index);

        try {
            remediationService.reportSliceFault({
                objectId: this.fileObject.id ?? 'unknown',
                sliceIndex: index,
                volumeId,
                source: 'read',
                code,
                message: errorObj?.message,
                isChecksum: code === 'ECHECKSUM'
            });
        }
        catch {
            // reporting must never break a read
        }

        const count = (this._faultCounts.get(index) ?? 0) + 1;
        this._faultCounts.set(index, count);

        const hard = code !== undefined && HARD_FAULT_CODES.has(code);
        if (hard || count >= ESCALATE_THRESHOLD) {
            this._failedSlices.add(index);
            this.logger('slice %d escalated to full reconstruction after %d fault(s)', index, count);
        }
        else {
            this.logger('reconstructing slice %d for this chunk set (fault %d)', index, count);
        }
    }

    private volumeIdForSlice(index: number): number | null {
        if (index < this.dataSliceCount)
            return this.dataSliceVolumeIds[index] ?? null;
        return this.paritySliceVolumeIds[index - this.dataSliceCount] ?? null;
    }

    private _quorumDetails(sources?: Set<number>): RepairBlockDetails {
        const allSliceIndexes = Array.from({ length: this._totalSliceCount }, (_unused, index) => index);
        const availableSliceIndexes = sources
            ? Array.from(sources).sort((a, b) => a - b)
            : allSliceIndexes.filter(index => !this._failedSlices.has(index));
        const available = new Set(availableSliceIndexes);
        const missingSliceIndexes = allSliceIndexes.filter(index => !available.has(index));
        const failedSliceIndexes = Array.from(this._failedSlices).sort((a, b) => a - b);

        return {
            requiredSlices: this.dataSliceCount,
            availableSlices: availableSliceIndexes.length,
            totalSlices: this._totalSliceCount,
            chunkIndex: this._currentChunkSetIndex,
            availableSliceIndexes,
            missingSliceIndexes,
            failedSliceIndexes,
            missingVolumeIds: this.uniqueVolumeIds(missingSliceIndexes),
            failedVolumeIds: this.uniqueVolumeIds(failedSliceIndexes)
        };
    }

    private uniqueVolumeIds(sliceIndexes: number[]): number[] {
        const volumeIds = new Set<number>();
        for (const index of sliceIndexes) {
            const volumeId = this.volumeIdForSlice(index);
            if (volumeId !== null)
                volumeIds.add(volumeId);
        }
        return Array.from(volumeIds).sort((a, b) => a - b);
    }

    private isIOAbortError(err: unknown): boolean {
        return (err as { code?: string } | undefined)?.code === 'IOABORT';
    }

    get hasReachedEOF(): boolean {
        return this._dataOffset >= this.size;
    }

    async close(): Promise<void> {
        this.logger('closing slices');
        this._hasReadSegment = true;
        await this._closeSlices();
    }

    private async _closeSlices(): Promise<void> {
        const closePromises = this._openSliceIdxs.map(index => this._slices[index].close());
        try {
            await Promise.all(closePromises);
        }
        catch (err) {
            this.logger.error('slice encountered error during close', err);
        }
    }

    private _logReadProgress(offset: number): void {
        const now = Date.now();
        if (now - this._lastReadLogTimestamp < 2000)
            return;

        this._lastReadLogTimestamp = now;
        const total = this.size;
        const bytesRead = Math.min(offset, total);
        this.logger('read %d bytes (cur offset: %d)', bytesRead, offset);
    }
}
