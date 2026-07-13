import dotenv from 'dotenv';
import { promises as fs } from 'fs';
import path from 'path';

import { createLogger } from './log';
import type { Severity } from './notify/notifier';

dotenv.config();

const log = createLogger('config');

// 16 bytes that make the whole array recognisable. Every volume's `.identity` is validated against it.
export const IDENTITY_PATH = '/var/lib/strubs/identity';

// Only the 16 hex bytes are meaningful; the stored text may be hyphenated (ours is a UUID). Every
// comparison and every buffer derivation goes through this, so representation never changes meaning.
export function normalizeIdentity(identity: string): string {
    return identity.trim().replace(/[^0-9a-f]/gi, '').toLowerCase();
}

const VALID_SEVERITIES: Severity[] = ['info', 'warning', 'critical'];
// A full whole-object rolling scrub can take weeks on a large array, so run it QUARTERLY -- frequent
// enough to catch and repair slice degradation on aging drives within the 4+2 redundancy window, gentle
// enough not to needlessly wear them (reads already checksum hot data continuously). The scheduler
// no-ops while a scrub is still in flight, and chunks this >24.8-day delay so it doesn't overflow the
// timer. Override with STRUBS_SCRUB_INTERVAL_MS.
const DEFAULT_SCRUB_INTERVAL_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_SYSLOG_WATCH_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_REPAIR_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_REPAIR_BATCH_SIZE = 25;
const DEFAULT_REPAIR_BACKLOG_DELAY_MS = 10 * 1000;
const DEFAULT_REPAIR_BLOCKED_RETRY_MS = 60 * 60 * 1000;
const DEFAULT_VOLUME_HEALTH_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_STORAGE_STATS_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_STORAGE_STATS_FLUSH_INTERVAL_MS = 5 * 1000;
const DEFAULT_VERIFY_READ_DELAY_MS = 2;
const DEFAULT_DRAIN_CONCURRENCY = 4;
// Backstop cadence only — udev drives low-latency reaction, so this just catches missed events. Kept
// at 5min (matching the other monitors) to avoid spawning smartctl across every disk too aggressively.
const DEFAULT_DEVICE_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

function parseSeverity(value: string | undefined, fallback: Severity): Severity {
    if (value && (VALID_SEVERITIES as string[]).includes(value))
        return value as Severity;
    return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
    if (!value)
        return fallback;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
    if (!value)
        return fallback;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export class Config {
    mongoUrl: string;
    dataSliceCount: number;
    paritySliceCount: number;
    chunkSize = 16384;
    identity: string | null = null;
    identityBuffer: Buffer | null = null;

    // Listeners. The object API and the admin surface (management API + UI) are on SEPARATE ORIGINS,
    // by port and scheme, so object-hosted content can never script the admin API (a stored-XSS ->
    // disk-wipe path otherwise). Object API is HTTP on httpPort; admin is HTTPS-only on adminPort.
    httpPort: number;
    adminPort: number;
    // Self-issued TLS for the admin listener. tlsDir holds the generated CA + leaf; tlsCertPath/
    // tlsKeyPath override with a bring-your-own pair. tlsExtraHosts adds SANs beyond the host's own
    // names/IPs (a real DNS name, a VIP). See lib/server/tls.ts.
    tlsDir: string;
    tlsCertPath: string | null;
    tlsKeyPath: string | null;
    tlsExtraHosts: string[];
    // Root-only Unix socket serving the admin API without a credential (local ops / lockout recovery).
    adminSocketPath: string;

    // Notifications. Slack is optional; when no webhook is set only the log
    // transport is active. Severity/cooldown tune routing and de-duplication.
    slackWebhookUrl: string | null;
    slackMinSeverity: Severity;
    notifyCooldownMs: number;

    // Rolling background scrub cadence. Set to 0 to disable the scheduler;
    // verification can still be triggered manually via the HTTP API.
    scrubIntervalMs: number;

    // smartd/kernel log watcher cadence. Set to 0 to disable it.
    systemLogWatchIntervalMs: number;

    // Closed-loop slice repair worker safety-net cadence. Set to 0 to disable
    // periodic polling; newly reported faults still wake a repair pass.
    repairIntervalMs: number;
    repairBatchSize: number;
    repairBacklogDelayMs: number;
    repairBlockedRetryMs: number;

    // Volume health monitor (auto read-only degradation) cadence + threshold.
    // Set the interval to 0 to disable it.
    volumeHealthIntervalMs: number;
    volumeFaultThreshold: number;

    // Cached content/volume storage statistics. The reconciliation interval
    // rebuilds from content aggregation; the flush interval batches live object
    // create/delete deltas into the cached snapshot.
    storageStatsIntervalMs: number;
    storageStatsFlushIntervalMs: number;

    // Namespace journal (DR-C): a replicated, plaintext record of {name, container, mime, md5} -- the only
    // things the disks cannot tell us themselves. Placement is never trusted from it; a restore always
    // re-derives that by scanning the disks.
    journalEnabled: boolean;
    journalReplicas: number;
    journalFlushMs: number;
    journalMaxBatch: number;
    journalSegmentBytes: number;

    // Backstop re-write of the per-volume bootstrap manifest. Event hooks cover fleet changes; this
    // catches anything they miss, because a manifest that quietly stopped refreshing is a problem you
    // only find out about during a recovery. 0 disables.
    bootstrapManifestIntervalMs: number;

    // Cooperative pacing between chunk reads during verification. This trades
    // scrub throughput for lower foreground-read contention.
    verifyReadDelayMs: number;
    verifyParity: boolean;

    // Mount the read-only FUSE filesystem at /run/strubs/data. OPT-IN (off by default): it is a second,
    // unauthenticated read path to every object and it needs the native fuse-native binding plus
    // /dev/fuse. Enable with STRUBS_FUSE_ENABLED=true. When off, the binding is never even loaded, so
    // STRUBS runs on a host without it. The HTTP object API is unaffected either way.
    fuseEnabled: boolean;

    // How many objects a drain relocates concurrently. Higher = faster on drives that can absorb the
    // parallel I/O, but the aging USB-DAS enclosures are seek-bound, so raise it in small steps and
    // measure. Override with STRUBS_DRAIN_CONCURRENCY.
    drainConcurrency: number;

    // NOTE: rebalance concurrency is deliberately NOT here. It lives in runtimeConfig so it can be
    // read and retuned from the API/UI while a rebalance is running (see rebalance-job).

    // Device reconciler: detects hotplugged disks (insert/remove) and remounts/marks volumes to match.
    // The interval is the periodic backstop pass (set 0 to disable); udev provides low-latency reaction
    // and can be turned off with STRUBS_DISABLE_UDEV=true (falls back to periodic-only).
    deviceReconcileIntervalMs: number;
    deviceReconcileUdev: boolean;

    constructor() {
        this.mongoUrl = process.env.STRUBS_MONGO_URL || 'mongodb://strubs:strubs@127.0.0.1:27017/strubs?authSource=admin';
        this.dataSliceCount = process.env.STRUBS_DATA_SLICES ? parseInt(process.env.STRUBS_DATA_SLICES, 10) : 4;
        this.paritySliceCount = process.env.STRUBS_PARITY_SLICES ? parseInt(process.env.STRUBS_PARITY_SLICES, 10) : 2;
        this.slackWebhookUrl = process.env.STRUBS_SLACK_WEBHOOK_URL || null;
        this.slackMinSeverity = parseSeverity(process.env.STRUBS_SLACK_MIN_SEVERITY, 'warning');
        this.notifyCooldownMs = process.env.STRUBS_NOTIFY_COOLDOWN_MS
            ? parseInt(process.env.STRUBS_NOTIFY_COOLDOWN_MS, 10)
            : 5 * 60 * 1000;
        this.scrubIntervalMs = process.env.STRUBS_SCRUB_INTERVAL_MS
            ? parseInt(process.env.STRUBS_SCRUB_INTERVAL_MS, 10)
            : DEFAULT_SCRUB_INTERVAL_MS;
        this.systemLogWatchIntervalMs = process.env.STRUBS_SYSLOG_WATCH_INTERVAL_MS
            ? parseInt(process.env.STRUBS_SYSLOG_WATCH_INTERVAL_MS, 10)
            : DEFAULT_SYSLOG_WATCH_INTERVAL_MS;
        this.repairIntervalMs = process.env.STRUBS_REPAIR_INTERVAL_MS
            ? parseInt(process.env.STRUBS_REPAIR_INTERVAL_MS, 10)
            : DEFAULT_REPAIR_INTERVAL_MS;
        this.repairBatchSize = parsePositiveInt(process.env.STRUBS_REPAIR_BATCH_SIZE, DEFAULT_REPAIR_BATCH_SIZE);
        this.repairBacklogDelayMs = parseNonNegativeInt(process.env.STRUBS_REPAIR_BACKLOG_DELAY_MS, DEFAULT_REPAIR_BACKLOG_DELAY_MS);
        this.repairBlockedRetryMs = parseNonNegativeInt(process.env.STRUBS_REPAIR_BLOCKED_RETRY_MS, DEFAULT_REPAIR_BLOCKED_RETRY_MS);
        this.volumeHealthIntervalMs = process.env.STRUBS_VOLUME_HEALTH_INTERVAL_MS
            ? parseInt(process.env.STRUBS_VOLUME_HEALTH_INTERVAL_MS, 10)
            : DEFAULT_VOLUME_HEALTH_INTERVAL_MS;
        this.volumeFaultThreshold = process.env.STRUBS_VOLUME_FAULT_THRESHOLD
            ? parseInt(process.env.STRUBS_VOLUME_FAULT_THRESHOLD, 10)
            : 10;
        this.storageStatsIntervalMs = process.env.STRUBS_STORAGE_STATS_INTERVAL_MS
            ? parseInt(process.env.STRUBS_STORAGE_STATS_INTERVAL_MS, 10)
            : DEFAULT_STORAGE_STATS_INTERVAL_MS;
        this.storageStatsFlushIntervalMs = parsePositiveInt(
            process.env.STRUBS_STORAGE_STATS_FLUSH_INTERVAL_MS,
            DEFAULT_STORAGE_STATS_FLUSH_INTERVAL_MS
        );
        this.bootstrapManifestIntervalMs = process.env.STRUBS_BOOTSTRAP_MANIFEST_INTERVAL_MS
            ? parseInt(process.env.STRUBS_BOOTSTRAP_MANIFEST_INTERVAL_MS, 10)
            : 30 * 60 * 1000;
        this.journalEnabled = process.env.STRUBS_JOURNAL_ENABLED !== 'false';
        this.journalReplicas = process.env.STRUBS_JOURNAL_REPLICAS
            ? parseInt(process.env.STRUBS_JOURNAL_REPLICAS, 10)
            : 3;
        this.journalFlushMs = process.env.STRUBS_JOURNAL_FLUSH_MS
            ? parseInt(process.env.STRUBS_JOURNAL_FLUSH_MS, 10)
            : 50;
        this.journalMaxBatch = process.env.STRUBS_JOURNAL_MAX_BATCH
            ? parseInt(process.env.STRUBS_JOURNAL_MAX_BATCH, 10)
            : 256;
        this.journalSegmentBytes = process.env.STRUBS_JOURNAL_SEGMENT_BYTES
            ? parseInt(process.env.STRUBS_JOURNAL_SEGMENT_BYTES, 10)
            : 64 * 1024 * 1024;
        this.verifyReadDelayMs = parseNonNegativeInt(
            process.env.STRUBS_VERIFY_READ_DELAY_MS,
            DEFAULT_VERIFY_READ_DELAY_MS
        );
        // Full-mode scrub also validates parity (recompute-and-compare); disable with =false.
        this.verifyParity = process.env.STRUBS_VERIFY_PARITY !== 'false';
        this.fuseEnabled = process.env.STRUBS_FUSE_ENABLED === 'true';
        this.httpPort = parsePositiveInt(process.env.STRUBS_HTTP_PORT, 80);
        this.adminPort = parsePositiveInt(process.env.STRUBS_ADMIN_PORT, 443);
        this.tlsDir = process.env.STRUBS_TLS_DIR || '/var/lib/strubs/tls';
        this.tlsCertPath = process.env.STRUBS_TLS_CERT || null;
        this.tlsKeyPath = process.env.STRUBS_TLS_KEY || null;
        this.tlsExtraHosts = (process.env.STRUBS_TLS_HOSTS || '')
            .split(',').map(h => h.trim()).filter(Boolean);
        this.adminSocketPath = process.env.STRUBS_ADMIN_SOCKET || '/run/strubs/admin.sock';
        this.drainConcurrency = parsePositiveInt(process.env.STRUBS_DRAIN_CONCURRENCY, DEFAULT_DRAIN_CONCURRENCY);
        this.deviceReconcileIntervalMs = parseNonNegativeInt(
            process.env.STRUBS_DEVICE_RECONCILE_INTERVAL_MS,
            DEFAULT_DEVICE_RECONCILE_INTERVAL_MS
        );
        this.deviceReconcileUdev = process.env.STRUBS_DISABLE_UDEV !== 'true';
    }

    // The instance identity is 16 bytes that every volume validates itself against. A MISSING file must
    // not kill startup: on a rebuilt host that would mean the process cannot even reach the UI that would
    // offer to restore it. So absence leaves `identity = null` and the caller enters recovery mode.
    //
    // It must NEVER generate a replacement. A fresh identity is the footgun that permanently orphans every
    // disk in the array -- each one would then be rejected as "not from this STRUBS instance".
    async loadIdentity(): Promise<void> {
        log('loading identity');

        let data: Buffer;
        try {
            data = await fs.readFile(IDENTITY_PATH);
        }
        catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
                throw err;
            this.identity = null;
            this.identityBuffer = null;
            log.error('=================================================================');
            log.error('  NO INSTANCE IDENTITY at %s', IDENTITY_PATH);
            log.error('  No volume can be verified without it. If this host previously');
            log.error('  ran STRUBS, RESTORE it from a volume bootstrap manifest --');
            log.error('  do NOT generate a new one, or every disk becomes unrecognisable.');
            log.error('=================================================================');
            return;
        }

        this.identity = data.toString().trim();
        this.identityBuffer = Buffer.from(normalizeIdentity(this.identity), 'hex');

        log('loaded identity:', this.identity);
    }

    // Adopt an identity recovered from a bootstrap manifest. Writing the file is not enough -- volumes
    // validate against `identityBuffer` in-process, so it must be populated before the fleet starts.
    //
    // The on-disk identity is stored in whatever form it was created in (ours is a hyphenated UUID), and
    // only its 16 hex BYTES are ever compared -- loadIdentity/verify both strip non-hex before building
    // the buffer. So the "is this the same identity?" guard must compare the NORMALISED forms; comparing
    // raw strings would make re-adopting the very same identity look like a different one and throw.
    async adoptIdentity(identity: string): Promise<void> {
        const normalized = normalizeIdentity(identity);
        if (normalized.length !== 32)
            throw new Error('instance identity must be 16 bytes (32 hex chars)');
        if (this.identity && normalizeIdentity(this.identity) !== normalized)
            throw new Error('refusing to overwrite an existing, different instance identity');
        await fs.mkdir(path.dirname(IDENTITY_PATH), { recursive: true });
        // Preserve the caller's original text (the manifest carries it verbatim), so the file keeps the
        // same form it had before the disaster rather than silently changing representation.
        const body = identity.trim();
        await fs.writeFile(IDENTITY_PATH, body, { mode: 0o600 });
        this.identity = body;
        this.identityBuffer = Buffer.from(normalized, 'hex');
        log('adopted instance identity %s', body);
    }
}

export const config = new Config();
