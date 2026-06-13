import type { NotificationMessage, NotificationTransport, Severity } from '../notifier';

type FetchFn = typeof fetch;

type SlackTransportOptions = {
    webhookUrl: string;
    minSeverity?: Severity;
    fetchFn?: FetchFn;
    timeoutMs?: number;
};

const SEVERITY_EMOJI: Record<Severity, string> = {
    info: ':information_source:',
    warning: ':warning:',
    critical: ':rotating_light:'
};

// Posts to a Slack incoming webhook. Kept deliberately small; the message shape
// is standard Slack blocks so other webhook-style targets can be adapted easily.
export class SlackTransport implements NotificationTransport {
    readonly name = 'slack';
    readonly minSeverity: Severity;
    private readonly webhookUrl: string;
    private readonly fetchFn: FetchFn;
    private readonly timeoutMs: number;

    constructor(options: SlackTransportOptions) {
        if (!options.webhookUrl)
            throw new Error('SlackTransport requires a webhookUrl');
        this.webhookUrl = options.webhookUrl;
        this.minSeverity = options.minSeverity ?? 'warning';
        this.fetchFn = options.fetchFn ?? fetch;
        this.timeoutMs = options.timeoutMs ?? 10000;
    }

    async send(message: NotificationMessage): Promise<void> {
        const payload = this.buildPayload(message);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await this.fetchFn(this.webhookUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            if (!response.ok) {
                const text = await response.text().catch(() => '');
                throw new Error(`slack webhook responded ${response.status}${text ? `: ${text}` : ''}`);
            }
        }
        finally {
            clearTimeout(timer);
        }
    }

    private buildPayload(message: NotificationMessage): Record<string, unknown> {
        const emoji = SEVERITY_EMOJI[message.severity] ?? '';
        const headerText = `${emoji} ${message.title}`.trim();
        const blocks: Record<string, unknown>[] = [
            { type: 'section', text: { type: 'mrkdwn', text: `*${headerText}*\n${message.body}` } }
        ];
        const fields = this.contextFields(message.context);
        if (fields.length)
            blocks.push({ type: 'section', fields });
        return { text: headerText, blocks };
    }

    private contextFields(context?: Record<string, unknown>): Record<string, unknown>[] {
        if (!context)
            return [];
        return Object.entries(context)
            .filter(([, value]) => value !== undefined && value !== null)
            .slice(0, 10)
            .map(([key, value]) => ({ type: 'mrkdwn', text: `*${key}:* ${String(value)}` }));
    }
}
