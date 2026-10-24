import type { Prisma } from '../../generated/prisma/client.js';
import { BATCH_OPEN_STATUSES, ORDER_DELAYABLE_STATUSES } from './pure/delay.js';

/**
 * Prisma `where` fragments that mirror the pure delay rules (pure/delay.ts) so counts, lists and
 * KPIs always agree with the per-entity delay evaluation. Change one, change the other.
 */

export const JOB_TERMINAL = ['COMPLETED', 'CANCELLED'] as const;
export const JOB_NOT_ACTIVE = ['COMPLETED', 'CANCELLED', 'ON_HOLD'] as const;
export const STAGE_OPEN = [
  'WAITING',
  'READY',
  'IN_PROGRESS',
  'BLOCKED',
] as const;
export const ORDER_NOT_LIVE = [
  'CANCELLED',
  'DRAFT',
  'PENDING_CONFIRMATION',
] as const;

export const delayedJobWhere = (now: Date): Prisma.FactoryJobWhereInput => ({
  status: { notIn: [...JOB_NOT_ACTIVE] },
  OR: [
    { targetCompletionDate: { lt: now } },
    {
      stages: {
        some: {
          supersededAt: null,
          isOnHold: false,
          status: { in: [...STAGE_OPEN] },
          dueAt: { lt: now },
        },
      },
    },
    { blockers: { some: { status: 'OPEN' } } },
  ],
});

export const delayedOrderWhere = (now: Date): Prisma.OrderWhereInput => ({
  status: { in: [...ORDER_DELAYABLE_STATUSES] },
  OR: [
    { targetDeliveryDate: { lt: now } },
    { jobs: { some: delayedJobWhere(now) } },
    {
      batches: {
        some: {
          status: { in: [...BATCH_OPEN_STATUSES] },
          targetCompletionDate: { lt: now },
        },
      },
    },
    { shipments: { some: { status: 'FAILED' } } },
    {
      shipments: {
        some: {
          status: { in: ['READY', 'DISPATCHED', 'IN_TRANSIT'] },
          scheduledAt: { lt: now },
        },
      },
    },
  ],
});

/** Live orders whose accepted quotation was ended by a revision and not replaced. */
export const reapprovalOrderWhere: Prisma.OrderWhereInput = {
  status: { notIn: [...ORDER_NOT_LIVE] },
  quotations: {
    some: {
      versions: {
        some: { acceptedAt: { not: null }, invalidatedAt: { not: null } },
      },
    },
  },
  NOT: { quotations: { some: { versions: { some: { status: 'ACCEPTED' } } } } },
};
