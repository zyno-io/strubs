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
    is_deleted?: boolean;
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
    public isEnabled: boolean;
    public readonly isHealthy: boolean;
    public isReadOnly: boolean;
    public isDeleted: boolean;
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
    public mountError: string | null = null;
    private readonly log: ReturnType<typeof createLogger>;

    constructor(inConfig: VolumeConfig) {
        super();

        this.id = inConfig.id;
        this.uuid = inConfig.uuid;

        this.isDeleted = inConfig.is_deleted === true;
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

    setEnabled(flag: boolean): void {
        this.isEnabled = flag && !this.isDeleted;
    }

    setVerifyErrors(errors: VolumeVerifyErrors | null): void {
        this.verifyErrors = errors;
    }

    setLabel(value: string | null): void {
        this.label = value;
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
        return this.isStarted && this.isEnabled && this.isHealthy && !this.isReadOnly;
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
        try {
            if (!this.isReadable)
                throw new Error('volume is not readable');
            if (!this.mountPoint)
                throw new Error('mount point is not configured');

            const path = this.resolveSliceDirectory(fileName) + '/' + fileName;
            const fileHandle = await fsp.open(path, 'r');
            return fileHandle;
        } catch (err) {
            const throwErr = new Error('failed to open slice') as Error & { cause?: unknown; path?: string };
            throwErr.cause = err;
            throwErr.path = this.resolveSliceDirectory(fileName) + '/' + fileName;
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
