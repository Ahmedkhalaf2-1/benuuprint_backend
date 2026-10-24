/**
 * Delay engines. Deterministic, derived at read time, return reasons (never just a boolean).
 *
 * JOB is delayed when it is open (not completed / cancelled / on hold) and at least one holds:
 *   STAGE_OVERDUE        a current stage is open past its due date (and not on hold)
 *   OPEN_BLOCKER         an unresolved blocker exists (its age is the delay)
 *   TARGET_DATE_EXCEEDED targetCompletionDate has passed
 *
 * ORDER is delayed when it is in the live production/delivery phase and at least one holds:
 *   DELIVERY_DATE_EXCEEDED   targetDeliveryDate has passed and the order is not delivered
 *   JOB_DELAYED              a live job of the order is delayed
 *   PACKAGING_DELAYED        …and the delayed stage is a packaging stage
 *   BATCH_TARGET_EXCEEDED    a batch is unfinished past its own target date
 *   SHIPMENT_FAILED          a shipment failed delivery and is not resolved
 *   SHIPMENT_OVERDUE         an unfinished shipment is past its scheduled date / SLA
 */

export type JobDelayCode =
  'STAGE_OVERDUE' | 'OPEN_BLOCKER' | 'TARGET_DATE_EXCEEDED';
export type OrderDelayCode =
  | 'DELIVERY_DATE_EXCEEDED'
  | 'JOB_DELAYED'
  | 'PACKAGING_DELAYED'
  | 'BATCH_TARGET_EXCEEDED'
  | 'SHIPMENT_FAILED'
  | 'SHIPMENT_OVERDUE';

export interface DelayReason<C extends string> {
  code: C;
  message: string;
  /** How late, in minutes, where that is meaningful. */
  minutes: number | null;
  /** Identifiers the reason refers to (stage ids, blocker ids, shipment ids, job ids). */
  refs: string[];
}

export interface DelayResult<C extends string> {
  isDelayed: boolean;
  delayMinutes: number;
  reasons: DelayReason<C>[];
}

const mins = (from: Date, to: Date) =>
  Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));

const JOB_NOT_DELAYABLE = new Set(['COMPLETED', 'CANCELLED', 'ON_HOLD']);
const STAGE_OPEN = new Set(['WAITING', 'READY', 'IN_PROGRESS', 'BLOCKED']);

export interface JobDelayInput {
  status: string;
  targetCompletionDate: Date | null;
  stages: {
    id: string;
    stageCode: string;
    stageName: string;
    departmentType: string;
    status: string;
    dueAt: Date | null;
    supersededAt: Date | null;
    isOnHold: boolean;
  }[];
  openBlockers: { id: string; type: string; createdAt: Date }[];
}

export function evaluateJobDelay(
  job: JobDelayInput,
  now: Date,
): DelayResult<JobDelayCode> {
  const reasons: DelayReason<JobDelayCode>[] = [];
  if (JOB_NOT_DELAYABLE.has(job.status))
    return { isDelayed: false, delayMinutes: 0, reasons };
  const overdue = job.stages.filter(
    (s) =>
      !s.supersededAt &&
      !s.isOnHold &&
      STAGE_OPEN.has(s.status) &&
      s.dueAt &&
      s.dueAt < now,
  );
  for (const s of overdue)
    reasons.push({
      code: 'STAGE_OVERDUE',
      message: `${s.stageName} is ${s.status} past its due date`,
      minutes: mins(s.dueAt!, now),
      refs: [s.id],
    });
  for (const b of job.openBlockers)
    reasons.push({
      code: 'OPEN_BLOCKER',
      message: `Unresolved blocker (${b.type})`,
      minutes: mins(b.createdAt, now),
      refs: [b.id],
    });
  if (job.targetCompletionDate && job.targetCompletionDate < now)
    reasons.push({
      code: 'TARGET_DATE_EXCEEDED',
      message: 'Target completion date has passed',
      minutes: mins(job.targetCompletionDate, now),
      refs: [],
    });
  const delayMinutes = reasons.reduce((m, r) => Math.max(m, r.minutes ?? 0), 0);
  return { isDelayed: reasons.length > 0, delayMinutes, reasons };
}

export const ORDER_DELAYABLE_STATUSES = [
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
] as const;
const ORDER_DELAYABLE = new Set<string>(ORDER_DELAYABLE_STATUSES);
export const BATCH_OPEN_STATUSES = [
  'PLANNED',
  'READY',
  'IN_PRODUCTION',
  'PARTIALLY_COMPLETED',
] as const;
const BATCH_OPEN = new Set<string>(BATCH_OPEN_STATUSES);

export interface OrderDelayInput {
  status: string;
  targetDeliveryDate: Date | null;
  jobs: {
    id: string;
    jobNumber: string;
    delay: DelayResult<JobDelayCode>;
    /** ids of delayed packaging-department stages */
    delayedPackagingStageIds: string[];
  }[];
  batches: {
    id: string;
    batchNumber: string;
    status: string;
    targetCompletionDate: Date | null;
  }[];
  shipments: {
    id: string;
    shipmentNumber: string;
    status: string;
    /** Deadline already resolved by the SLA engine (scheduled date or rule). */
    deadline: Date | null;
  }[];
}

export function evaluateOrderDelay(
  order: OrderDelayInput,
  now: Date,
): DelayResult<OrderDelayCode> {
  const reasons: DelayReason<OrderDelayCode>[] = [];
  if (!ORDER_DELAYABLE.has(order.status))
    return { isDelayed: false, delayMinutes: 0, reasons };
  if (order.targetDeliveryDate && order.targetDeliveryDate < now)
    reasons.push({
      code: 'DELIVERY_DATE_EXCEEDED',
      message: 'Target delivery date has passed',
      minutes: mins(order.targetDeliveryDate, now),
      refs: [],
    });
  for (const j of order.jobs) {
    if (!j.delay.isDelayed) continue;
    reasons.push({
      code: 'JOB_DELAYED',
      message: `${j.jobNumber} is delayed (${[...new Set(j.delay.reasons.map((r) => r.code))].join(', ')})`,
      minutes: j.delay.delayMinutes,
      refs: [j.id],
    });
    if (j.delayedPackagingStageIds.length)
      reasons.push({
        code: 'PACKAGING_DELAYED',
        message: `Packaging of ${j.jobNumber} is overdue`,
        minutes: null,
        refs: j.delayedPackagingStageIds,
      });
  }
  for (const b of order.batches)
    if (
      BATCH_OPEN.has(b.status) &&
      b.targetCompletionDate &&
      b.targetCompletionDate < now
    )
      reasons.push({
        code: 'BATCH_TARGET_EXCEEDED',
        message: `${b.batchNumber} is past its target completion date`,
        minutes: mins(b.targetCompletionDate, now),
        refs: [b.id],
      });
  for (const s of order.shipments) {
    if (s.status === 'FAILED')
      reasons.push({
        code: 'SHIPMENT_FAILED',
        message: `${s.shipmentNumber} failed delivery`,
        minutes: null,
        refs: [s.id],
      });
    else if (
      ['READY', 'DISPATCHED', 'IN_TRANSIT'].includes(s.status) &&
      s.deadline &&
      s.deadline < now
    )
      reasons.push({
        code: 'SHIPMENT_OVERDUE',
        message: `${s.shipmentNumber} is past its delivery commitment`,
        minutes: mins(s.deadline, now),
        refs: [s.id],
      });
  }
  const delayMinutes = reasons.reduce((m, r) => Math.max(m, r.minutes ?? 0), 0);
  return { isDelayed: reasons.length > 0, delayMinutes, reasons };
}
