import { HttpHelpers } from './helpers';
import { HttpBadRequestError, HttpNotFoundError } from './errors';
import { ioManager } from '../../io/manager';
import { deviceProvisioner } from '../../io/device-provisioner';
import type { CachedDevice } from '../../io/device-discovery';
import { verifyVolumesJob } from '../../jobs/verify-volumes-job';
import { verifyFileJob } from '../../jobs/verify-file-job';
import { database } from '../../database';
import type { HttpRequest, HttpResponse } from './server';
import type { Volume } from '../../io/volume';
import path from 'path';
import { volumeSmartMonitor, type VolumeSmartInfo, type VolumeSmartSummary } from '../../io/volume-smart-monitor';

type VolumeStatus = {
    id: number;
    uuid: string;
    blockPath: string | null;
    mountPoint: string | null;
    isMounted: boolean;
    isVerified: boolean;
    isStarted: boolean;
    isEnabled: boolean;
    isHealthy: boolean;
    isReadOnly: boolean;
    deviceSerial: string | null;
    deviceModel: string | null;
    deviceVendor: string | null;
    partitionUuid: string | null;
    busGroup: number | null;
    bytesTotal: number;
    bytesFree: number | null;
    verifyErrors: Volume['verifyErrors'];
    mountError: string | null;
    isDeleted: boolean;
    isSmartHealthy: boolean | null;
    smartInfoSummary: VolumeSmartSummary | null;
};

type VolumeDetail = VolumeStatus & {
    smartInfo: VolumeSmartInfo | null;
};

type RouteParams = Record<string, unknown>;
type FileInfoRouteParams = RouteParams & { normalizedPath: string };
type VerifyFileRouteParams = RouteParams & { objectId: string };
type RouteHandler = (req: HttpRequest, params: RouteParams) => Promise<unknown>;
type RouteDefinition = {
    method: string;
    match: (url: string) => RouteParams | null;
    handler: RouteHandler;
};
type RouteMatch = { handler: RouteHandler; params: RouteParams };

type StatusResponse = {
    availableVolumeIds: number[];
    unavailableVolumeIds: number[];
    disabledVolumeIds: number[];
    readOnlyVolumeIds: number[];
    verifyErrors: Record<string, Volume['verifyErrors']>;
    gbStored: number;
    gbCapacity: number;
    gbFree: number;
};

export class HttpMgmt {
    private static readonly routes: RouteDefinition[] = HttpMgmt.createRoutes();

    static async handle(_requestId: number, req: HttpRequest, _res: HttpResponse): Promise<unknown> {
        const method = req.method?.toUpperCase();
        const url = req.url;
        if (!method || !url)
            throw new HttpNotFoundError();

        const route = this.findRoute(method, url);
        if (!route)
            throw new HttpNotFoundError();

        return route.handler.call(this, req, route.params);
    }

    private static async handleVolumesRequest(req: HttpRequest): Promise<VolumeStatus[]> {
        const includeDeleted = this.shouldIncludeDeleted(req.params);
        return this.getVolumeStatus(includeDeleted);
    }

    private static async handleBlockDevicesRequest(req: HttpRequest): Promise<Array<Record<string, unknown>>> {
        const devices = ioManager.getCachedDevices();
        const sortParam = this.resolveSortParam(req.params);
        return this.serializeBlockDevices(devices, sortParam);
    }

    private static async handleBlockDevicesReloadRequest(req: HttpRequest): Promise<Array<Record<string, unknown>>> {
        await ioManager.reloadBlockDevices();
        return this.handleBlockDevicesRequest(req);
    }

    private static serializeBlockDevices(devices: CachedDevice[], sortParam: 'name' | 'sysfsPath' | 'size'): Array<Record<string, unknown>> {
        const enriched = devices.map(device => this.serializeCachedDevice(device));
        enriched.sort((a, b) => {
            if (sortParam === 'sysfsPath')
                return String(a.sysfsPath ?? '').localeCompare(String(b.sysfsPath ?? ''));
            if (sortParam === 'size')
                return (Number(a.size) || 0) - (Number(b.size) || 0);
            return String(a.name ?? '').localeCompare(String(b.name ?? ''));
        });
        return enriched;
    }

    private static serializeCachedDevice(device: CachedDevice): Record<string, unknown> {
        const sysfsResolved = path.resolve(`/sys/block/${device.name}`, device.sysfsPath);
        const children = device.partitions.map(partition => ({
            type: 'part',
            name: partition.name,
            path: partition.path ?? (partition.name ? `/dev/${partition.name}` : undefined),
            uuid: partition.uuid,
            size: partition.size,
            fstype: partition.fsType,
            mountpoint: partition.mountPoint ?? null
        }));
        const serialized: Record<string, unknown> = {
            name: device.name,
            path: `/dev/${device.name}`,
            type: 'disk',
            size: device.size,
            model: device.model,
            vendor: device.vendor,
            serial: device.serial,
            ptuuid: device.partitionTableUuid ?? undefined,
            pttype: device.partitionTableType ?? undefined,
            sysfsPath: sysfsResolved,
            busGroup: device.busGroup ?? null,
            children
        };
        return serialized;
    }

    private static async handleVerifyVolumesJobStartRequest(req: HttpRequest): Promise<{ startedAt: string }> {
        const payload = await this.parseJsonBody<{ volumeIds?: unknown }>(req);
        const volumeIds = this.normalizeVolumeIdFilter(payload.volumeIds);
        if (volumeIds)
            return verifyVolumesJob.start({ volumeIds });
        return verifyVolumesJob.start();
    }

    private static resolveSortParam(params: Record<string, unknown>): 'name' | 'sysfsPath' | 'size' {
        const raw = params.sort;
        const value = Array.isArray(raw) ? raw[0] : raw;
        if (value === 'sysfsPath')
            return 'sysfsPath';
        if (value === 'size')
            return 'size';
        return 'name';
    }

    private static async handleVerifyVolumesJobStopRequest(): Promise<{ stopped: boolean }> {
        await verifyVolumesJob.stop();
        return { stopped: true };
    }

    private static async handleVerifyVolumesJobStatusRequest(): Promise<{ running: boolean; startedAt: string | null; objectsVerified: number; errors: { total: number; volumes: Record<string, number> }; concurrency: number }> {
        return verifyVolumesJob.getStatus();
    }

    private static async handleVerifyFileRequest(_req: HttpRequest, params: VerifyFileRouteParams): Promise<unknown> {
        const objectId = this.parseObjectId(params);
        try {
            return await verifyFileJob.verify(objectId);
        }
        catch (err) {
            const code = (err as { code?: string })?.code;
            if (code === 'ENOENT')
                throw new HttpNotFoundError();
            if (code === 'ENOTFILE')
                throw new HttpBadRequestError('object is not a file');
            throw err;
        }
    }

    private static async handleStatusRequest(): Promise<StatusResponse> {
        const available: number[] = [];
        const unavailable: number[] = [];
        const disabled: number[] = [];
        const readOnly: number[] = [];
        const verifyErrors: Record<string, Volume['verifyErrors']> = {};
        let bytesStored = 0;
        let bytesCapacity = 0;
        let bytesFree = 0;

        for (const [id, volume] of ioManager.getVolumeEntries()) {
            const isAvailable = volume.isStarted && Boolean(volume.blockPath);
            if (isAvailable) {
                available.push(id);
                bytesCapacity += volume.bytesTotal;
                bytesStored += volume.bytesUsedData ?? 0;
                bytesStored += volume.bytesUsedParity ?? 0;
                bytesFree += volume.bytesFree ?? 0;
            }
            else {
                unavailable.push(id);
            }
            if (!volume.isEnabled)
                disabled.push(id);
            if (volume.isReadOnly)
                readOnly.push(id);
            if (volume.verifyErrors)
                verifyErrors[String(id)] = volume.verifyErrors;
        }

        return {
            availableVolumeIds: available,
            unavailableVolumeIds: unavailable,
            disabledVolumeIds: disabled,
            readOnlyVolumeIds: readOnly,
            verifyErrors,
            gbStored: bytesStored / (1024 ** 3),
            gbCapacity: bytesCapacity / (1024 ** 3),
            gbFree: bytesFree / (1024 ** 3)
        };
    }

    private static async handleVolumeCreationRequest(req: HttpRequest): Promise<VolumeStatus> {
        const payload = await this.parseJsonBody<{ blockPath?: string; wipe?: unknown; replace?: unknown }>(req);
        const blockPath = payload.blockPath;
        const wipe = payload.wipe;
        const replace = payload.replace;
        if (!blockPath || typeof blockPath !== 'string')
            throw new HttpBadRequestError('blockPath must be provided');
        let wipeFlag: boolean | undefined;
        if (wipe !== undefined) {
            if (typeof wipe !== 'number' || Number.isNaN(wipe))
                throw new HttpBadRequestError('wipe must be provided as a timestamp');
            const now = Date.now();
            if (Math.abs(now - wipe) > 10_000)
                throw new HttpBadRequestError('wipe timestamp must be within 10 seconds of current time');
            wipeFlag = true;
        }
        if (replace !== undefined && typeof replace !== 'boolean')
            throw new HttpBadRequestError('replace must be a boolean');

        const volumeConfig = await deviceProvisioner.provision({
            blockPath,
            wipe: wipeFlag,
            replace: replace as boolean | undefined
        });

        const volume = ioManager.getVolume(volumeConfig.id);
        if (!volume)
            throw new Error('failed to register volume');

        return this._serializeVolume(volumeConfig.id, volume);
    }

    private static async handleVolumeDetailRequest(params: RouteParams): Promise<VolumeDetail> {
        const id = this.parseVolumeId(params);
        const volume = ioManager.getVolume(id);
        if (!volume)
            throw new HttpNotFoundError();
        const smartInfo = volumeSmartMonitor.getInfo(id);
        const supportsSmart = smartInfo.summary.isSupported !== false;
        return {
            ...this._serializeVolume(id, volume),
            smartInfo: supportsSmart ? smartInfo : null
        };
    }

    private static async handleVolumeDeleteRequest(params: RouteParams): Promise<{ deleted: boolean }> {
        const id = this.parseVolumeId(params);
        await database.softDeleteVolume(id);
        await ioManager.softDeleteVolume(id).catch(() => undefined);
        return { deleted: true };
    }

    private static async handleVolumeUpdateRequest(req: HttpRequest, params: RouteParams): Promise<{ updated: boolean }> {
        const payload = await this.parseJsonBody<{ isEnabled?: unknown; isReadOnly?: unknown; isDeleted?: unknown }>(req);
        const id = this.parseVolumeId(params);

        const updates: { isEnabled?: boolean; isReadOnly?: boolean; isDeleted?: boolean } = {};
        let shouldSoftDelete = false;

        if (payload.isEnabled !== undefined) {
            if (typeof payload.isEnabled !== 'boolean')
                throw new HttpBadRequestError('isEnabled must be a boolean');
            updates.isEnabled = payload.isEnabled;
        }

        if (payload.isReadOnly !== undefined) {
            if (typeof payload.isReadOnly !== 'boolean')
                throw new HttpBadRequestError('isReadOnly must be a boolean');
            updates.isReadOnly = payload.isReadOnly;
        }

        if (payload.isDeleted !== undefined) {
            if (typeof payload.isDeleted !== 'boolean')
                throw new HttpBadRequestError('isDeleted must be a boolean');
            if (payload.isDeleted)
                shouldSoftDelete = true;
            else
                updates.isDeleted = false;
        }

        if (!shouldSoftDelete && !Object.keys(updates).length)
            throw new HttpBadRequestError('no valid fields to update');

        if (shouldSoftDelete) {
            await database.softDeleteVolume(id);
            await ioManager.softDeleteVolume(id).catch(() => undefined);
        }

        if (Object.keys(updates).length) {
            await database.updateVolumeFlags(id, updates);
            await ioManager.updateVolumeFlags(id, updates);
        }

        return { updated: true };
    }

    private static async getVolumeStatus(includeDeleted: boolean): Promise<VolumeStatus[]> {
        const entries = ioManager.getVolumeEntries();
        return entries
            .filter(([, volume]) => includeDeleted || !volume.isDeleted)
            .map(([id, volume]) => this._serializeVolume(id, volume));
    }

    private static _serializeVolume(id: number, volume: Volume): VolumeStatus {
        const smartInfoSummary = volumeSmartMonitor.getSummary(id);
        const supportsSmart = smartInfoSummary.isSupported !== false;
        return {
            id,
            uuid: volume.uuid,
            blockPath: volume.blockPath,
            mountPoint: volume.mountPoint,
            isMounted: volume.isMounted,
            isVerified: volume.isVerified,
            isStarted: volume.isStarted,
            isEnabled: volume.isEnabled,
            isHealthy: volume.isHealthy,
            isReadOnly: volume.isReadOnly,
            deviceSerial: volume.deviceSerial,
            deviceModel: volume.deviceModel ?? null,
            deviceVendor: volume.deviceVendor ?? null,
            partitionUuid: volume.partitionUuid,
            busGroup: volume.deviceGroup ?? null,
            bytesTotal: volume.bytesTotal,
            bytesFree: volume.bytesFree,
            verifyErrors: volume.verifyErrors,
            isDeleted: volume.isDeleted,
            mountError: volume.mountError,
            isSmartHealthy: supportsSmart ? smartInfoSummary.isHealthy : null,
            smartInfoSummary: supportsSmart ? smartInfoSummary : null
        };
    }

    private static async handleFileInfoRequest(params: FileInfoRouteParams): Promise<Record<string, unknown>> {
        const objectMeta = await HttpHelpers.getObjectMeta(params.normalizedPath);
        if (!objectMeta || !objectMeta.dataVolumes || !objectMeta.parityVolumes)
            throw new HttpNotFoundError();
        const { dataVolumes, parityVolumes } = objectMeta as typeof objectMeta & {
            dataVolumes: number[];
            parityVolumes: number[];
        };

        const slicePaths = await this._mapAsync(dataVolumes, async (volumeId, idx) => {
            const volume = ioManager.getVolume(volumeId);
            if (!volume)
                return `Error: volume ${volumeId} not found`;
            try {
                return await volume.getCommitedPath(`${objectMeta.id}.${idx}`);
            }
            catch (err) {
                return `Error: ${err}`;
            }
        });
        const parityPaths = await this._mapAsync(parityVolumes, async (volumeId, idx) => {
            const volume = ioManager.getVolume(volumeId);
            if (!volume)
                return `Error: volume ${volumeId} not found`;
            try {
                return await volume.getCommitedPath(`${objectMeta.id}.${idx + dataVolumes.length}`);
            }
            catch (err) {
                return `Error: ${err}`;
            }
        });

        return {
            'X-Object-Id': objectMeta.id,
            'X-Container-Id': objectMeta.containerId,
            'Content-MD5': objectMeta.md5?.toString('hex'),
            'Content-Type': objectMeta.mime,
            'X-Data-Slice-Count': dataVolumes.length,
            'X-Data-Slice-Volumes': dataVolumes,
            'X-Parity-Slice-Count': parityVolumes.length,
            'X-Parity-Slice-Volumes': parityVolumes,
            'X-Chunk-Size': objectMeta.chunkSize,
            slicePaths,
            parityPaths
        };
    }

    private static async _mapAsync<T, U>(items: T[], callback: (item: T, index: number) => Promise<U>): Promise<U[]> {
        const result: U[] = [];
        for (let i = 0; i < items.length; i++) {
            result.push(await callback(items[i], i));
        }
        return result;
    }

    private static findRoute(method: string, url: string): RouteMatch | null {
        for (const route of this.routes) {
            if (route.method !== method)
                continue;
            const params = route.match(url);
            if (params)
                return { handler: route.handler, params };
        }
        return null;
    }

    private static createRoutes(): RouteDefinition[] {
        return [
            {
                method: 'GET',
                match: url => url === '/$/volumes' ? {} : null,
                handler: async req => this.handleVolumesRequest(req)
            },
            {
                method: 'GET',
                match: url => this.matchVolumeIdRoute(url),
                handler: async (_req, params) => this.handleVolumeDetailRequest(params)
            },
            {
                method: 'GET',
                match: url => url === '/$/status' ? {} : null,
                handler: async () => this.handleStatusRequest()
            },
            {
                method: 'GET',
                match: url => url === '/$/blockDevices' ? {} : null,
                handler: async req => this.handleBlockDevicesRequest(req)
            },
            {
                method: 'POST',
                match: url => url === '/$/blockDevices/reload' ? {} : null,
                handler: async req => this.handleBlockDevicesReloadRequest(req)
            },
            {
                method: 'POST',
                match: url => url === '/$/volumes' ? {} : null,
                handler: async req => this.handleVolumeCreationRequest(req)
            },
            {
                method: 'PUT',
                match: url => this.matchVolumeIdRoute(url),
                handler: async (req, params) => this.handleVolumeUpdateRequest(req, params)
            },
            {
                method: 'DELETE',
                match: url => this.matchVolumeIdRoute(url),
                handler: async (_req, params) => this.handleVolumeDeleteRequest(params)
            },
            {
                method: 'POST',
                match: url => url === '/$/verify-volumes' ? {} : null,
                handler: async req => this.handleVerifyVolumesJobStartRequest(req)
            },
            {
                method: 'GET',
                match: url => url === '/$/verify-volumes' ? {} : null,
                handler: async () => this.handleVerifyVolumesJobStatusRequest()
            },
            {
                method: 'DELETE',
                match: url => url === '/$/verify-volumes' ? {} : null,
                handler: async () => this.handleVerifyVolumesJobStopRequest()
            },
            {
                method: 'POST',
                match: url => this.matchVerifyFileRoute(url),
                handler: async (req, params) => this.handleVerifyFileRequest(req, params as VerifyFileRouteParams)
            },
            {
                method: 'GET',
                match: url => this.matchFileInfoRoute(url),
                handler: async (_req, params) => this.handleFileInfoRequest(params as FileInfoRouteParams)
            }
        ];
    }

    private static shouldIncludeDeleted(params: RouteParams): boolean {
        const value = params.includeDeleted;
        if (typeof value === 'string')
            return value.toLowerCase() === 'true';
        if (Array.isArray(value))
            return value.some(item => typeof item === 'string' && item.toLowerCase() === 'true');
        return false;
    }

    private static normalizeVolumeIdFilter(raw: unknown): number[] | null {
        if (raw === undefined || raw === null)
            return null;
        if (!Array.isArray(raw))
            throw new HttpBadRequestError('volumeIds must be an array of numbers');
        const normalized: number[] = [];
        for (const entry of raw) {
            if (typeof entry !== 'number' || !Number.isFinite(entry))
                throw new HttpBadRequestError('volumeIds must be an array of numbers');
            normalized.push(entry);
        }
        const unique = Array.from(new Set(normalized));
        return unique.length ? unique : null;
    }

    private static parseVolumeId(params: RouteParams): number {
        const idRaw = (params.id ?? '') as string;
        const id = Number.parseInt(idRaw, 10);
        if (!Number.isFinite(id))
            throw new HttpBadRequestError('invalid volume id');
        return id;
    }

    private static parseObjectId(params: VerifyFileRouteParams): string {
        const value = params.objectId;
        if (typeof value !== 'string' || !/^[0-9a-fA-F]{24}$/.test(value))
            throw new HttpBadRequestError('invalid object id');
        return value;
    }

    private static matchFileInfoRoute(url: string): FileInfoRouteParams | null {
        const prefix = '/$/fileinfo/';
        if (!url.toLowerCase().startsWith(prefix))
            return null;
        const requestedPath = url.slice(prefix.length);
        const normalizedPath = requestedPath.startsWith('/') ? requestedPath : '/' + requestedPath;
        return { normalizedPath };
    }

    private static matchVolumeIdRoute(url: string): RouteParams | null {
        const match = /^\/\$\/volumes\/(\d+)$/.exec(url);
        if (!match)
            return null;
        return { id: match[1] };
    }

    private static matchVerifyFileRoute(url: string): VerifyFileRouteParams | null {
        const match = /^\/\$\/verify-file\/([^/]+)$/.exec(url);
        if (!match)
            return null;
        return { objectId: match[1] };
    }

    private static async parseJsonBody<T>(req: HttpRequest): Promise<T> {
        const body = await this.readRequestBody(req);
        if (!body.length)
            return {} as T;
        try {
            return JSON.parse(body.toString('utf-8')) as T;
        }
        catch (err) {
            throw new HttpBadRequestError('invalid JSON body');
        }
    }

    private static readRequestBody(req: HttpRequest): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            req.on('data', chunk => {
                chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            });
            req.on('end', () => resolve(Buffer.concat(chunks)));
            req.on('error', reject);
            req.on('aborted', () => reject(new HttpBadRequestError('request aborted')));
        });
    }

}
