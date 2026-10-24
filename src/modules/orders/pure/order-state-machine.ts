import type { OrderStatus } from '../../../generated/prisma/client.js';

/**
 * Order lifecycle as data. Status is never written directly: every change is a named action.
 *
 *  DRAFT ─submit→ PENDING_CONFIRMATION ─confirm→ CONFIRMED ─mark-ready→ READY_FOR_PRODUCTION
 *    ─(job starts)→ IN_PRODUCTION ⇄ PARTIALLY_COMPLETED ─(all quantity produced)→ PRODUCTION_COMPLETED
 *
 * hold/resume and cancel are available while the order is still alive. There are no delivery
 * statuses yet (Phase 5B).
 */
export const ORDER_ACTIONS = [
  'submit',
  'request-changes',
  'confirm',
  'mark-ready',
  'production-started',
  'production-partial',
  'production-completed',
  'production-reset',
  'commercial-reapproval',
  'fulfillment-sync',
  'complete',
  'force-complete',
  'hold',
  'resume',
  'cancel',
] as const;
export type OrderAction = (typeof ORDER_ACTIONS)[number];

interface Rule {
  from: readonly OrderStatus[];
  /** 'PREVIOUS' returns to the status held before ON_HOLD. */
  to: OrderStatus | 'PREVIOUS' | 'DERIVED';
  reasonRequired: boolean;
  /** true = caused by production events, not requested by a person */
  system: boolean;
}

const LIVE: readonly OrderStatus[] = [
  'DRAFT',
  'PENDING_CONFIRMATION',
  'CONFIRMED',
  'READY_FOR_PRODUCTION',
  'IN_PRODUCTION',
  'PARTIALLY_COMPLETED',
  'READY_FOR_PACKAGING',
  'PACKAGING',
  'READY_FOR_DELIVERY',
];

/** Statuses that production and fulfilment facts can move an order between (system-driven). */
export const DERIVED_TARGETS: readonly OrderStatus[] = [
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
];
const DERIVABLE_FROM: readonly OrderStatus[] = DERIVED_TARGETS.filter(
  (s) => s !== 'DELIVERED',
);

export const ORDER_TRANSITIONS: Record<OrderAction, Rule> = {
  submit: {
    from: ['DRAFT'],
    to: 'PENDING_CONFIRMATION',
    reasonRequired: false,
    system: false,
  },
  'request-changes': {
    from: ['PENDING_CONFIRMATION'],
    to: 'DRAFT',
    reasonRequired: true,
    system: false,
  },
  confirm: {
    from: ['DRAFT', 'PENDING_CONFIRMATION'],
    to: 'CONFIRMED',
    reasonRequired: false,
    system: false,
  },
  'mark-ready': {
    from: ['CONFIRMED'],
    to: 'READY_FOR_PRODUCTION',
    reasonRequired: false,
    system: false,
  },
  'production-started': {
    from: ['READY_FOR_PRODUCTION', 'PARTIALLY_COMPLETED'],
    to: 'IN_PRODUCTION',
    reasonRequired: false,
    system: true,
  },
  'production-partial': {
    from: ['READY_FOR_PRODUCTION', 'IN_PRODUCTION'],
    to: 'PARTIALLY_COMPLETED',
    reasonRequired: false,
    system: true,
  },
  'production-completed': {
    from: ['READY_FOR_PRODUCTION', 'IN_PRODUCTION', 'PARTIALLY_COMPLETED'],
    to: 'PRODUCTION_COMPLETED',
    reasonRequired: false,
    system: true,
  },
  'production-reset': {
    from: ['IN_PRODUCTION', 'PARTIALLY_COMPLETED'],
    to: 'READY_FOR_PRODUCTION',
    reasonRequired: false,
    system: true,
  },
  // A commercially relevant revision ended the accepted quotation of a released order.
  'commercial-reapproval': {
    from: ['READY_FOR_PRODUCTION'],
    to: 'CONFIRMED',
    reasonRequired: false,
    system: true,
  },
  // Production / packaging / delivery facts move the order between DERIVED_TARGETS.
  'fulfillment-sync': {
    from: DERIVABLE_FROM,
    to: 'DERIVED',
    reasonRequired: false,
    system: true,
  },
  // Closing an order: everything delivered. Force-completing skips the normal path (reason + audit).
  complete: {
    from: ['DELIVERED'],
    to: 'COMPLETED',
    reasonRequired: false,
    system: false,
  },
  'force-complete': {
    from: [
      'PRODUCTION_COMPLETED',
      'READY_FOR_PACKAGING',
      'PACKAGING',
      'READY_FOR_DELIVERY',
      'PARTIALLY_SHIPPED',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
    ],
    to: 'COMPLETED',
    reasonRequired: true,
    system: false,
  },
  hold: {
    from: [
      'PENDING_CONFIRMATION',
      'CONFIRMED',
      'READY_FOR_PRODUCTION',
      'IN_PRODUCTION',
      'PARTIALLY_COMPLETED',
      'READY_FOR_PACKAGING',
      'PACKAGING',
      'READY_FOR_DELIVERY',
      'PARTIALLY_SHIPPED',
    ],
    to: 'ON_HOLD',
    reasonRequired: true,
    system: false,
  },
  resume: {
    from: ['ON_HOLD'],
    to: 'PREVIOUS',
    reasonRequired: false,
    system: false,
  },
  cancel: {
    from: [...LIVE, 'ON_HOLD'],
    to: 'CANCELLED',
    reasonRequired: true,
    system: false,
  },
};

export type OrderTransitionCheck =
  | { ok: true; to: OrderStatus }
  | { ok: false; reason: 'NOT_ALLOWED' | 'NO_PREVIOUS_STATUS' };

export function checkOrderTransition(
  action: OrderAction,
  current: OrderStatus,
  holdPreviousStatus: OrderStatus | null,
  derivedTarget?: OrderStatus,
): OrderTransitionCheck {
  const rule = ORDER_TRANSITIONS[action];
  if (!rule.from.includes(current)) return { ok: false, reason: 'NOT_ALLOWED' };
  if (rule.to === 'DERIVED') {
    return derivedTarget && DERIVED_TARGETS.includes(derivedTarget)
      ? { ok: true, to: derivedTarget }
      : { ok: false, reason: 'NOT_ALLOWED' };
  }
  if (rule.to === 'PREVIOUS') {
    return holdPreviousStatus
      ? { ok: true, to: holdPreviousStatus }
      : { ok: false, reason: 'NO_PREVIOUS_STATUS' };
  }
  return { ok: true, to: rule.to };
}

/** Statuses whose production / fulfilment state is derived from jobs, packaging and shipments. */
export const PRODUCTION_PHASE_STATUSES: readonly OrderStatus[] = DERIVABLE_FROM;

/** Statuses in which the production definition (items / variants) is frozen against edits. */
export const PRODUCTION_STARTED_STATUSES: readonly OrderStatus[] = [
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
];
