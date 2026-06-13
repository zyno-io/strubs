import { createLogger } from '../../log';
import type { NotificationMessage, NotificationTransport, Severity } from '../notifier';

type LogTransportDeps = {
    createLogger: typeof createLogger;
};

const defaultDeps: LogTransportDeps = {
    createLogger
};

// Always-on fallback transport so notifications are observable even before any
// external target (Slack, etc.) is configured.
export class LogTransport implements NotificationTransport {
    readonly name = 'log';
    readonly minSeverity: Severity;
    // Always capture to the console/journald, even when Slack is rate-limited.
    readonly alwaysDeliver = true;
    private readonly log: ReturnType<typeof createLogger>;

    constructor(minSeverity: Severity = 'info', deps?: Partial<LogTransportDeps>) {
        const resolved = { ...defaultDeps, ...deps };
        this.minSeverity = minSeverity;
        this.log = resolved.createLogger('notify');
    }

    async send(message: NotificationMessage): Promise<void> {
        const context = this.formatContext(message.context);
        const line = `[${message.severity}] ${message.title} — ${message.body}${context}`;
        if (message.severity === 'critical' || message.severity === 'warning')
            this.log.error(line);
        else
            this.log(line);
    }

    private formatContext(context?: Record<string, unknown>): string {
        if (!context)
            return '';
        const parts = Object.entries(context)
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([key, value]) => `${key}=${String(value)}`);
        return parts.length ? ` (${parts.join(' ')})` : '';
    }
}
