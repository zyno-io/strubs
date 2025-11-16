import { createLogger } from '../../log';
import type { FileObject } from '../file-object';
import { Base } from './base';

export class FileObjectReader extends Base {
    private logger: ReturnType<typeof createLogger>;

    private _hasReadSegment = false;
    private _currentSliceIndex = 0;
    private _activeSliceIdxs: number[] = [];

    private _unavailableSliceIdxs: number[] = [];
    private _paritySliceIdxs: number[] = [];
    private _mustReconstructData = false;

    private _startOffset = 0;
    private _endOffset = 0;
    private _lastReadLogTimestamp = 0;

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

        for (let index = 0; index < this.dataSliceCount; index++) {
            if (this._slices[index].isAvailable()) {
                this._activeSliceIdxs.push(index);
            } else {
                this._mustReconstructData = true;
                this._unavailableSliceIdxs.push(index);
            }
        }

        if (this._mustReconstructData) {
            this._prepareReconstruction();
        }

        const openPromises = this._activeSliceIdxs.map(index => this._slices[index].open());
        await Promise.all(openPromises);
    }

    private _prepareReconstruction(): void {
        this.logger('preparing for file reconstruction');

        for (let index = this.dataSliceCount; index < this._totalSliceCount; index++) {
            if (this._slices[index].isAvailable()) {
                this._activeSliceIdxs.push(index);
                this._paritySliceIdxs.push(index);
            }

            if (this._activeSliceIdxs.length === this.dataSliceCount) {
                break;
            }
        }

        if (this._activeSliceIdxs.length < this.dataSliceCount) {
            throw new Error('insufficient slices available to reconstruct file');
        }

        this._rsSourcesBits = 0;
        for (let index of this._activeSliceIdxs)
            this._rsSourcesBits |= (1 << index);

        this._rsTargetsBits = 0;
        for (let index of this._unavailableSliceIdxs)
            this._rsTargetsBits |= (1 << index);
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

            if (this._startOffset < this._endChunkSetDataOffset) {
                this._configureMiddleState();
            } else {
                this._configureEndState();
            }
        }

        if (this._mustReconstructData === true) {
            this._currentSliceIndex = 0;
        } else {
            const startOffsetDiff = this._startOffset - this._dataOffset;
            this._currentSliceIndex = Math.floor(startOffsetDiff / this._chunkDataSize);
            this._dataOffset += this._chunkDataSize * this._currentSliceIndex;
        }

        this._slices.forEach((slice, index) => {
            if (index < this._currentSliceIndex)
                slice.seekToChunkIndex(chunkSetIndex + 1);
            else
                slice.seekToChunkIndex(chunkSetIndex);
        });
    }

    async readChunk(): Promise<Buffer | null> {
        if (this._hasReadSegment) return null;

        const readOffset = this._dataOffset;
        this._logReadProgress(readOffset);
        let data = await this._fetchNextChunk();

        if (this._startOffset > readOffset) {
            if (this._dataOffset < this._startOffset) {
                throw new Error('reader not properly aligned to start chunk');
            }

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

    private async _fetchNextChunk(): Promise<Buffer> {
        if (this._mustReconstructData === true) {
            return this._reconstructNextChunkSet();
        } else {
            return this._directlyReadNextChunk();
        }
    }

    private async _directlyReadNextChunk(): Promise<Buffer> {
        const data = await this._slices[this._currentSliceIndex].readChunk();
        this._dataOffset += this._chunkDataSize;

        this._currentSliceIndex++;
        if (this._currentSliceIndex === this.dataSliceCount)
            this._currentSliceIndex = 0;

        if (this._dataOffset === this._nextChunkGroupOffset)
            this._configureNextChunkGroup();

        return data;
    }

    private async _reconstructNextChunkSet(): Promise<Buffer> {
        const chunkSetBuffer = this._chunkSetBuffer;
        if (!chunkSetBuffer)
            throw new Error('chunk set buffer not initialized');

        const sliceReadPromises = this._activeSliceIdxs.map(sliceIdx => this._slices[sliceIdx].readChunk());

        const chunkDatas = await Promise.all(sliceReadPromises);

        this._activeSliceIdxs.forEach((sliceIdx, dataIdx) => {
            const offset = sliceIdx * this._chunkDataSize;
            chunkDatas[dataIdx].copy(chunkSetBuffer, offset);
        });

        await this._computeParity();

        const data = chunkSetBuffer.slice(0, this._chunkSetDataSize);
        this._dataOffset += this._chunkSetDataSize;

        if (this._dataOffset === this._nextChunkGroupOffset) {
            this._configureNextChunkGroup();
        }

        return data;
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
        const closePromises = this._activeSliceIdxs.map(index => this._slices[index].close());

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
