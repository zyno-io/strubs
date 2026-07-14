import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '../../log';
import { HttpHelpers } from './helpers';
import { scryptHash } from './secret-hash';
import { clearCredentialCache, getBucketActivity, invalidateAuthEnforcedCache, isValidBucketName } from './object-authz';
import type { Grant } from '../../database/credential-repository';
import { HttpBadRequestError, HttpNotFoundError, HttpUnauthorizedError, HttpTooManyRequestsError } from './errors';
import { adminAuth, parseCookies, sessionSetCookie, sessionClearCookie, SESSION_COOKIE } from './admin-auth';
import { ioManager } from '../../io/manager';
import { journal } from '../../io/journal';
import { snapshotJob } from '../../jobs/snapshot-job';
import { namespaceRestore, type RestoreSummary } from '../../recovery/restore';
import { driftScrubJob, type DriftReport } from '../../jobs/drift-scrub-job';
import { buildSliceIndex } from '../../recovery/recovery';
import { readProcMounts } from '../../io/helpers';
import { mapperPath as luksMapperPath } from '../../io/luks';
import { findManifestsOnDevices, recoverFleetFromDisks, type FleetRecoverySummary } from '../../recovery/bootstrap';
import { bootstrapManifestWriter, type ManifestSnapshotRef } from '../../io/bootstrap-manifest';
import { deviceProvisioner, ENCRYPT_NEW_VOLUMES_KEY } from '../../io/device-provisioner';
import {
    auditRecoveryKey,
    hasRecoveryPassphrase,
    lastRecoveryAudit,
    scanFleet,
    setFleetRecoveryPassphrase,
    volumeDiskIsAttached,
    withEncryptionSlot,
    type PassphraseRotation,
    type RecoveryAudit
} from '../../io/luks-recovery-key';
import type { CachedDevice } from '../../io/device-discovery';
import { verifyVolumesJob } from '../../jobs/verify-volumes-job';
import type { VerifyVolumesStatus } from '../../jobs/verify-volumes-job';
import { drainVolumeJob } from '../../jobs/drain-volume-job';
import { driveIdentifier } from '../../io/drive-identifier';
import { rebalanceJob, type RebalanceStatus } from '../../jobs/rebalance-job';
import { verifyFileJob } from '../../jobs/verify-file-job';
import { verifyScheduler } from '../../jobs/verify-scheduler';
import { repairWorker } from '../../remediation/repair-worker';
import { config } from '../../config';
import { isMaintenanceFrozen, setMaintenanceFrozen } from '../../maintenance';
import { database } from '../../database';
import type { HttpRequest, HttpResponse, HttpContentPayload } from './server';
import type { Volume } from '../../io/volume';
import { volumeSmartMonitor, type VolumeSmartInfo, type VolumeSmartSummary } from '../../io/volume-smart-monitor';
import { volumePriorityManager } from '../../io/volume-priority-manager';
import { notificationService } from '../../notify/service';
import type { Severity } from '../../notify/notifier';
import { remediationService } from '../../remediation/service';
import type { SliceFault } from '../../remediation/fault';
import { storageStatsTracker } from '../../storage/stats-tracker';
import type { StorageStatsSnapshot } from '../../storage/stats';

export type VolumeStatus = {
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
    // Whether the volume's disk is currently discovered/bound, and the derived operator-facing "the disk
    // STRUBS expects is gone" state (enabled + not deleted + not present). Lets the UI show "missing"
    // distinctly from disabled or unhealthy.
    isPresent: boolean;
    isMissing: boolean;

    // Derived at DISCOVERY from the partition's fstype, never stored as a flag. A flag can drift; a disk
    // cannot lie about its own superblock. `false` on a volume whose disk is absent means "we don't know",
    // not "plaintext" -- which is why the fleet coverage below counts only volumes we can actually see.
    isEncrypted: boolean;
    deviceSerial: string | null;
    deviceModel: string | null;
    deviceVendor: string | null;
    partitionUuid: string | null;
    busGroup: number | null;
    label: string | null;
    comment: string | null;
    bytesTotal: number;
    bytesFree: number | null;
    verifyErrors: Volume['verifyErrors'];
    mountError: string | null;
    isDeleted: boolean;
    isDraining: boolean;
    stateUpdatedAt: string | null;
    isSmartHealthy: boolean | null;
    smartInfoSummary: VolumeSmartSummary | null;
};

export type VolumeDetail = VolumeStatus & {
    smartInfo: VolumeSmartInfo | null;
};

export type BlockDevicePartition = {
    type: 'part';
    name: string;
    path?: string;
    uuid: string | null;
    size: number;
    fstype: string | null;
    mountpoint: string | null;
};

export type BlockDevice = {
    name: string;
    path: string;
    type: 'disk';
    size: number;
    model: string | null;
    vendor: string | null;
    serial: string | null;
    ptuuid?: string;
    pttype?: string;
    sysfsPath: string;
    busGroup: number | null;
    volumeId?: number;
    volumeLabel?: string | null;
    // Derived "group.bay" label (e.g. "3.2") for UNASSIGNED enclosure drives,
    // inferred from the labeled bridge sibling sharing the same USB port.
    // Null when not derivable (no labeled sibling, non-enclosure disk, etc.).
    derivedGroupLabel?: string | null;
    children: BlockDevicePartition[];
};

type RouteParams = Record<string, unknown>;
type FileInfoRouteParams = RouteParams & { normalizedPath: string };
type VerifyFileRouteParams = RouteParams & { objectId: string };
type UiRouteParams = RouteParams & { assetPath?: string };
type RouteHandler = (req: HttpRequest, params: RouteParams, res: HttpResponse) => Promise<unknown>;
type RouteDefinition = {
    method: string;
    match: (url: string) => RouteParams | null;
    handler: RouteHandler;
};
type RouteMatch = { handler: RouteHandler; params: RouteParams };

export type StatusResponse = {
    availableVolumeIds: number[];
    unavailableVolumeIds: number[];
    disabledVolumeIds: number[];
    readOnlyVolumeIds: number[];
    verifyErrors: Record<string, Volume['verifyErrors']>;
    gbStored: number;
    gbCapacity: number;
    gbFree: number;

    // FLEET ENCRYPTION COVERAGE -- reported as three disjoint lists rather than one percentage, because the
    // honest answer has three states and a percentage would round the dangerous one away.
    //
    // PARTIAL ENCRYPTION IS PARTIAL PROTECTION. Until every volume is converted, pulling any PLAINTEXT disk
    // still leaks every slice on it. The UI must not paint the array "protected" while `plaintextVolumeIds`
    // is non-empty -- that is the entire reason this is a list of ids and not a boolean.
    encryption: {
        encryptNewVolumes: boolean;
        hasRecoveryPassphrase: boolean;
        encryptedVolumeIds: number[];
        plaintextVolumeIds: number[];
        // Disk absent, so its filesystem cannot be read: we do NOT know, and we do not guess "plaintext".
        unknownVolumeIds: number[];

        // When the recovery passphrase was last PROVEN against the platters, and what it found. Null means
        // never -- which on an encrypted fleet means nobody has ever confirmed the disks can actually be
        // recovered. That is worth saying out loud rather than leaving as an absence.
        lastAudit: RecoveryAudit | null;
    };
};

type DebugResponse = {
    priorityStats: Array<{ volumeId: number; highCount: number; waiters: number }>;
    verifyStatus: VerifyVolumesStatus;
};

const log = createLogger('mgmt');

// Per-bucket counts/sizes are a $group over every file in the array. Cache them: they do not move fast
// enough to justify re-scanning 3.5M documents on every UI poll.
const BUCKET_STATS_TTL_MS = 60_000;

export class HttpMgmt {
    private static readonly routes: RouteDefinition[] = HttpMgmt.createRoutes();

    // WHILE THE NAMESPACE IS MISSING, ALMOST NOTHING HERE IS SAFE TO CALL.
    //
    // Recovery mode brings the FLEET up -- it must, because reading the snapshot off the platters is the whole
    // point -- and that leaves the admin API sitting there, fully armed, in front of a MongoDB that is empty
    // and that the array has explicitly declared non-authoritative. Two of these routes are loaded guns:
    //
    //   POST /$/snapshot   -- snapshots whatever Mongo currently holds (nothing), stores it, and PUBLISHES THE
    //                         POINTER to every disk. That is the exact catastrophe the marker exists to
    //                         prevent, reachable by hand, from the surface we deliberately left up.
    //
    //   DELETE /$/volumes  -- refuses to delete a volume that still holds objects, and asks Mongo how many. On
    //                         an empty database the answer for a live, full 3TB platter is ZERO. The volume is
    //                         marked deleted, the manifests are refreshed to say so, and every future recovery
    //                         SKIPS that disk. A disk full of the only copies of somebody's data, dropped
    //                         because the database we already know is empty said it was empty.
    //
    // So this is an ALLOWLIST, not a blocklist. Anything not named here is refused while the namespace is
    // missing -- which means a route added next year is safe by default rather than dangerous by default, and
    // that is the only way this stays true.
    // THESE PATHS ARE CHECKED AGAINST THE REAL ROUTE TABLE BY A TEST, and that test exists because the first
    // version of this list was WRITTEN FROM MEMORY and got the auth routes wrong -- it allowed `/$/login` and
    // `/$/password`, which do not exist. The real ones (`POST /$/session`, `PUT /$/admin/password`) were
    // therefore refused, so an operator could not log in, so they could not reach POST /$/restore, so the array
    // could not be recovered. The guard written to prevent a lockout WAS the lockout.
    //
    // If you add an entry here, it must match a route that actually exists. The test will tell you.
    static readonly NAMESPACE_RECOVERY_ALLOWLIST: Array<{ method: string; path: string }> = [
        // THE WAY OUT. Without these the array is bricked, and nothing else on this list matters.
        { method: 'POST', path: '/$/restore' },
        { method: 'POST', path: '/$/recover-fleet' },

        // ENOUGH AUTH TO GET IN AND USE THEM. An operator who cannot log in cannot restore.
        { method: 'GET', path: '/$/auth/status' },
        { method: 'POST', path: '/$/session' },              // log in
        { method: 'DELETE', path: '/$/session' },            // log out
        { method: 'PUT', path: '/$/admin/password' },        // first-boot password set
        { method: 'GET', path: '/$/auth/settings' },         // the SPA reads this before it renders a login

        // LOOKING IS NOT TOUCHING.
        { method: 'GET', path: '/$/status' },
        { method: 'GET', path: '/$/volumes' },
        { method: 'GET', path: '/$/snapshot' },              // READS the pointer. POST publishes one -- refused.
        { method: 'GET', path: '/$/debug' },
        { method: 'GET', path: '/$/blockDevices' },
        { method: 'GET', path: '/$/faults' },
        { method: 'GET', path: '/$/ui' }                     // prefix-matched below; the SPA itself
    ];

    private static allowedDuringNamespaceRecovery(method: string, url: string): boolean {
        return this.NAMESPACE_RECOVERY_ALLOWLIST.some(a =>
            a.method === method && (a.path === '/$/ui' ? url.startsWith('/$/ui') : url === a.path));
    }

    private static namespaceMissing = false;

    // Set by core.ts before the admin surface comes up, and never cleared in-process: a restore that succeeds
    // is followed by a restart into normal mode.
    static setNamespaceMissing(missing: boolean): void {
        this.namespaceMissing = missing;
    }

    static async handle(_requestId: number, req: HttpRequest, res: HttpResponse): Promise<unknown> {
        const method = req.method?.toUpperCase();
        const url = req.url;
        if (!method || !url)
            throw new HttpNotFoundError();

        const route = this.findRoute(method, url);
        if (!route)
            throw new HttpNotFoundError();

        if (this.namespaceMissing && !this.allowedDuringNamespaceRecovery(method, url))
            throw new HttpBadRequestError(`${method} ${url} is refused while the namespace has not been restored. `
                + `MongoDB is empty and the array has declared it non-authoritative, so anything that reads it to `
                + `make a decision -- how many objects are on a volume, what to put in a snapshot -- would be `
                + `acting on the belief that this array is empty. Restore the namespace first (POST /$/restore).`);

        // res is passed through so the few handlers that manage cookies (login/logout) can reach it;
        // the vast majority ignore it.
        return route.handler.call(this, req, route.params, res);
    }

    private static async handleVolumesRequest(req: HttpRequest): Promise<VolumeStatus[]> {
        const includeDeleted = this.shouldIncludeDeleted(req.params);
        return this.getVolumeStatus(includeDeleted);
    }

    private static async handleBlockDevicesRequest(req: HttpRequest): Promise<BlockDevice[]> {
        const devices = ioManager.getCachedDevices();
        const sortParam = this.resolveSortParam(req.params);
        return this.serializeBlockDevices(devices, sortParam);
    }

    private static async handleBlockDevicesReloadRequest(req: HttpRequest): Promise<BlockDevice[]> {
        await ioManager.reloadBlockDevices();
        return this.handleBlockDevicesRequest(req);
    }

    private static async handleUiRequest(_req: HttpRequest, params: UiRouteParams): Promise<HttpContentPayload> {
        const assetPath = typeof params.assetPath === 'string' ? params.assetPath : '';
        const candidates = this.getUiRootCandidates();

        for (const root of candidates) {
            const asset = await this.tryReadUiAsset(root, assetPath);
            if (!asset)
                continue;

            const { body, resolvedPath } = asset;
            const contentType = this.resolveUiContentType(resolvedPath);
            return {
                body,
                headers: {
                    'content-type': contentType,
                    'cache-control': assetPath ? 'public, max-age=300' : 'no-store'
                }
            };
        }

        throw new HttpNotFoundError('UI bundle not found');
    }

    private static serializeBlockDevices(devices: CachedDevice[], sortParam: 'name' | 'sysfsPath' | 'size' | 'volumeId' | 'volumeLabel'): BlockDevice[] {
        const enriched = devices.map(device => this.serializeCachedDevice(device));
        this.applyDerivedGroupLabels(enriched);
        enriched.sort((a, b) => {
            if (sortParam === 'sysfsPath')
                return String(a.sysfsPath ?? '').localeCompare(String(b.sysfsPath ?? ''));
            if (sortParam === 'size')
                return (Number(a.size) || 0) - (Number(b.size) || 0);
            if (sortParam === 'volumeId')
                return (Number(a.volumeId) || 0) - (Number(b.volumeId) || 0);
            if (sortParam === 'volumeLabel')
                return String(a.volumeLabel ?? '').localeCompare(String(b.volumeLabel ?? ''));
            return String(a.name ?? '').localeCompare(String(b.name ?? ''));
        });
        return enriched;
    }

    private static serializeCachedDevice(device: CachedDevice): BlockDevice {
        const sysfsResolved = path.resolve(`/sys/block/${device.name}`, device.sysfsPath);
        const children: BlockDevicePartition[] = device.partitions.map(partition => ({
            type: 'part' as const,
            name: partition.name,
            path: partition.path ?? (partition.name ? `/dev/${partition.name}` : undefined),
            uuid: partition.uuid ?? null,
            size: partition.size,
            fstype: partition.fsType ?? null,
            mountpoint: partition.mountPoint ?? null
        }));
        const serialized: BlockDevice = {
            name: device.name,
            path: `/dev/${device.name}`,
            type: 'disk' as const,
            size: device.size,
            model: device.model ?? null,
            vendor: device.vendor ?? null,
            serial: device.serial ?? null,
            ptuuid: device.partitionTableUuid ?? undefined,
            pttype: device.partitionTableType ?? undefined,
            sysfsPath: sysfsResolved,
            busGroup: device.busGroup ?? null,
            children
        };
        const primaryPartition = device.partitions.find(part => part.uuid);
        if (primaryPartition?.uuid) {
            const volume = ioManager.getVolumeByPartitionUuid(primaryPartition.uuid);
            if (volume) {
                serialized.volumeId = volume.id;
                serialized.volumeLabel = volume.label ?? null;
            }
        }
        return serialized;
    }

    // For UNASSIGNED enclosure drives, derive a "group.bay" label from the
    // labeled bridge sibling. The two drives behind one dual-drive USB bridge
    // share the same USB port (sysfs interface) and differ only by SCSI LUN
    // (0 and 1); their human bay numbers are consecutive. So an unassigned
    // drive's bay = sibling's bay + (ownLun - siblingLun). The enclosure group
    // number comes from the sibling's label. Left null when not derivable.
    private static applyDerivedGroupLabels(devices: BlockDevice[]): void {
        type Topo = { device: BlockDevice; bridgeKey: string; lun: number };
        const bridges = new Map<string, Topo[]>();
        const topos: Topo[] = [];
        for (const device of devices) {
            const topo = this.parseBridgeTopology(device.sysfsPath);
            if (!topo)
                continue;
            const entry: Topo = { device, bridgeKey: topo.bridgeKey, lun: topo.lun };
            topos.push(entry);
            const list = bridges.get(topo.bridgeKey);
            if (list)
                list.push(entry);
            else
                bridges.set(topo.bridgeKey, [entry]);
        }

        for (const entry of topos) {
            // Assigned devices already carry their real volume label.
            if (entry.device.volumeLabel)
                continue;
            const siblings = bridges.get(entry.bridgeKey);
            if (!siblings)
                continue;
            for (const sibling of siblings) {
                if (sibling === entry || sibling.lun === entry.lun)
                    continue;
                const parsed = this.parseGroupBayLabel(sibling.device.volumeLabel);
                if (!parsed)
                    continue;
                const derivedBay = parsed.bay + (entry.lun - sibling.lun);
                if (derivedBay < 1)
                    continue;
                entry.device.derivedGroupLabel = `${parsed.group}.${derivedBay}`;
                break;
            }
        }
    }

    // Extract the USB bridge interface (shared by both LUNs of a dual-drive
    // bridge) and the SCSI LUN from a resolved sysfs path, e.g.
    // /sys/.../2-3.4.2.1/2-3.4.2.1:1.0/host21/target21:0:0/21:0:0:1/block/sdv
    private static parseBridgeTopology(sysfsPath: string | null | undefined): { bridgeKey: string; lun: number } | null {
        if (!sysfsPath)
            return null;
        const match = /\/(\d+-[\d.]+:\d+\.\d+)\/host\d+\/target\d+:\d+:\d+\/\d+:\d+:\d+:(\d+)\//.exec(sysfsPath);
        if (!match)
            return null;
        return { bridgeKey: match[1], lun: Number(match[2]) };
    }

    private static parseGroupBayLabel(label: string | null | undefined): { group: number; bay: number } | null {
        if (!label)
            return null;
        const match = /^(\d+)\.(\d+)$/.exec(label);
        if (!match)
            return null;
        return { group: Number(match[1]), bay: Number(match[2]) };
    }

    private static async handleNotifyTestRequest(req: HttpRequest): Promise<{ delivered: string[]; failed: { transport: string; error: string }[]; suppressed: boolean; transports: string[] }> {
        const payload = await this.parseJsonBody<{ severity?: unknown; title?: unknown; body?: unknown }>(req);
        // Default to 'warning' so an empty test request exercises Slack, whose
        // default minimum severity is 'warning'.
        const severity = this.normalizeSeverity(payload.severity, 'warning');
        const title = typeof payload.title === 'string' && payload.title.length ? payload.title : 'STRUBS notification test';
        const body = typeof payload.body === 'string' && payload.body.length ? payload.body : 'This is a test notification from STRUBS.';
        const result = await notificationService.notify(
            { severity, title, body, context: { test: true } },
            { bypassCooldown: true }
        );
        return {
            delivered: result.delivered,
            failed: result.failed,
            suppressed: result.suppressed,
            transports: notificationService.listTransports()
        };
    }

    private static async handleFaultsRequest(): Promise<{ faults: SliceFault[] }> {
        return { faults: remediationService.listFaults() };
    }

    // --- admin authentication ---

    // Auth-exempt (the gate lets these through): tells the SPA whether to show login or the dashboard,
    // and whether a bootstrap password is still in effect.
    private static async handleAuthStatusRequest(req: HttpRequest): Promise<{ authenticated: boolean; passwordSet: boolean }> {
        const cookies = parseCookies(req.headers.cookie);
        const authed = adminAuth.verifySession(cookies[SESSION_COOKIE])
            || await this.bearerAuthorized(req);
        return { authenticated: authed, passwordSet: await adminAuth.isPasswordSet() };
    }

    // Auth-exempt. Verifies the password and mints a session cookie. A failed attempt is a 401.
    private static async handleSessionCreateRequest(req: HttpRequest, _params: unknown, res: HttpResponse): Promise<{ ok: true }> {
        // Fast reject before even reading the body when clearly throttled; verifyLoginPassword re-checks
        // atomically (the authoritative bound) after the body is parsed.
        if (adminAuth.isLoginLocked())
            throw new HttpTooManyRequestsError('too many failed login attempts; try again shortly');
        const payload = await this.parseJsonBody<{ password?: unknown }>(req);
        if (typeof payload.password !== 'string' || !payload.password)
            throw new HttpBadRequestError('password is required');
        const result = await adminAuth.verifyLoginPassword(payload.password);
        if (result === 'throttled')
            throw new HttpTooManyRequestsError('too many concurrent login attempts; try again shortly');
        if (result === 'invalid')
            throw new HttpUnauthorizedError('invalid password');
        res.setHeader('Set-Cookie', sessionSetCookie(adminAuth.createSession()));
        return { ok: true };
    }

    // Auth-exempt. Logout: clear the cookie AND bump the session epoch.
    //
    // Sessions are stateless signed tokens, so there is nothing server-side to forget -- clearing the
    // cookie alone would leave a copied token valid until it expired. Bumping the epoch revokes every
    // outstanding token, so on this single-admin system "log out" means "log out everywhere". That is the
    // safe reading, and unlike an in-memory denylist it survives a restart.
    private static async handleSessionDeleteRequest(req: HttpRequest, _params: unknown, res: HttpResponse): Promise<{ ok: true }> {
        void req;
        await adminAuth.destroyAllSessions();
        res.setHeader('Set-Cookie', sessionClearCookie());
        return { ok: true };
    }

    // Requires auth (not exempt). Changing the password invalidates every existing session, so other
    // logged-in browsers must re-authenticate.
    private static async handleAdminPasswordRequest(req: HttpRequest): Promise<{ ok: true }> {
        const payload = await this.parseJsonBody<{ currentPassword?: unknown; newPassword?: unknown }>(req);
        if (typeof payload.newPassword !== 'string' || payload.newPassword.length < 8)
            throw new HttpBadRequestError('newPassword must be at least 8 characters');
        // The trusted Unix socket is the lockout-recovery path: reset the password with NO current one
        // (you use the socket precisely because you have lost the password). Over the network, the
        // current password is required -- a live session must not silently rotate the credential.
        if (!req.trusted) {
            if (typeof payload.currentPassword !== 'string' || !await adminAuth.verifyPassword(payload.currentPassword))
                throw new HttpUnauthorizedError('current password is incorrect');
        }
        await adminAuth.setPassword(payload.newPassword);
        await adminAuth.destroyAllSessions();
        return { ok: true };
    }

    private static async handleAdminTokensListRequest(): Promise<{ tokens: unknown[] }> {
        return { tokens: await database.listAdminTokens() };
    }

    // The token is returned ONCE, here, and never again (only its hash is stored).
    private static async handleAdminTokenCreateRequest(req: HttpRequest): Promise<{ token: string; selector: string }> {
        const payload = await this.parseJsonBody<{ name?: unknown }>(req);
        const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : 'unnamed';
        return adminAuth.createToken(name);
    }

    private static async handleAdminTokenDeleteRequest(_req: HttpRequest, params: { selector: string }): Promise<{ removed: boolean }> {
        return { removed: await database.removeAdminToken(params.selector) };
    }

    // Panic button: revoke every bearer token at once. Password change deliberately does NOT do this
    // (tokens are independent automation credentials, like SSH keys -- a password rotation should not
    // silently break CI); this is the explicit "lock everyone out" action for a suspected compromise.
    private static async handleAdminTokensPurgeRequest(): Promise<{ removed: number }> {
        return { removed: await database.removeAllAdminTokens() };
    }

    // --- buckets ---

    // The bucket LIST: names, policy, and request counters. Deliberately does NOT compute object counts
    // and sizes -- that is a $group across 3.5M documents, and making the UI wait for it just to render
    // seven bucket names and their toggles is the wrong trade. The counts come from /$/buckets/stats,
    // which the UI fetches separately and merges in when it arrives.
    private static async handleBucketsListRequest(): Promise<{ buckets: unknown[]; enforced: boolean }> {
        const [buckets, enforced] = await Promise.all([
            database.listBuckets(),
            database.getRuntimeConfig('authEnforced')
        ]);
        const activity = getBucketActivity();
        const rows = buckets.map(b => ({
            id: b.id,
            name: b.name,
            publicRead: b.publicRead ?? null,     // null = unset (open while dark)
            publicWrite: b.publicWrite ?? null,
            activity: activity[b.name ?? ''] ?? { anon: 0, auth: 0 }
        }));
        return { buckets: rows, enforced: enforced === true };
    }

    // Per-bucket object count + logical size. This is the expensive one (a $group over every file), so it
    // is cached: the UI polls, and the numbers do not move fast enough to justify re-scanning the
    // collection every few seconds.
    private static bucketStatsCache: { at: number; rows: Array<{ bucketId: string; objectCount: number; logicalBytes: number }> } | null = null;
    private static bucketStatsInFlight: Promise<Array<{ bucketId: string; objectCount: number; logicalBytes: number }>> | null = null;

    private static async handleBucketStatsRequest(): Promise<{ stats: unknown[] }> {
        const now = Date.now();
        if (this.bucketStatsCache && now - this.bucketStatsCache.at < BUCKET_STATS_TTL_MS)
            return { stats: this.bucketStatsCache.rows };

        // Single-flight: several browser tabs polling at once must not each kick off the aggregation.
        if (!this.bucketStatsInFlight) {
            this.bucketStatsInFlight = database.computeBucketStats()
                .then(rows => {
                    this.bucketStatsCache = { at: Date.now(), rows };
                    return rows;
                })
                .finally(() => { this.bucketStatsInFlight = null; });
        }
        return { stats: await this.bucketStatsInFlight };
    }

    private static async handleBucketPolicyRequest(req: HttpRequest, params: { id: string }): Promise<{ updated: boolean }> {
        const payload = await this.parseJsonBody<{ publicRead?: unknown; publicWrite?: unknown }>(req);
        const policy: { publicRead?: boolean; publicWrite?: boolean } = {};
        if (payload.publicRead !== undefined) {
            if (typeof payload.publicRead !== 'boolean') throw new HttpBadRequestError('publicRead must be a boolean');
            policy.publicRead = payload.publicRead;
        }
        if (payload.publicWrite !== undefined) {
            if (typeof payload.publicWrite !== 'boolean') throw new HttpBadRequestError('publicWrite must be a boolean');
            policy.publicWrite = payload.publicWrite;
        }
        if (policy.publicRead === undefined && policy.publicWrite === undefined)
            throw new HttpBadRequestError('publicRead and/or publicWrite is required');

        // THE JOURNAL FIRST, then Mongo -- the same order as every other namespace change, and for the same
        // reason. The snapshot froze this bucket's policy at snapshot time; if a policy change is not recorded
        // anywhere else, a recovery restores the OLD one. Closing a bucket and then losing the database would
        // re-open it. Journaling first means the worst case is a policy recorded but not applied, which the
        // next write or a restore simply re-applies -- rather than one applied but never recorded, which a
        // restore silently rolls back.
        await journal.append({
            op: 'policy',
            ts: new Date().toISOString(),
            id: String(params.id),
            ...(policy.publicRead === undefined ? {} : { pr: policy.publicRead }),
            ...(policy.publicWrite === undefined ? {} : { pw: policy.publicWrite })
        });

        const updated = await database.setBucketPolicy(params.id, policy);
        if (!updated) throw new HttpNotFoundError('bucket not found');

        // AND IF MONGO HAD FAILED? The journal would then hold a policy record for a change the caller was told
        // did not happen -- and there is NO compensating record that can honestly undo it, because a `policy` has
        // no physical evidence for a replay to check it against, and a compensating record could fail in exactly
        // the same way.
        //
        // That is why the restore refuses to let a journalled policy OPEN a bucket (see restore.ts). It closes
        // the hole from the other end: whatever fails, and however it fails, the worst a stale or escaped policy
        // record can do is leave a bucket MORE closed than it should be. An operator sees that in a moment --
        // things stop being publicly readable -- and fixes it with one call. Nothing leaks, ever.
        return { updated };
    }

    // Browse a container's contents, like a file explorer. `path` is a raw storage path ('' = the root,
    // which lists the buckets). Paginated by name.
    //
    // The path is RE-TRAVERSED on every call rather than trusted: the UI deep-links a path in its URL, and
    // a link to a since-deleted folder must resolve to "gone", never to some other folder that now
    // occupies part of the chain.
    private static async handleBrowseRequest(req: HttpRequest): Promise<{
        path: string;
        entries: unknown[];
        hasMore: boolean;
    }> {
        const rawPath = typeof req.params.path === 'string' ? req.params.path : '';
        const after = typeof req.params.after === 'string' && req.params.after ? req.params.after : undefined;
        const limit = typeof req.params.limit === 'string' ? parseInt(req.params.limit, 10) : undefined;

        const path = rawPath.replace(/^\/+|\/+$/g, '');

        let containerId: string | null | undefined = null;
        if (path) {
            containerId = await database.resolveContainerStrict(path);
            if (containerId === undefined)
                throw new HttpNotFoundError(`no such path: ${path}`);
        }

        const { entries, hasMore } = await database.listContainerEntries(containerId ?? null, {
            after,
            limit: Number.isFinite(limit) ? limit : undefined
        });

        return {
            path,
            hasMore,
            entries: entries.map(e => ({
                id: e.id,
                name: e.name,
                isContainer: e.isContainer === true,
                isFile: e.isFile === true,
                size: e.size ?? null,
                mime: e.mime ?? null
            }))
        };
    }

    // --- object-API credentials ---

    private static validateGrants(raw: unknown): Grant[] {
        if (!Array.isArray(raw))
            throw new HttpBadRequestError('grants must be an array');
        return raw.map(g => {
            if (!g || typeof g !== 'object')
                throw new HttpBadRequestError('each grant must be an object');
            const { bucket, read, write } = g as Record<string, unknown>;
            if (typeof bucket !== 'string' || (bucket !== '*' && !isValidBucketName(bucket)))
                throw new HttpBadRequestError('grant bucket must be "*" or a valid bucket name');
            if (typeof read !== 'boolean' || typeof write !== 'boolean')
                throw new HttpBadRequestError('grant read and write must be booleans');
            return { bucket, read, write };
        });
    }

    private static async handleCredentialsListRequest(): Promise<{ credentials: unknown[] }> {
        const creds = await database.listCredentials();
        // secretHash is projected out at the repository; strip _id too and surface only what the UI needs.
        return {
            credentials: creds.map(c => ({
                accessKeyId: c.accessKeyId,
                name: c.name,
                grants: c.grants,
                enabled: c.enabled,
                createdAt: c.createdAt,
                lastUsedAt: c.lastUsedAt ?? null,
                expiresAt: c.expiresAt ?? null
            }))
        };
    }

    // The secret is returned ONCE here and never again (only its scrypt hash is stored).
    private static async handleCredentialCreateRequest(req: HttpRequest): Promise<{ accessKeyId: string; secret: string }> {
        const payload = await this.parseJsonBody<{ name?: unknown; grants?: unknown }>(req);
        const name = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : 'unnamed';
        const grants = this.validateGrants(payload.grants ?? []);
        const accessKeyId = crypto.randomBytes(12).toString('base64url');    // 16 chars, opaque
        const secret = crypto.randomBytes(24).toString('base64url');
        await database.createCredential({
            accessKeyId,
            secretHash: await scryptHash(secret),
            name,
            grants,
            enabled: true,
            createdAt: new Date()
        });
        // Belt-and-suspenders: drop any cached negative so a newly-created credential can never be shadowed
        // by a stale "no such key" verdict. (Bucket policy is read fresh per request, so it needs no clear.)
        clearCredentialCache();
        return { accessKeyId, secret };
    }

    private static async handleCredentialUpdateRequest(req: HttpRequest, params: { accessKeyId: string }): Promise<{ updated: boolean }> {
        const payload = await this.parseJsonBody<{ grants?: unknown; enabled?: unknown }>(req);
        if (payload.grants === undefined && payload.enabled === undefined)
            throw new HttpBadRequestError('grants and/or enabled is required');
        // Validate the ENTIRE payload before any DB write, so a malformed `enabled` can't leave a partial
        // grants change committed with the verify-cache still holding the old (broader) grants.
        const grants = payload.grants !== undefined ? this.validateGrants(payload.grants) : undefined;
        let enabled: boolean | undefined;
        if (payload.enabled !== undefined) {
            if (typeof payload.enabled !== 'boolean') throw new HttpBadRequestError('enabled must be a boolean');
            enabled = payload.enabled;
        }

        let updated = false;
        try {
            if (grants !== undefined)
                updated = await database.setCredentialGrants(params.accessKeyId, grants) || updated;
            if (enabled !== undefined)
                updated = await database.setCredentialEnabled(params.accessKeyId, enabled) || updated;
        }
        finally {
            // Clear if ANY write landed -- even if a later write throws -- so a disabled/grant-reduced
            // credential stops working NOW, not after the verify-cache TTL.
            if (updated) clearCredentialCache();
        }
        if (!updated) throw new HttpNotFoundError('credential not found');
        return { updated };
    }

    // Rotate: issue a NEW secret (shown once), invalidating the old one. Returns 404 if the key is gone.
    private static async handleCredentialRotateRequest(_req: HttpRequest, params: { accessKeyId: string }): Promise<{ accessKeyId: string; secret: string }> {
        const secret = crypto.randomBytes(24).toString('base64url');
        const ok = await database.setCredentialSecretHash(params.accessKeyId, await scryptHash(secret));
        if (!ok) throw new HttpNotFoundError('credential not found');
        clearCredentialCache();      // the old secret must stop verifying immediately
        return { accessKeyId: params.accessKeyId, secret };
    }

    private static async handleCredentialDeleteRequest(_req: HttpRequest, params: { accessKeyId: string }): Promise<{ removed: boolean }> {
        const removed = await database.removeCredential(params.accessKeyId);
        if (removed) clearCredentialCache();     // a deleted credential must stop verifying immediately
        return { removed };
    }

    // --- auth enforcement setting (the dark switch; NOT flipped here, just exposed) ---

    private static async handleAuthSettingsRequest(): Promise<{ authEnforced: boolean }> {
        return { authEnforced: (await database.getRuntimeConfig('authEnforced')) === true };
    }

    private static async handleAuthSettingsSetRequest(req: HttpRequest): Promise<{ authEnforced: boolean }> {
        const payload = await this.parseJsonBody<{ authEnforced?: unknown }>(req);
        if (typeof payload.authEnforced !== 'boolean')
            throw new HttpBadRequestError('authEnforced must be a boolean');
        if (payload.authEnforced) {
            // BLOCKER for the real flip (deliberately out of scope here): the object listener is plain
            // HTTP, so HTTP Basic credentials would cross the wire in cleartext. Before enforcement is
            // ever relied upon, the object API needs TLS (or the plaintext listener must reject Basic).
            log.error('WARNING: authEnforced enabled, but the object API is plain HTTP -- Basic '
                + 'credentials will be sent in CLEARTEXT. Add TLS to the object listener before relying on this.');
        }
        await database.setRuntimeConfig('authEnforced', payload.authEnforced);
        invalidateAuthEnforcedCache();      // so the choke point sees the change without waiting out its TTL
        return { authEnforced: payload.authEnforced };
    }

    private static matchBucketPolicyRoute(url: string): { id: string } | null {
        const match = /^\/\$\/buckets\/([0-9a-f]{24})\/policy$/i.exec(url);
        return match ? { id: match[1] } : null;
    }

    private static matchCredentialRoute(url: string): { accessKeyId: string } | null {
        const match = /^\/\$\/credentials\/([^/]+)$/.exec(url);
        return match ? { accessKeyId: decodeURIComponent(match[1]) } : null;
    }

    private static matchCredentialRotateRoute(url: string): { accessKeyId: string } | null {
        const match = /^\/\$\/credentials\/([^/]+)\/rotate$/.exec(url);
        return match ? { accessKeyId: decodeURIComponent(match[1]) } : null;
    }

    private static async bearerAuthorized(req: HttpRequest): Promise<boolean> {
        const auth = req.headers.authorization;
        return typeof auth === 'string' && auth.startsWith('Bearer ')
            ? adminAuth.verifyBearer(auth.slice(7).trim())
            : false;
    }

    private static normalizeSeverity(raw: unknown, fallback: Severity = 'info'): Severity {
        if (raw === 'info' || raw === 'warning' || raw === 'critical')
            return raw;
        return fallback;
    }

    private static async handleVerifyVolumesJobStartRequest(req: HttpRequest): Promise<{ startedAt: string }> {
        const payload = await this.parseJsonBody<{ volumeIds?: unknown; mode?: unknown }>(req);
        const volumeIds = this.normalizeVolumeIdFilter(payload.volumeIds);
        const mode = this.normalizeVerifyMode(payload.mode);
        return verifyVolumesJob.start({ volumeIds: volumeIds ?? undefined, mode });
    }

    private static normalizeVerifyMode(raw: unknown): 'light' | 'full' {
        if (raw === undefined || raw === null)
            return 'full';
        if (raw === 'light' || raw === 'full')
            return raw;
        throw new HttpBadRequestError("mode must be 'light' or 'full'");
    }

    private static resolveSortParam(params: Record<string, unknown>): 'name' | 'sysfsPath' | 'size' | 'volumeId' | 'volumeLabel' {
        const raw = params.sort;
        const value = Array.isArray(raw) ? raw[0] : raw;
        if (value === 'sysfsPath')
            return 'sysfsPath';
        if (value === 'size')
            return 'size';
        if (value === 'volumeId')
            return 'volumeId';
        if (value === 'volumeLabel')
            return 'volumeLabel';
        return 'name';
    }

    private static async handleVerifyVolumesJobStopRequest(): Promise<{ stopped: boolean }> {
        await verifyVolumesJob.stop();
        return { stopped: true };
    }

    private static async handleVerifyVolumesJobStatusRequest(): Promise<VerifyVolumesStatus> {
        return verifyVolumesJob.getStatus();
    }

    private static async handleVerifyFileRequest(req: HttpRequest, params: VerifyFileRouteParams): Promise<unknown> {
        const objectId = this.parseObjectId(params);
        const payload = await this.parseJsonBody<{ mode?: unknown }>(req);
        const mode = this.normalizeVerifyMode(payload.mode);
        try {
            return await verifyFileJob.verify(objectId, { mode });
        }
        catch (err) {
            const code = (err as { code?: string })?.code;
            if (code === 'ENOENT')
                throw new HttpNotFoundError();
            if (code === 'ENOTFILE')
                throw new HttpBadRequestError('object is not a file');
            if (code === 'EMAINTENANCE')
                throw new HttpBadRequestError('maintenance freeze active; verification disabled');
            throw err;
        }
    }

    private static async handleMaintenanceFreezeStatusRequest(): Promise<{ frozen: boolean }> {
        return { frozen: await isMaintenanceFrozen() };
    }

    // Persist the freeze flag AND apply it to the live services so the change
    // takes effect immediately (not just on the next restart). Freezing stops the
    // scheduler/worker and asks any in-flight verify run to stop while preserving
    // its persisted progress; unfreezing restarts them mirroring core.ts's boot
    // config so behaviour matches a fresh, unfrozen start.
    private static async handleMaintenanceFreezeSetRequest(req: HttpRequest): Promise<{ frozen: boolean }> {
        const payload = await this.parseJsonBody<{ frozen?: unknown }>(req);
        if (typeof payload.frozen !== 'boolean')
            throw new HttpBadRequestError('frozen must be a boolean');
        const frozen = payload.frozen;
        await setMaintenanceFrozen(frozen);
        if (frozen) {
            verifyScheduler.stop();
            repairWorker.stop();
            drainVolumeJob.stop();
            rebalanceJob.stop();
            await verifyVolumesJob.stop({ preserveState: true });
        }
        else {
            // Drains run before routine maintenance; rebalance (housekeeping) resumes last.
            await drainVolumeJob.resumePendingJob();
            verifyScheduler.start(config.scrubIntervalMs);
            repairWorker.start(config.repairIntervalMs, {
                batchSize: config.repairBatchSize,
                backlogDelayMs: config.repairBacklogDelayMs,
                blockedRetryMs: config.repairBlockedRetryMs
            });
            await rebalanceJob.resumePendingJob();
        }
        return { frozen };
    }

    private static async handleStatusRequest(): Promise<StatusResponse> {
        const available: number[] = [];
        const unavailable: number[] = [];
        const disabled: number[] = [];
        const readOnly: number[] = [];
        const verifyErrors: Record<string, Volume['verifyErrors']> = {};
        const encrypted: number[] = [];
        const plaintext: number[] = [];
        const unknownEncryption: number[] = [];
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

            if (volume.isDeleted) {
                // Not part of the fleet, so not part of its coverage either way.
            }
            else if (!volume.isPresent)
                unknownEncryption.push(id);
            else if (volume.isEncrypted)
                encrypted.push(id);
            else
                plaintext.push(id);
        }

        return {
            availableVolumeIds: available,
            unavailableVolumeIds: unavailable,
            disabledVolumeIds: disabled,
            readOnlyVolumeIds: readOnly,
            verifyErrors,
            gbStored: bytesStored / (1024 ** 3),
            gbCapacity: bytesCapacity / (1024 ** 3),
            gbFree: bytesFree / (1024 ** 3),
            encryption: {
                encryptNewVolumes: await database.getRuntimeConfig(ENCRYPT_NEW_VOLUMES_KEY) === true,
                hasRecoveryPassphrase: await hasRecoveryPassphrase(),
                encryptedVolumeIds: encrypted,
                plaintextVolumeIds: plaintext,
                unknownVolumeIds: unknownEncryption,
                lastAudit: await lastRecoveryAudit()
            }
        };
    }

    private static async handleDebugRequest(): Promise<DebugResponse> {
        const priorityStats = volumePriorityManager.getStats();
        const verifyStatus = verifyVolumesJob.getStatus();

        return {
            priorityStats,
            verifyStatus
        };
    }

    // RECOMPUTE THE STATISTICS FROM THE OBJECT RECORDS.
    //
    // The per-volume counters are a CACHE kept up to date by incremental deltas, and under live traffic those
    // deltas can drift. A full reconcile runs on a timer -- but there was no way to ASK for one, so an operator
    // watching a volume report "-16 files" had no move except to wait six hours for the scheduler.
    //
    // It touches no disk and no object: it recomputes derived numbers from `content`. Takes ~50 seconds on this
    // array, so it is awaited rather than fired and forgotten -- an operator asking for a recount wants to know
    // it happened.
    private static async handleStorageStatsReconcileRequest(): Promise<StorageStatsSnapshot> {
        log('recomputing the storage statistics on request');
        await storageStatsTracker.reconcile();

        const snapshot = await storageStatsTracker.getSnapshot();
        if (!snapshot)
            throw new Error('storage stats unavailable');
        return snapshot;
    }

    private static async handleStorageStatsRequest(): Promise<StorageStatsSnapshot> {
        let snapshot = await storageStatsTracker.getSnapshot();
        if (!snapshot) {
            await storageStatsTracker.reconcile();
            snapshot = await storageStatsTracker.getSnapshot();
        }
        if (!snapshot)
            throw new Error('storage stats unavailable');
        return snapshot;
    }

    private static async handleVolumeCreationRequest(req: HttpRequest): Promise<VolumeStatus> {
        const payload = await this.parseJsonBody<{
            blockPath?: string; wipe?: unknown; replace?: unknown; encrypt?: unknown; recoveryPassphrase?: unknown;
        }>(req);
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

        if (payload.encrypt !== undefined && typeof payload.encrypt !== 'boolean')
            throw new HttpBadRequestError('encrypt must be a boolean');
        if (payload.recoveryPassphrase !== undefined && typeof payload.recoveryPassphrase !== 'string')
            throw new HttpBadRequestError('recoveryPassphrase must be a string');

        const volumeConfig = await deviceProvisioner.provision({
            blockPath,
            wipe: wipeFlag,
            replace: replace as boolean | undefined,
            // Left undefined, the provisioner falls back to the fleet default (encryptNewVolumes).
            encrypt: payload.encrypt as boolean | undefined,
            recoveryPassphrase: payload.recoveryPassphrase as string | undefined
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

    // Take a snapshot NOW. Awaited, not fired and forgotten: an operator asking for one before pulling a
    // disk wants to know it WORKED, and the whole point of the job is that it verifies itself.
    private static async handleSnapshotRequest(): Promise<{ objectId: string; objects: number; containers: number; bytes: number }> {
        try {
            const result = await snapshotJob.run();
            return {
                objectId: result.objectId,
                objects: result.objects,
                containers: result.containers,
                bytes: result.bytes
            };
        }
        catch (err) {
            throw new HttpBadRequestError(err instanceof Error ? err.message : String(err));
        }
    }

    // STEP ONE OF THE WORST DAY: ask the disks who they are.
    //
    // This is the only thing that works on a bare host, because it is the only thing that does not need the
    // fleet -- and the fleet cannot mount without the volume table, which lived in the database that is gone.
    // It reads every disk read-only, works out which array this is by MAJORITY (a single disk from somebody
    // else's array must not be allowed to become us), adopts that identity -- never generates one -- and
    // writes the volume table back.
    //
    // Then STRUBS is restarted, the fleet comes up, and /$/restore can rebuild the namespace. Two steps, and
    // deliberately so: mounting thirty drives on a host that has just decided who it is deserves a look
    // before the next thing starts writing to them.
    private static async handleRecoverFleetRequest(req: HttpRequest): Promise<FleetRecoverySummary> {
        type Body = { force?: boolean; recoveryPassphrase?: string };
        const body = await this.parseJsonBody<Body>(req).catch(() => ({} as Body));

        const recoveryPassphrase = typeof body?.recoveryPassphrase === 'string' && body.recoveryPassphrase
            ? body.recoveryPassphrase
            : undefined;

        try {
            return await recoverFleetFromDisks({
                findManifests: (options) => findManifestsOnDevices(options),
                adoptIdentity: (identity: string) => config.adoptIdentity(identity),
                existingVolumes: () => database.getVolumes(),
                writeVolumes: (configs) => database.restoreVolumes(configs as never),
                restoreInterrupted: () => database.fleetRestoreIncomplete(),
                beginRestore: (expected: number) => database.beginFleetRestore(expected)
            }, { force: body?.force === true, recoveryPassphrase });
        }
        catch (err) {
            throw new HttpBadRequestError(err instanceof Error ? err.message : String(err));
        }
    }

    // REBUILD THE NAMESPACE FROM THE PLATTERS.
    //
    // Defaults to a DRY RUN, and that default is the point. This is the operation you reach for on the worst
    // day you will ever have with this array, and the first thing you want from it is not action -- it is an
    // honest account of what is actually still there. So it tells you, and changes nothing, until you say
    // otherwise.
    private static async handleRestoreRequest(req: HttpRequest): Promise<RestoreSummary & { applied: boolean }> {
        const body = await this.parseJsonBody<{ apply?: boolean; force?: boolean }>(req)
            .catch(() => ({} as { apply?: boolean; force?: boolean }));
        const apply = body?.apply === true;

        try {
            // A NULL SNAPSHOT POINTER MEANS ONE OF TWO VERY DIFFERENT THINGS, and the restore is about to tell
            // an operator their namespace is gone. Make sure that is actually what happened.
            if (!bootstrapManifestWriter.getSnapshot() && bootstrapManifestWriter.hydrationWasIncomplete())
                throw new HttpBadRequestError('this host could not read the bootstrap manifest off some of its '
                    + 'disks, and found no snapshot pointer on the ones it could read. That is NOT the same as '
                    + 'there being no snapshot -- the pointer may be sitting on a disk that would not answer. '
                    + 'Refusing to tell you your namespace is gone on the strength of a disk that is not talking. '
                    + 'Fix the disks and restart.');

            // ...and hand it the PREVIOUS snapshot too. We keep one for exactly this moment: if the newest
            // snapshot object turns out to be below quorum, an intact older copy of every name is right there
            // on the platters, named in the manifest we have already read. A namespace a few hours stale, with
            // the journal replayed on top, is not a hard trade against "everything is gone".
            const summary = await namespaceRestore.run(bootstrapManifestWriter.getSnapshot(),
                { apply, force: body?.force === true, previous: bootstrapManifestWriter.getPreviousSnapshot() });
            return { ...summary, applied: apply };
        }
        catch (err) {
            throw new HttpBadRequestError(err instanceof Error ? err.message : String(err));
        }
    }

    // What the database says, against what is actually on the platters. Read-only: it finds drift, it does
    // not repair it -- deciding what to do about an orphan or a phantom is not a decision to make behind an
    // operator's back.
    private static async handleDriftScrubRequest(): Promise<DriftReport> {
        try {
            return await driftScrubJob.run();
        }
        catch (err) {
            throw new HttpBadRequestError(err instanceof Error ? err.message : String(err));
        }
    }

    private static handleSnapshotStatusRequest(): { running: boolean; current: ManifestSnapshotRef | null } {
        return {
            running: snapshotJob.isRunning(),
            current: bootstrapManifestWriter.getSnapshot()
        };
    }

    // A retired encrypted volume coming back into service. While it was deleted, rotations passed it by -- so it
    // may be carrying a passphrase the fleet has since abandoned, and nothing in normal service would notice,
    // because STRUBS mounts with the keyfile and never touches the passphrase slot.
    //
    // Require its disk to be here (so the next rotation can reach it), and make the operator's next move obvious.
    private static async assertVolumeMayReturn(id: number): Promise<void> {
        // NO DISK, NO UNDELETE -- for ANY volume, encrypted or not.
        //
        // The earlier version asked `luksEncryptedVolumes` first and returned early if the id was not in it. That
        // record lives in the same database you may have just restored, so "not in the record" does not mean
        // "not encrypted" -- it can equally mean "the record is gone". The check that was supposed to be
        // unconditional was conditional on the one thing least worth trusting.
        //
        // So do not ask the database at all. If the disk is not here we cannot tell what is on it, and a volume
        // whose disk is absent has nothing to offer by being restored anyway. The same coarse rule as rotation:
        // when the answer matters and the disk is the only thing that knows it, the disk has to be present.
        const volume = ioManager.getVolume(id);

        if (!await volumeDiskIsAttached(volume?.partitionUuid ?? null))
            throw new HttpBadRequestError(
                `refusing to restore volume ${id}: its disk is not attached, so we cannot tell what is on it. If `
                + `it is encrypted, rotations that happened while it was deleted did not reach it -- it could be `
                + `carrying a recovery passphrase nobody has, and nothing in normal service would tell you, `
                + `because STRUBS unlocks with the keyfile. Attach the disk and try again.`
            );

        // The disk is here, so the PLATTER can tell us whether it is encrypted -- no database required.
        const { ours } = await scanFleet();

        if (ours.some(disk => disk.volumeId === id))
            log.error('volume%d is ENCRYPTED and is being restored after being deleted. Any passphrase rotation '
                + 'that happened while it was retired did not reach it, so it may still hold an OLD recovery '
                + 'passphrase. Run POST /$/encryption/audit to find out, and PUT /$/encryption/passphrase (with '
                + 'every disk attached) to rewrite it.', id);
    }

    private static async handleVolumeDeleteRequest(params: RouteParams): Promise<{ deleted: boolean }> {
        const id = this.parseVolumeId(params);
        // Under the same gate as an encrypted provision: a rotation walks only the volumes that are not deleted,
        // so a volume changing deleted-ness mid-rotation is one the rotation may reach or may skip depending on
        // nothing but timing. See withEncryptionSlot().
        return withEncryptionSlot(() => this.doVolumeDelete(id));
    }

    private static async doVolumeDelete(id: number): Promise<{ deleted: boolean }> {
        await this.assertVolumeRemovable(id);
        await database.softDeleteVolume(id);
        await ioManager.softDeleteVolume(id).catch(() => undefined);

        // NOTE: nothing about encryption is recorded here, and nothing needs to be.
        //
        // A soft delete is REVERSIBLE, and there used to be an anxious dance around that: remember whether the
        // retired volume was encrypted, so a later rotation would know to refuse while its disk was away. Every
        // version of that was wrong, because the memory lived in the database a restore can take away.
        //
        // The volume cannot come back without its disk (see assertVolumeMayReturn), and a rotation refuses while
        // ANY volume is absent. Both rules ask the platters. Neither needs to remember anything.
        return { deleted: true };
    }

    // A volume may only be removed once no LIVE object references its slices. Documented-dead objects
    // (recoveryComment) are excluded (accepted loss). This forces an drain-first workflow so a drive is
    // never pulled with recoverable data still on it.
    private static async assertVolumeRemovable(id: number): Promise<void> {
        await this.assertNotLastJournalCopy(id);

        const liveRefs = await database.countObjectsOnVolume(id, { excludeDead: true });
        if (liveRefs > 0)
            throw new HttpBadRequestError(`volume ${id} still holds ${liveRefs} live object slice(s); drain it first: POST /$/volumes/${id}/drain`);
    }

    // Refuse to remove a volume holding the ONLY surviving copy of a journal segment. Journal files are
    // not object slices: the drain relocates what `content` references and knows nothing about .journal/,
    // so nothing else stops you from pulling the last copy of the namespace's recent history. Same shape
    // as refusing to delete a volume that still holds live slices, and for the same reason.
    private static async assertNotLastJournalCopy(id: number): Promise<void> {
        try {
            await journal.assertNotLastCopy(id);
        }
        catch (err) {
            throw new HttpBadRequestError(err instanceof Error ? err.message : String(err));
        }
    }

    // Move the JOURNAL off a volume that is on its way out, and WAIT for it. The fleet-change hook fires
    // re-election too, but fire-and-forget -- and a drain is the moment an operator starts treating a disk
    // as removable. A draining volume is no longer writable, so re-election excludes it and copies its
    // segments onto a replacement.
    //
    // A FAILURE HERE FAILS THE DRAIN. Swallowing it would let a drain "succeed" with the journal still
    // only on the disk being pulled -- and "drain returned" is exactly what an operator reads as "safe to
    // pull". The removal guard would still catch a formal DELETE, but not a hand on a drive tray.
    //
    // relocateOff() PROVES the journal left rather than assuming it: re-election resolving is not evidence
    // (it drops a replica whose copy failed and carries on). The drain job asserts the same invariant for
    // itself, because a resumed or auto-continued drain never passes through here.
    private static async relocateJournalOffVolume(id: number): Promise<void> {
        try {
            await journal.relocateOff(id);
        }
        catch (err) {
            log.error('journal relocation off volume%d failed: %s', id, err);
            throw new HttpBadRequestError(
                `refusing to drain volume ${id}: the namespace journal could not be relocated off it `
                + `(${err instanceof Error ? err.message : String(err)}). Draining now would leave the journal on a `
                + `disk you are about to remove.`
            );
        }
    }

    // ENCRYPT AN EXISTING VOLUME -- the on-demand conversion, and the same operation the fleet backfill runs
    // one disk at a time.
    //
    // You cannot encrypt a disk in place. Every honest path is drain -> rebuild -> refill, so this is a wrapper
    // over machinery that already exists and is already proven: the operator (or the drain queue) empties the
    // volume, this rebuilds the empty disk as a LUKS container under the SAME volume id, and the rebalance
    // refills it from the rest of the fleet.
    //
    // IT REFUSES A VOLUME THAT STILL HOLDS DATA. It does not drain for you. A single endpoint that silently
    // drained 4.4TB and then wiped the disk is exactly the kind of thing that gets fired off at 2am against the
    // wrong id -- so the destructive half demands that the disk already be empty, and the emptiness is checked
    // against Mongo (live slices) and the journal, not taken on trust.
    private static async handleVolumeEncryptRequest(req: HttpRequest, params: RouteParams): Promise<VolumeStatus> {
        const id = this.parseVolumeId(params);
        const payload = await this.parseJsonBody<{ recoveryPassphrase?: unknown }>(req);
        const passphrase = payload.recoveryPassphrase;

        if (typeof passphrase !== 'string' || !passphrase)
            throw new HttpBadRequestError('recoveryPassphrase is required to encrypt a volume');

        const volume = ioManager.getVolume(id);
        if (!volume)
            throw new HttpNotFoundError();

        if (volume.isEncrypted)
            throw new HttpBadRequestError(`volume ${id} is already encrypted`);

        const blockPath = volume.blockPath;
        if (!blockPath || !volume.isPresent)
            throw new HttpBadRequestError(`volume ${id} has no disk present: nothing to convert`);

        // THE DOOR MUST ALREADY BE SHUT. WE DO NOT SHUT IT OURSELVES AND WALK STRAIGHT IN.
        //
        // "It holds no slices" is a statement about the PAST the instant it returns, and a PUT commits its
        // slice files BEFORE it inserts the object record. So a write that had already chosen this volume can
        // still be laying slices down while we scan -- and if we flipped the volume read-only ourselves a
        // moment ago, that window is wide open: the placer let the write in before the flag, the scan sees
        // nothing, the wipe destroys the slices, and the insert lands afterwards pointing at them. A PHANTOM,
        // which reads as data loss.
        //
        // There is no in-flight-write counter to wait on, so we do not pretend to quiesce. We DEMAND that the
        // volume is ALREADY read-only -- which is precisely what a completed drain leaves behind, and a drain
        // takes hours. The quiesce is the operator's drain, not a millisecond of ours.
        if (!volume.isReadOnly)
            throw new HttpBadRequestError(
                `refusing to convert volume ${id}: it is still writable. Encrypting a volume WIPES it, and a `
                + `writable volume can be taking new slices this very moment. Drain it first `
                + `(POST /$/volumes/${id}/drain) -- a completed drain leaves it read-only and empty, which is `
                + `the state this needs.`
            );

        // The same two checks that gate pulling a disk out of the array -- because this destroys the disk just
        // as thoroughly, and "it grew back" is no comfort to an object that was below quorum when it did.
        // (Live slices, and the last surviving copy of a journal segment.)
        await this.assertVolumeRemovable(id);

        // ...AND THEN ASK THE DISK, BECAUSE THE DISK IS AUTHORITATIVE AND MONGO IS A DERIVED INDEX.
        //
        // Everything above this line asks MONGO whether the volume is empty, and Mongo does not know:
        //
        //   - A PUT commits its SLICE FILES FIRST and inserts the object record afterwards. A write already in
        //     flight when we started has its slices on the platter and nothing in `content` yet -- so the count
        //     says zero, we wipe, and the insert lands moments later pointing at slices that no longer exist.
        //     That is a PHANTOM: a record whose data is gone, which reads as data loss.
        //
        //   - ORPHAN SLICES ARE RECOVERABLE DATA. A slice with no record can be rebuilt into one (that is what
        //     the whole of DR-E does). Mongo has never heard of it, so `countObjectsOnVolume` returns zero for
        //     a disk with 9,000 recoverable orphans on it, and we would wipe every one. ORPHANS BEAT PHANTOMS
        //     is the rule, and destroying orphans on the strength of Mongo's silence inverts it.
        //
        // So walk the platter. Zero slice FILES, or no conversion. buildSliceIndex fails closed -- a directory
        // it could not read throws rather than reporting an empty disk -- which is exactly the property a wipe
        // guard needs and exactly the property a Mongo count does not have.
        await this.assertPlatterHoldsNoSlices(volume);

        // Stop and unbind, keeping the record. The provisioner re-registers under the same id.
        await ioManager.deregisterVolume(id);

        let volumeConfig;
        try {
            volumeConfig = await deviceProvisioner.provision({
                blockPath,
                wipe: true,
                replace: true,
                encrypt: true,
                recoveryPassphrase: passphrase,
                convertVolumeId: id
            });
        }
        catch (err) {
            // The volume is deregistered but its record still exists, so nothing has been lost -- but it has
            // also silently vanished from the fleet, and a volume that is merely ABSENT is one nobody
            // investigates. Put it back so it fails VISIBLY: if the disk was already wiped it will now show up
            // as a volume that cannot mount, which is exactly what it is.
            const existing = (await database.getVolumes()).find(v => v.id === id);
            if (existing)
                await ioManager.registerVolume(existing).catch(reregisterErr =>
                    log.error('volume%d could not be put back into the fleet after a failed conversion: %s',
                        id, reregisterErr));

            log.error('conversion of volume%d failed: %s', id, err);
            throw err;
        }

        // Back into service, empty. Clearing draining + read-only is what lets the rebalance refill it -- an
        // encrypted volume left read-only would just sit there looking converted and doing nothing.
        await database.updateVolumeFlags(id, { isDraining: false, isReadOnly: false });
        await ioManager.updateVolumeFlags(id, { isDraining: false, isReadOnly: false });

        const converted = ioManager.getVolume(volumeConfig.id);
        if (!converted)
            throw new Error('failed to re-register the converted volume');

        log('volume%d converted to an encrypted volume; the rebalance will refill it', id);
        return this._serializeVolume(volumeConfig.id, converted);
    }

    // Walk the volume's own platter and refuse if a single slice file is left on it. See the call site: this
    // is the only check in the conversion that consults the authoritative copy rather than the index of it.
    private static async assertPlatterHoldsNoSlices(volume: Volume): Promise<void> {
        if (!volume.isMounted || !volume.mountPoint)
            throw new HttpBadRequestError(
                `refusing to convert volume ${volume.id}: it is not mounted, so its platter cannot be scanned. `
                + `A disk we cannot read is not a disk with nothing on it.`
            );

        // ASK THE KERNEL, NOT OUR OWN FLAG.
        //
        // `volume.isMounted` is a belief held in memory, and the whole reason isMountStale() exists is that it
        // can be WRONG -- a USB disk drops, the mount goes, and the flag stays true until the next reconcile.
        // In that window `volume.mountPoint` is an empty directory on the ROOT FILESYSTEM, and a scan of it
        // finds no slices, and reports the disk clean, and we wipe a platter full of orphans on the strength of
        // a readdir of /run/strubs/mounts/<uuid> that never touched the disk at all.
        //
        // So confirm with /proc/mounts that something really is mounted there -- and on an encrypted volume,
        // that it is OUR mapper -- before believing a single thing the scan says.
        const mounts = await readProcMounts();
        const source = mounts.get(volume.mountPoint);

        if (!source)
            throw new HttpBadRequestError(
                `refusing to convert volume ${volume.id}: the kernel says nothing is mounted at `
                + `${volume.mountPoint}, even though the volume believes it is mounted. Its platter cannot be `
                + `scanned, so it cannot be shown to be empty.`
            );

        // `if (expected && ...)` would SKIP the check when we could not work out what to expect -- a
        // fail-open shape in a guard whose whole job is to fail closed. Unreachable today (the caller has
        // already refused a volume with no blockPath), and written so that it stays safe if that ever changes.
        const expected = volume.isEncrypted ? luksMapperPath(volume.uuid) : volume.blockPath;
        if (!expected)
            throw new HttpBadRequestError(
                `refusing to convert volume ${volume.id}: we cannot say which device ought to be mounted at `
                + `${volume.mountPoint}, so we cannot confirm the platter we are about to wipe is the right one.`
            );

        if (source !== expected)
            throw new HttpBadRequestError(
                `refusing to convert volume ${volume.id}: ${volume.mountPoint} is mounted from ${source}, not `
                + `from ${expected}. That is not this volume's disk, and scanning it would tell us nothing about `
                + `the platter we are about to wipe.`
            );

        // And the tree itself has to be there. buildSliceIndex reads a missing directory as an empty one --
        // right for a fleet-wide scan (a volume legitimately has no `strubs/` until its first write), wrong
        // for a guard whose entire job is to prove a specific disk is empty.
        try {
            await fs.stat(`${volume.mountPoint}/strubs`);
        }
        catch (err) {
            throw new HttpBadRequestError(
                `refusing to convert volume ${volume.id}: ${volume.mountPoint}/strubs could not be read `
                + `(${err instanceof Error ? err.message : String(err)}). An empty answer from a directory we `
                + `cannot read is not evidence that the disk is empty.`
            );
        }

        let index;
        try {
            index = await buildSliceIndex([{ volumeId: volume.id, mountPoint: volume.mountPoint }]);
        }
        catch (err) {
            // The scan itself refused (an unreadable directory). Fail closed: that is what it is for.
            throw new HttpBadRequestError(
                `refusing to convert volume ${volume.id}: its platter could not be scanned `
                + `(${err instanceof Error ? err.message : String(err)}).`
            );
        }

        if (index.size > 0)
            throw new HttpBadRequestError(
                `refusing to convert volume ${volume.id}: ${index.size} slice file(s) are still on the disk, `
                + `even though the database lists none. Those are ORPHANS -- slices with no record -- and they `
                + `are RECOVERABLE data that this wipe would destroy. Run the drift scrub, resolve them, and `
                + `try again. (If a write was in flight when the drain finished, simply re-draining may clear `
                + `them.)`
            );
    }

    // DOES THE RECOVERY PASSPHRASE STILL OPEN EVERY ENCRYPTED DISK?
    //
    // The one question about an encrypted fleet that nothing else in the system will ever ask. STRUBS mounts
    // with the KEYFILE, so a disk whose passphrase slot has rotted, been changed by hand, or was never the
    // fleet's to begin with serves flawlessly for years -- and announces itself on the single day it matters,
    // when the OS disk is dead and the passphrase from the safe opens eleven of thirty disks.
    //
    // ~3 seconds per encrypted volume (argon2id is memory-hard on purpose). Slow, thorough, and exactly the
    // kind of check that belongs on a schedule rather than bolted onto the front of a provision.
    private static async handleEncryptionAuditRequest(req: HttpRequest): Promise<RecoveryAudit> {
        const payload = await this.parseJsonBody<{ recoveryPassphrase?: unknown }>(req);

        if (typeof payload.recoveryPassphrase !== 'string' || !payload.recoveryPassphrase)
            throw new HttpBadRequestError(
                'recoveryPassphrase is required: the audit puts it against every encrypted disk\'s LUKS header, '
                + 'which is the only way to know it still opens them. We do not keep it on the machine it is '
                + 'meant to recover.'
            );

        return await auditRecoveryKey(payload.recoveryPassphrase);
    }

    // SET OR CHANGE THE FLEET RECOVERY PASSPHRASE.
    //
    // This works -- and it is the reason the rest of the encryption code can be as simple as it is -- because we
    // hold the KEYFILE, and the keyfile opens every disk. So the passphrase is not something we have to discover
    // from the platters and defend against drifting: it is something we WRITE, to every disk, whenever we like.
    //
    // Changing it rewrites the second keyslot on every encrypted volume. See setFleetRecoveryPassphrase() for
    // the ordering, which is chosen so that a crash can never leave a disk that no known passphrase opens.
    private static async handleEncryptionPassphraseRequest(req: HttpRequest): Promise<PassphraseRotation> {
        const payload = await this.parseJsonBody<{ passphrase?: unknown; currentPassphrase?: unknown }>(req);

        if (typeof payload.passphrase !== 'string' || !payload.passphrase)
            throw new HttpBadRequestError('passphrase is required');
        if (payload.currentPassphrase !== undefined && typeof payload.currentPassphrase !== 'string')
            throw new HttpBadRequestError('currentPassphrase must be a string');

        return await setFleetRecoveryPassphrase(payload.passphrase, payload.currentPassphrase as string | undefined);
    }

    // The fleet default for NEW disks. Deliberately does not touch a single existing volume -- turning this on
    // converts nothing, it only decides what the next disk to be added looks like.
    private static async handleEncryptionSettingsSetRequest(req: HttpRequest): Promise<{ encryptNewVolumes: boolean }> {
        const payload = await this.parseJsonBody<{ encryptNewVolumes?: unknown }>(req);
        const value = payload.encryptNewVolumes;

        if (typeof value !== 'boolean')
            throw new HttpBadRequestError('encryptNewVolumes must be a boolean');

        await database.setRuntimeConfig(ENCRYPT_NEW_VOLUMES_KEY, value);
        log('encryptNewVolumes set to %s (no existing volume was changed)', value);
        return { encryptNewVolumes: value };
    }

    private static async handleVolumeDrainRequest(params: RouteParams): Promise<{ draining: boolean; volumeId: number }> {
        const id = this.parseVolumeId(params);
        // Mark the drive READ-ONLY (no new writes) + draining (excluded from placement, still readable),
        // persist both, then start the drain. Delete stays a separate, manual step.
        await database.updateVolumeFlags(id, { isDraining: true, isReadOnly: true });
        await ioManager.updateVolumeFlags(id, { isDraining: true, isReadOnly: true });

        await this.relocateJournalOffVolume(id);

        await drainVolumeJob.start(id);
        return { draining: true, volumeId: id };
    }

    // Cancel an in-progress drain: abort the drain (and clear its persisted state so it never resumes),
    // then clear the draining flag. The drive is LEFT read-only (the operator clears that explicitly via
    // "Clear Read-Only" when ready to use it again). Already-relocated slices keep their new homes.
    // Identify a drive by flashing its activity LED (continuous read-only I/O to the raw device), so the
    // operator can find the right bay before pulling it. Heartbeat-driven: the UI re-POSTs ~every second
    // and the reads self-stop ~3s after the last ping, so a closed tab or lost "stop" can't leave a drive
    // churning. DELETE stops immediately.
    private static resolveIdentifyDevicePath(id: number): string {
        const volume = ioManager.getVolume(id);
        if (!volume)
            throw new HttpNotFoundError();
        if (!volume.deviceName)
            throw new HttpBadRequestError(`volume ${id} has no online device to identify (drive offline?)`);
        return `/dev/${volume.deviceName}`;
    }

    private static async handleVolumeIdentifyRequest(params: RouteParams): Promise<{ identifying: boolean; volumeId: number; device: string }> {
        const id = this.parseVolumeId(params);
        const devicePath = this.resolveIdentifyDevicePath(id);
        driveIdentifier.identify(devicePath);
        return { identifying: true, volumeId: id, device: devicePath };
    }

    private static async handleVolumeIdentifyStopRequest(params: RouteParams): Promise<{ identifying: boolean; volumeId: number }> {
        const id = this.parseVolumeId(params);
        const volume = ioManager.getVolume(id);
        if (volume?.deviceName)
            driveIdentifier.stop(`/dev/${volume.deviceName}`);
        return { identifying: false, volumeId: id };
    }

    private static async handleVolumeDrainCancelRequest(params: RouteParams): Promise<{ draining: boolean; volumeId: number }> {
        const id = this.parseVolumeId(params);
        await drainVolumeJob.cancel(id);
        await database.updateVolumeFlags(id, { isDraining: false });
        await ioManager.updateVolumeFlags(id, { isDraining: false });
        return { draining: false, volumeId: id };
    }

    private static async handleRebalanceStartRequest(req: HttpRequest): Promise<{ rebalancing: boolean }> {
        const payload = await this.parseJsonBody<{ deadband?: unknown; maxMoves?: unknown; concurrency?: unknown }>(req);
        const options: { deadband?: number; maxMoves?: number } = {};
        if (payload.deadband !== undefined) {
            if (typeof payload.deadband !== 'number' || payload.deadband < 0 || payload.deadband > 0.5)
                throw new HttpBadRequestError('deadband must be a number in [0, 0.5]');
            options.deadband = payload.deadband;
        }
        if (payload.maxMoves !== undefined) {
            if (typeof payload.maxMoves !== 'number' || payload.maxMoves <= 0)
                throw new HttpBadRequestError('maxMoves must be a positive number');
            options.maxMoves = payload.maxMoves;
        }
        if (payload.concurrency !== undefined)
            await rebalanceJob.setConcurrency(payload.concurrency);
        await rebalanceJob.start(options);
        return { rebalancing: true };
    }

    private static async handleRebalanceStatusRequest(): Promise<RebalanceStatus> {
        return rebalanceJob.getStatus();
    }

    // Retune concurrency without stopping: a running rebalance picks it up at the next batch.
    private static async handleRebalanceConfigRequest(req: HttpRequest): Promise<{ concurrency: number }> {
        const payload = await this.parseJsonBody<{ concurrency?: unknown }>(req);
        if (payload.concurrency === undefined)
            throw new HttpBadRequestError('concurrency is required');
        const n = typeof payload.concurrency === 'number' ? payload.concurrency : NaN;
        if (!Number.isInteger(n) || n < 1 || n > 64)
            throw new HttpBadRequestError('concurrency must be an integer in [1, 64]');
        return { concurrency: await rebalanceJob.setConcurrency(n) };
    }

    private static async handleRebalanceCancelRequest(): Promise<{ rebalancing: boolean; stopping: boolean }> {
        await rebalanceJob.cancel();

        // "rebalancing: false" was a lie the moment it was written. cancel() stops the job taking NEW work and
        // returns at once -- but up to `concurrency` slice relocations are already in the air, and each is
        // drained to a safe boundary (a slice is only unlinked from its source after the copy is fsynced and the
        // database reference flipped). On cold spindles that takes a while, during which the job is still very
        // much running and the logs are still scrolling.
        //
        // Reporting it as stopped made the array look like it had ignored the operator. Report what is true.
        return { rebalancing: rebalanceJob.isRunning(), stopping: rebalanceJob.isStopping };
    }

    private static async handleVolumeUpdateRequest(req: HttpRequest, params: RouteParams): Promise<{ updated: boolean }> {
        const payload = await this.parseJsonBody<{ isEnabled?: unknown; isReadOnly?: unknown; isDeleted?: unknown; isHealthy?: unknown; isDraining?: unknown; label?: unknown; comment?: unknown }>(req);
        const id = this.parseVolumeId(params);

        // A change to deleted-ness changes WHICH VOLUMES A ROTATION WALKS -- rotation considers only the ones
        // that are not deleted. So it must not straddle one: `scanFleet()` snapshots the volume list and then
        // enumerates the disks, and an undelete landing in that window makes a volume active again while the
        // rotation's snapshot still calls it deleted. The rotation skips it, records the new passphrase, and the
        // disk comes back into service holding a key nobody has.
        //
        // Same gate as an encrypted provision. Everything else about a volume (label, read-only, enabled) is
        // irrelevant to the passphrase and needs no gate.
        if (payload.isDeleted !== undefined)
            return withEncryptionSlot(() => this.doVolumeUpdate(req, id, payload));

        return this.doVolumeUpdate(req, id, payload);
    }

    private static async doVolumeUpdate(
        req: HttpRequest,
        id: number,
        payload: { isEnabled?: unknown; isReadOnly?: unknown; isDeleted?: unknown; isHealthy?: unknown; isDraining?: unknown; label?: unknown; comment?: unknown }
    ): Promise<{ updated: boolean }> {

        const updates: { isEnabled?: boolean; isReadOnly?: boolean; isDeleted?: boolean; isHealthy?: boolean; isDraining?: boolean; label?: string | null; comment?: string | null } = {};
        let shouldSoftDelete = false;

        if (payload.isDraining !== undefined) {
            if (typeof payload.isDraining !== 'boolean')
                throw new HttpBadRequestError('isDraining must be a boolean');
            updates.isDraining = payload.isDraining;
        }

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

        if (payload.isHealthy !== undefined) {
            if (typeof payload.isHealthy !== 'boolean')
                throw new HttpBadRequestError('isHealthy must be a boolean');
            updates.isHealthy = payload.isHealthy;
        }

        if (payload.isDeleted !== undefined) {
            if (typeof payload.isDeleted !== 'boolean')
                throw new HttpBadRequestError('isDeleted must be a boolean');
            if (payload.isDeleted)
                shouldSoftDelete = true;
            else {
                // ⚠️ UNDELETING AN ENCRYPTED VOLUME BRINGS BACK A DISK THAT MAY HAVE MISSED A ROTATION.
                //
                // Rotation only walks volumes that are NOT deleted, so while this one was retired the fleet
                // passphrase may have been changed without it. Bring it back and it holds a key nobody has --
                // and nothing in normal service would ever notice, because STRUBS mounts with the keyfile.
                //
                // Its disk must be attached, so that the next rotation can actually reach it, and the operator
                // is told to prove the passphrase against it.
                await this.assertVolumeMayReturn(id);
                updates.isDeleted = false;
            }
        }

        if (payload.label !== undefined) {
            if (payload.label !== null && typeof payload.label !== 'string')
                throw new HttpBadRequestError('label must be a string or null');
            updates.label = payload.label as string | null;
        }

        if (payload.comment !== undefined) {
            if (payload.comment !== null && typeof payload.comment !== 'string')
                throw new HttpBadRequestError('comment must be a string or null');
            updates.comment = payload.comment as string | null;
        }

        if (!shouldSoftDelete && !Object.keys(updates).length)
            throw new HttpBadRequestError('no valid fields to update');

        if (shouldSoftDelete)
            await this.assertVolumeRemovable(id);

        if (shouldSoftDelete) {
            await database.softDeleteVolume(id);
            await ioManager.softDeleteVolume(id).catch(() => undefined);
        }

        if (Object.keys(updates).length) {
            await database.updateVolumeFlags(id, updates);
            await ioManager.updateVolumeFlags(id, updates);
        }

        // Start the drain when drain is turned on; cancel it (abort + clear state) when turned off.
        // This path starts a drain too, so it gets the same awaited journal relocation as POST /drain --
        // otherwise it is simply a second door into the same room with no lock on it.
        if (updates.isDraining === true) {
            await this.relocateJournalOffVolume(id);
            await drainVolumeJob.start(id);
        }
        else if (updates.isDraining === false) {
            await drainVolumeJob.cancel(id);
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
            isPresent: volume.isPresent,
            isMissing: volume.isMissing,
            isEncrypted: volume.isEncrypted,
            deviceSerial: volume.deviceSerial,
            deviceModel: volume.deviceModel ?? null,
            deviceVendor: volume.deviceVendor ?? null,
            partitionUuid: volume.partitionUuid,
            busGroup: volume.deviceGroup ?? null,
            label: volume.label ?? null,
            comment: volume.comment ?? null,
            bytesTotal: volume.bytesTotal,
            bytesFree: volume.bytesFree,
            verifyErrors: volume.verifyErrors,
            isDeleted: volume.isDeleted,
            isDraining: volume.isDraining,
            stateUpdatedAt: volume.stateUpdatedAt ? volume.stateUpdatedAt.toISOString() : null,
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

    static findRoute(method: string, url: string): RouteMatch | null {
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
                match: url => this.matchUiRoute(url),
                handler: async (req, params) => this.handleUiRequest(req, params as UiRouteParams)
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
                match: url => url === '/$/debug' ? {} : null,
                handler: async () => this.handleDebugRequest()
            },
            {
                method: 'GET',
                match: url => url === '/$/storage-stats' ? {} : null,
                handler: async () => this.handleStorageStatsRequest()
            },
            {
                method: 'POST',
                match: url => url === '/$/storage-stats' ? {} : null,
                handler: async () => this.handleStorageStatsReconcileRequest()
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
                match: url => this.matchVolumeDrainRoute(url),
                handler: async (_req, params) => this.handleVolumeDrainRequest(params)
            },
            {
                method: 'POST',
                match: url => this.matchVolumeEncryptRoute(url),
                handler: async (req, params) => this.handleVolumeEncryptRequest(req, params)
            },
            {
                method: 'PUT',
                match: url => url === '/$/encryption/settings' ? {} : null,
                handler: async req => this.handleEncryptionSettingsSetRequest(req)
            },
            {
                method: 'POST',
                match: url => url === '/$/encryption/audit' ? {} : null,
                handler: async req => this.handleEncryptionAuditRequest(req)
            },
            {
                method: 'PUT',
                match: url => url === '/$/encryption/passphrase' ? {} : null,
                handler: async req => this.handleEncryptionPassphraseRequest(req)
            },
            {
                method: 'DELETE',
                match: url => this.matchVolumeDrainRoute(url),
                handler: async (_req, params) => this.handleVolumeDrainCancelRequest(params)
            },
            {
                method: 'POST',
                match: url => this.matchVolumeIdentifyRoute(url),
                handler: async (_req, params) => this.handleVolumeIdentifyRequest(params)
            },
            {
                method: 'DELETE',
                match: url => this.matchVolumeIdentifyRoute(url),
                handler: async (_req, params) => this.handleVolumeIdentifyStopRequest(params)
            },
            {
                method: 'POST',
                match: url => url === '/$/snapshot' ? {} : null,
                handler: async () => this.handleSnapshotRequest()
            },
            {
                method: 'POST',
                match: url => url === '/$/recover-fleet' ? {} : null,
                handler: async req => this.handleRecoverFleetRequest(req)
            },
            {
                method: 'POST',
                match: url => url === '/$/restore' ? {} : null,
                handler: async req => this.handleRestoreRequest(req)
            },
            {
                method: 'POST',
                match: url => url === '/$/drift' ? {} : null,
                handler: async () => this.handleDriftScrubRequest()
            },
            {
                method: 'GET',
                match: url => url === '/$/snapshot' ? {} : null,
                handler: async () => this.handleSnapshotStatusRequest()
            },
            {
                method: 'POST',
                match: url => url === '/$/rebalance' ? {} : null,
                handler: async req => this.handleRebalanceStartRequest(req)
            },
            {
                method: 'GET',
                match: url => url === '/$/rebalance' ? {} : null,
                handler: async () => this.handleRebalanceStatusRequest()
            },
            {
                method: 'PUT',
                match: url => url === '/$/rebalance' ? {} : null,
                handler: async req => this.handleRebalanceConfigRequest(req)
            },
            {
                method: 'DELETE',
                match: url => url === '/$/rebalance' ? {} : null,
                handler: async () => this.handleRebalanceCancelRequest()
            },
            {
                method: 'POST',
                match: url => url === '/$/notify/test' ? {} : null,
                handler: async req => this.handleNotifyTestRequest(req)
            },
            {
                method: 'GET',
                match: url => url === '/$/auth/status' ? {} : null,
                handler: async req => this.handleAuthStatusRequest(req)
            },
            {
                method: 'POST',
                match: url => url === '/$/session' ? {} : null,
                handler: async (req, _p, res) => this.handleSessionCreateRequest(req, _p, res)
            },
            {
                method: 'DELETE',
                match: url => url === '/$/session' ? {} : null,
                handler: async (req, _p, res) => this.handleSessionDeleteRequest(req, _p, res)
            },
            {
                method: 'PUT',
                match: url => url === '/$/admin/password' ? {} : null,
                handler: async req => this.handleAdminPasswordRequest(req)
            },
            {
                method: 'GET',
                match: url => url === '/$/admin/tokens' ? {} : null,
                handler: async () => this.handleAdminTokensListRequest()
            },
            {
                method: 'POST',
                match: url => url === '/$/admin/tokens' ? {} : null,
                handler: async req => this.handleAdminTokenCreateRequest(req)
            },
            {
                method: 'DELETE',
                match: url => url === '/$/admin/tokens' ? {} : null,
                handler: async () => this.handleAdminTokensPurgeRequest()
            },
            {
                method: 'DELETE',
                match: url => this.matchAdminTokenRoute(url),
                handler: async (req, params) => this.handleAdminTokenDeleteRequest(req, params as { selector: string })
            },
            {
                method: 'GET',
                match: url => url === '/$/buckets' ? {} : null,
                handler: async () => this.handleBucketsListRequest()
            },
            {
                method: 'PUT',
                match: url => this.matchBucketPolicyRoute(url),
                handler: async (req, params) => this.handleBucketPolicyRequest(req, params as { id: string })
            },
            {
                method: 'GET',
                match: url => url === '/$/buckets/stats' ? {} : null,
                handler: async () => this.handleBucketStatsRequest()
            },
            {
                method: 'GET',
                match: url => url.split('?')[0] === '/$/browse' ? {} : null,
                handler: async req => this.handleBrowseRequest(req)
            },
            {
                method: 'GET',
                match: url => url === '/$/credentials' ? {} : null,
                handler: async () => this.handleCredentialsListRequest()
            },
            {
                method: 'POST',
                match: url => url === '/$/credentials' ? {} : null,
                handler: async req => this.handleCredentialCreateRequest(req)
            },
            {
                method: 'POST',
                match: url => this.matchCredentialRotateRoute(url),
                handler: async (req, params) => this.handleCredentialRotateRequest(req, params as { accessKeyId: string })
            },
            {
                method: 'PUT',
                match: url => this.matchCredentialRoute(url),
                handler: async (req, params) => this.handleCredentialUpdateRequest(req, params as { accessKeyId: string })
            },
            {
                method: 'DELETE',
                match: url => this.matchCredentialRoute(url),
                handler: async (req, params) => this.handleCredentialDeleteRequest(req, params as { accessKeyId: string })
            },
            {
                method: 'GET',
                match: url => url === '/$/auth/settings' ? {} : null,
                handler: async () => this.handleAuthSettingsRequest()
            },
            {
                method: 'PUT',
                match: url => url === '/$/auth/settings' ? {} : null,
                handler: async req => this.handleAuthSettingsSetRequest(req)
            },
            {
                method: 'GET',
                match: url => url === '/$/faults' ? {} : null,
                handler: async () => this.handleFaultsRequest()
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
                method: 'GET',
                match: url => url === '/$/maintenance-freeze' ? {} : null,
                handler: async () => this.handleMaintenanceFreezeStatusRequest()
            },
            {
                method: 'PUT',
                match: url => url === '/$/maintenance-freeze' ? {} : null,
                handler: async req => this.handleMaintenanceFreezeSetRequest(req)
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

    private static async tryReadUiAsset(root: string, assetPath: string): Promise<{ body: Buffer; resolvedPath: string } | null> {
        let resolvedPath: string;
        try {
            resolvedPath = this.resolveUiAssetPath(root, assetPath);
        }
        catch {
            return null;
        }

        try {
            const body = await fs.readFile(resolvedPath);
            return { body, resolvedPath };
        }
        catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT')
                return null;
            throw err;
        }
    }

    private static resolveUiAssetPath(root: string, rawPath: string): string {
        const normalized = path.normalize(rawPath || '');
        const relative = !normalized || normalized === '.' ? 'index.html' : normalized;
        const rootResolved = path.resolve(root);
        const resolved = path.resolve(rootResolved, relative);
        const relativeToRoot = path.relative(rootResolved, resolved);
        if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot))
            throw new HttpNotFoundError();
        return resolved;
    }

    private static getUiRootCandidates(): string[] {
        const cwd = process.cwd();
        return [
            path.resolve(cwd, 'ui', 'dist'),
            path.resolve(cwd, '..', 'ui', 'dist')
        ];
    }

    private static resolveUiContentType(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        switch (ext) {
        case '.html': return 'text/html; charset=utf-8';
        case '.css': return 'text/css; charset=utf-8';
        case '.js': return 'application/javascript; charset=utf-8';
        case '.json': return 'application/json; charset=utf-8';
        case '.svg': return 'image/svg+xml';
        case '.png': return 'image/png';
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.gif': return 'image/gif';
        case '.ico': return 'image/x-icon';
        default: return 'application/octet-stream';
        }
    }

    private static matchUiRoute(url: string): RouteParams | null {
        const prefix = '/$/ui';
        if (!url.startsWith(prefix))
            return null;
        const remainder = url.slice(prefix.length);
        if (!remainder || remainder === '/')
            return { assetPath: '' };
        if (!remainder.startsWith('/'))
            return null;
        const assetPath = remainder.slice(1);
        return { assetPath };
    }

    private static matchAdminTokenRoute(url: string): { selector: string } | null {
        const match = /^\/\$\/admin\/tokens\/([^/]+)$/.exec(url);
        return match ? { selector: decodeURIComponent(match[1]) } : null;
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

    private static matchVolumeEncryptRoute(url: string): RouteParams | null {
        const match = /^\/\$\/volumes\/(\d+)\/encrypt$/.exec(url);
        if (!match)
            return null;
        return { id: match[1] };
    }

    private static matchVolumeDrainRoute(url: string): RouteParams | null {
        const match = /^\/\$\/volumes\/(\d+)\/drain$/.exec(url);
        if (!match)
            return null;
        return { id: match[1] };
    }

    private static matchVolumeIdentifyRoute(url: string): RouteParams | null {
        const match = /^\/\$\/volumes\/(\d+)\/identify$/.exec(url);
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

    // Management request bodies are small JSON documents. Cap the buffer so an unauthenticated caller
    // (login is auth-exempt) cannot exhaust memory by streaming an unbounded body.
    private static readonly MAX_BODY_BYTES = 64 * 1024;

    private static readRequestBody(req: HttpRequest): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            let total = 0;
            req.on('data', chunk => {
                const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
                total += buf.length;
                if (total > this.MAX_BODY_BYTES) {
                    req.destroy();
                    return reject(new HttpBadRequestError('request body too large'));
                }
                chunks.push(buf);
            });
            req.on('end', () => resolve(Buffer.concat(chunks)));
            req.on('error', reject);
            req.on('aborted', () => reject(new HttpBadRequestError('request aborted')));
        });
    }

}
