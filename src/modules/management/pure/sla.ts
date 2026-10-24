/**
 * SLA evaluation. Pure and derived: nothing here is ever stored per job / stage / order.
 *
 * Every target type has a clock: it starts at `startAt`, ends at `completedAt` and must end before
 * `deadline`. A rule only decides the deadline; operational dates win where they exist:
 *   STAGE     deadline = readyAt + rule threshold          (else stage.dueAt, else readyAt + expectedDuration)
 *   JOB       deadline = targetCompletionDate              (else createdAt + rule threshold)
 *   ORDER     deadline = targetDeliveryDate                (else confirmedAt + rule threshold)
 *   SHIPMENT  deadline = scheduledAt                       (else readyAt + rule threshold)
 * The clock is pluggable (`BusinessClock`): by default calendar time, or the factory working calendar so that
 * thresholds, remaining time and breaches are counted in WORKING minutes. Stored timestamps are always UTC.
 */

import { CALENDAR_TIME, type BusinessClock } from './working-time.js';

export type SlaState =
  | 'NO_SLA'
  | 'ON_TRACK'
  | 'WARNING'
  | 'BREACHED'
  | 'COMPLETED_ON_TIME'
  | 'COMPLETED_LATE';

export interface SlaRuleLike {
  thresholdMinutes: number;
  warningBeforeMinutes: number | null;
  priorityMultipliers: Record<string, number> | null;
}

export type DeadlineSource =
  | 'RULE'
  | 'DUE_AT'
  | 'EXPECTED_DURATION'
  | 'TARGET_DATE'
  | 'SCHEDULED'
  | 'NONE';

/** Share of the threshold used for the warning when a rule does not set `warningBeforeMinutes`. */
export const DEFAULT_WARNING_SHARE = 0.2;

export function effectiveThreshold(
  rule: SlaRuleLike,
  priority: string | null,
): number {
  const m = priority ? rule.priorityMultipliers?.[priority] : undefined;
  return Math.max(1, Math.round(rule.thresholdMinutes * (m ?? 1)));
}

export function warningMinutes(rule: SlaRuleLike, threshold: number): number {
  return (
    rule.warningBeforeMinutes ?? Math.round(threshold * DEFAULT_WARNING_SHARE)
  );
}

export interface ResolvedDeadline {
  deadline: Date | null;
  source: DeadlineSource;
  /** Threshold in minutes when a rule produced the deadline, else the expected duration if known. */
  expectedMinutes: number | null;
  warningBeforeMinutes: number | null;
}

export function resolveStageDeadline(
  stage: {
    readyAt: Date | null;
    dueAt: Date | null;
    expectedDurationMinutes: number | null;
  },
  rule: SlaRuleLike | null,
  priority: string | null,
  clock: BusinessClock = CALENDAR_TIME,
): ResolvedDeadline {
  if (rule && stage.readyAt) {
    const t = effectiveThreshold(rule, priority);
    return {
      deadline: clock.add(stage.readyAt, t),
      source: 'RULE',
      expectedMinutes: t,
      warningBeforeMinutes: warningMinutes(rule, t),
    };
  }
  const expected = stage.expectedDurationMinutes;
  const warn = (minutes: number | null) =>
    minutes ? Math.round(minutes * DEFAULT_WARNING_SHARE) : null;
  if (stage.dueAt)
    return {
      deadline: stage.dueAt,
      source: 'DUE_AT',
      expectedMinutes: expected,
      warningBeforeMinutes: warn(expected),
    };
  if (stage.readyAt && expected)
    return {
      deadline: clock.add(stage.readyAt, expected),
      source: 'EXPECTED_DURATION',
      expectedMinutes: expected,
      warningBeforeMinutes: warn(expected),
    };
  return {
    deadline: null,
    source: 'NONE',
    expectedMinutes: expected,
    warningBeforeMinutes: null,
  };
}

/** Job / order / shipment: an explicit date wins, a rule is the fallback. */
export function resolveDateOrRuleDeadline(
  explicit: Date | null,
  explicitSource: 'TARGET_DATE' | 'SCHEDULED',
  startAt: Date | null,
  rule: SlaRuleLike | null,
  priority: string | null,
  now: Date,
  clock: BusinessClock = CALENDAR_TIME,
): ResolvedDeadline {
  if (explicit) {
    // Warn in the last 20% of the time between the start and the deadline when the start is known.
    const span = startAt ? clock.between(startAt, explicit) * 60_000 : null;
    return {
      deadline: explicit,
      source: explicitSource,
      expectedMinutes: span && span > 0 ? Math.round(span / 60_000) : null,
      warningBeforeMinutes:
        span && span > 0
          ? Math.round((span / 60_000) * DEFAULT_WARNING_SHARE)
          : null,
    };
  }
  if (rule && startAt) {
    const t = effectiveThreshold(rule, priority);
    return {
      deadline: clock.add(startAt, t),
      source: 'RULE',
      expectedMinutes: t,
      warningBeforeMinutes: warningMinutes(rule, t),
    };
  }
  void now;
  return {
    deadline: null,
    source: 'NONE',
    expectedMinutes: null,
    warningBeforeMinutes: null,
  };
}

export interface SlaEvaluation {
  state: SlaState;
  deadline: Date | null;
  /** Minutes from the clock start to completion, or to `now` while open. */
  elapsedMinutes: number | null;
  /** Minutes left before the deadline; negative never: breaches report `breachMinutes`. Null when done or no deadline. */
  remainingMinutes: number | null;
  breached: boolean;
  breachMinutes: number;
  warning: boolean;
}

export function evaluateSla(input: {
  startAt: Date | null;
  deadline: Date | null;
  completedAt: Date | null;
  warningBeforeMinutes: number | null;
  now: Date;
  clock?: BusinessClock;
}): SlaEvaluation {
  const { startAt, deadline, completedAt, now } = input;
  const clock = input.clock ?? CALENDAR_TIME;
  const end = completedAt ?? now;
  const elapsed = startAt ? clock.between(startAt, end) : null;
  if (!deadline)
    return {
      state: 'NO_SLA',
      deadline: null,
      elapsedMinutes: elapsed,
      remainingMinutes: null,
      breached: false,
      breachMinutes: 0,
      warning: false,
    };
  if (completedAt) {
    const late = completedAt.getTime() > deadline.getTime();
    return {
      state: late ? 'COMPLETED_LATE' : 'COMPLETED_ON_TIME',
      deadline,
      elapsedMinutes: elapsed,
      remainingMinutes: null,
      breached: late,
      breachMinutes: late ? clock.between(deadline, completedAt) : 0,
      warning: false,
    };
  }
  const remainingMs = deadline.getTime() - now.getTime();
  if (remainingMs < 0)
    return {
      state: 'BREACHED',
      deadline,
      elapsedMinutes: elapsed,
      remainingMinutes: null,
      breached: true,
      breachMinutes: clock.between(deadline, now),
      warning: false,
    };
  const remaining = clock.between(now, deadline);
  const warning =
    input.warningBeforeMinutes != null &&
    remaining <= input.warningBeforeMinutes;
  return {
    state: warning ? 'WARNING' : 'ON_TRACK',
    deadline,
    elapsedMinutes: elapsed,
    remainingMinutes: remaining,
    breached: false,
    breachMinutes: 0,
    warning,
  };
}

/** Validates `{ URGENT: 0.5 }`-style maps; returns an error message or null. */
export function validatePriorityMultipliers(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value))
    return 'priorityMultipliers must be an object';
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(k))
      return `priorityMultipliers: unknown priority ${k}`;
    if (typeof v !== 'number' || !(v >= 0.1 && v <= 10))
      return `priorityMultipliers.${k} must be a number between 0.1 and 10`;
  }
  return null;
}
