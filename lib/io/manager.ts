import { createLogger } from '../log';
import { createError } from '../helpers';
import { deviceDiscovery, type DeviceDiscovery, type CachedDevice } from './device-discovery';
import { volumeFleet as defaultVolumeFleet, type VolumeFleet } from './volume-fleet';
import type { Volume, VolumeConfig, PersistedVolumeConfig } from './volume';
import { mountRootManager as defaultMountRootManager, type MountRootManager } from './mount-root-manager';
import { repairWorker } from '../remediation/repair-worker';
import { bootstrapManifestWriter } from './bootstrap-manifest';

const log = createLogger('io-manager');

type IOManagerDeps = {
    deviceDiscovery: DeviceDiscovery;
    volumeFleet: VolumeFleet;
    mountRootManager: MountRootManager;
    repairWorker: Pick<typeof repairWorker, 'wake'>;
    bootstrapManifestWriter: Pick<typeof bootstrapManifestWriter, 'write' | 'setJournalVolumeIds'>;
};

const defaultDeps: IOManagerDeps = {
    deviceDiscovery,
    volumeFleet: defaultVolumeFleet,
    mountRootManager: defaultMountRootManager,
    repairWorker,
    bootstrapManifestWriter
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

    getVolumeByPartitionUuid(partitionUuid: string): Volume | undefined {
        return this.deps.volumeFleet.getVolumeByPartitionUuid(partitionUuid);
    }

    getVolumeByDeviceName(deviceName: string): Volume | undefined {
        return this.deps.volumeFleet.getVolumeByDeviceName(deviceName);
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

    async registerVolume(config: PersistedVolumeConfig, opts: { initializeIdentity?: boolean } = {}): Promise<void> {
        await this.reloadBlockDevices();
        await this.deps.mountRootManager.ensureExists();
        await this.deps.volumeFleet.registerVolume(config, this._onlineDevices, opts);
        this.volumeGroupCount = this.deps.volumeFleet.countVolumeGroups();
        this.deps.repairWorker.wake(`volume ${config.id} registered`);
        this.refreshBootstrapManifest();
    }

    async softDeleteVolume(id: number): Promise<void> {
        await this.deps.volumeFleet.softDeleteVolume(id);
        this.refreshBootstrapManifest();
    }

    async updateVolumeFlags(id: number, changes: { isEnabled?: boolean; isReadOnly?: boolean; isDeleted?: boolean; isHealthy?: boolean; isDraining?: boolean; label?: string | null; comment?: string | null }): Promise<void> {
        await this.reloadBlockDevices();
        await this.deps.volumeFleet.updateVolumeFlags(id, changes, this._onlineDevices);
        if (changes.isEnabled === true || changes.isDeleted === false)
            this.deps.repairWorker.wake(`volume ${id} availability changed`);
        this.refreshBootstrapManifest();
    }

    // The bootstrap manifest records the fleet's recovery policy, so it is stale the moment any volume's
    // state changes. Hooked HERE -- the single boundary every mutation funnels through (operator flags,
    // drain start/cancel/complete, health degradation, provision, delete) -- rather than at the HTTP
    // handlers, which miss the ones the system does to itself. Fire-and-forget: a manifest write must
    // never fail or delay a fleet change, and the periodic backstop makes a dropped write self-healing.
    //
    // The JOURNAL has to follow the fleet from the same hook. Journal files are not object slices: the
    // drain job walks `content` and relocates what the records reference, and it knows nothing about
    // .journal/ -- so draining and pulling a journal volume would silently destroy one of its replicas,
    // and retiring the wrong three disks over a year could quietly take it to zero.
    private refreshBootstrapManifest(): void {
        void (async () => {
            try {
                const { journal } = require('./journal') as typeof import('./journal');
                await journal.onFleetChange();
                this.deps.bootstrapManifestWriter.setJournalVolumeIds(journal.replicaVolumeIds);
            }
            catch { /* the journal re-election must never fail a fleet change */ }
            await this.deps.bootstrapManifestWriter.write().catch(() => undefined);
        })();
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
