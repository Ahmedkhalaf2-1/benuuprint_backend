import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ActorRef } from '../../../common/types/auth-user.js';
import type {
  Order,
  OrderActivityType,
  OrderStatus,
  Prisma,
} from '../../../generated/prisma/client.js';
import { OrderActivityService } from './order-activity.service.js';
import {
  ORDER_TRANSITIONS,
  checkOrderTransition,
  type OrderAction,
} from '../pure/order-state-machine.js';

type Tx = Prisma.TransactionClient;

const ACTIVITY_FOR: Record<OrderAction, OrderActivityType> = {
  submit: 'ORDER_SUBMITTED',
  'request-changes': 'ORDER_UPDATED',
  confirm: 'ORDER_CONFIRMED',
  'mark-ready': 'PRODUCTION_READY',
  'production-started': 'PRODUCTION_STARTED',
  'production-partial': 'ORDER_UPDATED',
  'production-completed': 'PRODUCTION_COMPLETED',
  'production-reset': 'ORDER_UPDATED',
  'commercial-reapproval': 'COMMERCIAL_REAPPROVAL_REQUIRED',
  'fulfillment-sync': 'ORDER_UPDATED',
  complete: 'ORDER_COMPLETED',
  'force-complete': 'ORDER_COMPLETED',
  hold: 'ORDER_HELD',
  resume: 'ORDER_RESUMED',
  cancel: 'ORDER_CANCELLED',
};

/** The timeline event for a status the production / delivery facts moved the order to. */
const DERIVED_ACTIVITY: Partial<Record<OrderStatus, OrderActivityType>> = {
  IN_PRODUCTION: 'PRODUCTION_STARTED',
  PACKAGING: 'PACKAGING_STARTED',
  READY_FOR_DELIVERY: 'PACKAGING_COMPLETED',
  DELIVERED: 'ORDER_DELIVERED',
};

export interface OrderTransitionContext {
  actor: ActorRef | null;
  reason?: string | null;
  message?: string;
  metadata?: Record<string, unknown>;
  /** For `fulfillment-sync`: the derived status to move to. */
  derivedTarget?: OrderStatus;
}

/**
 * The only place an order's status changes: state-machine check, timestamps, and the order
 * timeline entry, inside the caller's transaction. Callers hold the order lock (`lock`).
 */
@Injectable()
export class OrderTransitionsService {
  constructor(private readonly activity: OrderActivityService) {}

  /** Root lock of everything order-related: batches, jobs and reports lock the order first. */
  async lock(tx: Tx, orderId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
  }

  async apply(
    tx: Tx,
    orderId: string,
    action: OrderAction,
    ctx: OrderTransitionContext,
  ): Promise<Order> {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    const check = checkOrderTransition(
      action,
      order.status,
      order.holdPreviousStatus,
      ctx.derivedTarget,
    );
    if (!check.ok) {
      throw new ConflictException(
        check.reason === 'NO_PREVIOUS_STATUS'
          ? 'The order has no status to resume to'
          : `Cannot ${action.replace(/-/g, ' ')} an order that is ${order.status}`,
      );
    }
    const reason = ctx.reason?.trim() || null;
    if (ORDER_TRANSITIONS[action].reasonRequired && !reason) {
      throw new BadRequestException(
        `A reason is required to ${action.replace(/-/g, ' ')}`,
      );
    }
    const now = new Date();
    const data: Prisma.OrderUncheckedUpdateInput = {
      status: check.to,
      holdPreviousStatus: check.to === 'ON_HOLD' ? order.status : null,
    };
    if (action === 'hold') {
      data.holdReason = reason;
      data.heldAt = now;
    }
    if (action === 'resume') {
      data.holdReason = null;
      data.heldAt = null;
    }
    if (action === 'cancel') {
      data.cancelledAt = now;
      data.cancellationReason = reason;
      data.holdReason = null;
      data.heldAt = null;
    }
    if (action === 'confirm') data.confirmedAt = order.confirmedAt ?? now;
    if (action === 'production-started')
      data.productionStartDate = order.productionStartDate ?? now;
    if (action === 'production-completed') data.completedAt = now;
    if (check.to === 'PRODUCTION_COMPLETED' && !order.completedAt)
      data.completedAt = now;
    if (check.to === 'DELIVERED') data.deliveredAt = order.deliveredAt ?? now;
    if (action === 'complete' || action === 'force-complete')
      data.closedAt = now;
    if (action === 'production-reset') data.productionStartDate = null;
    if (action === 'fulfillment-sync') {
      // production start is stamped the first time the order leaves "ready", cleared if it falls back
      if (check.to === 'READY_FOR_PRODUCTION') data.productionStartDate = null;
      else data.productionStartDate = order.productionStartDate ?? now;
    }
    const updated = await tx.order.update({ where: { id: orderId }, data });
    await this.activity.log(
      tx,
      orderId,
      ctx.actor,
      action === 'fulfillment-sync'
        ? check.to === 'IN_PRODUCTION' &&
          order.status !== 'READY_FOR_PRODUCTION'
          ? 'ORDER_UPDATED' // falling back from packaging, not a first start
          : (DERIVED_ACTIVITY[check.to] ?? 'ORDER_UPDATED')
        : ACTIVITY_FOR[action],
      ctx.message ??
        `${order.orderNumber}: ${order.status} → ${check.to}${reason ? ` (${reason})` : ''}`,
      { action, from: order.status, to: check.to, reason, ...ctx.metadata },
    );
    return updated;
  }
}
