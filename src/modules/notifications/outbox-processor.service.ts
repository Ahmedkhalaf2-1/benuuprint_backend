import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { ManagementContext } from '../management/management-context.service.js';
import { NotificationPlannerService } from './notification-planner.service.js';
import { addSeconds, backoffSeconds } from './retry-policy.js';

export interface OutboxRunResult {
  claimed: number;
  processed: number;
  retried: number;
  failed: number;
  notifications: number;
}

/**
 * Drains the outbox. Safe to run concurrently and to crash:
 *  - events are claimed with `FOR UPDATE SKIP LOCKED` and stamped PROCESSING (the attempt counts at claim);
 *  - a PROCESSING event whose lease expired (worker died) is claimed again;
 *  - planning is idempotent (deduplication keys), so a second pass over the same event creates nothing new;
 *  - a failing event is retried with bounded backoff and finally marked FAILED, never retried forever.
 */
@Injectable()
export class OutboxProcessorService {
  private readonly logger = new Logger(OutboxProcessorService.name);
  private readonly cfg: AppConfig['notifications'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly planner: NotificationPlannerService,
    private readonly ctx: ManagementContext,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<AppConfig>('app').notifications;
  }

  async processBatch(
    limit = this.cfg.outboxBatchSize,
  ): Promise<OutboxRunResult> {
    const now = this.ctx.now();
    const cutoff = addSeconds(now, -this.cfg.outboxLeaseSeconds);
    const claimed = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE outbox_events SET status = 'PROCESSING', locked_at = ${now}, attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM outbox_events
        WHERE (status = 'PENDING' AND next_attempt_at <= ${now})
           OR (status = 'PROCESSING' AND locked_at < ${cutoff})
        ORDER BY occurred_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
      RETURNING id`);
    const result: OutboxRunResult = {
      claimed: claimed.length,
      processed: 0,
      retried: 0,
      failed: 0,
      notifications: 0,
    };
    if (claimed.length === 0) return result;
    const events = await this.prisma.outboxEvent.findMany({
      where: { id: { in: claimed.map((c) => c.id) } },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
    for (const event of events) {
      try {
        result.notifications += await this.planner.plan(event);
        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            status: 'PROCESSED',
            processedAt: now,
            lockedAt: null,
            lastError: null,
          },
        });
        result.processed += 1;
      } catch (e) {
        const message = (e instanceof Error ? e.message : String(e)).slice(
          0,
          500,
        );
        const exhausted = event.attempts >= this.cfg.outboxMaxAttempts;
        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: exhausted
            ? { status: 'FAILED', lockedAt: null, lastError: message }
            : {
                status: 'PENDING',
                lockedAt: null,
                lastError: message,
                nextAttemptAt: addSeconds(
                  now,
                  backoffSeconds(
                    event.attempts,
                    this.cfg.retryBaseSeconds,
                    this.cfg.retryMaxSeconds,
                  ),
                ),
              },
        });
        if (exhausted) result.failed += 1;
        else result.retried += 1;
        this.logger.warn(
          `Outbox event ${event.id} (${event.eventType}) attempt ${event.attempts}: ${message}`,
        );
      }
    }
    return result;
  }
}
