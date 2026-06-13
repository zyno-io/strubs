// Notification primitives. Transports are pluggable: implement
// NotificationTransport and register it with the NotificationService. The core
// never depends on any specific target (Slack, email, etc.).

export type Severity = 'info' | 'warning' | 'critical';

const SEVERITY_RANK: Record<Severity, number> = {
    info: 10,
    warning: 20,
    critical: 30
};

export function severityRank(severity: Severity): number {
    return SEVERITY_RANK[severity] ?? 0;
}

export function meetsSeverity(severity: Severity, minimum: Severity): boolean {
    return severityRank(severity) >= severityRank(minimum);
}

export interface NotificationMessage {
    severity: Severity;
    title: string;
    body: string;
    // Messages sharing a dedupeKey are coalesced within the service cooldown
    // window, so a flapping fault does not spam the target.
    dedupeKey?: string;
    // Structured fields a transport may render (e.g. Slack blocks).
    context?: Record<string, unknown>;
}

export interface NotificationTransport {
    readonly name: string;
    readonly minSeverity: Severity;
    // Audit sinks (e.g. the console/journald log) set this so the dedupe
    // cooldown never suppresses them — they must capture every occurrence even
    // when throttled targets like Slack are coalesced.
    readonly alwaysDeliver?: boolean;
    send(message: NotificationMessage): Promise<void>;
}
