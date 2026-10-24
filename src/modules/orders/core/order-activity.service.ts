import { Injectable } from '@nestjs/common';
import type { ActorRef } from '../../../common/types/auth-user.js';
import type {
  OrderActivityType,
  Prisma,
} from '../../../generated/prisma/client.js';
import type { EventType, Milestone } from '../../notifications/events.js';
import { OutboxService } from '../../notifications/outbox.service.js';

/**
 * Order timeline entries that are also domain events. Each is written to the outbox in the SAME
 * transaction as the timeline row; customer-facing milestones carry a deduplication key so a milestone
 * is announced once per order. (QUOTATION_* / PAYMENT_VERIFIED events are emitted by their own services.)
 */
const EVENT_FOR: Partial<Record<OrderActivityType, EventType>> = {
  ORDER_SUBMITTED: 'ORDER_SUBMITTED',
  ORDER_CONFIRMED: 'ORDER_CONFIRMED',
  PRODUCTION_READY: 'ORDER_READY_FOR_PRODUCTION',
  PRODUCTION_COMPLETED: 'ORDER_PRODUCTION_COMPLETED',
  PACKAGING_COMPLETED: 'ORDER_READY_FOR_DELIVERY',
  SHIPMENT_DISPATCHED: 'SHIPMENT_DISPATCHED',
  SHIPMENT_FAILED: 'SHIPMENT_FAILED',
  ORDER_DELIVERED: 'ORDER_DELIVERED',
  COMMERCIAL_REAPPROVAL_REQUIRED: 'COMMERCIAL_REAPPROVAL_REQUIRED',
};
const MILESTONE_FOR: Partial<Record<OrderActivityType, Milestone>> = {
  PRODUCTION_STARTED: 'PRODUCTION_STARTED',
  PACKAGING_STARTED: 'PACKAGING',
};

/** Append-only order timeline: separate from the security AuditLog and from JobActivity. */
@Injectable()
export class OrderActivityService {
  constructor(private readonly outbox: OutboxService) {}

  async log(
    tx: Prisma.TransactionClient,
    orderId: string,
    /** A staff user id, or a customer actor (portal). */
    actor: string | ActorRef | null,
    type: OrderActivityType,
    message: string,
    metadata?: Record<string, unknown>,
  ) {
    const byCustomer = typeof actor === 'object' && actor?.customer === true;
    const actorUserId =
      typeof actor === 'string'
        ? actor
        : byCustomer
          ? null
          : (actor?.id ?? null);
    const row = await tx.orderActivity.create({
      data: {
        orderId,
        actorUserId,
        actorCustomerId: byCustomer ? actor.id : null,
        type,
        message,
        metadata: metadata as Prisma.InputJsonValue | undefined,
      },
    });
    const eventType = EVENT_FOR[type];
    if (eventType) {
      const shipmentId =
        typeof metadata?.shipmentId === 'string'
          ? metadata.shipmentId
          : undefined;
      // "in-transit" is also logged as SHIPMENT_DISPATCHED; only the real dispatch is an event
      if (!(
        type === 'SHIPMENT_DISPATCHED' && metadata?.action === 'in-transit'
      ))
        await this.outbox.emit(tx, {
          eventType,
          aggregateType: shipmentId ? 'Shipment' : 'Order',
          aggregateId: shipmentId ?? orderId,
          // facts that may change before the event is processed travel with it (the reason of a failed delivery)
          payload: {
            orderId,
            ...(shipmentId && { shipmentId }),
            ...(typeof metadata?.reason === 'string' &&
              metadata.reason && { reason: metadata.reason.slice(0, 300) }),
          },
        });
    }
    const milestone = MILESTONE_FOR[type];
    if (milestone)
      await this.outbox.emit(tx, {
        eventType: 'ORDER_MILESTONE',
        aggregateType: 'Order',
        aggregateId: orderId,
        payload: { orderId, milestone },
        deduplicationKey: `MILESTONE:${orderId}:${milestone}`,
      });
    return row;
  }
}
