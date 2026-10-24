/**
 * Needs Attention ranking: explicit, additive, documented rules. No learning, no hidden weights.
 *
 *   score = BASE[type] + PRIORITY[priority] + min(daysOverdue, 30) × 10 + min(ageDays, 14) × 5 + closeness
 *   closeness (APPROACHING_DEADLINE only) = hours left in the window, inverted: 0 … 48
 *   severity: CRITICAL ≥ 800, WARNING ≥ 450, otherwise INFO
 *
 * Ties break on the earlier due date, then on the entity id, so the order is stable.
 */

export const ATTENTION_TYPES = [
  'BLOCKED_STAGE',
  'DELAYED_STAGE',
  'OVERDUE_JOB',
  'OVERDUE_ORDER',
  'FAILED_QC',
  'OPEN_REWORK',
  'PAYMENT_BLOCK',
  'COMMERCIAL_REAPPROVAL_REQUIRED',
  'UNASSIGNED_READY_STAGE',
  'APPROACHING_DEADLINE',
  'SHIPMENT_FAILED',
  'DELIVERY_DELAY',
  'PACKAGING_DELAY',
] as const;
export type AttentionType = (typeof ATTENTION_TYPES)[number];
export type AttentionSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export const BASE_SCORE: Record<AttentionType, number> = {
  SHIPMENT_FAILED: 750,
  BLOCKED_STAGE: 700,
  OVERDUE_ORDER: 650,
  FAILED_QC: 650,
  OVERDUE_JOB: 600,
  PAYMENT_BLOCK: 550,
  DELIVERY_DELAY: 550,
  DELAYED_STAGE: 500,
  COMMERCIAL_REAPPROVAL_REQUIRED: 500,
  PACKAGING_DELAY: 480,
  OPEN_REWORK: 450,
  UNASSIGNED_READY_STAGE: 300,
  APPROACHING_DEADLINE: 200,
};

export const PRIORITY_BONUS: Record<string, number> = {
  URGENT: 200,
  HIGH: 100,
  NORMAL: 0,
  LOW: -50,
};

/** Types that need an extra permission on top of dashboard.read. */
export const ATTENTION_EXTRA_PERMISSION: Partial<
  Record<AttentionType, string>
> = {
  PAYMENT_BLOCK: 'commercial_kpis.read',
  COMMERCIAL_REAPPROVAL_REQUIRED: 'commercial_kpis.read',
  FAILED_QC: 'quality_kpis.read',
  OPEN_REWORK: 'quality_kpis.read',
};

export function attentionScore(input: {
  type: AttentionType;
  priority?: string | null;
  /** Minutes past the due date (0 when not overdue). */
  overdueMinutes?: number;
  ageMinutes?: number;
  /** Minutes left until the deadline (APPROACHING_DEADLINE). */
  minutesLeft?: number;
  windowMinutes?: number;
}): number {
  const overdueDays = Math.min(
    Math.floor((input.overdueMinutes ?? 0) / 1440),
    30,
  );
  const ageDays = Math.min(Math.floor((input.ageMinutes ?? 0) / 1440), 14);
  let closeness = 0;
  if (
    input.type === 'APPROACHING_DEADLINE' &&
    input.minutesLeft != null &&
    input.windowMinutes
  ) {
    const w = input.windowMinutes / 60;
    const left = Math.max(0, input.minutesLeft / 60);
    closeness = Math.round(Math.max(0, Math.min(48, ((w - left) / w) * 48)));
  }
  return (
    BASE_SCORE[input.type] +
    (PRIORITY_BONUS[input.priority ?? 'NORMAL'] ?? 0) +
    overdueDays * 10 +
    ageDays * 5 +
    closeness
  );
}

export function severityFor(score: number): AttentionSeverity {
  return score >= 800 ? 'CRITICAL' : score >= 450 ? 'WARNING' : 'INFO';
}

export interface Rankable {
  score: number;
  dueAt: Date | null;
  entityId: string;
}

export function compareAttention(a: Rankable, b: Rankable): number {
  if (b.score !== a.score) return b.score - a.score;
  const ad = a.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bd = b.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (ad !== bd) return ad - bd;
  return a.entityId.localeCompare(b.entityId);
}
