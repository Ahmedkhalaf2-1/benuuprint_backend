/**
 * Deterministic ETA of a job. No ML, no false precision.
 *
 *  1. Remaining stages = current (non-superseded) stages that are WAITING / READY / IN_PROGRESS / BLOCKED.
 *  2. Per-stage duration estimate: historical average of completed occurrences of that stage when at
 *     least `minSamples` exist (HISTORICAL), else the stage's configured expectedDurationMinutes
 *     (CONFIGURED), else unknown (NONE: counted as zero and reported, never invented).
 *  3. An IN_PROGRESS stage contributes what is left of its estimate (never negative).
 *  4. A READY stage waits for the work queued ahead of it in the same stage:
 *     queue = stagesAhead × average duration ÷ workers (eligible staff, at least 1).
 *     Queues of stages that are still WAITING are not modelled (their queue does not exist yet).
 *  5. Stages are scheduled on the dependency graph: start = max(now, latest estimated finish of the
 *     remaining stages it depends on). ETA = latest finish (the critical path).
 *  6. Time: with a working calendar configured (Phase 6B) durations, queues and the ETA are WORKING minutes and
 *     nights, weekends and holidays are skipped; without one (or with an always-open calendar) it is calendar time.
 *
 * Data quality: HIGH = every remaining stage uses history, nothing is blocked or held;
 * MEDIUM = every remaining stage has an estimate (history or configured), nothing blocked or held;
 * LOW = any stage has no estimate, the job is blocked or on hold, or there is nothing to base it on.
 */

import { CALENDAR_TIME, type BusinessClock } from './working-time.js';

export type EtaSource = 'HISTORICAL' | 'CONFIGURED' | 'NONE';
export type DataQuality = 'LOW' | 'MEDIUM' | 'HIGH';

export interface EtaStageInput {
  id: string;
  stageCode: string;
  stageName: string;
  status: string;
  startedAt: Date | null;
  dependsOn: string[];
  /** Average minutes of completed occurrences, and how many samples back it. */
  historicalAverageMinutes: number | null;
  historicalSamples: number;
  expectedDurationMinutes: number | null;
  /** Other READY / IN_PROGRESS occurrences of the same stage that were there first. */
  stagesAhead: number;
  workers: number;
}

export interface EtaStageOutput {
  stageId: string;
  stageCode: string;
  stageName: string;
  status: string;
  estimateMinutes: number | null;
  source: EtaSource;
  queueMinutes: number;
  remainingMinutes: number;
  estimatedStartAt: Date;
  estimatedEndAt: Date;
}

export interface JobEtaInput {
  now: Date;
  jobStatus: string;
  completedAt: Date | null;
  stages: EtaStageInput[];
  openBlockers: { type: string; createdAt: Date }[];
  minSamples: number;
  /** Working calendar (default: calendar time). Durations, queues and the ETA itself are in this clock's minutes. */
  clock?: BusinessClock;
}

export interface JobEtaResult {
  estimatedCompletionAt: Date | null;
  dataQuality: DataQuality;
  blocked: boolean;
  onHold: boolean;
  stages: EtaStageOutput[];
  basis: string[];
}

const REMAINING = new Set(['WAITING', 'READY', 'IN_PROGRESS', 'BLOCKED']);
const hours = (minutes: number) =>
  minutes >= 120
    ? `${(minutes / 60).toFixed(1)}h`
    : `${Math.round(minutes)}min`;

export function estimateFor(
  s: Pick<
    EtaStageInput,
    'historicalAverageMinutes' | 'historicalSamples' | 'expectedDurationMinutes'
  >,
  minSamples: number,
): { minutes: number | null; source: EtaSource } {
  if (s.historicalAverageMinutes != null && s.historicalSamples >= minSamples)
    return { minutes: s.historicalAverageMinutes, source: 'HISTORICAL' };
  if (s.expectedDurationMinutes != null)
    return { minutes: s.expectedDurationMinutes, source: 'CONFIGURED' };
  return { minutes: null, source: 'NONE' };
}

export function computeJobEta(input: JobEtaInput): JobEtaResult {
  const { now } = input;
  const clock = input.clock ?? CALENDAR_TIME;
  if (input.jobStatus === 'COMPLETED')
    return {
      estimatedCompletionAt: input.completedAt,
      dataQuality: 'HIGH',
      blocked: false,
      onHold: false,
      stages: [],
      basis: ['The job is completed; this is its actual completion time'],
    };
  if (input.jobStatus === 'CANCELLED')
    return {
      estimatedCompletionAt: null,
      dataQuality: 'LOW',
      blocked: false,
      onHold: false,
      stages: [],
      basis: ['The job is cancelled'],
    };

  const onHold = input.jobStatus === 'ON_HOLD';
  const blocked =
    input.openBlockers.length > 0 || input.jobStatus === 'BLOCKED';
  const remaining = input.stages.filter((s) => REMAINING.has(s.status));
  const ids = new Set(remaining.map((s) => s.id));
  const byId = new Map(remaining.map((s) => [s.id, s]));
  const basis: string[] = [];

  const finish = new Map<string, EtaStageOutput>();
  const visiting = new Set<string>();
  const schedule = (s: EtaStageInput): EtaStageOutput => {
    const done = finish.get(s.id);
    if (done) return done;
    if (visiting.has(s.id))
      throw new Error('Stage dependencies contain a cycle');
    visiting.add(s.id);
    let start = clock.next(now).getTime();
    for (const d of s.dependsOn)
      if (ids.has(d))
        start = Math.max(
          start,
          schedule(byId.get(d)!).estimatedEndAt.getTime(),
        );
    visiting.delete(s.id);
    const est = estimateFor(s, input.minSamples);
    const avg = s.historicalAverageMinutes ?? est.minutes ?? 0;
    let queue = 0;
    let remainingMinutes = est.minutes ?? 0;
    if (s.status === 'IN_PROGRESS' && s.startedAt) {
      const elapsed = clock.between(s.startedAt, now);
      remainingMinutes = Math.max((est.minutes ?? 0) - elapsed, 0);
    } else if (s.status === 'READY' && s.stagesAhead > 0) {
      queue = (s.stagesAhead * avg) / Math.max(1, s.workers);
    }
    const startWork = clock.next(new Date(start));
    const startAt = queue > 0 ? clock.add(startWork, queue) : startWork;
    const out: EtaStageOutput = {
      stageId: s.id,
      stageCode: s.stageCode,
      stageName: s.stageName,
      status: s.status,
      estimateMinutes: est.minutes,
      source: est.source,
      queueMinutes: Math.round(queue),
      remainingMinutes: Math.round(remainingMinutes),
      estimatedStartAt: startAt,
      estimatedEndAt: clock.add(startAt, remainingMinutes),
    };
    finish.set(s.id, out);
    return out;
  };
  const stages = remaining
    .map(schedule)
    .sort((a, b) => a.estimatedEndAt.getTime() - b.estimatedEndAt.getTime());

  let eta: Date | null = null;
  if (remaining.length === 0) {
    eta = now;
    basis.push('No stages remain; the job only needs closing');
  } else {
    eta = new Date(Math.max(...stages.map((s) => s.estimatedEndAt.getTime())));
    basis.push(
      `${remaining.length} stage${remaining.length === 1 ? '' : 's'} remaining`,
    );
    for (const s of stages) {
      if (s.source === 'NONE')
        basis.push(
          `${s.stageName}: no historical or configured duration (counted as 0)`,
        );
      else {
        const label =
          s.source === 'HISTORICAL'
            ? 'historical average'
            : 'configured estimate';
        const left =
          s.status === 'IN_PROGRESS'
            ? `, ${hours(s.remainingMinutes)} left`
            : '';
        basis.push(
          `${s.stageName}: ${label} ${hours(s.estimateMinutes!)}${left}`,
        );
      }
      if (s.queueMinutes > 0)
        basis.push(`${s.stageName}: queue adds ${hours(s.queueMinutes)}`);
    }
  }
  if (blocked) {
    const oldest = [...input.openBlockers].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    )[0];
    basis.push(
      oldest
        ? `Blocked since ${oldest.createdAt.toISOString()} (${oldest.type}); the estimate assumes it is resolved now`
        : 'The job is blocked; the estimate assumes it is resolved now',
    );
  }
  if (onHold) {
    basis.push('The job is on hold; the estimate assumes it resumes now');
  }

  let dataQuality: DataQuality;
  if (blocked || onHold || stages.some((s) => s.source === 'NONE'))
    dataQuality = 'LOW';
  else if (stages.length === 0) dataQuality = 'LOW';
  else if (stages.every((s) => s.source === 'HISTORICAL')) dataQuality = 'HIGH';
  else dataQuality = 'MEDIUM';
  basis.push(
    clock.kind === 'WORKING'
      ? 'Working time: counted on the factory working calendar (nights, weekends and holidays are skipped)'
      : 'Calendar time: nights, weekends and holidays are not excluded',
  );
  return {
    estimatedCompletionAt: eta,
    dataQuality,
    blocked,
    onHold,
    stages,
    basis,
  };
}

const RANK: Record<DataQuality, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
export const lowestQuality = (qualities: DataQuality[]): DataQuality =>
  qualities.length === 0
    ? 'LOW'
    : qualities.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
