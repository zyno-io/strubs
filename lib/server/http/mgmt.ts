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
import { deviceProvisioner } from '../../io/device-provisioner';
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

    static async handle(_requestId: number, req: HttpRequest, res: HttpResponse): Promise<unknown> {
        const method = req.method?.toUpperCase();
        const url = req.url;
        if (!method || !url)
            throw new HttpNotFoundError();

        const route = this.findRoute(method, url);
        if (!route)
            throw new HttpNotFoundError();

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
        const updated = await database.setBucketPolicy(params.id, policy);
        if (!updated) throw new HttpNotFoundError('bucket not found');
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

    private static async handleDebugRequest(): Promise<DebugResponse> {
        const priorityStats = volumePriorityManager.getStats();
        const verifyStatus = verifyVolumesJob.getStatus();

        return {
            priorityStats,
            verifyStatus
        };
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
        await this.assertVolumeRemovable(id);
        await database.softDeleteVolume(id);
        await ioManager.softDeleteVolume(id).catch(() => undefined);
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

    private static async handleRebalanceCancelRequest(): Promise<{ rebalancing: boolean }> {
        await rebalanceJob.cancel();
        return { rebalancing: false };
    }

    private static async handleVolumeUpdateRequest(req: HttpRequest, params: RouteParams): Promise<{ updated: boolean }> {
        const payload = await this.parseJsonBody<{ isEnabled?: unknown; isReadOnly?: unknown; isDeleted?: unknown; isHealthy?: unknown; isDraining?: unknown; label?: unknown; comment?: unknown }>(req);
        const id = this.parseVolumeId(params);

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
            else
                updates.isDeleted = false;
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
