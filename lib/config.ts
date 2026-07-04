import dotenv from 'dotenv';
import { promises as fs } from 'fs';

import { createLogger } from './log';
import type { Severity } from './notify/notifier';

dotenv.config();

const log = createLogger('config');

const VALID_SEVERITIES: Severity[] = ['info', 'warning', 'critical'];
// A full whole-object rolling scrub takes ~2 weeks on this array, so run it QUARTERLY -- frequent
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

    // Cooperative pacing between chunk reads during verification. This trades
    // scrub throughput for lower foreground-read contention.
    verifyReadDelayMs: number;
    verifyParity: boolean;

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
        this.verifyReadDelayMs = parseNonNegativeInt(
            process.env.STRUBS_VERIFY_READ_DELAY_MS,
            DEFAULT_VERIFY_READ_DELAY_MS
        );
        // Full-mode scrub also validates parity (recompute-and-compare); disable with =false.
        this.verifyParity = process.env.STRUBS_VERIFY_PARITY !== 'false';
    }

    async loadIdentity(): Promise<void> {
        log('loading identity');

        const data = await fs.readFile('/var/lib/strubs/identity');

        this.identity = data.toString().trim();
        this.identityBuffer = Buffer.from(this.identity.replace(/[^0-9a-f]/g, ''), 'hex');

        log('loaded identity:', this.identity);
    }
}

export const config = new Config();
