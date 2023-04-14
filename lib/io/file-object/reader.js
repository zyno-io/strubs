const Log = require('../../log');

const Base = require('./base');

class FileObjectReader extends Base {
    constructor(fileObject) {
        super(fileObject);

        this._sliceReadPromises = {};
        this._sliceReadaheadBuffers = {};

        this._hasReadSegment = false;
        this._currentSliceIndex = 0;
        this._activeSliceIdxs = [];

        this._unavailableSliceIdxs = [];
        this._paritySliceIdxs = [];
        this._mustReconstructData = false;

        this._startOffset = null;
        this._endOffset = null;
    }

    async prepare() {
        this._configureInternals();
        this._configureStartState();
        this._instantiateSlices();

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

        let openPromises = [];
        this._activeSliceIdxs.forEach(index => {
            const slice = this._slices[index];
            openPromises.push(slice.open());
        });
        await Promise.all(openPromises);
    }

    _prepareReconstruction() {
        this.log('preparing for file reconstruction');

        for (let index = this.dataSliceCount; index < this._totalSliceCount; index++) {
            if (this._slices[index].isAvailable()) {
                this._activeSliceIdxs.push(index);
                this._paritySliceIdxs.push(index);
            }

            if (this._activeSliceIdxs.length == this.dataSliceCount) {
                break;
            }
        }

        if (this._slices.length < this.dataSliceCount) {
            throw new Error('insufficient slices available to reconstruct file');
        }

        this._rsSourcesBits = 0;
        for (let index of this._activeSliceIdxs)
            this._rsSourcesBits |= (1 << index);

        this._rsTargetsBits = 0;
        for (let index of this._unavailableSliceIdxs)
            this._rsTargetsBits |= (1 << index);
    }

    setReadRange(start, end) {
        this._hasReadSegment = false;
        this._startOffset = start;
        this._endOffset = end;

        let chunkSetIndex = null;

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

    async readChunk() {
        // console.log('*readChunk', this._dataOffset, this._hasReadSegment);
        if (this._hasReadSegment) return null;

        const readOffset = this._dataOffset;
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

    async _fetchNextChunk() {
        if (this._mustReconstructData === true) {
            return await this._reconstructNextChunkSet();
        } else {
            return await this._directlyReadNextChunk();
        }
    }

    async _directlyReadNextChunk() {
        let data = await this._slices[this._currentSliceIndex].readChunk();
        this._dataOffset += this._chunkDataSize;

        this._currentSliceIndex++;
        if (this._currentSliceIndex == this.dataSliceCount)
            this._currentSliceIndex = 0;

        if (this._dataOffset == this._nextChunkGroupOffset)
            this._configureNextChunkGroup();

        return data;
    }

    async _reconstructNextChunkSet() {
        let sliceReadPromises = [];
        this._activeSliceIdxs.forEach(sliceIdx => {
            sliceReadPromises.push(this._slices[sliceIdx].readChunk());
        });

        const chunkDatas = await Promise.all(sliceReadPromises);

        this._activeSliceIdxs.forEach((sliceIdx, dataIdx) => {
            const offset = sliceIdx * this._chunkDataSize;
            chunkDatas[dataIdx].copy(this._chunkSetBuffer, offset);
        });

        await this._computeParity();

        const data = this._chunkSetBuffer.slice(0, this._chunkSetDataSize);
        this._dataOffset += this._chunkSetDataSize;

        if (this._dataOffset == this._nextChunkGroupOffset) {
            this._configureNextChunkGroup();
        }

        return data;
    }

    get hasReachedEOF() {
        return this._dataOffset >= this.size;
    }

    async close() {
        this.log('closing slices');
        this._hasReadSegment = true;

        // TODO: this should wait until all read promises return instead of an arbitrary delay
        setTimeout(() => {
            this._closeSlices();
        }, 1000);
    }

    async _closeSlices() {
        let closePromises = [];
        this._activeSliceIdxs.forEach(index => {
            const slice = this._slices[index];
            closePromises.push(slice.close());
        });

        try {
            await Promise.all(closePromises);
        }
        catch (err) {
            this.log.error('slice encountered error during close', err);
        }
    }

    log() {
        this.log = Log('file:' + this.fileObject.id + ':reader');
        this.log.apply(this.log, arguments);
    }
}

module.exports = FileObjectReader;