import type { ShipmentStatus } from '../../../generated/prisma/client.js';

/**
 * Shipment lifecycle as data (a database trigger repeats the whitelist).
 *
 *  DRAFT ─ready→ READY ─dispatch→ DISPATCHED ─in-transit→ IN_TRANSIT ─deliver→ DELIVERED
 *                                    │  └──────────fail→ FAILED ─dispatch (retry)→ DISPATCHED
 *                                    └─────return→ RETURNED ←──return── FAILED
 *  cancel: DRAFT | READY → CANCELLED
 *
 * Units on CANCELLED or RETURNED shipments are available to ship again.
 */
export const SHIPMENT_ACTIONS = [
  'ready',
  'dispatch',
  'in-transit',
  'deliver',
  'fail',
  'return',
  'cancel',
] as const;
export type ShipmentAction = (typeof SHIPMENT_ACTIONS)[number];

interface Rule {
  from: readonly ShipmentStatus[];
  to: ShipmentStatus;
  reasonRequired: boolean;
}

export const SHIPMENT_TRANSITIONS: Record<ShipmentAction, Rule> = {
  ready: { from: ['DRAFT'], to: 'READY', reasonRequired: false },
  dispatch: {
    from: ['READY', 'FAILED'],
    to: 'DISPATCHED',
    reasonRequired: false,
  },
  'in-transit': {
    from: ['DISPATCHED'],
    to: 'IN_TRANSIT',
    reasonRequired: false,
  },
  deliver: {
    from: ['DISPATCHED', 'IN_TRANSIT'],
    to: 'DELIVERED',
    reasonRequired: false,
  },
  fail: {
    from: ['DISPATCHED', 'IN_TRANSIT'],
    to: 'FAILED',
    reasonRequired: true,
  },
  return: {
    from: ['DISPATCHED', 'IN_TRANSIT', 'FAILED'],
    to: 'RETURNED',
    reasonRequired: true,
  },
  cancel: { from: ['DRAFT', 'READY'], to: 'CANCELLED', reasonRequired: true },
};

/** Units on a shipment in these states are spoken for. */
export const COMMITTED_SHIPMENT_STATUSES: readonly ShipmentStatus[] = [
  'DRAFT',
  'READY',
  'DISPATCHED',
  'IN_TRANSIT',
  'DELIVERED',
  'FAILED',
];
export const IN_FLIGHT_SHIPMENT_STATUSES: readonly ShipmentStatus[] = [
  'DISPATCHED',
  'IN_TRANSIT',
];
export const FINAL_SHIPMENT_STATUSES: readonly ShipmentStatus[] = [
  'DELIVERED',
  'RETURNED',
  'CANCELLED',
];

export type ShipmentCheck = { ok: true; to: ShipmentStatus } | { ok: false };

export function checkShipmentTransition(
  action: ShipmentAction,
  current: ShipmentStatus,
): ShipmentCheck {
  const rule = SHIPMENT_TRANSITIONS[action];
  return rule.from.includes(current)
    ? { ok: true, to: rule.to }
    : { ok: false };
}
