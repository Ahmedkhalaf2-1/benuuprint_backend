import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma, type Notification } from '../../generated/prisma/client.js';
import { ManagementContext } from '../management/management-context.service.js';
import {
  EmailProvider,
  ProviderError,
  WhatsAppProvider,
  type DeliveryResult,
} from './providers/provider.ports.js';
import { addSeconds, backoffSeconds } from './retry-policy.js';
import { toHtml } from './template-renderer.js';

export interface DispatchRunResult {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
}

/**
 * Delivers PENDING external notifications through the provider ports. Retries use bounded exponential
 * backoff; permanent errors (invalid recipient, disabled channel) fail at once. The notification id is the
 * provider idempotency key, so a retry after a crash between "provider accepted" and "row updated" does not
 * send a second message.
 */
@Injectable()
export class NotificationDispatcherService {
  private readonly logger = new Logger(NotificationDispatcherService.name);
  private readonly cfg: AppConfig['notifications'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: ManagementContext,
    private readonly email: EmailProvider,
    private readonly whatsapp: WhatsAppProvider,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<AppConfig>('app').notifications;
  }

  async dispatchDue(
    limit = this.cfg.outboxBatchSize,
  ): Promise<DispatchRunResult> {
    const now = this.ctx.now();
    const cutoff = addSeconds(now, -this.cfg.outboxLeaseSeconds);
    const claimed = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE notifications SET status = 'PROCESSING', locked_at = ${now}, attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM notifications
        WHERE channel <> 'IN_APP'
          AND ((status = 'PENDING' AND COALESCE(next_attempt_at, created_at) <= ${now})
            OR (status = 'PROCESSING' AND locked_at < ${cutoff}))
        ORDER BY created_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
      RETURNING id`);
    const result: DispatchRunResult = {
      claimed: claimed.length,
      sent: 0,
      retried: 0,
      failed: 0,
    };
    if (claimed.length === 0) return result;
    const rows = await this.prisma.notification.findMany({
      where: { id: { in: claimed.map((c) => c.id) } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const n of rows) {
      try {
        const delivered = await this.deliver(n);
        await this.prisma.notification.update({
          where: { id: n.id },
          data: {
            status: 'SENT',
            sentAt: now,
            providerMessageId: delivered.providerMessageId,
            lockedAt: null,
            failureReason: null,
            failedAt: null,
          },
        });
        result.sent += 1;
      } catch (e) {
        const permanent = e instanceof ProviderError && e.permanent;
        const reason = (e instanceof Error ? e.message : String(e)).slice(
          0,
          500,
        );
        const exhausted = n.attempts >= this.cfg.maxAttempts;
        if (permanent || exhausted) {
          await this.prisma.notification.update({
            where: { id: n.id },
            data: {
              status: 'FAILED',
              failedAt: now,
              lockedAt: null,
              failureReason: permanent
                ? reason
                : `${reason} (gave up after ${n.attempts} attempts)`,
            },
          });
          result.failed += 1;
        } else {
          await this.prisma.notification.update({
            where: { id: n.id },
            data: {
              status: 'PENDING',
              lockedAt: null,
              failureReason: reason,
              nextAttemptAt: addSeconds(
                now,
                backoffSeconds(
                  n.attempts,
                  this.cfg.retryBaseSeconds,
                  this.cfg.retryMaxSeconds,
                ),
              ),
            },
          });
          result.retried += 1;
        }
        this.logger.warn(
          `Notification ${n.id} (${n.channel}) attempt ${n.attempts}: ${permanent ? 'permanent' : 'transient'} failure: ${reason}`,
        );
      }
    }
    return result;
  }

  private async deliver(n: Notification): Promise<DeliveryResult> {
    if (!n.recipientAddress)
      throw new ProviderError(
        'The notification has no recipient address',
        true,
      );
    const metadata = {
      notificationId: n.id,
      type: n.type,
      ...(n.entityType && n.entityId
        ? { entityType: n.entityType, entityId: n.entityId }
        : {}),
    };
    if (n.channel === 'EMAIL')
      return this.email.send({
        to: n.recipientAddress,
        from: this.cfg.emailFrom,
        subject: n.title,
        text: n.body,
        html: toHtml(n.body),
        idempotencyKey: n.id,
        metadata,
      });
    const vars = (n.variables ?? {}) as Record<string, string>;
    return this.whatsapp.send({
      to: n.recipientAddress,
      templateName: `${(n.templateCode ?? n.type).toLowerCase()}_${n.locale}`,
      locale: n.locale,
      variables: Object.values(vars),
      fallbackText: n.body,
      idempotencyKey: n.id,
      metadata,
    });
  }
}
