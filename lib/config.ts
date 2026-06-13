import dotenv from 'dotenv';
import { promises as fs } from 'fs';

import { createLogger } from './log';
import type { Severity } from './notify/notifier';

dotenv.config();

const log = createLogger('config');

const VALID_SEVERITIES: Severity[] = ['info', 'warning', 'critical'];

function parseSeverity(value: string | undefined, fallback: Severity): Severity {
    if (value && (VALID_SEVERITIES as string[]).includes(value))
        return value as Severity;
    return fallback;
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

    // Rolling background scrub cadence. 0 (default) disables the scheduler;
    // verification can still be triggered manually via the HTTP API.
    scrubIntervalMs: number;

    // smartd/kernel log watcher cadence. 0 (default) disables it.
    systemLogWatchIntervalMs: number;

    // Closed-loop slice repair worker cadence. 0 (default) disables it.
    repairIntervalMs: number;

    // Volume health monitor (auto read-only degradation) cadence + threshold.
    volumeHealthIntervalMs: number;
    volumeFaultThreshold: number;

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
            : 0;
        this.systemLogWatchIntervalMs = process.env.STRUBS_SYSLOG_WATCH_INTERVAL_MS
            ? parseInt(process.env.STRUBS_SYSLOG_WATCH_INTERVAL_MS, 10)
            : 0;
        this.repairIntervalMs = process.env.STRUBS_REPAIR_INTERVAL_MS
            ? parseInt(process.env.STRUBS_REPAIR_INTERVAL_MS, 10)
            : 0;
        this.volumeHealthIntervalMs = process.env.STRUBS_VOLUME_HEALTH_INTERVAL_MS
            ? parseInt(process.env.STRUBS_VOLUME_HEALTH_INTERVAL_MS, 10)
            : 0;
        this.volumeFaultThreshold = process.env.STRUBS_VOLUME_FAULT_THRESHOLD
            ? parseInt(process.env.STRUBS_VOLUME_FAULT_THRESHOLD, 10)
            : 10;
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
