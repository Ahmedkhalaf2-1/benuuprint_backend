import type { OrderStatus } from '../../../generated/prisma/client.js';
import {
  CUSTOMER_ORDER_STATUSES,
  ORDER_NEXT_STEP,
  orderAllowedActions,
  projectOrderActivity,
  toCustomerOrderStatus,
  type OrderStatusFacts,
} from './customer-order-status.js';

const f = (
  status: OrderStatus,
  over: Partial<OrderStatusFacts> = {},
): OrderStatusFacts => ({
  status,
  holdPreviousStatus: null,
  openQuotation: false,
  accepted: false,
  paymentState: 'UNPAID',
  pendingPayment: false,
  ...over,
});

describe('customer order status', () => {
  it('maps every internal status to a customer status with a next step', () => {
    const all: OrderStatus[] = [
      'DRAFT',
      'PENDING_CONFIRMATION',
      'CONFIRMED',
      'READY_FOR_PRODUCTION',
      'IN_PRODUCTION',
      'PARTIALLY_COMPLETED',
      'PRODUCTION_COMPLETED',
      'READY_FOR_PACKAGING',
      'PACKAGING',
      'READY_FOR_DELIVERY',
      'PARTIALLY_SHIPPED',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
      'COMPLETED',
      'ON_HOLD',
      'CANCELLED',
    ];
    for (const s of all) {
      const mapped = toCustomerOrderStatus(f(s));
      expect(CUSTOMER_ORDER_STATUSES).toContain(mapped);
      expect(ORDER_NEXT_STEP[mapped]).toBeTruthy();
    }
  });

  it('walks the commercial steps of a confirmed order', () => {
    expect(toCustomerOrderStatus(f('CONFIRMED'))).toBe('QUOTATION_PENDING');
    expect(toCustomerOrderStatus(f('CONFIRMED', { openQuotation: true }))).toBe(
      'QUOTATION_READY',
    );
    expect(toCustomerOrderStatus(f('CONFIRMED', { accepted: true }))).toBe(
      'PAYMENT_REQUIRED',
    );
    expect(
      toCustomerOrderStatus(
        f('CONFIRMED', { accepted: true, pendingPayment: true }),
      ),
    ).toBe('PAYMENT_UNDER_REVIEW');
    expect(
      toCustomerOrderStatus(
        f('CONFIRMED', { accepted: true, paymentState: 'PAID' }),
      ),
    ).toBe('READY_FOR_PRODUCTION');
  });

  it('shows a quotation sent before confirmation and hides holds', () => {
    expect(
      toCustomerOrderStatus(f('PENDING_CONFIRMATION', { openQuotation: true })),
    ).toBe('QUOTATION_READY');
    expect(toCustomerOrderStatus(f('PENDING_CONFIRMATION'))).toBe(
      'PENDING_CONFIRMATION',
    );
    expect(
      toCustomerOrderStatus(
        f('ON_HOLD', { holdPreviousStatus: 'IN_PRODUCTION' }),
      ),
    ).toBe('IN_PRODUCTION');
  });

  it('follows production, packaging and delivery', () => {
    expect(toCustomerOrderStatus(f('PARTIALLY_COMPLETED'))).toBe(
      'IN_PRODUCTION',
    );
    expect(toCustomerOrderStatus(f('PRODUCTION_COMPLETED'))).toBe(
      'IN_PRODUCTION',
    );
    expect(toCustomerOrderStatus(f('PACKAGING'))).toBe('PACKAGING');
    expect(toCustomerOrderStatus(f('READY_FOR_DELIVERY'))).toBe(
      'READY_TO_SHIP',
    );
    expect(toCustomerOrderStatus(f('PARTIALLY_SHIPPED'))).toBe(
      'PARTIALLY_SHIPPED',
    );
    expect(toCustomerOrderStatus(f('OUT_FOR_DELIVERY'))).toBe('SHIPPED');
    expect(toCustomerOrderStatus(f('DELIVERED'))).toBe('DELIVERED');
  });
});

describe('customer order actions', () => {
  const a = (
    status: OrderStatus,
    over: Partial<{
      openQuotation: boolean;
      canSubmitPayment: boolean;
      reorderable: boolean;
    }> = {},
  ) =>
    orderAllowedActions({
      status,
      openQuotation: false,
      canSubmitPayment: false,
      reorderable: false,
      ...over,
    });

  it('lets a draft be edited and submitted, nothing else', () => {
    expect(a('DRAFT')).toEqual(['EDIT_ORDER', 'SUBMIT_ORDER']);
    expect(a('PENDING_CONFIRMATION')).toEqual([]);
  });

  it('offers the quotation decision only for an open quotation', () => {
    expect(a('CONFIRMED', { openQuotation: true })).toEqual([
      'ACCEPT_QUOTATION',
      'REJECT_QUOTATION',
    ]);
    expect(a('IN_PRODUCTION', { openQuotation: true })).toEqual([]);
  });

  it('offers payment proof only while money is owed, never on a draft or cancelled order', () => {
    expect(a('CONFIRMED', { canSubmitPayment: true })).toEqual([
      'UPLOAD_PAYMENT_PROOF',
    ]);
    expect(a('DRAFT', { canSubmitPayment: true })).not.toContain(
      'UPLOAD_PAYMENT_PROOF',
    );
    expect(a('CANCELLED', { canSubmitPayment: true })).toEqual([]);
  });

  it('offers reorder only when eligible', () => {
    expect(a('DELIVERED', { reorderable: true })).toEqual(['REORDER']);
    expect(a('DELIVERED')).toEqual([]);
  });
});

describe('customer order timeline', () => {
  it('keeps whitelisted events with customer titles and drops everything internal', () => {
    const t = (n: number) => new Date(2026, 0, n);
    const events = projectOrderActivity([
      { type: 'ORDER_CREATED', createdAt: t(1), metadata: null },
      { type: 'ORDER_UPDATED', createdAt: t(2), metadata: null },
      { type: 'PRIORITY_CHANGED', createdAt: t(3), metadata: null },
      { type: 'ORDER_HELD', createdAt: t(4), metadata: null },
      { type: 'BATCH_CREATED', createdAt: t(5), metadata: null },
      { type: 'JOB_CREATED', createdAt: t(6), metadata: null },
      { type: 'TRACKING_UPDATED', createdAt: t(7), metadata: null },
      {
        type: 'QUOTATION_SENT',
        createdAt: t(8),
        metadata: { decision: 'reject' },
      },
      { type: 'QUOTATION_SENT', createdAt: t(9), metadata: null },
      {
        type: 'SHIPMENT_DISPATCHED',
        createdAt: t(10),
        metadata: { action: 'in-transit' },
      },
      { type: 'SHIPMENT_DISPATCHED', createdAt: t(11), metadata: {} },
      { type: 'ORDER_DELIVERED', createdAt: t(12), metadata: null },
    ]);
    expect(events.map((e) => e.title)).toEqual([
      'Order created',
      'Quotation declined',
      'Quotation ready',
      'Shipment dispatched',
      'Order delivered',
    ]);
  });
});
