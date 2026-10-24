import type {
  FactoryJobSourceType,
  FactoryJobStatus,
  OrderBatchStatus,
} from '../../../generated/prisma/client.js';

export interface JobFacts {
  sourceType: FactoryJobSourceType;
  status: FactoryJobStatus;
  startedAt: Date | null;
  completedQuantity: number;
}
export interface BatchFacts {
  status: OrderBatchStatus;
  quantity: number;
}

export type DerivedOrderProduction =
  | 'READY_FOR_PRODUCTION'
  | 'IN_PRODUCTION'
  | 'PARTIALLY_COMPLETED'
  | 'PRODUCTION_COMPLETED';

/**
 * The production state of an order, derived from its (non-cancelled) jobs and batches.
 * PRODUCTION_COMPLETED needs every ordered unit to be covered by a COMPLETED job: either one
 * whole-order job, or batches that together hold the full quantity and are all finished.
 */
export function deriveOrderProduction(input: {
  totalQuantity: number;
  jobs: JobFacts[];
  batches: BatchFacts[];
  /** completed job per batch (batches that have a COMPLETED job) */
  completedBatchCount: number;
}): DerivedOrderProduction {
  const jobs = input.jobs.filter((j) => j.status !== 'CANCELLED');
  if (jobs.length === 0) return 'READY_FOR_PRODUCTION';
  const bulkDone = jobs.some(
    (j) => j.sourceType === 'BULK_ORDER' && j.status === 'COMPLETED',
  );
  const liveBatches = input.batches.filter((b) => b.status !== 'CANCELLED');
  const allocated = liveBatches.reduce((sum, b) => sum + b.quantity, 0);
  const batchesDone =
    liveBatches.length > 0 &&
    allocated >= input.totalQuantity &&
    input.completedBatchCount === liveBatches.length;
  if (bulkDone || batchesDone) return 'PRODUCTION_COMPLETED';
  if (jobs.some((j) => j.status === 'COMPLETED' || j.completedQuantity > 0))
    return 'PARTIALLY_COMPLETED';
  if (jobs.some((j) => j.startedAt)) return 'IN_PRODUCTION';
  return 'READY_FOR_PRODUCTION';
}

export interface BatchProduction {
  jobStatus: FactoryJobStatus | null;
  started: boolean;
  completedQuantity: number;
}

/** Batch status from its job (a batch without a job is just READY). */
export function deriveBatchProduction(
  job: BatchProduction,
): 'READY' | 'IN_PRODUCTION' | 'PARTIALLY_COMPLETED' | 'COMPLETED' {
  if (job.jobStatus === 'COMPLETED') return 'COMPLETED';
  if (job.completedQuantity > 0) return 'PARTIALLY_COMPLETED';
  if (job.started) return 'IN_PRODUCTION';
  return 'READY';
}

// ───────────────────────── stage quantities ─────────────────────────

export interface QuantityContext {
  plannedQuantity: number;
  /** set on occurrences created by rework: only those units are handled */
  reworkAffectedQuantity: number | null;
  /** units scrapped by earlier stages (any attempt) of the same job */
  rejectedBefore: number;
}

/** Units a stage occurrence must account for (produced + rejected). */
export function requiredQuantity(c: QuantityContext): number {
  if (c.reworkAffectedQuantity != null) return c.reworkAffectedQuantity;
  return Math.max(0, c.plannedQuantity - c.rejectedBefore);
}

export type ReportCheck =
  | { ok: true; remainingAfter: number }
  | { ok: false; reason: 'EMPTY' | 'OVER_REPORT'; remaining: number };

/** A report may never push produced + rejected beyond what the stage must handle. */
export function checkReport(input: {
  required: number;
  accounted: number;
  produced: number;
  rejected: number;
  rework: number;
}): ReportCheck {
  const remaining = Math.max(0, input.required - input.accounted);
  if (input.produced + input.rejected + input.rework <= 0)
    return { ok: false, reason: 'EMPTY', remaining };
  if (input.produced + input.rejected > remaining)
    return { ok: false, reason: 'OVER_REPORT', remaining };
  return {
    ok: true,
    remainingAfter: remaining - input.produced - input.rejected,
  };
}

/** Share of the units that can still be delivered that have passed the final stage. Not an average of stages. */
export function progressPercent(input: {
  totalQuantity: number;
  completedQuantity: number;
  rejectedQuantity: number;
}): number {
  const deliverable = input.totalQuantity - input.rejectedQuantity;
  if (deliverable <= 0) return input.totalQuantity > 0 ? 100 : 0;
  return Math.min(
    100,
    Math.round((input.completedQuantity / deliverable) * 1000) / 10,
  );
}
