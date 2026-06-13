import { describe, expect, it, vi } from 'vitest';

import { NotificationService } from '../lib/notify/service';
import { configureNotifications } from '../lib/notify/bootstrap';
import { LogTransport } from '../lib/notify/transports/log-transport';
import { SlackTransport } from '../lib/notify/transports/slack-transport';
import type { NotificationTransport, Severity } from '../lib/notify/notifier';
import type { Config } from '../lib/config';

const loggerFactory = () => vi.fn(() => Object.assign(vi.fn(), { error: vi.fn() })) as any;

const makeTransport = (
    name: string,
    minSeverity: Severity,
    impl?: () => Promise<void>
): NotificationTransport & { send: ReturnType<typeof vi.fn> } => ({
    name,
    minSeverity,
    send: vi.fn(impl ?? (async () => undefined))
});

describe('NotificationService', () => {
    it('routes messages only to transports that meet the severity', async () => {
        const service = new NotificationService({}, { createLogger: loggerFactory(), now: () => 0 });
        const infoT = makeTransport('info', 'info');
        const critT = makeTransport('crit', 'critical');
        service.registerTransport(infoT);
        service.registerTransport(critT);

        const warn = await service.notify({ severity: 'warning', title: 't', body: 'b' });
        expect(warn.delivered).toEqual(['info']);
        expect(critT.send).not.toHaveBeenCalled();

        const crit = await service.notify({ severity: 'critical', title: 't', body: 'b' });
        expect(crit.delivered).toEqual(['info', 'crit']);
    });

    it('suppresses repeats sharing a dedupeKey within the cooldown window', async () => {
        let now = 1000;
        const service = new NotificationService({ cooldownMs: 100 }, { createLogger: loggerFactory(), now: () => now });
        const t = makeTransport('log', 'info');
        service.registerTransport(t);

        const first = await service.notify({ severity: 'info', title: 't', body: 'b', dedupeKey: 'k' });
        expect(first.suppressed).toBe(false);
        expect(t.send).toHaveBeenCalledTimes(1);

        const second = await service.notify({ severity: 'info', title: 't', body: 'b', dedupeKey: 'k' });
        expect(second.suppressed).toBe(true);
        expect(t.send).toHaveBeenCalledTimes(1);

        now += 200; // past cooldown
        const third = await service.notify({ severity: 'info', title: 't', body: 'b', dedupeKey: 'k' });
        expect(third.suppressed).toBe(false);
        expect(t.send).toHaveBeenCalledTimes(2);
    });

    it('bypasses cooldown when requested (test endpoint path)', async () => {
        const service = new NotificationService({ cooldownMs: 10000 }, { createLogger: loggerFactory(), now: () => 0 });
        const t = makeTransport('log', 'info');
        service.registerTransport(t);
        await service.notify({ severity: 'info', title: 't', body: 'b', dedupeKey: 'k' });
        const again = await service.notify({ severity: 'info', title: 't', body: 'b', dedupeKey: 'k' }, { bypassCooldown: true });
        expect(again.suppressed).toBe(false);
        expect(t.send).toHaveBeenCalledTimes(2);
    });

    it('does not double-send to throttled transports under concurrent same-key calls', async () => {
        let release: () => void = () => undefined;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const slack: NotificationTransport & { send: ReturnType<typeof vi.fn> } = {
            name: 'slack', minSeverity: 'info', send: vi.fn(async () => { await gate; })
        };
        const service = new NotificationService({ cooldownMs: 100000 }, { createLogger: loggerFactory(), now: () => 0 });
        service.registerTransport(slack);

        const p1 = service.notify({ severity: 'warning', title: 't', body: 'b', dedupeKey: 'k' });
        const p2 = service.notify({ severity: 'warning', title: 't', body: 'b', dedupeKey: 'k' });
        release();
        const [r1, r2] = await Promise.all([p1, p2]);

        expect(slack.send).toHaveBeenCalledTimes(1);
        expect([r1.suppressed, r2.suppressed].filter(Boolean)).toHaveLength(1);
    });

    it('lets a higher-severity escalation bypass an active cooldown', async () => {
        const service = new NotificationService({ cooldownMs: 100000 }, { createLogger: loggerFactory(), now: () => 0 });
        const t = makeTransport('log', 'info');
        service.registerTransport(t);

        await service.notify({ severity: 'warning', title: 't', body: 'b', dedupeKey: 'k' });
        const escalated = await service.notify({ severity: 'critical', title: 't', body: 'b', dedupeKey: 'k' });
        expect(escalated.suppressed).toBe(false);
        expect(t.send).toHaveBeenCalledTimes(2);

        // ...but a same/lower severity repeat is still suppressed.
        const repeat = await service.notify({ severity: 'warning', title: 't', body: 'b', dedupeKey: 'k' });
        expect(repeat.suppressed).toBe(true);
    });

    it('does not arm the cooldown when nothing was delivered', async () => {
        const service = new NotificationService({ cooldownMs: 100000 }, { createLogger: loggerFactory(), now: () => 0 });
        const bad = makeTransport('bad', 'info', async () => { throw new Error('down'); });
        service.registerTransport(bad);

        await service.notify({ severity: 'warning', title: 't', body: 'b', dedupeKey: 'k' });
        const second = await service.notify({ severity: 'warning', title: 't', body: 'b', dedupeKey: 'k' });
        expect(second.suppressed).toBe(false); // not suppressed: first attempt delivered nothing
        expect(bad.send).toHaveBeenCalledTimes(2);
    });

    it('still delivers suppressed messages to always-deliver audit sinks (journald)', async () => {
        const service = new NotificationService({ cooldownMs: 100000 }, { createLogger: loggerFactory(), now: () => 0 });
        const audit: NotificationTransport & { send: ReturnType<typeof vi.fn> } = {
            name: 'log', minSeverity: 'info', alwaysDeliver: true, send: vi.fn(async () => undefined)
        };
        const slack = makeTransport('slack', 'warning'); // throttled (no alwaysDeliver)
        service.registerTransport(audit);
        service.registerTransport(slack);

        await service.notify({ severity: 'warning', title: 't', body: 'b', dedupeKey: 'k' });
        expect(audit.send).toHaveBeenCalledTimes(1);
        expect(slack.send).toHaveBeenCalledTimes(1);

        const second = await service.notify({ severity: 'warning', title: 't', body: 'b', dedupeKey: 'k' });
        expect(second.suppressed).toBe(true);
        expect(audit.send).toHaveBeenCalledTimes(2); // console/journald still captures it
        expect(slack.send).toHaveBeenCalledTimes(1); // slack stays throttled
    });

    it('isolates a transport that throws synchronously', async () => {
        const service = new NotificationService({}, { createLogger: loggerFactory(), now: () => 0 });
        const sync = makeTransport('sync', 'info', () => { throw new Error('sync boom'); });
        const good = makeTransport('good', 'info');
        service.registerTransport(sync);
        service.registerTransport(good);

        const result = await service.notify({ severity: 'info', title: 't', body: 'b' });
        expect(result.delivered).toEqual(['good']);
        expect(result.failed).toEqual([{ transport: 'sync', error: 'sync boom' }]);
    });

    it('isolates a failing transport from the rest', async () => {
        const service = new NotificationService({}, { createLogger: loggerFactory(), now: () => 0 });
        const good = makeTransport('good', 'info');
        const bad = makeTransport('bad', 'info', async () => { throw new Error('boom'); });
        service.registerTransport(good);
        service.registerTransport(bad);

        const result = await service.notify({ severity: 'info', title: 't', body: 'b' });
        expect(result.delivered).toEqual(['good']);
        expect(result.failed).toEqual([{ transport: 'bad', error: 'boom' }]);
    });
});

describe('configureNotifications', () => {
    const baseConfig = (overrides?: Partial<Config>): Config => ({
        slackWebhookUrl: null,
        slackMinSeverity: 'warning',
        notifyCooldownMs: 1000,
        ...overrides
    }) as Config;

    it('is idempotent — repeated configuration does not duplicate transports', () => {
        const service = new NotificationService({}, { createLogger: loggerFactory(), now: () => 0 });
        configureNotifications(baseConfig(), service);
        configureNotifications(baseConfig(), service);
        expect(service.listTransports()).toEqual(['log']);
    });

    it('adds the slack transport when a webhook is configured', () => {
        const service = new NotificationService({}, { createLogger: loggerFactory(), now: () => 0 });
        configureNotifications(baseConfig({ slackWebhookUrl: 'https://hooks.example/x' }), service);
        expect(service.listTransports()).toEqual(['log', 'slack']);
    });
});

describe('LogTransport', () => {
    const makeLogTransport = () => {
        const logFn = Object.assign(vi.fn(), { error: vi.fn() });
        const transport = new LogTransport('info', { createLogger: vi.fn(() => logFn) as any });
        return { transport, logFn };
    };

    it('is an always-deliver audit sink', () => {
        const { transport } = makeLogTransport();
        expect(transport.alwaysDeliver).toBe(true);
        expect(transport.name).toBe('log');
    });

    it('logs info via the normal logger and includes context', async () => {
        const { transport, logFn } = makeLogTransport();
        await transport.send({ severity: 'info', title: 'T', body: 'B', context: { volumeId: 7 } });
        expect(logFn).toHaveBeenCalledTimes(1);
        expect(logFn.error).not.toHaveBeenCalled();
        expect(String(logFn.mock.calls[0][0])).toContain('volumeId=7');
    });

    it('logs warning/critical via the error logger', async () => {
        const { transport, logFn } = makeLogTransport();
        await transport.send({ severity: 'critical', title: 'T', body: 'B' });
        expect(logFn.error).toHaveBeenCalledTimes(1);
    });
});

describe('SlackTransport', () => {
    it('POSTs Slack blocks to the webhook', async () => {
        const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' })) as any;
        const transport = new SlackTransport({ webhookUrl: 'https://hooks.example/abc', fetchFn });

        await transport.send({ severity: 'warning', title: 'Disk fault', body: 'slice 0 failed', context: { volumeId: 7 } });

        expect(fetchFn).toHaveBeenCalledTimes(1);
        const [url, init] = fetchFn.mock.calls[0];
        expect(url).toBe('https://hooks.example/abc');
        expect(init.method).toBe('POST');
        const payload = JSON.parse(init.body);
        expect(payload.text).toContain('Disk fault');
        expect(JSON.stringify(payload.blocks)).toContain('slice 0 failed');
        expect(JSON.stringify(payload.blocks)).toContain('volumeId');
    });

    it('throws on a non-2xx webhook response', async () => {
        const fetchFn = vi.fn(async () => ({ ok: false, status: 500, text: async () => 'no_service' })) as any;
        const transport = new SlackTransport({ webhookUrl: 'https://hooks.example/abc', fetchFn });
        await expect(transport.send({ severity: 'critical', title: 't', body: 'b' })).rejects.toThrow('500');
    });
});
