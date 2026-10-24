import {
  deriveOrderStatus,
  customerStatus,
  shippableQuantity,
  type FulfillmentFacts,
} from './order-fulfillment.js';
import {
  checkOrderTransition,
  ORDER_TRANSITIONS,
  DERIVED_TARGETS,
} from './order-state-machine.js';
import {
  SHIPMENT_ACTIONS,
  SHIPMENT_TRANSITIONS,
  checkShipmentTransition,
} from './shipment-state-machine.js';

const base: FulfillmentFacts = {
  production: 'PRODUCTION_COMPLETED',
  completedQuantity: 500,
  packedQuantity: 500,
  hasPackagingSpec: true,
  packagingStageActive: false,
  packagingStageReady: false,
  deliveredQuantity: 0,
  inFlightQuantity: 0,
};
const f = (o: Partial<FulfillmentFacts>): FulfillmentFacts => ({
  ...base,
  ...o,
});

describe('order fulfilment derivation', () => {
  it('production complete is not delivered: it waits for packaging, then is ready for delivery', () => {
    expect(deriveOrderStatus(f({ hasPackagingSpec: false }))).toBe(
      'PRODUCTION_COMPLETED',
    );
    expect(deriveOrderStatus(f({ packedQuantity: 400 }))).toBe(
      'PRODUCTION_COMPLETED',
    );
    expect(deriveOrderStatus(f({}))).toBe('READY_FOR_DELIVERY');
    expect(
      deriveOrderStatus(f({ completedQuantity: 0, packedQuantity: 0 })),
    ).toBe('PRODUCTION_COMPLETED');
  });

  it('partial shipments never make the order delivered', () => {
    expect(deriveOrderStatus(f({ deliveredQuantity: 300 }))).toBe(
      'PARTIALLY_SHIPPED',
    );
    expect(
      deriveOrderStatus(f({ deliveredQuantity: 300, inFlightQuantity: 100 })),
    ).toBe('PARTIALLY_SHIPPED');
    expect(deriveOrderStatus(f({ inFlightQuantity: 200 }))).toBe(
      'PARTIALLY_SHIPPED',
    );
  });

  it('out for delivery once every unit is on the road; delivered only when all are delivered', () => {
    expect(
      deriveOrderStatus(f({ deliveredQuantity: 300, inFlightQuantity: 200 })),
    ).toBe('OUT_FOR_DELIVERY');
    expect(deriveOrderStatus(f({ inFlightQuantity: 500 }))).toBe(
      'OUT_FOR_DELIVERY',
    );
    expect(deriveOrderStatus(f({ deliveredQuantity: 500 }))).toBe('DELIVERED');
    expect(
      deriveOrderStatus(f({ deliveredQuantity: 499, inFlightQuantity: 0 })),
    ).toBe('PARTIALLY_SHIPPED');
  });

  it('while production is still running: packaging states and partial shipping', () => {
    const running = {
      production: 'IN_PRODUCTION' as const,
      completedQuantity: 0,
      packedQuantity: 0,
    };
    expect(deriveOrderStatus(f({ ...running }))).toBe('IN_PRODUCTION');
    expect(
      deriveOrderStatus(f({ ...running, packagingStageReady: true })),
    ).toBe('READY_FOR_PACKAGING');
    expect(
      deriveOrderStatus(
        f({
          ...running,
          packagingStageActive: true,
          packagingStageReady: true,
        }),
      ),
    ).toBe('PACKAGING');
    expect(
      deriveOrderStatus(
        f({
          production: 'PARTIALLY_COMPLETED',
          completedQuantity: 300,
          packedQuantity: 300,
        }),
      ),
    ).toBe('PARTIALLY_COMPLETED');
    expect(
      deriveOrderStatus(
        f({
          production: 'PARTIALLY_COMPLETED',
          completedQuantity: 300,
          packedQuantity: 300,
          deliveredQuantity: 300,
        }),
      ),
    ).toBe('PARTIALLY_SHIPPED');
  });

  it('never derives COMPLETED', () => {
    expect(deriveOrderStatus(f({ deliveredQuantity: 500 }))).not.toBe(
      'COMPLETED',
    );
    expect(DERIVED_TARGETS).not.toContain('COMPLETED');
  });

  it('shippable quantity is packed, produced and not already committed', () => {
    expect(
      shippableQuantity({
        completedQuantity: 500,
        packedQuantity: 500,
        committedQuantity: 0,
      }),
    ).toBe(500);
    expect(
      shippableQuantity({
        completedQuantity: 500,
        packedQuantity: 300,
        committedQuantity: 100,
      }),
    ).toBe(200);
    expect(
      shippableQuantity({
        completedQuantity: 100,
        packedQuantity: 500,
        committedQuantity: 150,
      }),
    ).toBe(0);
  });

  it('labels statuses for customers without internal detail', () => {
    expect(customerStatus('PARTIALLY_COMPLETED')).toBe('IN_PRODUCTION');
    expect(customerStatus('PACKAGING')).toBe('PACKING');
    expect(customerStatus('PENDING_CONFIRMATION')).toBe('ORDER_RECEIVED');
    expect(customerStatus('ON_HOLD')).toBe('ON_HOLD');
  });
});

describe('order state machine (fulfilment)', () => {
  it('only accepts derived targets and never leaves terminal states', () => {
    expect(
      checkOrderTransition(
        'fulfillment-sync',
        'IN_PRODUCTION',
        null,
        'PACKAGING',
      ),
    ).toEqual({ ok: true, to: 'PACKAGING' });
    expect(
      checkOrderTransition(
        'fulfillment-sync',
        'IN_PRODUCTION',
        null,
        'COMPLETED',
      ).ok,
    ).toBe(false);
    expect(
      checkOrderTransition('fulfillment-sync', 'IN_PRODUCTION', null).ok,
    ).toBe(false);
    expect(
      checkOrderTransition('fulfillment-sync', 'DRAFT', null, 'IN_PRODUCTION')
        .ok,
    ).toBe(false);
    expect(
      checkOrderTransition('fulfillment-sync', 'ON_HOLD', null, 'IN_PRODUCTION')
        .ok,
    ).toBe(false);
    expect(
      checkOrderTransition('fulfillment-sync', 'COMPLETED', null, 'DELIVERED')
        .ok,
    ).toBe(false);
    expect(
      checkOrderTransition(
        'fulfillment-sync',
        'DELIVERED',
        null,
        'PARTIALLY_SHIPPED',
      ).ok,
    ).toBe(false);
  });

  it('completes only from DELIVERED; force-complete needs a reason and skips nothing earlier than production', () => {
    expect(checkOrderTransition('complete', 'DELIVERED', null)).toEqual({
      ok: true,
      to: 'COMPLETED',
    });
    expect(checkOrderTransition('complete', 'PARTIALLY_SHIPPED', null).ok).toBe(
      false,
    );
    expect(
      checkOrderTransition('complete', 'PRODUCTION_COMPLETED', null).ok,
    ).toBe(false);
    expect(ORDER_TRANSITIONS['force-complete'].reasonRequired).toBe(true);
    expect(
      checkOrderTransition('force-complete', 'IN_PRODUCTION', null).ok,
    ).toBe(false);
    expect(
      checkOrderTransition('force-complete', 'PARTIALLY_SHIPPED', null).ok,
    ).toBe(true);
    expect(checkOrderTransition('cancel', 'OUT_FOR_DELIVERY', null).ok).toBe(
      false,
    );
    expect(checkOrderTransition('cancel', 'PARTIALLY_SHIPPED', null).ok).toBe(
      false,
    );
    expect(checkOrderTransition('cancel', 'READY_FOR_DELIVERY', null).ok).toBe(
      true,
    );
    expect(checkOrderTransition('hold', 'READY_FOR_DELIVERY', null).ok).toBe(
      true,
    );
  });
});

describe('shipment state machine', () => {
  it('has a rule per action and walks the happy path', () => {
    for (const a of SHIPMENT_ACTIONS)
      expect(SHIPMENT_TRANSITIONS[a]).toBeDefined();
    let s: Parameters<typeof checkShipmentTransition>[1] = 'DRAFT';
    for (const [a, to] of [
      ['ready', 'READY'],
      ['dispatch', 'DISPATCHED'],
      ['in-transit', 'IN_TRANSIT'],
      ['deliver', 'DELIVERED'],
    ] as const) {
      expect(checkShipmentTransition(a, s)).toEqual({ ok: true, to });
      s = to;
    }
  });

  it('refuses double dispatch, double delivery and moves out of final states', () => {
    expect(checkShipmentTransition('dispatch', 'DISPATCHED').ok).toBe(false);
    expect(checkShipmentTransition('dispatch', 'DRAFT').ok).toBe(false);
    expect(checkShipmentTransition('deliver', 'DELIVERED').ok).toBe(false);
    expect(checkShipmentTransition('deliver', 'READY').ok).toBe(false);
    for (const final of ['DELIVERED', 'RETURNED', 'CANCELLED'] as const)
      for (const a of SHIPMENT_ACTIONS)
        expect(checkShipmentTransition(a, final).ok).toBe(false);
  });

  it('supports failure, retry and return; reasons are required where history matters', () => {
    expect(checkShipmentTransition('fail', 'IN_TRANSIT')).toEqual({
      ok: true,
      to: 'FAILED',
    });
    expect(checkShipmentTransition('dispatch', 'FAILED')).toEqual({
      ok: true,
      to: 'DISPATCHED',
    });
    expect(checkShipmentTransition('return', 'FAILED')).toEqual({
      ok: true,
      to: 'RETURNED',
    });
    expect(checkShipmentTransition('cancel', 'DISPATCHED').ok).toBe(false);
    expect(SHIPMENT_TRANSITIONS.fail.reasonRequired).toBe(true);
    expect(SHIPMENT_TRANSITIONS.return.reasonRequired).toBe(true);
    expect(SHIPMENT_TRANSITIONS.cancel.reasonRequired).toBe(true);
  });
});
