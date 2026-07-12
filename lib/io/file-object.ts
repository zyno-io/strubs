import { Duplex } from 'stream';

import { database } from '../database';
import type { ContentDocument, SliceErrorInfo, SliceVerificationTimes } from '../database';
import { createLogger } from '../log';
import { storageStatsTracker } from '../storage/stats-tracker';

import { generateObjectId } from './helpers';
import { planner } from './planner';
import { Plan } from './plan';

import { FileObjectWriter } from './file-object/writer';
import { FileObjectReader } from './file-object/reader';
import { FileObjectDestroyer } from './file-object/destroyer';
import type { VolumePriority } from './volume-priority-manager';

type FileObjectMode = 'write' | 'read' | null;

type ResolveablePromise = Promise<void> & { resolve: () => void };

export interface StoredObjectRecord extends ContentDocument {
    id: string;
    containerId?: string | null;
    bucketId?: string | null;
    isFile: boolean;
    name: string;
    size: number;
    md5: Buffer | null;
    mime?: string | null;
    chunkSize: number;
    sliceSize?: number;
    dataVolumes: number[];
    parityVolumes: number[];
    unavailableSlices?: number[];
    damagedSlices?: number[];
    sliceErrors?: Record<string, SliceErrorInfo>;
    sliceVerificationTimes?: SliceVerificationTimes;
    lastVerifiedAt?: Date | null;
}

// TODO: make sure data is actually flushed to disk on _finish
type PlanResult = Awaited<ReturnType<typeof planner.generatePlan>>;

export type FileObjectDependencies = {
    generateObjectId: () => Buffer;
    generatePlan: (size: number) => Promise<Plan>;
    createObjectRecord: (record: StoredObjectRecord) => Promise<void>;
    deleteObjectById: (id: string) => Promise<void>;
    recordObjectCreated: (record: StoredObjectRecord) => void;
    recordObjectDeleted: (record: StoredObjectRecord) => void;
    createLogger: typeof createLogger;
};

const defaultDeps: FileObjectDependencies = {
    generateObjectId,
    generatePlan: (size: number) => Promise.resolve(planner.generatePlan(size)),
    createObjectRecord: record => database.createObjectRecord(record),
    deleteObjectById: id => database.deleteObjectById(id),
    recordObjectCreated: record => storageStatsTracker.recordCreated(record),
    recordObjectDeleted: record => storageStatsTracker.recordDeleted(record),
    createLogger
};

// Mongo returns md5 as a BSON Binary (has a .buffer Buffer); the writer produces a real Buffer. Normalize
// either to a Buffer so Buffer.equals() in the md5 gate works.
function toBuffer(value: unknown): Buffer | null {
    if (value == null)
        return null;
    if (Buffer.isBuffer(value))
        return value;
    const inner = (value as { buffer?: unknown }).buffer;
    if (Buffer.isBuffer(inner))
        return inner;
    return Buffer.from(value as Uint8Array);
}

export class FileObject extends Duplex {
    id: string | null = null;
    idBuf: Buffer | null = null;
    containerId: string | null = null;
    bucketId: string | null = null;
    name: string | null = null;
    size = 0;
    mime: string | null = null;
    md5: Buffer | null = null;
    chunkSize = 0;
    dataSliceCount = 0;
    dataSliceVolumeIds: number[] = [];
    paritySliceCount = 0;
    paritySliceVolumeIds: number[] = [];
    unavailableSliceIdxs: number[] = [];

    private _mode: FileObjectMode = null;
    private _writer: FileObjectWriter | null = null;
    private _reader: FileObjectReader | null = null;

    private _isPersisted = false;
    private _lockPromises: ResolveablePromise[] = [];
    private _isAwaitingData = false;
    private _shouldTransmitEOR = false;
    private _hasVolumeReservations = false;

    private readonly deps: FileObjectDependencies;
    private logger: ReturnType<typeof createLogger>;
    plan: Plan | null = null;
    private _requestId: string | null = null;
    private _loggerPrefix = 'file:uninitialized';
    private _priority: VolumePriority = 'normal';

    constructor(deps?: Partial<FileObjectDependencies>) {
        super();
        this.deps = { ...defaultDeps, ...deps };
        this.logger = this.deps.createLogger(this._buildLoggerPrefix());
    }

    hasVolumeReservations(): boolean {
        return this._hasVolumeReservations;
    }

    async createWithSize(size: number): Promise<void> {
        this.idBuf = this.deps.generateObjectId();
        this.id = this.idBuf.toString('hex');
        this.size = size;

        this.logger = this.deps.createLogger(this._buildLoggerPrefix());

        const plan = await this.deps.generatePlan(size);
        this.plan = plan;
        this._hasVolumeReservations = true;

        if (!plan.chunkSize || !plan.dataSliceCount || !plan.paritySliceCount)
            throw new Error('plan is incomplete');

        this.chunkSize = plan.chunkSize;
        this.dataSliceCount = plan.dataSliceCount;
        this.dataSliceVolumeIds = plan.dataVolumes;
        this.paritySliceCount = plan.paritySliceCount;
        this.paritySliceVolumeIds = plan.parityVolumes;

        this.logger(
            'preparing to store %d byte object stored in %d byte chunks; data on volumes %s; parity on volumes %s',
            this.size,
            this.chunkSize,
            this.dataSliceVolumeIds.join(', '),
            this.paritySliceVolumeIds.join(', ')
        );

        this._writer = new FileObjectWriter(this);

        try {
        await this._writer.prepare();
        }
        catch (err) {
            this.logger.error('failed to create slices:', err);
            await this._writer.abort();
            throw new Error('failed to create file object');
        }

        this._mode = 'write';

        this.logger('ready to store');
    }

    async commit(): Promise<void> {
        if (this._mode !== 'write' || !this._writer || !this.id)
            throw new Error('file object is not in a writable state');

        await this._writer.commit();

        const dbObject: StoredObjectRecord = {
            id: this.id,
            containerId: this.containerId,
            bucketId: this.bucketId,
            isFile: true,
            name: this.name ?? '',
            size: this.size,
            md5: this.md5,
            mime: this.mime,
            chunkSize: this.chunkSize,
            sliceSize: this.plan?.sliceSize ?? undefined,
            dataVolumes: this.dataSliceVolumeIds,
            parityVolumes: this.paritySliceVolumeIds
        };

        if (!dbObject.mime)
            delete dbObject.mime;

        await this.deps.createObjectRecord(dbObject);
        this.deps.recordObjectCreated(dbObject);

        this._isPersisted = true;
        this._mode = null;

        this.logger('committed');
        this._hasVolumeReservations = false;
    }

    async loadFromRecord(record: StoredObjectRecord): Promise<void> {
        this._isPersisted = true;

        this.id = record.id;
        this.logger = this.deps.createLogger(this._buildLoggerPrefix());
        this.idBuf = Buffer.from(this.id, 'hex');
        this.size = record.size;
        this.containerId = record.containerId || null;
        this.bucketId = record.bucketId || null;
        this.name = record.name;
        // Mongo hands md5 back as a BSON Binary, not a Buffer; unwrap it so the whole-object md5 gate
        // (which calls Buffer.equals) works. Normal reads never compare it, so this was latent until
        // reconstruction (drain/repair) ran on real records.
        this.md5 = toBuffer(record.md5);
        this.mime = record.mime || null;
        this.chunkSize = record.chunkSize;
        this.dataSliceVolumeIds = record.dataVolumes;
        this.dataSliceCount = this.dataSliceVolumeIds.length;
        this.paritySliceVolumeIds = record.parityVolumes;
        this.paritySliceCount = this.paritySliceVolumeIds.length;
        this.unavailableSliceIdxs = [...(record.unavailableSlices ?? []), ...(record.damagedSlices ?? [])];
        const plan = new Plan();
        plan.fileSize = this.size;
        plan.chunkSize = this.chunkSize;
        plan.dataSliceCount = this.dataSliceCount;
        plan.paritySliceCount = this.paritySliceCount;
        plan.dataVolumes = this.dataSliceVolumeIds;
        plan.parityVolumes = this.paritySliceVolumeIds;
        plan.computeSliceSize();
        this.plan = plan;

        this.logger(
            'loaded %d byte object stored in %d byte chunks; data on volumes %s; parity on volumes %s',
            this.size,
            this.chunkSize,
            this.dataSliceVolumeIds.join(', '),
            this.paritySliceVolumeIds.join(', ')
        );
    }

    setRequestId(requestId: string | null): void {
        this._requestId = requestId ?? null;
        this.logger = this.deps.createLogger(this._buildLoggerPrefix());
        this._writer?.onRequestContextChanged?.();
        this._reader?.onRequestContextChanged?.();
    }

    getRequestId(): string | null {
        return this._requestId;
    }

    setPriority(priority: VolumePriority): void {
        this._priority = priority;
    }

    getPriority(): VolumePriority {
        return this._priority;
    }

    getLoggerPrefix(): string {
        return this._loggerPrefix;
    }

    private _buildLoggerPrefix(): string {
        const idPart = this.id ?? 'uninitialized';
        if (this._requestId)
            this._loggerPrefix = `${this._requestId}:file:${idPart}`;
        else
            this._loggerPrefix = `file:${idPart}`;
        return this._loggerPrefix;
    }

    async prepareForRead(): Promise<void> {
        this._reader = new FileObjectReader(this);

        try {
            await this._reader.prepare();
        }
        catch (err) {
            this.logger.error('failed to open slices:', err);
            throw new Error('failed to open file object');
        }

        this._mode = 'read';

        this.logger('ready to read');
    }

    setReadRange(start: number, end: number, shouldTransmitEOR?: boolean): void {
        if (this._mode !== 'read' || !this._reader)
            throw new Error('file object is not in a readable state');
        this._reader.setReadRange(start, end);
        this._shouldTransmitEOR = shouldTransmitEOR === true;
        if (this._isAwaitingData) void this._read();
    }

    async delete(): Promise<void> {
        this.logger('deleting object');

        if (this._mode === 'write' && this._writer) {
            await this._writer.abort();
        }
        else {
            const destroyer = new FileObjectDestroyer(this);
            await destroyer.destroy();
        }

        if (this._isPersisted && this.id) {
            const deletedRecord = this.toStoredObjectRecord();
            await this.deps.deleteObjectById(this.id);
            this.deps.recordObjectDeleted(deletedRecord);
        }

        this._mode = null;
        this._isPersisted = false;

        this.logger('deleted object');
        this._hasVolumeReservations = false;
    }

    private toStoredObjectRecord(): StoredObjectRecord {
        if (!this.id)
            throw new Error('file object has no id');
        return {
            id: this.id,
            containerId: this.containerId,
            bucketId: this.bucketId,
            isFile: true,
            name: this.name ?? '',
            size: this.size,
            md5: this.md5,
            mime: this.mime,
            chunkSize: this.chunkSize,
            sliceSize: this.plan?.sliceSize ?? undefined,
            dataVolumes: this.dataSliceVolumeIds,
            parityVolumes: this.paritySliceVolumeIds
        };
    }

    override async _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): Promise<void> {
        if (this._mode !== 'write' || !this._writer)
            return callback(new Error('file object is not in a writable state'));

        try {
            await this._writer.write(chunk);
            callback();
        }
        catch (err) {
            callback(err as Error);
        }
    }

    override async _final(callback: (error?: Error | null) => void): Promise<void> {
        if (this._mode !== 'write' || !this._writer)
            return callback(new Error('file object is not in a writable state'));

        try {
            await this._writer.finish();
            this.md5 = this._writer.md5;
            callback();
        }
        catch (err) {
            callback(err as Error);
        }
    }

    override async _read(): Promise<void> {
        if (this._mode !== 'read' || !this._reader)
            return void this.emit('error', new Error('file object is not in a readable state'));

        try {
            const buffer = await this._reader.readChunk();

            if (buffer === null) {
                if (this._shouldTransmitEOR === false) {
                    this._isAwaitingData = true;
                    return;
                }
                this.push(null);
            } else {
                this.push(buffer);
            }
            this._isAwaitingData = false;
        }
        catch (err) {
            this.emit('error', err as Error);
        }
    }

    async close(): Promise<void> {
        if (this._mode !== 'read' || !this._reader)
            throw new Error('file object is not in a readable state');

        super.destroy();
        await this._reader.close();

        this._reader = null;
        this._mode = null;
    }

    async acquireIOLock(): Promise<void> {
        const previousPromise = this._lockPromises[this._lockPromises.length - 1];
        let resolver: () => void = () => {};
        const newPromise = new Promise<void>(resolve => {
            resolver = resolve;
        }) as ResolveablePromise;
        newPromise.resolve = resolver;
        this._lockPromises.push(newPromise);
        if (previousPromise)
            await previousPromise;
    }

    releaseIOLock(): void {
        if (this._lockPromises.length === 0) return;
        const nextPromise = this._lockPromises.shift();
        nextPromise?.resolve();
    }
}
