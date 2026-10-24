import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { randomUUID } from 'node:crypto';
import { assertNoSecrets } from './template-renderer.js';
import type { EventType } from './events.js';

export interface OutboxEmit {
  eventType: EventType;
  aggregateType: string;
  aggregateId: string;
  /** Identifiers and safe facts only. */
  payload: Record<string, unknown>;
  /**
   * Natural key when the same occurrence can be emitted twice (a milestone reached once per order). Omit for
   * events that are distinct every time; they get a random key.
   */
  deduplicationKey?: string;
}

/**
 * Transactional outbox: `emit` is called INSIDE the business transaction, so the event exists if and only if
 * the business change committed. Nothing is sent here; a worker plans and delivers notifications later, so an
 * email / WhatsApp failure can never roll back an order update, a stage completion, a payment or a dispatch.
 */
@Injectable()
export class OutboxService {
  async emit(tx: Prisma.TransactionClient, event: OutboxEmit): Promise<void> {
    assertNoSecrets(event.payload);
    await tx.outboxEvent.createMany({
      data: [
        {
          eventType: event.eventType,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          payload: event.payload as Prisma.InputJsonValue,
          deduplicationKey:
            event.deduplicationKey ?? `${event.eventType}:${randomUUID()}`,
        },
      ],
      skipDuplicates: true,
    });
  }
}
