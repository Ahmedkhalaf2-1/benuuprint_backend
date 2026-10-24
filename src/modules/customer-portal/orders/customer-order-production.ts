import { stepForStage } from '../samples/customer-sample-production.js';

/**
 * Coarse production steps of an order, aggregated over ALL of its non-cancelled jobs (one bulk job, or
 * several batch jobs): the customer never has to understand batches. No stage names, assignees, QC detail,
 * blockers, rework or per-stage quantities leave this file.
 */
export const ORDER_PRODUCTION_STEPS = [
  'PREPARING_MATERIALS',
  'PATTERN_AND_CUTTING',
  'DECORATION',
  'SEWING',
  'QUALITY_CHECK',
  'PACKAGING',
  'READY_FOR_SHIPMENT',
] as const;
export type OrderProductionStep = (typeof ORDER_PRODUCTION_STEPS)[number];

export const ORDER_STEP_LABEL: Record<OrderProductionStep, string> = {
  PREPARING_MATERIALS: 'Preparing materials',
  PATTERN_AND_CUTTING: 'Pattern & cutting',
  DECORATION: 'Decoration',
  SEWING: 'Sewing',
  QUALITY_CHECK: 'Quality check',
  PACKAGING: 'Packaging',
  READY_FOR_SHIPMENT: 'Ready for shipment',
};

function orderStep(stageCode: string): OrderProductionStep | null {
  if (stageCode === 'PACKAGING') return 'PACKAGING';
  if (stageCode === 'READY') return 'READY_FOR_SHIPMENT';
  const s = stepForStage(stageCode);
  return s && s !== 'SAMPLE_READY' ? s : null;
}

export interface JobFacts {
  status: string;
  stages: { stageCode: string; status: string; superseded: boolean }[];
}

const DONE = new Set(['COMPLETED', 'SKIPPED']);
const WORKING = new Set(['IN_PROGRESS', 'BLOCKED', 'FAILED']);

export function projectOrderProduction(jobs: JobFacts[]) {
  const live = jobs.filter((j) => j.status !== 'CANCELLED');
  const groups = new Map<OrderProductionStep, { status: string }[]>();
  for (const job of live)
    for (const s of job.stages) {
      if (s.superseded || s.status === 'CANCELLED') continue;
      const step = orderStep(s.stageCode);
      if (!step) continue;
      groups.set(step, [...(groups.get(step) ?? []), s]);
    }
  const allComplete =
    live.length > 0 && live.every((j) => j.status === 'COMPLETED');
  const steps = ORDER_PRODUCTION_STEPS.map((code) => {
    const g = groups.get(code) ?? [];
    let state: 'PENDING' | 'ACTIVE' | 'DONE' = 'PENDING';
    if (allComplete || (g.length > 0 && g.every((s) => DONE.has(s.status))))
      state = 'DONE';
    else if (g.some((s) => WORKING.has(s.status) || DONE.has(s.status)))
      state = 'ACTIVE';
    return { code, label: ORDER_STEP_LABEL[code], state };
  });
  const started = steps.some((s) => s.state !== 'PENDING');
  return {
    phase: allComplete
      ? ('COMPLETE' as const)
      : live.length > 0 && started
        ? ('IN_PROGRESS' as const)
        : ('NOT_STARTED' as const),
    steps,
  };
}

/** Customer wording for the production ETA: never a promise, never the internal data-quality scale. */
export function etaView(
  estimate: Date | null,
  quality: 'LOW' | 'MEDIUM' | 'HIGH',
): {
  estimatedCompletion: Date;
  confidence: 'ESTIMATED' | 'APPROXIMATE';
  note: string;
} | null {
  if (!estimate) return null;
  const reliable = quality === 'HIGH';
  return {
    estimatedCompletion: estimate,
    confidence: reliable ? 'ESTIMATED' : 'APPROXIMATE',
    note: reliable
      ? 'Estimated production completion.'
      : 'An approximate date; it may move as production progresses.',
  };
}

/** Customer states of a shipment; internal failure notes and staff are never part of them. */
export const SHIPMENT_STATE: Record<string, string> = {
  READY: 'PREPARING',
  DISPATCHED: 'ON_THE_WAY',
  IN_TRANSIT: 'ON_THE_WAY',
  DELIVERED: 'DELIVERED',
  FAILED: 'DELIVERY_ATTEMPT_FAILED',
  RETURNED: 'RETURNED',
};
