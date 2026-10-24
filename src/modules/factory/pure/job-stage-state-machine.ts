import type { JobStageStatus } from '../../../generated/prisma/client.js';

/**
 * Stage lifecycle as data. Status is never written directly: every change is a
 * named action checked against this table (and again by a database trigger).
 *
 *   WAITING ─ready→ READY ─start→ IN_PROGRESS ─complete→ COMPLETED
 *                     │ └──────────block──────────┘ ↓          (QC) fail → FAILED
 *                     └────────────→ BLOCKED ─unblock→ (READY | IN_PROGRESS)
 *   skip: WAITING | READY → SKIPPED      cancel: any open status → CANCELLED
 */
export const JOB_STAGE_ACTIONS = [
  'make-ready',
  'start',
  'complete',
  'force-complete',
  'fail',
  'block',
  'unblock',
  'skip',
  'cancel',
] as const;

export type JobStageAction = (typeof JOB_STAGE_ACTIONS)[number];

interface Rule {
  from: readonly JobStageStatus[];
  /** 'PREVIOUS' returns to the status the stage had when it was blocked. */
  to: JobStageStatus | 'PREVIOUS';
}

const OPEN: readonly JobStageStatus[] = [
  'WAITING',
  'READY',
  'IN_PROGRESS',
  'BLOCKED',
];

export const JOB_STAGE_TRANSITIONS: Record<JobStageAction, Rule> = {
  'make-ready': { from: ['WAITING'], to: 'READY' },
  start: { from: ['READY'], to: 'IN_PROGRESS' },
  complete: { from: ['IN_PROGRESS'], to: 'COMPLETED' },
  // admin override only (reason + audit): may bypass notes/attachments/QC
  'force-complete': { from: ['READY', 'IN_PROGRESS'], to: 'COMPLETED' },
  fail: { from: ['IN_PROGRESS'], to: 'FAILED' },
  block: { from: ['READY', 'IN_PROGRESS'], to: 'BLOCKED' },
  unblock: { from: ['BLOCKED'], to: 'PREVIOUS' },
  skip: { from: ['WAITING', 'READY'], to: 'SKIPPED' },
  cancel: { from: OPEN, to: 'CANCELLED' },
};

export const TERMINAL_STAGE_STATUSES: readonly JobStageStatus[] = [
  'COMPLETED',
  'SKIPPED',
  'FAILED',
  'CANCELLED',
];
/** Statuses that mean "this stage's work is done and later stages may proceed". */
export const SATISFIED_STAGE_STATUSES: readonly JobStageStatus[] = [
  'COMPLETED',
  'SKIPPED',
];
/** Statuses where a due date can still be missed. */
export const OPEN_STAGE_STATUSES = OPEN;

export type StageTransitionCheck =
  | { ok: true; to: JobStageStatus }
  | { ok: false; reason: 'NOT_ALLOWED' | 'NO_PREVIOUS_STATUS' };

export function checkStageTransition(
  action: JobStageAction,
  current: JobStageStatus,
  blockedFromStatus: JobStageStatus | null,
): StageTransitionCheck {
  const rule = JOB_STAGE_TRANSITIONS[action];
  if (!rule.from.includes(current)) return { ok: false, reason: 'NOT_ALLOWED' };
  if (rule.to === 'PREVIOUS') {
    return blockedFromStatus
      ? { ok: true, to: blockedFromStatus }
      : { ok: false, reason: 'NO_PREVIOUS_STATUS' };
  }
  return { ok: true, to: rule.to };
}

/** A stage is delayed when it is not finished and its due date has passed. Derived, never stored. */
export function isStageDelayed(
  stage: {
    status: JobStageStatus;
    dueAt: Date | null;
    supersededAt?: Date | null;
  },
  now: Date = new Date(),
): boolean {
  return (
    !stage.supersededAt &&
    !!stage.dueAt &&
    stage.dueAt < now &&
    OPEN.includes(stage.status)
  );
}
