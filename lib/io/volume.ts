// TODO: async/await

import { EventEmitter } from 'events';
import diskusage from 'diskusage';
import * as fsp from 'fs/promises';
import type { FileHandle } from 'fs/promises';

import { createLogger } from '../log';
import { config } from '../config';
import { formatBytes, mount as mountVolume, unmount as unmountVolume } from './helpers';
import { buildVolumeIdentityBuffer } from './volume-identity';
import { ensureExtFilesystemHealthy } from './filesystem-check';
import type { CachedDevice, CachedPartition } from './device-discovery';

export type VolumeVerifyErrors = {
    checksum: number;
    total: number;
};

export interface VolumeConfig {
    id: number;
    uuid: string;
    enabled: boolean;
    healthy: boolean;
    read_only: boolean;
    disk_serial: string;
    partition_uuid: string;
    partition_size: number;
    data_size: number;
    parity_size?: number;
    verifyErrors?: VolumeVerifyErrors | null;
    label?: string | null;
    comment?: string | null;
    is_deleted?: boolean;
    is_draining?: boolean;
    state_updated_at?: Date | string | null;
    pending_sector_high_water?: number;
}

export type PersistedVolumeConfig = VolumeConfig & { is_deleted?: boolean };

export class Volume extends EventEmitter {
    public readonly id: number;
    public readonly uuid: string;
    public blockPath: string | null = null;
    public fsType: string | null = null;
    public mountPoint: string | null = null;
    public mountOptions: Record<string, string | number | boolean> | null = null;
    public isMounted = false;
    public isVerified = false;
    public isStarted = false;
    // Whether a matching device+partition was found in the latest discovery and bound to this volume.
    // Distinct from operator flags (enabled/deleted): a disk pulled or still enumerating leaves the
    // volume unbound. `isMissing` derives the operator-visible "the disk STRUBS expects is gone" state.
    public isPresent = false;
    public isEnabled: boolean;
    public isHealthy: boolean;
    public isReadOnly: boolean;
    public isDeleted: boolean;
    // Timestamp of the last operational STATE change (enabled/read-only/deleted/draining/healthy).
    public stateUpdatedAt: Date | null;
    // Highest SMART pending-sector count we've already reacted to for this drive (the syslog-watcher
    // only re-verifies when it GROWS beyond this, so a stable known-pending sector doesn't churn).
    public pendingSectorHighWater: number;
    // Draining: the operator has asked to remove this drive. Its slices are being reconstructed and
    // relocated onto healthy volumes. It stays READABLE (reads still serve during the drain) but is
    // NOT writable (no new placement, no in-place repair) so the drain is the only thing moving it.
    public isDraining: boolean;
    public deviceSerial: string | null;
    public deviceModel: string | null = null;
    public deviceVendor: string | null = null;
    public partitionUuid: string | null;
    public bytesTotal: number;
    public bytesUsedData: number;
    public bytesUsedParity: number;
    public bytesFree: number | null = null;
    public bytesPending = 0;
    public deviceName: string | null = null;
    public deviceGroup: number | null = null;
    public verifyErrors: VolumeVerifyErrors | null;
    public label: string | null = null;
    public comment: string | null = null;
    public mountError: string | null = null;
    private readonly log: ReturnType<typeof createLogger>;

    constructor(inConfig: VolumeConfig) {
        super();

        this.id = inConfig.id;
        this.uuid = inConfig.uuid;

        this.isDeleted = inConfig.is_deleted === true;
        this.stateUpdatedAt = inConfig.state_updated_at ? new Date(inConfig.state_updated_at) : null;
        this.pendingSectorHighWater = inConfig.pending_sector_high_water ?? 0;
        this.isDraining = inConfig.is_draining === true;
        this.isEnabled = inConfig.enabled && !this.isDeleted;
        this.isHealthy = inConfig.healthy;
        this.isReadOnly = inConfig.read_only;

        this.deviceSerial = inConfig.disk_serial; // TODO: update this to device_serial in the data
        this.partitionUuid = inConfig.partition_uuid;

        this.bytesTotal = inConfig.partition_size; // TODO: change these to bytes
        this.bytesUsedData = inConfig.data_size;
        this.bytesUsedParity = inConfig.parity_size || 0; // TODO: add
        this.verifyErrors = inConfig.verifyErrors ?? null;
        this.label = typeof inConfig.label === 'string' ? inConfig.label : (inConfig.label ?? null);
        this.comment = typeof inConfig.comment === 'string' ? inConfig.comment : (inConfig.comment ?? null);

        this.log = createLogger('volume' + this.id);

        this.on('error', err => {
            this.log.error(err);
        });

        this.log('initialized');
    }

    markDeleted(): void {
        this.isDeleted = true;
        this.isEnabled = false;
    }

    unmarkDeleted(): void {
        this.isDeleted = false;
    }

    setReadOnly(flag: boolean): void {
        this.isReadOnly = flag;
    }

    setHealthy(flag: boolean): void {
        this.isHealthy = flag;
    }

    setEnabled(flag: boolean): void {
        this.isEnabled = flag && !this.isDeleted;
    }

    setDraining(flag: boolean): void {
        this.isDraining = flag;
    }

    setStateUpdatedAt(when: Date): void {
        this.stateUpdatedAt = when;
    }

    setPendingSectorHighWater(count: number): void {
        this.pendingSectorHighWater = count;
    }

    setVerifyErrors(errors: VolumeVerifyErrors | null): void {
        this.verifyErrors = errors;
    }

    setLabel(value: string | null): void {
        this.label = value;
    }

    setComment(value: string | null): void {
        this.comment = value;
    }

    async start(): Promise<void> {
        try {
            this.log('starting...');

            if (!this.isMounted) {
                this.log('not mounted.');
                await this.mount();
            }

            await this.verify();
            await this.updateFreeBytes();

            this.log(
                'started with %s of %s available',
                formatBytes(this.bytesFree ?? 0),
                formatBytes(this.bytesTotal)
            );
            this.isStarted = true;
            this.emit('started');
        }

        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.mountError = message;
            this.log.error('error encountered while starting the volume', err);
            this.emit('error', err);
            throw err;
        }
    }

    async stop(): Promise<void> {
        if (!this.isStarted && !this.isMounted)
            return;

        this.log('stopping...');

        try {
            if (this.isMounted)
                await this.unmount();

            this.isStarted = false;
            this.isVerified = false;
            this.bytesFree = null;
            this.log('stopped');
        }
        catch (err) {
            this.log.error('error encountered while stopping the volume', err);
            this.emit('error', err);
            throw err;
        }
    }

    async mount(): Promise<void> {
        this.mountPoint = '/run/strubs/mounts/' + this.uuid;
        this.mountError = null;

        try {
            await fsp.access(this.mountPoint);
        }
        catch(err: any) {
            if (err.code !== 'ENOENT')
                throw new Error('unable to check mount directory: ' + err);

            this.log('mount point %s does not exist. creating...', this.mountPoint);

            try {
                await fsp.mkdir(this.mountPoint);
            }
            catch (mkdirErr) {
                throw new Error('unable to create mount directory: ' + mkdirErr);
            }

            this.log('mount point created');
        }

        this.log('attempting to mount %s (%s) to %s', this.blockPath, this.fsType, this.mountPoint);

        if (!this.blockPath || !this.mountPoint || !this.fsType)
            throw new Error('volume mount path is not fully configured');

        if (this.shouldPerformFilesystemCheck())
            await ensureExtFilesystemHealthy(this.blockPath, this.log);

        try {
            await mountVolume(this.blockPath, this.mountPoint, this.fsType, this.mountOptions || {});
        }
        catch (err) {
            const message = 'unable to mount: ' + err;
            this.mountError = message;
            throw new Error(message);
        }

        const volumeTempPath = this.mountPoint + '/strubs/.tmp';
        try {
            await fsp.access(volumeTempPath);
        }
        catch(err: any) {
            if (err.code !== 'ENOENT')
                throw new Error('unable to check volume temporary directory: ' + err);

            this.log('volume temporary directory %s does not exist. creating...', volumeTempPath);

            try {
                await fsp.mkdir(volumeTempPath, { recursive: true});
            }
            catch (mkdirErr) {
                throw new Error('unable to create volume temporary directory: ' + mkdirErr);
            }

            this.log('volume temporary directory created');
        }

        this.isMounted = true;
        this.log('mounted block device %s to %s', this.blockPath, this.mountPoint);
    }

    private async unmount(): Promise<void> {
        if (!this.isMounted)
            return;
        if (!this.mountPoint)
            throw new Error('mount point is not configured');

        this.log('attempting to unmount %s', this.mountPoint);

        try {
            await unmountVolume(this.mountPoint);
        }
        catch (err) {
            throw new Error('unable to unmount: ' + err);
        }

        this.isMounted = false;
        this.log('unmounted %s', this.mountPoint);
    }

    private shouldPerformFilesystemCheck(): boolean {
        if (!this.fsType)
            return false;
        return this.fsType.toLowerCase().startsWith('ext');
    }

    async verify(): Promise<void> {
        this.log('verifying volume...');

        if (!this.mountPoint)
            throw new Error('mount point is not configured');

        try {
            await fsp.access(this.mountPoint);
        }
        catch (err) {
            throw new Error('volume mount point inaccessible: ' + err);
        }

        let data: Buffer;
        try {
            data = await fsp.readFile(this.mountPoint + '/strubs/.identity');
        }
        catch (err: any) {
            if (err.code !== 'ENOENT') throw new Error('volume identity file could not be read: ' + err);
            data = await this.createIdentityFile();
        }

        if (data[0] !== 0x1F || data[1] !== 0xFB || data[2] !== 0x01 || data[3] !== 0xFB || data[data.length - 2] !== 0x19 || data[data.length - 1] !== 0xFB)
            throw new Error('volume identify file corrupt');

        if (data[4] !== 1)
            throw new Error('volume identify file has invalid version');

        if (!config.identityBuffer || data.compare(config.identityBuffer, 0, 16, 5, 21) !== 0)
            throw new Error('volume is not from this STRUBS instance');

        let volumeUuidBuf = Buffer.from(this.uuid.replace(/[^0-9a-f]/g, ''), 'hex');
        if (data.compare(volumeUuidBuf, 0, 16, 21, 37) !== 0)
            throw new Error('volume does not match expected volume UUID');

        if (data[37] !== this.id)
            throw new Error('volume does not match expected volume ID');

        this.log('verified volume');
        this.isVerified = true;
    }

    async createIdentityFile() {
        if (!config.identityBuffer)
            throw new Error('STRUBS identity buffer is not configured');
        if (!this.mountPoint)
            throw new Error('mount point is not configured');

        const identityBuf = buildVolumeIdentityBuffer({
            volumeId: this.id,
            volumeUuid: this.uuid,
            identityBuffer: config.identityBuffer
        });

        try {
            await fsp.mkdir(this.mountPoint + '/strubs');
        }
        catch (err) {}

        await fsp.writeFile(this.mountPoint + '/strubs/.identity', identityBuf);

        return identityBuf;
    }

    async updateFreeBytes(): Promise<void> {
        if (!this.mountPoint)
            throw new Error('mount point is not configured');
        const info = await (diskusage as any).check(this.mountPoint);
        this.bytesFree = info.free;
    }

    reserveSpace(bytes: number): void {
        this.bytesPending += bytes;
    }

    releaseReservation(bytes: number): void {
        this.bytesPending = Math.max(0, this.bytesPending - bytes);
    }

    applyCommittedBytes(bytesReserved: number, bytesWritten: number, sliceType: 'data' | 'parity'): void {
        this.releaseReservation(bytesReserved);
        if (sliceType === 'data')
            this.bytesUsedData += bytesWritten;
        else
            this.bytesUsedParity += bytesWritten;

        if (typeof this.bytesFree === 'number')
            this.bytesFree = Math.max(0, this.bytesFree - bytesWritten);
    }

    releaseCommittedBytes(bytes: number, sliceType: 'data' | 'parity'): void {
        if (sliceType === 'data')
            this.bytesUsedData = Math.max(0, this.bytesUsedData - bytes);
        else
            this.bytesUsedParity = Math.max(0, this.bytesUsedParity - bytes);

        if (typeof this.bytesFree === 'number')
            this.bytesFree += bytes;
    }

    get isReadable() {
        return this.isStarted && this.isEnabled;
    }

    get isWritable() {
        return this.isStarted && this.isEnabled && this.isHealthy && !this.isReadOnly && !this.isDraining;
    }

    // The disk STRUBS expects for this volume isn't present in the latest discovery. Only meaningful
    // for volumes the operator wants online — a disabled/deleted volume isn't "missing", it's off.
    get isMissing() {
        return this.isEnabled && !this.isDeleted && !this.isPresent;
    }

    // Bind this volume to a freshly-discovered device+partition. The single place device identity is
    // copied onto the volume — used by initial init, the Enable path, and the device reconciler, so a
    // disk that appears (or reappears under a new kernel name) is picked up the same way everywhere.
    bindDevice(device: CachedDevice, partition: CachedPartition): void {
        this.deviceSerial = device.serial ?? null;
        this.deviceModel = device.model ?? null;
        this.deviceVendor = device.vendor ?? null;
        this.deviceName = device.name;
        this.deviceGroup = device.busGroup ?? null;
        this.fsType = partition.fsType ?? null;
        this.blockPath = partition.path ?? `/dev/${partition.name}`;
        this.mountPoint = partition.mountPoint || null;
        this.isMounted = !!partition.mountPoint;
        this.isPresent = true;
    }

    // The backing disk is gone (pulled, or dropped off the bus). Tear down any (now-stale) mount with a
    // lazy unmount — the device node may be EIO, which a normal unmount can't complete — and clear the
    // device binding so nothing (health watcher, reads) resolves to a dead kernel name. Config is kept.
    async markMissing(): Promise<void> {
        this.log('marking missing: backing device is no longer present');
        if (this.isMounted && this.mountPoint) {
            try {
                await unmountVolume(this.mountPoint, { lazy: true });
            }
            catch (err) {
                this.log.error('lazy unmount during markMissing failed', err);
            }
        }
        this.isStarted = false;
        this.isVerified = false;
        this.isMounted = false;
        this.bytesFree = null;
        this.blockPath = null;
        this.fsType = null;
        this.deviceName = null;
        this.deviceGroup = null;
        this.mountPoint = null;
        this.isPresent = false;
        this.emit('missing');
    }

    async createTemporaryFh(fileName: string): Promise<FileHandle> {
        if (!this.isWritable)
            throw new Error('volume is not writable');
        if (!this.mountPoint)
            throw new Error('mount point is not configured');

        const path = this.mountPoint + '/strubs/.tmp/' + fileName;
        const fileHandle = await fsp.open(path, 'w');
        return fileHandle;
    }

    async commitTemporaryFile(fileName: string): Promise<void> {
        if (!this.isWritable)
            throw new Error('volume is not writable');
        if (!this.mountPoint)
            throw new Error('mount point is not configured');

        const srcPath = this.mountPoint + '/strubs/.tmp/' + fileName;
        const dstFolder = this.resolveSliceDirectory(fileName);
        const dstPath = dstFolder + '/' + fileName;

        try {
            await fsp.mkdir(dstFolder, { recursive: true });
        }
        catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST')
                throw err;
        }

        await fsp.rename(srcPath, dstPath);
    }

    async deleteTemporaryFile(fileName: string): Promise<void> {
        if (!this.isWritable)
            throw new Error('volume is not writable');
        if (!this.mountPoint)
            throw new Error('mount point is not configured');

        const path = this.mountPoint + '/strubs/.tmp/' + fileName;
        await fsp.unlink(path);
    }

    async getCommitedPath(fileName: string): Promise<string> {
        if (!this.isReadable)
            throw new Error('volume is not readable');
        if (!this.mountPoint)
            throw new Error('mount point is not configured');

        const path = this.resolveSliceDirectory(fileName) + '/' + fileName;
        try {
            await fsp.access(path);
            return path;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                throw e;
        }

        throw new Error('slice path not found');
    }

    async openCommittedFh(fileName: string): Promise<FileHandle> {
        // The volume being offline/unmounted is a volume-level condition, not a
        // property of this slice: tag it EUNAVAIL so it is never confused with a
        // genuinely missing or corrupt slice on a healthy disk.
        if (!this.isReadable || !this.mountPoint) {
            const err = new Error(this.mountPoint ? 'volume is not readable' : 'mount point is not configured') as Error & { code?: string };
            err.code = 'EUNAVAIL';
            throw err;
        }

        const path = this.resolveSliceDirectory(fileName) + '/' + fileName;
        try {
            return await fsp.open(path, 'r');
        } catch (err) {
            // Preserve the filesystem errno (ENOENT => the slice file genuinely
            // does not exist on a mounted volume; EIO/EACCES => disk trouble) so
            // downstream categorization can distinguish "missing" from "unreadable".
            const throwErr = new Error('failed to open slice') as Error & { cause?: unknown; path?: string; code?: string };
            throwErr.cause = err;
            throwErr.path = path;
            throwErr.code = (err as NodeJS.ErrnoException)?.code;
            throw throwErr;
        }
    }

    async deleteCommittedFile(fileName: string): Promise<void> {
        if (!this.isWritable)
            throw new Error('volume is not writable');
        if (!this.mountPoint)
            throw new Error('mount point is not configured');

        const path = this.resolveSliceDirectory(fileName) + '/' + fileName;
        await fsp.unlink(path);
    }

    private resolveSliceDirectory(fileName: string): string {
        if (!this.mountPoint)
            throw new Error('mount point is not configured');

        const first = fileName.substring(0, 2);
        const second = fileName.substring(2, 4);
        const third = fileName.substring(4, 6);

        return `${this.mountPoint}/strubs/${first}/${second}/${third}`;
    }
}
