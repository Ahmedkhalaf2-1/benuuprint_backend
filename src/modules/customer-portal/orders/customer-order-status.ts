import type { OrderStatus } from '../../../generated/prisma/client.js';

/**
 * What a customer sees of an order's lifecycle. Derived from the internal OrderStatus plus a few commercial
 * facts (no new enum, no second state machine). A hold is not shown: the customer sees the status it
 * interrupted.
 */
export const CUSTOMER_ORDER_STATUSES = [
  'DRAFT',
  'PENDING_CONFIRMATION',
  'QUOTATION_PENDING',
  'QUOTATION_READY',
  'PAYMENT_REQUIRED',
  'PAYMENT_UNDER_REVIEW',
  'READY_FOR_PRODUCTION',
  'IN_PRODUCTION',
  'PACKAGING',
  'READY_TO_SHIP',
  'PARTIALLY_SHIPPED',
  'SHIPPED',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type CustomerOrderStatus = (typeof CUSTOMER_ORDER_STATUSES)[number];

export type CustomerOrderAction =
  | 'EDIT_ORDER'
  | 'SUBMIT_ORDER'
  | 'ACCEPT_QUOTATION'
  | 'REJECT_QUOTATION'
  | 'UPLOAD_PAYMENT_PROOF'
  | 'REORDER';
export const CUSTOMER_ORDER_ACTIONS: readonly CustomerOrderAction[] = [
  'EDIT_ORDER',
  'SUBMIT_ORDER',
  'ACCEPT_QUOTATION',
  'REJECT_QUOTATION',
  'UPLOAD_PAYMENT_PROOF',
  'REORDER',
];

export interface OrderStatusFacts {
  status: OrderStatus;
  holdPreviousStatus: OrderStatus | null;
  /** An unexpired, not-invalidated SENT quotation version exists. */
  openQuotation: boolean;
  /** A quotation version is currently ACCEPTED (an accepted one ended by a change is not). */
  accepted: boolean;
  /** Cached backend payment state against the accepted quotation. */
  paymentState: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';
  /** A payment of the order is waiting for staff review. */
  pendingPayment: boolean;
}

export function toCustomerOrderStatus(
  f: OrderStatusFacts,
): CustomerOrderStatus {
  const effective =
    f.status === 'ON_HOLD' ? (f.holdPreviousStatus ?? 'CONFIRMED') : f.status;
  switch (effective) {
    case 'DRAFT':
      return 'DRAFT';
    case 'PENDING_CONFIRMATION':
      return f.openQuotation ? 'QUOTATION_READY' : 'PENDING_CONFIRMATION';
    case 'CONFIRMED':
      if (f.accepted) {
        if (f.paymentState === 'PAID') return 'READY_FOR_PRODUCTION';
        return f.pendingPayment ? 'PAYMENT_UNDER_REVIEW' : 'PAYMENT_REQUIRED';
      }
      return f.openQuotation ? 'QUOTATION_READY' : 'QUOTATION_PENDING';
    case 'READY_FOR_PRODUCTION':
      return 'READY_FOR_PRODUCTION';
    case 'IN_PRODUCTION':
    case 'PARTIALLY_COMPLETED':
    case 'PRODUCTION_COMPLETED':
      return 'IN_PRODUCTION';
    case 'READY_FOR_PACKAGING':
    case 'PACKAGING':
      return 'PACKAGING';
    case 'READY_FOR_DELIVERY':
      return 'READY_TO_SHIP';
    case 'PARTIALLY_SHIPPED':
      return 'PARTIALLY_SHIPPED';
    case 'OUT_FOR_DELIVERY':
      return 'SHIPPED';
    case 'DELIVERED':
      return 'DELIVERED';
    case 'COMPLETED':
      return 'COMPLETED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'ON_HOLD':
      return 'PENDING_CONFIRMATION';
  }
}

export const ORDER_NEXT_STEP: Record<CustomerOrderStatus, string> = {
  DRAFT: 'Set your quantities and submit the order when you are ready.',
  PENDING_CONFIRMATION: 'Our team is reviewing your order.',
  QUOTATION_PENDING: 'Our team is preparing your quotation.',
  QUOTATION_READY: 'Review your quotation.',
  PAYMENT_REQUIRED: 'Payment is required.',
  PAYMENT_UNDER_REVIEW: 'Your payment proof is being reviewed.',
  READY_FOR_PRODUCTION: 'Your order is ready for production.',
  IN_PRODUCTION: 'Your order is being produced.',
  PACKAGING: 'Your order is being packed.',
  READY_TO_SHIP: 'Your order is packed and ready to ship.',
  PARTIALLY_SHIPPED: 'Part of your order has shipped.',
  SHIPPED: 'Your order is on its way.',
  DELIVERED: 'Your order has been delivered.',
  COMPLETED: 'Your order is complete. Thank you!',
  CANCELLED: 'This order was cancelled.',
};

export const ORDER_STATUS_LABEL: Record<CustomerOrderStatus, string> = {
  DRAFT: 'Draft',
  PENDING_CONFIRMATION: 'Pending confirmation',
  QUOTATION_PENDING: 'Preparing quotation',
  QUOTATION_READY: 'Quotation ready',
  PAYMENT_REQUIRED: 'Payment required',
  PAYMENT_UNDER_REVIEW: 'Payment under review',
  READY_FOR_PRODUCTION: 'Ready for production',
  IN_PRODUCTION: 'In production',
  PACKAGING: 'Packaging',
  READY_TO_SHIP: 'Ready to ship',
  PARTIALLY_SHIPPED: 'Partially shipped',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export interface OrderActionFacts {
  status: OrderStatus;
  openQuotation: boolean;
  /** Money still owed on the accepted quotation and room for another pending submission. */
  canSubmitPayment: boolean;
  /** Confirmed, and either delivered or completed (a finished piece of business). */
  reorderable: boolean;
}

export function orderAllowedActions(
  f: OrderActionFacts,
): CustomerOrderAction[] {
  const out: CustomerOrderAction[] = [];
  if (f.status === 'DRAFT') out.push('EDIT_ORDER', 'SUBMIT_ORDER');
  const quotable = [
    'PENDING_CONFIRMATION',
    'CONFIRMED',
    'READY_FOR_PRODUCTION',
    'ON_HOLD',
  ].includes(f.status);
  if (quotable && f.openQuotation)
    out.push('ACCEPT_QUOTATION', 'REJECT_QUOTATION');
  if (f.canSubmitPayment && f.status !== 'CANCELLED' && f.status !== 'DRAFT')
    out.push('UPLOAD_PAYMENT_PROOF');
  if (f.reorderable) out.push('REORDER');
  return out;
}

/** Statuses from which a customer may place a reorder: the business is finished. */
export const REORDERABLE_STATUSES: readonly OrderStatus[] = [
  'DELIVERED',
  'COMPLETED',
];

/** Titles of the order timeline entries a customer may see (everything else is internal). */
export const ORDER_ACTIVITY_TITLE: Partial<Record<string, string>> = {
  ORDER_CREATED: 'Order created',
  ORDER_SUBMITTED: 'Order submitted',
  ORDER_CONFIRMED: 'Order confirmed',
  QUOTATION_ACCEPTED: 'Quotation accepted',
  PAYMENT_VERIFIED: 'Payment verified',
  PRODUCTION_READY: 'Ready for production',
  PRODUCTION_STARTED: 'Production started',
  PRODUCTION_COMPLETED: 'Production complete',
  PACKAGING_STARTED: 'Packaging started',
  PACKAGING_COMPLETED: 'Ready to ship',
  SHIPMENT_DISPATCHED: 'Shipment dispatched',
  SHIPMENT_DELIVERED: 'Shipment delivered',
  SHIPMENT_FAILED: 'A delivery attempt failed',
  ORDER_DELIVERED: 'Order delivered',
  ORDER_COMPLETED: 'Order completed',
  ORDER_CANCELLED: 'Order cancelled',
  COMMERCIAL_REAPPROVAL_REQUIRED: 'A new quotation is needed',
};

export interface OrderActivityRow {
  type: string;
  createdAt: Date;
  metadata: unknown;
}

/**
 * Customer-safe timeline of an order from its internal activity: whitelisted types only, titles written
 * for customers, no free text from staff (messages, reasons and hold/priority/job/batch events stay internal).
 */
export function projectOrderActivity(rows: OrderActivityRow[]) {
  const out: { at: Date; kind: 'ORDER'; title: string }[] = [];
  for (const r of rows) {
    const meta = (r.metadata ?? {}) as { decision?: string; action?: string };
    let title = ORDER_ACTIVITY_TITLE[r.type];
    // a rejected quotation is logged as QUOTATION_SENT with the decision in its metadata
    if (r.type === 'QUOTATION_SENT')
      title =
        meta.decision === 'reject' ? 'Quotation declined' : 'Quotation ready';
    // "in transit" is logged as a dispatch too; only the real dispatch is shown
    if (r.type === 'SHIPMENT_DISPATCHED' && meta.action === 'in-transit')
      continue;
    if (!title) continue;
    out.push({ at: r.createdAt, kind: 'ORDER', title });
  }
  return out;
}
