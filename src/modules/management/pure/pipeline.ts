import type {
  OrderStatus,
  SampleStatus,
} from '../../../generated/prisma/client.js';

/**
 * Pipeline groups for the dashboard. Each group lists the real enum values it covers, so a new
 * status that is not placed in a group fails the unit test instead of silently disappearing.
 */
export const SAMPLE_PIPELINE: Record<string, readonly SampleStatus[]> = {
  draft: ['DRAFT'],
  review: ['SUBMITTED', 'UNDER_REVIEW'],
  commercial: ['QUOTED', 'AWAITING_PAYMENT'],
  production: ['READY_FOR_PRODUCTION', 'IN_PRODUCTION'],
  awaitingApproval: ['AWAITING_APPROVAL'],
  approved: ['APPROVED'],
  completed: ['COMPLETED'],
  onHold: ['ON_HOLD'],
  closed: ['REJECTED', 'CANCELLED'],
};

export const ORDER_PIPELINE: Record<string, readonly OrderStatus[]> = {
  draft: ['DRAFT', 'PENDING_CONFIRMATION'],
  confirmed: ['CONFIRMED'],
  ready: ['READY_FOR_PRODUCTION'],
  production: ['IN_PRODUCTION', 'PARTIALLY_COMPLETED', 'PRODUCTION_COMPLETED'],
  packaging: ['READY_FOR_PACKAGING', 'PACKAGING'],
  delivery: ['READY_FOR_DELIVERY', 'PARTIALLY_SHIPPED', 'OUT_FOR_DELIVERY'],
  delivered: ['DELIVERED'],
  completed: ['COMPLETED'],
  onHold: ['ON_HOLD'],
  cancelled: ['CANCELLED'],
};

export function groupCounts<S extends string>(
  groups: Record<string, readonly S[]>,
  byStatus: Map<S, number>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(groups).map(([name, statuses]) => [
      name,
      statuses.reduce((n, s) => n + (byStatus.get(s) ?? 0), 0),
    ]),
  );
}
