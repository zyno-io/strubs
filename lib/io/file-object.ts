import { Duplex } from 'stream';

import { database } from '../database';
import type { ContentDocument, SliceErrorInfo, SliceVerificationTimes } from '../database';
import { createLogger } from '../log';
import { storageStatsTracker } from '../storage/stats-tracker';

import { generateObjectId } from './helpers';
import { journal } from './journal';
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
    // AWAITED, unlike recordObjectCreated/Deleted below. Those are synchronous fire-and-forget hooks used
    // for storage stats, and they fire AFTER the Mongo write -- too late to guarantee anything, and a void
    // callback cannot be awaited for durability. The journal needs its own calls, in their own positions.
    journalPut: (record: StoredObjectRecord) => Promise<void>;
    journalDelete: (id: string) => Promise<void>;
    recordObjectCreated: (record: StoredObjectRecord) => void;
    recordObjectDeleted: (record: StoredObjectRecord) => void;
    createLogger: typeof createLogger;
};

const defaultDeps: FileObjectDependencies = {
    generateObjectId,
    generatePlan: (size: number) => Promise.resolve(planner.generatePlan(size)),
    createObjectRecord: record => database.createObjectRecord(record),
    deleteObjectById: id => database.deleteObjectById(id),
    journalPut: record => journal.append({
        op: 'put',
        ts: new Date().toISOString(),
        id: record.id,
        cid: record.containerId ?? null,
        name: record.name,
        mime: record.mime ?? null,
        md5: record.md5 ? record.md5.toString('hex') : null,
        size: record.size,
        cs: record.chunkSize,
        // Diagnostic hint ONLY. A restore must never trust these: drain and rebalance relocate slices
        // without journaling, so a recorded placement can predate the very move that invalidated it --
        // and rebalance deletes the source. Placement is always re-derived by scanning the disks.
        dv: record.dataVolumes,
        pv: record.parityVolumes
    }),
    journalDelete: id => journal.append({ op: 'del', ts: new Date().toISOString(), id }),
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
    // True once this object's `put` record is durable in the journal. Distinct from _isPersisted, which
    // only becomes true after the Mongo insert -- and the window between the two is exactly where a
    // half-failed create can leave a journal `put` with no object behind it. See delete().
    private _journaledPut = false;
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

        // ORDER: slices committed -> JOURNAL (fsynced) -> Mongo insert.
        //
        // A crash between the journal and Mongo leaves the object on disk AND in the journal but not in
        // Mongo -- the rebuild finds it, fully named. The reverse order would leave it in Mongo but not
        // the journal, so a snapshot+journal restore would miss it entirely and it would degrade to a
        // nameless orphan. Journal first. This is an AWAITED call for that reason: the existing
        // recordObjectCreated hook is a synchronous fire-and-forget that runs after the insert, i.e. too
        // late to guarantee anything, which is why it cannot be reused here.
        await this.deps.journalPut(dbObject);
        this._journaledPut = true;

        await this.deps.createObjectRecord(dbObject);

        // The row EXISTS the moment that returns, so say so BEFORE anything else can throw. Setting this
        // after the hook below leaves a window where a failure runs the cleanup path with _isPersisted
        // still false -- and that path unlinks the slices but skips deleteObjectById(), leaving a Mongo row
        // pointing at nothing. That is a PHANTOM: it reads as data loss, which is the one outcome the whole
        // ordering exists to avoid. (An orphan we can recover; a phantom just lies.)
        this._isPersisted = true;

        this.deps.recordObjectCreated(dbObject);
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

        // ORDER: JOURNAL (fsynced) -> unlink slices -> Mongo delete.
        //
        // A crash after journaling but before unlinking leaves slices with no record: an ORPHAN, which
        // lands in lost+found and is recoverable. The reverse leaves a record with no slices: a PHANTOM,
        // which reads as data loss and will alarm you about an object that was deliberately deleted.
        // Orphans are strictly better than phantoms, so the journal goes first -- before the destroyer,
        // which is what actually unlinks the slice files.
        //
        // We journal a delete if the object is persisted OR if we already journaled its PUT. That second
        // case is the subtle one: commit() journals before the Mongo insert, so if the insert then throws,
        // the PUT is durable in the journal while `_isPersisted` is still false. The cleanup path would
        // treat that as a mere aborted upload, unlink the slices, and journal nothing -- leaving a `put`
        // record for an object with no slices and no row. A replay would faithfully restore a PHANTOM.
        // So the compensating `del` is what makes the journal honest about a half-failed create.
        //
        // A genuinely aborted upload -- one that never reached the journal -- is not a namespace change
        // and is still not journaled. There is nothing for a restore to know about.
        if (this.id && (this._isPersisted || this._journaledPut))
            await this.deps.journalDelete(this.id);

        // ...and the Mongo row comes out BEFORE the slices, for the same reason in miniature. Unlink first
        // and a failure in the delete below strands a row pointing at slices that are already gone -- a
        // LIVE phantom, which reads as data loss for an object the user deliberately deleted. This way
        // round, a failure strands slices with no row: an orphan, which is inert, recoverable, and already
        // journaled as deleted so no replay will resurrect it. Orphans beat phantoms, all the way down.
        if (this._isPersisted && this.id) {
            const deletedRecord = this.toStoredObjectRecord();
            try {
                await this.deps.deleteObjectById(this.id);
            }
            catch (err) {
                // The `del` is already durable, but the row is still there and the slices have not been
                // touched: the object is still LIVE, and the caller is about to be told the delete FAILED.
                // Left like this the journal's last word on the object is "deleted" -- so a rebuild from the
                // platters would honour it and drop the name of an object that still exists, quietly turning
                // it into a nameless orphan. Put the name back. The journal has to agree with reality, and
                // reality is that this object is still here.
                await this.deps.journalPut(deletedRecord).catch(compensationErr =>
                    this.logger.error('JOURNAL INCONSISTENT: object %s is journaled as DELETED but its Mongo delete '
                        + 'failed AND the compensating put could not be written (%s). A rebuild from the platters '
                        + 'would lose its name.', this.id, compensationErr));
                throw err;
            }
            this.deps.recordObjectDeleted(deletedRecord);
        }

        if (this._mode === 'write' && this._writer) {
            await this._writer.abort();
        }
        else {
            const destroyer = new FileObjectDestroyer(this);
            await destroyer.destroy();
        }

        this._mode = null;
        this._isPersisted = false;
        this._journaledPut = false;

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
