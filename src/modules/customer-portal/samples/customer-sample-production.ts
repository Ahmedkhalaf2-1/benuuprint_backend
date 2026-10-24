/**
 * What a customer sees of physical sample production: six coarse steps derived from the real
 * factory job. No stage names, staff, QC checklists, blockers, rework, notes or quantities leave this
 * file: only a step list with PENDING / ACTIVE / DONE.
 */
export const PRODUCTION_STEPS = [
  'PREPARING_MATERIALS',
  'PATTERN_AND_CUTTING',
  'DECORATION',
  'SEWING',
  'QUALITY_CHECK',
  'SAMPLE_READY',
] as const;
export type ProductionStep = (typeof PRODUCTION_STEPS)[number];
export type StepState = 'PENDING' | 'ACTIVE' | 'DONE';

export const STEP_LABEL: Record<ProductionStep, string> = {
  PREPARING_MATERIALS: 'Preparing materials',
  PATTERN_AND_CUTTING: 'Pattern & cutting',
  DECORATION: 'Decoration',
  SEWING: 'Sewing',
  QUALITY_CHECK: 'Quality check',
  SAMPLE_READY: 'Sample ready',
};

export function stepForStage(stageCode: string): ProductionStep | null {
  if (stageCode.startsWith('QC_')) return 'QUALITY_CHECK';
  switch (stageCode) {
    case 'FABRIC_PREPARATION':
      return 'PREPARING_MATERIALS';
    case 'PATTERN_MAKING':
    case 'CUTTING':
      return 'PATTERN_AND_CUTTING';
    case 'PRINTING_EMBROIDERY':
      return 'DECORATION';
    case 'SEWING':
      return 'SEWING';
    case 'PACKAGING':
    case 'READY':
      return 'SAMPLE_READY';
    default:
      return null;
  }
}

export interface StageFact {
  stageCode: string;
  status: string;
  superseded: boolean;
}

export interface ProductionProjection {
  phase: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETE';
  steps: { code: ProductionStep; label: string; state: StepState }[];
}

const DONE = new Set(['COMPLETED', 'SKIPPED']);
const WORKING = new Set(['IN_PROGRESS', 'BLOCKED', 'FAILED']);

/** `jobStatus` null = no sample production job exists yet. */
export function projectProduction(
  jobStatus: string | null,
  stages: StageFact[],
): ProductionProjection {
  const live = stages.filter((s) => !s.superseded && s.status !== 'CANCELLED');
  const byStep = new Map<ProductionStep, StageFact[]>();
  for (const s of live) {
    const step = stepForStage(s.stageCode);
    if (!step) continue;
    byStep.set(step, [...(byStep.get(step) ?? []), s]);
  }
  const complete = jobStatus === 'COMPLETED';
  const steps = PRODUCTION_STEPS.map((code) => {
    const group = byStep.get(code) ?? [];
    let state: StepState = 'PENDING';
    if (
      complete ||
      (group.length > 0 && group.every((s) => DONE.has(s.status)))
    )
      state = 'DONE';
    else if (group.some((s) => WORKING.has(s.status) || DONE.has(s.status)))
      state = 'ACTIVE';
    return { code, label: STEP_LABEL[code], state };
  });
  const started = steps.some((s) => s.state !== 'PENDING');
  return {
    phase: complete
      ? 'COMPLETE'
      : jobStatus && started
        ? 'IN_PROGRESS'
        : 'NOT_STARTED',
    steps,
  };
}
