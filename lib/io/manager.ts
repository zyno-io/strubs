import { createLogger } from '../log';
import { createError } from '../helpers';
import { deviceDiscovery, type DeviceDiscovery, type CachedDevice } from './device-discovery';
import { volumeFleet as defaultVolumeFleet, type VolumeFleet } from './volume-fleet';
import type { Volume, VolumeConfig, PersistedVolumeConfig } from './volume';
import { mountRootManager as defaultMountRootManager, type MountRootManager } from './mount-root-manager';

const log = createLogger('io-manager');

type IOManagerDeps = {
    deviceDiscovery: DeviceDiscovery;
    volumeFleet: VolumeFleet;
    mountRootManager: MountRootManager;
};

const defaultDeps: IOManagerDeps = {
    deviceDiscovery,
    volumeFleet: defaultVolumeFleet,
    mountRootManager: defaultMountRootManager
};

export class IOManager {
    private readonly deps: IOManagerDeps;
    private _onlineDevices: CachedDevice[] = [];
    public volumeGroupCount = 0;
    private _refreshInterval: NodeJS.Timeout | null = null;
    private _stopPromise: Promise<void> | null = null;

    constructor(deps?: Partial<IOManagerDeps>) {
        this.deps = { ...defaultDeps, ...deps };
    }

    async init(): Promise<void> {
        try {
            log('starting IO manager');

            await this.deps.volumeFleet.loadConfig();
            await this.reloadBlockDevices();
            await this.deps.mountRootManager.ensureExists();
            this.deps.volumeFleet.initializeVolumes(this._onlineDevices);
            await this.deps.volumeFleet.startVolumes();
            this.volumeGroupCount = this.deps.volumeFleet.countVolumeGroups();
            this.deps.volumeFleet.logUtilization();
            this._startVolumeRefreshLoop();
        }
        catch (err) {
            throw createError('IOFAIL', 'failed to init IO manager', err as Error);
        }
    }

    getVolume(id: number): Volume | undefined {
        return this.deps.volumeFleet.getVolume(id);
    }

    getVolumeEntries(): Array<[number, Volume]> {
        return this.deps.volumeFleet.getVolumeEntries();
    }

    getWritableVolumes(): Volume[] {
        return this.deps.volumeFleet.getWritableVolumes();
    }

    private _startVolumeRefreshLoop(): void {
        if (this._refreshInterval)
            return;
        this._refreshInterval = setInterval(() => {
            void this.deps.volumeFleet.refreshVolumeStats().catch(err => {
                log.error('failed to refresh volume stats:', err);
            });
        }, 5 * 60 * 1000);
        this._refreshInterval.unref?.();
    }

    async stop(): Promise<void> {
        if (this._stopPromise)
            return this._stopPromise;

        this._stopPromise = (async () => {
            if (this._refreshInterval) {
                clearInterval(this._refreshInterval);
                this._refreshInterval = null;
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
            await this.deps.volumeFleet.stopVolumes();
        })();

        try {
            await this._stopPromise;
        }
        finally {
            this._stopPromise = null;
        }
    }

    async registerVolume(config: PersistedVolumeConfig): Promise<void> {
        await this.reloadBlockDevices();
        await this.deps.mountRootManager.ensureExists();
        await this.deps.volumeFleet.registerVolume(config, this._onlineDevices);
        this.volumeGroupCount = this.deps.volumeFleet.countVolumeGroups();
    }

    async softDeleteVolume(id: number): Promise<void> {
        await this.deps.volumeFleet.softDeleteVolume(id);
    }

    async updateVolumeFlags(id: number, changes: { isEnabled?: boolean; isReadOnly?: boolean; isDeleted?: boolean; label?: string | null }): Promise<void> {
        await this.reloadBlockDevices();
        await this.deps.volumeFleet.updateVolumeFlags(id, changes, this._onlineDevices);
    }

    getCachedDevices(): CachedDevice[] {
        return this._onlineDevices;
    }

    async reloadBlockDevices(): Promise<CachedDevice[]> {
        this._onlineDevices = await this.deps.deviceDiscovery.discover();
        return this._onlineDevices;
    }
}

export const ioManager = new IOManager();
