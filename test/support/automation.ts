import type { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/database/prisma.service.js';
import { NotificationDispatcherService } from '../../src/modules/notifications/notification-dispatcher.service.js';
import { OutboxProcessorService } from '../../src/modules/notifications/outbox-processor.service.js';
import {
  LogEmailProvider,
  LogWhatsAppProvider,
} from '../../src/modules/notifications/providers/dev-providers.js';
import {
  EmailProvider,
  WhatsAppProvider,
} from '../../src/modules/notifications/providers/provider.ports.js';

/** Plan every pending outbox event and deliver every due notification (what the scheduler does, on demand). */
export async function drain(app: INestApplication, rounds = 30) {
  const outbox = app.get(OutboxProcessorService);
  const dispatcher = app.get(NotificationDispatcherService);
  const total = { events: 0, notifications: 0, sent: 0, failed: 0, retried: 0 };
  for (let i = 0; i < rounds; i++) {
    const o = await outbox.processBatch(500);
    const d = await dispatcher.dispatchDue(500);
    total.events += o.processed;
    total.notifications += o.notifications;
    total.sent += d.sent;
    total.failed += d.failed;
    total.retried += d.retried;
    if (o.claimed === 0 && d.claimed === 0) break;
  }
  return total;
}

export const providers = (app: INestApplication) => ({
  email: app.get(EmailProvider) as unknown as LogEmailProvider,
  whatsapp: app.get(WhatsAppProvider) as unknown as LogWhatsAppProvider,
});

/** Notifications about one entity (order / sample / job / stage / shipment id). */
export const notificationsFor = (app: INestApplication, entityId: string) =>
  app.get(PrismaService).notification.findMany({
    where: { entityId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
