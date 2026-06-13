import { createLogger } from '../log';
import { meetsSeverity, severityRank, type NotificationMessage, type NotificationTransport } from './notifier';

type NotificationServiceDeps = {
    createLogger: typeof createLogger;
    now: () => number;
};

const defaultDeps: NotificationServiceDeps = {
    createLogger,
    now: () => Date.now()
};

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

export type NotifyResult = {
    delivered: string[];
    failed: { transport: string; error: string }[];
    suppressed: boolean;
};

// Fans a message out to every registered transport whose minSeverity it meets.
// Coalesces messages sharing a dedupeKey within a cooldown window, and isolates
// transport failures so one bad target never breaks remediation or another
// transport.
export class NotificationService {
    private readonly deps: NotificationServiceDeps;
    private readonly log: ReturnType<typeof createLogger>;
    private readonly transports: NotificationTransport[] = [];
    private readonly lastSent = new Map<string, { at: number; rank: number }>();
    private cooldownMs: number;

    constructor(options?: { cooldownMs?: number }, deps?: Partial<NotificationServiceDeps>) {
        this.deps = { ...defaultDeps, ...deps };
        this.log = this.deps.createLogger('notify-service');
        this.cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    }

    configure(options: { cooldownMs?: number }): void {
        if (typeof options.cooldownMs === 'number' && Number.isFinite(options.cooldownMs) && options.cooldownMs >= 0)
            this.cooldownMs = options.cooldownMs;
    }

    registerTransport(transport: NotificationTransport): void {
        this.transports.push(transport);
        this.log('registered transport %s (minSeverity=%s)', transport.name, transport.minSeverity);
    }

    // Used by bootstrap to make (re)configuration idempotent — startup retries
    // must not accumulate duplicate transports.
    clearTransports(): void {
        this.transports.length = 0;
    }

    listTransports(): string[] {
        return this.transports.map(transport => transport.name);
    }

    // bypassCooldown is used by the test endpoint so an operator can always force
    // a delivery regardless of recent traffic.
    async notify(message: NotificationMessage, options?: { bypassCooldown?: boolean }): Promise<NotifyResult> {
        const suppressed = !options?.bypassCooldown && this.isSuppressed(message);

        // Reserve the cooldown synchronously BEFORE awaiting delivery, so two
        // concurrent same-key notifications don't both see "not suppressed" and
        // both hit a throttled transport (Slack). Rolled back below if no
        // throttled transport actually delivers.
        let reservation: { key: string; prior: { at: number; rank: number } | undefined } | null = null;
        if (!suppressed && message.dedupeKey && this.hasThrottledTarget(message)) {
            reservation = { key: message.dedupeKey, prior: this.lastSent.get(message.dedupeKey) };
            this.markSent(message);
        }

        // When suppressed, throttled transports (e.g. Slack) are skipped, but
        // always-deliver sinks (console/journald) still capture every occurrence.
        const targets = this.transports.filter(transport =>
            meetsSeverity(message.severity, transport.minSeverity) && (!suppressed || transport.alwaysDeliver === true)
        );
        const delivered: string[] = [];
        const failed: { transport: string; error: string }[] = [];
        let throttledDelivered = false;

        // Promise.resolve().then(...) guards against transports that throw
        // synchronously inside send(), so one bad transport cannot prevent the
        // others from running or reject notify().
        const results = await Promise.allSettled(
            targets.map(transport => Promise.resolve().then(() => transport.send(message)))
        );
        results.forEach((result, index) => {
            const transport = targets[index];
            if (result.status === 'fulfilled') {
                delivered.push(transport.name);
                if (transport.alwaysDeliver !== true)
                    throttledDelivered = true;
            }
            else {
                const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
                failed.push({ transport: transport.name, error });
                this.log.error('transport %s failed to deliver notification: %s', transport.name, error);
            }
        });

        // Roll back the reservation if no throttled transport actually delivered,
        // so the next attempt can retry rather than being suppressed for the
        // whole cooldown.
        if (reservation && !throttledDelivered) {
            if (reservation.prior)
                this.lastSent.set(reservation.key, reservation.prior);
            else
                this.lastSent.delete(reservation.key);
        }

        return { delivered, failed, suppressed };
    }

    private hasThrottledTarget(message: NotificationMessage): boolean {
        return this.transports.some(transport =>
            meetsSeverity(message.severity, transport.minSeverity) && transport.alwaysDeliver !== true
        );
    }

    private isSuppressed(message: NotificationMessage): boolean {
        if (!message.dedupeKey)
            return false;
        const last = this.lastSent.get(message.dedupeKey);
        if (last === undefined)
            return false;
        if (this.deps.now() - last.at >= this.cooldownMs)
            return false;
        // Let an escalation (e.g. warning -> critical) for the same key through
        // even while the cooldown is active.
        if (severityRank(message.severity) > last.rank)
            return false;
        return true;
    }

    private markSent(message: NotificationMessage): void {
        if (message.dedupeKey)
            this.lastSent.set(message.dedupeKey, { at: this.deps.now(), rank: severityRank(message.severity) });
    }
}

export const notificationService = new NotificationService();
