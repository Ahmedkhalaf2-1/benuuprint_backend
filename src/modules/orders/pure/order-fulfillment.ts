import type { OrderStatus } from '../../../generated/prisma/client.js';
import type { DerivedOrderProduction } from './order-production.js';

export interface FulfillmentFacts {
  production: DerivedOrderProduction;
  /** units that passed the final production stage (all non-cancelled jobs) */
  completedQuantity: number;
  /** units reported packed on the packaging stage */
  packedQuantity: number;
  hasPackagingSpec: boolean;
  /** a live job's PACKAGING stage is running / waiting to be started */
  packagingStageActive: boolean;
  packagingStageReady: boolean;
  /** units on DELIVERED shipments */
  deliveredQuantity: number;
  /** units on DISPATCHED / IN_TRANSIT shipments */
  inFlightQuantity: number;
}

/**
 * The status an order should have given what production, packaging and shipments say.
 * Pure and total: the order service applies it through the state machine (`fulfillment-sync`).
 * COMPLETED is never derived: closing an order is an explicit, checked action.
 */
export function deriveOrderStatus(f: FulfillmentFacts): OrderStatus {
  const shipped = f.deliveredQuantity + f.inFlightQuantity;
  if (f.production === 'PRODUCTION_COMPLETED') {
    if (f.completedQuantity > 0 && f.deliveredQuantity >= f.completedQuantity)
      return 'DELIVERED';
    if (f.inFlightQuantity > 0 && shipped >= f.completedQuantity)
      return 'OUT_FOR_DELIVERY';
    if (shipped > 0) return 'PARTIALLY_SHIPPED';
    if (
      f.hasPackagingSpec &&
      f.completedQuantity > 0 &&
      f.packedQuantity >= f.completedQuantity
    )
      return 'READY_FOR_DELIVERY';
    return 'PRODUCTION_COMPLETED';
  }
  if (shipped > 0) return 'PARTIALLY_SHIPPED';
  if (f.packagingStageActive) return 'PACKAGING';
  if (f.packagingStageReady) return 'READY_FOR_PACKAGING';
  return f.production;
}

/** Units that can still go on a new shipment: packed, produced and not already committed. */
export function shippableQuantity(input: {
  completedQuantity: number;
  packedQuantity: number;
  committedQuantity: number;
}): number {
  return Math.max(
    0,
    Math.min(input.completedQuantity, input.packedQuantity) -
      input.committedQuantity,
  );
}

/** Customer-facing label of an order status: coarse on purpose, nothing internal. */
export function customerStatus(status: OrderStatus): string {
  switch (status) {
    case 'DRAFT':
    case 'PENDING_CONFIRMATION':
      return 'ORDER_RECEIVED';
    case 'CONFIRMED':
    case 'READY_FOR_PRODUCTION':
      return 'CONFIRMED';
    case 'IN_PRODUCTION':
    case 'PARTIALLY_COMPLETED':
    case 'PRODUCTION_COMPLETED':
      return 'IN_PRODUCTION';
    case 'READY_FOR_PACKAGING':
    case 'PACKAGING':
      return 'PACKING';
    case 'READY_FOR_DELIVERY':
      return 'READY_FOR_DELIVERY';
    case 'PARTIALLY_SHIPPED':
      return 'PARTIALLY_SHIPPED';
    case 'OUT_FOR_DELIVERY':
      return 'OUT_FOR_DELIVERY';
    case 'DELIVERED':
      return 'DELIVERED';
    case 'COMPLETED':
      return 'COMPLETED';
    case 'ON_HOLD':
      return 'ON_HOLD';
    case 'CANCELLED':
      return 'CANCELLED';
  }
}
