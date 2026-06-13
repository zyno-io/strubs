import { createLogger } from '../log';
import type { Config } from '../config';
import { notificationService, NotificationService } from './service';
import { LogTransport } from './transports/log-transport';
import { SlackTransport } from './transports/slack-transport';

// Wires configured transports onto the notification service at startup. The log
// transport is always on; Slack is added only when a webhook is configured.
export function configureNotifications(config: Config, service: NotificationService = notificationService): void {
    const log = createLogger('notify-bootstrap');
    // Idempotent: a retried startup must not accumulate duplicate transports.
    service.clearTransports();
    service.configure({ cooldownMs: config.notifyCooldownMs });
    service.registerTransport(new LogTransport('info'));

    if (config.slackWebhookUrl) {
        service.registerTransport(new SlackTransport({
            webhookUrl: config.slackWebhookUrl,
            minSeverity: config.slackMinSeverity
        }));
        log('slack notifications enabled (minSeverity=%s)', config.slackMinSeverity);
    }
    else {
        log('slack webhook not configured; using log transport only');
    }
}
