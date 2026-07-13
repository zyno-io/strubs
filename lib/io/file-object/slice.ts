import type { FileHandle } from 'fs/promises';

import { hash } from '../../async-bridges/crypto-async';
import { constants, SLICE_MAGIC } from '../../constants';
import { createLogger } from '../../log';
import { ioManager } from '../manager';
import type { FileObject } from '../file-object';
import type { Volume } from '../volume';
import type { Base } from './base';
import { volumePriorityManager, type VolumePriority } from '../volume-priority-manager';
import { ioShutdown } from '../io-shutdown';

type SliceMode = 'write' | 'read' | null;

interface SliceChecksumError extends Error {
    code: string;
    objectId: string;
    sliceIndex: number;
    volumeId: number;
}

interface SliceErrorContext {
    code?: string;
    objectId?: string;
    sliceIndex?: number;
    volumeId?: number;
    fileName?: string;
}

export class Slice {
    private readonly fileObject: FileObject;
    private readonly ioClass: Base;
    private readonly sliceIndex: number;
    private readonly _volumeId: number;
    private readonly _volume: Volume;
    private readonly _fileName: string;
    private readonly _reservedBytes: number;
    private readonly _hasReservation: boolean;
    private readonly _priority: VolumePriority;
    private readonly log: ReturnType<typeof createLogger>;

    private _size = 0;
    private _mode: SliceMode = null;
    private _cursorOffset = 0;
    private _isPerformingIO = false;
    private _isCommitted = false;
    private _writeBuf: Buffer | null = null;
    private _readBuf: Buffer | null = null;
    private _hashBuf: Buffer | null = null;
    private _outputFh: FileHandle | null = null;
    private _inputFh: FileHandle | null = null;
    private _priorityRelease: (() => void) | null = null;

    constructor(fileObject: FileObject, ioClass: Base, sliceIndex: number) {
        if (!fileObject.id || !fileObject.idBuf)
            throw new Error('file object is not initialized');

        this.fileObject = fileObject;
        this.ioClass = ioClass;
        this.sliceIndex = sliceIndex;

        if (sliceIndex < this.fileObject.dataSliceCount)
            this._volumeId = this.fileObject.dataSliceVolumeIds[sliceIndex];
        else if (sliceIndex < this.fileObject.dataSliceCount + this.fileObject.paritySliceCount)
            this._volumeId = this.fileObject.paritySliceVolumeIds[sliceIndex - this.fileObject.dataSliceCount];
        else
            throw new Error('invalid slice index');

        const volume = ioManager.getVolume(this._volumeId);
        if (!volume)
            throw new Error(`volume ${this._volumeId} not found`);

        this._volume = volume;
        this._fileName = `${fileObject.id}.${sliceIndex}`;
        this._reservedBytes = this.fileObject.plan?.sliceSize ?? this.fileObject.chunkSize;
        this._hasReservation = this.fileObject.hasVolumeReservations();
        this._priority = this.fileObject.getPriority();
        this.log = createLogger(`${this.fileObject.getLoggerPrefix()}:slice-${sliceIndex}`);
    }

    async create(): Promise<void> {
        ioShutdown.throwIfAborted();
        const writeBuf = this._writeBuf = Buffer.allocUnsafe(this.fileObject.chunkSize);
        const idBuf = this.fileObject.idBuf;
        if (!idBuf)
            throw new Error('file object id buffer is not initialized');

        this._size = constants.FILE_HEADER_SIZE;
        this._cursorOffset = constants.FILE_HEADER_SIZE;
        this._isPerformingIO = true;

        try {
            this._outputFh = await this._volume.createTemporaryFh(this._fileName);

            // Check for shutdown after opening - if aborted, clean up the handle
            if (ioShutdown.isAborted()) {
                await this._cleanupOutputHandle();
                ioShutdown.throwIfAborted();
            }

            // The bytes that are actually on every platter in this array -- see SLICE_MAGIC. This used to be
            // spelled `writeBuf.write('\x01\xfb\x02\xfb', 0)`, which, through a UTF-8 encoding quirk, wrote
            // these exact four bytes while appearing to write four different ones. Same bytes, same file, same
            // format: the code just no longer says the opposite of what it does.
            /* 00-03 */ SLICE_MAGIC.copy(writeBuf, 0); // magic header
            /* 04-04 */ writeBuf.writeUInt8(1, 4); // version
            /* 05-06 */ writeBuf.writeUInt16LE(constants.FILE_HEADER_SIZE, 5); // header length
            /* 07-22 */ ; // header checksum (will populate after its computed)
            /* 23-34 */ idBuf.copy(writeBuf, 23, 0, 12); // file ID
            /* 35-39 */ writeBuf.writeIntLE(this.fileObject.size, 35, 5); // file size
            /* 40-40 */ writeBuf.writeUInt8(this.fileObject.dataSliceCount, 40); // data slice count
            /* 41-41 */ writeBuf.writeUInt8(this.fileObject.paritySliceCount, 41); // parity slice count
            /* 42-42 */ writeBuf.writeUInt8(this.sliceIndex, 42); // slice index
            /* 43-45 */ writeBuf.writeIntLE(this.fileObject.chunkSize, 43, 3); // chunk size
            /* 46-47 */ writeBuf.fill(0, 46); // end padding to make the header length a multiple of 8

            await hash('md5', writeBuf, 23, 25, writeBuf, 7);

            const outputFh = this._outputFh;
            if (!outputFh)
                throw new Error('output file handle is not initialized');

            this._registerPriorityHold();

            try {
                ioShutdown.throwIfAborted();
                await outputFh.write(writeBuf, 0, constants.FILE_HEADER_SIZE);
            } catch (err) {
                // Release priority hold on error to prevent deadlock
                this._releasePriorityHold();
                await this._cleanupOutputHandle();
                throw err;
            }
        }
        finally {
            this._isPerformingIO = false;
        }

        this._mode = 'write';
    }

    async writeChunk(data: Buffer): Promise<void> {
        ioShutdown.throwIfAborted();
        if (this._isPerformingIO)
            throw new Error('slice already writing');
        if (this._mode !== 'write')
            throw new Error('slice not opened for writing');
        if (!this._writeBuf || !this._outputFh)
            throw new Error('slice not prepared for writing');

        this._isPerformingIO = true;

        try {
            const writeBuf = this._writeBuf;
            const dataLen = data.length;
            const chunkLen = data.length + constants.CHUNK_HEADER_SIZE;

            data.copy(writeBuf, constants.CHUNK_HEADER_SIZE, 0, dataLen);
            await hash(constants.CHUNK_HEADER_ALGO, writeBuf, constants.CHUNK_HEADER_SIZE, dataLen, writeBuf, 0);
            ioShutdown.throwIfAborted();
            await this._outputFh.write(writeBuf, 0, chunkLen);

            this._size += chunkLen;
        }
        finally {
            this._isPerformingIO = false;
        }
    }

    isAvailable(): boolean {
        return this._volume.isReadable && !this.fileObject.unavailableSliceIdxs?.includes(this.sliceIndex);
    }

    async open(): Promise<void> {
        ioShutdown.throwIfAborted();
        this._readBuf = Buffer.allocUnsafe(this.fileObject.chunkSize);
        this._hashBuf = Buffer.allocUnsafe(constants.CHUNK_HEADER_SIZE);

        this._isPerformingIO = true;

        try {
            this._inputFh = await this._withTimeout(
                () => this._volume.openCommittedFh(this._fileName),
                30000,
                'open slice file',
                // If timeout occurs, close the orphaned file handle when it eventually opens
                fh => fh.close().catch(() => {})
            );

            // Check for shutdown after opening - if aborted, clean up the handle
            if (ioShutdown.isAborted()) {
                await this._cleanupInputHandle();
                ioShutdown.throwIfAborted();
            }

            const inputFh = this._inputFh;
            if (!inputFh)
                throw new Error('input file handle is not initialized');

            this._registerPriorityHold();

            try {
                await this._ensurePriorityWindow();
                const headerRead = await this._withTimeout(
                    () => inputFh.read(this._readBuf as Buffer, 0, constants.FILE_HEADER_SIZE),
                    30000,
                    'read slice header'
                );
                if (headerRead.bytesRead !== constants.FILE_HEADER_SIZE) {
                    const shortErr = new Error(`short read on slice header: ${headerRead.bytesRead}/${constants.FILE_HEADER_SIZE}`) as Error & { code?: string };
                    shortErr.code = 'EIO';
                    throw shortErr;
                }
                this._validateHeader(this._readBuf as Buffer);
            } catch (err) {
                // Release priority hold on error to prevent deadlock
                this._releasePriorityHold();
                await this._cleanupInputHandle();

                // Preserve the underlying reason in the message (so EHEADER vs a
                // genuine I/O fault is legible without opening the file) and keep
                // the source code: EHEADER (bad/foreign header), EIO (short/native
                // read), or EOPEN only when the cause carried no code of its own.
                const causeMessage = err instanceof Error ? err.message : String(err);
                const throwErr = new Error(`failed to read slice header: ${causeMessage}`) as Error & { cause?: unknown };
                throwErr.cause = err;
                const code = (err as { code?: string } | undefined)?.code ?? 'EOPEN';
                throw this._decorateError(throwErr, code);
            }

            this._cursorOffset = constants.FILE_HEADER_SIZE;
            this._mode = 'read';
            this._isCommitted = true;
        }
        catch (err) {
            // Covers raw openCommittedFh() rejections that bypass the inner
            // header-read catch; existing codes (ETIMEOUT/IOABORT/native) win.
            throw this._decorateError(err, 'EOPEN');
        }
        finally {
            this._isPerformingIO = false;
        }
    }

    seekToHead(): void {
        this._cursorOffset = constants.FILE_HEADER_SIZE;
    }

    seekToChunkIndex(chunkIndex: number): void {
        this._cursorOffset = constants.FILE_HEADER_SIZE;

        const headerChunkCount = chunkIndex > 0 ? 1 : 0;
        this._cursorOffset += headerChunkCount * (constants.CHUNK_HEADER_SIZE + this.ioClass._startChunkDataSize);

        const standardChunkCount = Math.max(0, chunkIndex - 1);
        this._cursorOffset += standardChunkCount * (constants.CHUNK_HEADER_SIZE + this.ioClass._standardChunkDataSize);
    }

    async readChunk(): Promise<Buffer> {
        ioShutdown.throwIfAborted();
        if (this._isPerformingIO)
            throw new Error('slice already reading');
        if (this._mode !== 'read')
            throw new Error('slice not opened for reading');
        if (!this._readBuf || !this._hashBuf || !this._inputFh)
            throw new Error('slice not prepared for reading');

        this._isPerformingIO = true;

        try {
            const readBuf = this._readBuf;
            const hashBuf = this._hashBuf;
            const readDataLen = this.ioClass._chunkDataSize;
            const readLen = constants.CHUNK_HEADER_SIZE + readDataLen;
            const inputFh = this._inputFh;
            if (!inputFh)
                throw new Error('input file handle is not initialized');

            await this._ensurePriorityWindow();
            const chunkRead = await this._withTimeout(
                () => inputFh.read(readBuf, 0, readLen, this._cursorOffset),
                30000,
                'read slice chunk'
            );
            // A short read would leave stale bytes from a prior chunk in the
            // reused buffer, which could pass the checksum and return wrong data
            // (and silently corrupt RS reconstruction). Treat it as an I/O error.
            if (chunkRead.bytesRead !== readLen)
                throw new Error(`short read on slice chunk: ${chunkRead.bytesRead}/${readLen}`);

            await hash(constants.CHUNK_HEADER_ALGO, readBuf, constants.CHUNK_HEADER_SIZE, readDataLen, hashBuf, 0);

            if (!readBuf.slice(0, constants.CHUNK_HEADER_SIZE).equals(hashBuf))
                this.throwChecksumError();

            this._cursorOffset += readLen;

            return readBuf.slice(constants.CHUNK_HEADER_SIZE, readLen);
        }
        catch (err) {
            throw this._decorateError(err, 'EIO');
        }
        finally {
            this._isPerformingIO = false;
        }
    }

    private async _withTimeout<T>(
        fn: () => Promise<T>,
        timeoutMs: number,
        context: string,
        cleanupOnTimeout?: (result: T) => Promise<void> | void
    ): Promise<T> {
        let timer: NodeJS.Timeout | null = null;
        let timedOut = false;
        const fnPromise = fn();

        try {
            const timeoutPromise = new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    const err = new Error(`slice ${context} timed out after ${timeoutMs}ms`) as Error & SliceErrorContext;
                    err.code = 'ETIMEOUT';
                    err.objectId = this.fileObject.id ?? undefined;
                    err.sliceIndex = this.sliceIndex;
                    err.volumeId = this._volumeId;
                    err.fileName = this._fileName;
                    reject(err);
                }, timeoutMs);
            });
            return await Promise.race([fnPromise, timeoutPromise]);
        }
        finally {
            if (timer)
                clearTimeout(timer);

            // If we timed out and there's a cleanup function, handle the orphaned result
            if (timedOut && cleanupOnTimeout) {
                fnPromise.then(
                    result => {
                        // Operation completed after timeout - clean up the result
                        try {
                            cleanupOnTimeout(result);
                        }
                        catch {
                            // Ignore cleanup errors
                        }
                    },
                    () => {
                        // Operation failed after timeout - nothing to clean up
                    }
                );
            }
        }
    }

    async skipChunk(): Promise<void> {
        this._cursorOffset += constants.CHUNK_HEADER_SIZE + this.ioClass._chunkDataSize;
    }

    async close(): Promise<void> {
        await this._waitForIdle('close');

        if (this._mode === null)
            throw new Error('slice is not open');

        this._isPerformingIO = true;

        try {
            if (this._mode === 'write' && this._outputFh) {
                await this._outputFh.sync();
                await this._outputFh.close();
                this._outputFh = null;
            }
            else if (this._mode === 'read' && this._inputFh) {
                await this._inputFh.close();
                this._inputFh = null;
            }

            this._releasePriorityHold();
            this._mode = null;
        }
        finally {
            this._isPerformingIO = false;
        }
    }

    async commit(): Promise<void> {
        if (this._isPerformingIO)
            throw new Error('slice busy');

        this._isPerformingIO = true;

        try {
            await this._volume.commitTemporaryFile(this._fileName);
            if (this._hasReservation)
                this._volume.applyCommittedBytes(this._reservedBytes, this._size, this.sliceIndex < this.fileObject.dataSliceCount ? 'data' : 'parity');

            this._isCommitted = true;
            this._mode = null;
        }
        finally {
            this._isPerformingIO = false;
        }
    }

    async delete(): Promise<void> {
        await this._waitForIdle('delete');

        if (this._mode === 'write' && this._outputFh) {
            await this._outputFh.close();
            this._outputFh = null;
        }

        this._isPerformingIO = true;

        try {
            const sliceType: 'data' | 'parity' = this.sliceIndex < this.fileObject.dataSliceCount ? 'data' : 'parity';

            if (this._isCommitted) {
                await this._volume.deleteCommittedFile(this._fileName);
                this._volume.releaseCommittedBytes(this._size, sliceType);
            }
            else {
                await this._volume.deleteTemporaryFile(this._fileName);
                if (this._hasReservation)
                    this._volume.releaseReservation(this._reservedBytes);
            }

            this._releasePriorityHold();
            this._mode = null;
        }
        finally {
            this._isPerformingIO = false;
        }
    }

    markAsCommitted(): void {
        this._isCommitted = true;
    }

    private _registerPriorityHold(): void {
        if (this._priorityRelease)
            return;
        this._priorityRelease = volumePriorityManager.registerHandle(this._volumeId, this._priority);
    }

    private async _cleanupOutputHandle(): Promise<void> {
        const outputFh = this._outputFh;
        if (!outputFh)
            return;
        this._outputFh = null;
        try {
            await outputFh.close();
        }
        catch {
            // ignore close errors to avoid masking original failure
        }
        try {
            await this._volume.deleteTemporaryFile(this._fileName);
        }
        catch {
            // ignore delete failures during cleanup
        }
    }

    private async _cleanupInputHandle(): Promise<void> {
        const inputFh = this._inputFh;
        if (!inputFh)
            return;
        this._inputFh = null;
        try {
            await inputFh.close();
        }
        catch {
            // ignore cleanup close errors
        }
    }

    private _releasePriorityHold(): void {
        if (!this._priorityRelease)
            return;
        const release = this._priorityRelease;
        this._priorityRelease = null;
        release();
    }

    private async _ensurePriorityWindow(): Promise<void> {
        await this._waitForPriorityWindow();
        ioShutdown.throwIfAborted();
    }

    private async _waitForPriorityWindow(): Promise<void> {
        const waitPromise = volumePriorityManager.waitForAccess(this._volumeId, this._priority);
        if (!waitPromise)
            return;
        if (ioShutdown.isAborted())
            ioShutdown.throwIfAborted();
        this.log('waiting for higher priority items');
        await waitPromise;
        ioShutdown.throwIfAborted();
    }

    private async _waitForIdle(context: string): Promise<void> {
        const maxWaitMs = 5000;
        const interval = 50;
        let waited = 0;
        while (this._isPerformingIO) {
            if (ioShutdown.isAborted())
                return;
            await new Promise(resolve => setTimeout(resolve, interval));
            waited += interval;
            if (waited >= maxWaitMs)
                throw new Error(`slice timeout waiting for idle during ${context}`);
        }
    }

    // Ensure every error leaving a slice carries enough context for the
    // remediation pipeline to attribute it to a specific object/slice/volume.
    // Existing fields are preserved; only missing fields (and a fallback code)
    // are filled in, so this is safe to apply more than once.
    private _decorateError(err: unknown, fallbackCode?: string): Error & SliceErrorContext {
        const error = (err instanceof Error ? err : new Error(String(err))) as Error & SliceErrorContext;
        if (error.objectId === undefined && this.fileObject.id)
            error.objectId = this.fileObject.id;
        if (error.sliceIndex === undefined)
            error.sliceIndex = this.sliceIndex;
        if (error.volumeId === undefined)
            error.volumeId = this._volumeId;
        if (error.fileName === undefined)
            error.fileName = this._fileName;
        if (error.code === undefined && fallbackCode !== undefined)
            error.code = fallbackCode;
        return error;
    }

    // Validate the on-disk slice header against this object/slice so a stale or
    // misplaced slice file can never be accepted as a (silently wrong) source
    // for reconstruction. Field offsets mirror create().
    private _validateHeader(buf: Buffer): void {
        // A header that opens fine but describes a different object/slice means the
        // on-disk bytes are intact yet mis-attributed (wrong object id, stale slice
        // placement, etc.). Tag these EHEADER so remediation can tell a recoverable
        // mis-stamp from a genuine read fault — they categorize very differently.
        const fail = (message: string): never => {
            const err = new Error(message) as Error & { code?: string };
            err.code = 'EHEADER';
            throw err;
        };
        const idBuf = this.fileObject.idBuf;
        if (!idBuf || !buf.subarray(23, 35).equals(idBuf))
            fail('slice header object id mismatch');
        if (buf.readUInt8(40) !== this.fileObject.dataSliceCount)
            fail('slice header data slice count mismatch');
        if (buf.readUInt8(41) !== this.fileObject.paritySliceCount)
            fail('slice header parity slice count mismatch');
        if (buf.readUInt8(42) !== this.sliceIndex)
            fail('slice header slice index mismatch');
        if (buf.readIntLE(43, 3) !== this.fileObject.chunkSize)
            fail('slice header chunk size mismatch');
    }

    private throwChecksumError(): never {
        const err = new Error('checksum mismatch at ' + this._fileName + ':' + this._cursorOffset) as SliceChecksumError;
        err.code = 'ECHECKSUM';
        if (!this.fileObject.id)
            throw new Error('file object is not initialized');
        err.objectId = this.fileObject.id;
        err.sliceIndex = this.sliceIndex;
        err.volumeId = this._volumeId;
        throw err;
    }
}
