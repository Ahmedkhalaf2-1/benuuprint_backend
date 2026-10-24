import {
  JOB_STAGE_ACTIONS,
  JOB_STAGE_TRANSITIONS,
  TERMINAL_STAGE_STATUSES,
  checkStageTransition,
  isStageDelayed,
} from './job-stage-state-machine.js';
import { deriveJobStatus, type StageSummary } from './job-status.js';
import { resolveDependencies, validateWorkflow } from './workflow-graph.js';
import type { JobStageStatus } from '../../../generated/prisma/client.js';

const ALL: JobStageStatus[] = [
  'WAITING',
  'READY',
  'IN_PROGRESS',
  'BLOCKED',
  'COMPLETED',
  'SKIPPED',
  'FAILED',
  'CANCELLED',
];

describe('job stage state machine', () => {
  it('walks WAITING → READY → IN_PROGRESS → COMPLETED', () => {
    expect(checkStageTransition('make-ready', 'WAITING', null)).toEqual({
      ok: true,
      to: 'READY',
    });
    expect(checkStageTransition('start', 'READY', null)).toEqual({
      ok: true,
      to: 'IN_PROGRESS',
    });
    expect(checkStageTransition('complete', 'IN_PROGRESS', null)).toEqual({
      ok: true,
      to: 'COMPLETED',
    });
  });

  it('allows each action only from its source statuses', () => {
    for (const action of JOB_STAGE_ACTIONS) {
      const rule = JOB_STAGE_TRANSITIONS[action];
      for (const status of ALL) {
        const result = checkStageTransition(action, status, 'IN_PROGRESS');
        expect(result.ok).toBe(rule.from.includes(status));
      }
    }
  });

  it('never leaves a terminal status', () => {
    for (const terminal of TERMINAL_STAGE_STATUSES) {
      for (const action of JOB_STAGE_ACTIONS) {
        expect(checkStageTransition(action, terminal, 'READY').ok).toBe(false);
      }
    }
  });

  it('cannot start a stage that is waiting, blocked or already running, or complete one that never started', () => {
    for (const status of [
      'WAITING',
      'BLOCKED',
      'IN_PROGRESS',
      'COMPLETED',
    ] as const) {
      expect(checkStageTransition('start', status, null).ok).toBe(false);
    }
    for (const status of [
      'WAITING',
      'READY',
      'BLOCKED',
      'COMPLETED',
    ] as const) {
      expect(checkStageTransition('complete', status, null).ok).toBe(false);
    }
  });

  it('blocks from READY or IN_PROGRESS and unblocks back to where it was', () => {
    expect(checkStageTransition('block', 'READY', null)).toEqual({
      ok: true,
      to: 'BLOCKED',
    });
    expect(checkStageTransition('block', 'WAITING', null).ok).toBe(false);
    expect(checkStageTransition('unblock', 'BLOCKED', 'IN_PROGRESS')).toEqual({
      ok: true,
      to: 'IN_PROGRESS',
    });
    expect(checkStageTransition('unblock', 'BLOCKED', 'READY')).toEqual({
      ok: true,
      to: 'READY',
    });
    expect(checkStageTransition('unblock', 'BLOCKED', null)).toEqual({
      ok: false,
      reason: 'NO_PREVIOUS_STATUS',
    });
    expect(checkStageTransition('unblock', 'READY', 'READY').ok).toBe(false);
  });

  it('only a running stage can fail, and only a stage not yet started can be skipped', () => {
    expect(checkStageTransition('fail', 'IN_PROGRESS', null).ok).toBe(true);
    expect(checkStageTransition('fail', 'READY', null).ok).toBe(false);
    expect(checkStageTransition('skip', 'WAITING', null).ok).toBe(true);
    expect(checkStageTransition('skip', 'IN_PROGRESS', null).ok).toBe(false);
    expect(checkStageTransition('force-complete', 'WAITING', null).ok).toBe(
      false,
    );
  });

  it('cancels any open stage', () => {
    for (const status of [
      'WAITING',
      'READY',
      'IN_PROGRESS',
      'BLOCKED',
    ] as const) {
      expect(checkStageTransition('cancel', status, 'READY')).toEqual({
        ok: true,
        to: 'CANCELLED',
      });
    }
  });
});

describe('isStageDelayed', () => {
  const now = new Date('2026-01-10T12:00:00Z');
  const past = new Date('2026-01-10T11:00:00Z');
  const future = new Date('2026-01-10T13:00:00Z');
  it('is delayed only when open and past due', () => {
    expect(isStageDelayed({ status: 'IN_PROGRESS', dueAt: past }, now)).toBe(
      true,
    );
    expect(isStageDelayed({ status: 'READY', dueAt: past }, now)).toBe(true);
    expect(isStageDelayed({ status: 'BLOCKED', dueAt: past }, now)).toBe(true);
    expect(isStageDelayed({ status: 'READY', dueAt: future }, now)).toBe(false);
    expect(isStageDelayed({ status: 'READY', dueAt: null }, now)).toBe(false);
    for (const status of [
      'COMPLETED',
      'SKIPPED',
      'FAILED',
      'CANCELLED',
    ] as const) {
      expect(isStageDelayed({ status, dueAt: past }, now)).toBe(false);
    }
    expect(
      isStageDelayed({ status: 'READY', dueAt: past, supersededAt: past }, now),
    ).toBe(false);
  });
});

describe('deriveJobStatus', () => {
  const stage = (
    status: JobStageStatus,
    extra: Partial<StageSummary> = {},
  ): StageSummary => ({
    status,
    isRequired: true,
    supersededAt: null,
    ...extra,
  });
  const derive = (
    stages: StageSummary[],
    openJobBlockers = 0,
    hasStarted = false,
  ) => deriveJobStatus({ stages, openJobBlockers, hasStarted }).status;

  it('is PLANNED before anything is ready, READY once a stage is ready', () => {
    expect(derive([stage('WAITING'), stage('WAITING')])).toBe('PLANNED');
    expect(derive([stage('READY'), stage('WAITING')])).toBe('READY');
  });
  it('is IN_PROGRESS while work runs or has run', () => {
    expect(derive([stage('IN_PROGRESS'), stage('WAITING')])).toBe(
      'IN_PROGRESS',
    );
    expect(derive([stage('COMPLETED'), stage('READY')])).toBe('IN_PROGRESS');
    expect(derive([stage('READY')], 0, true)).toBe('IN_PROGRESS');
  });
  it('is BLOCKED by a blocked stage or an open job-level blocker', () => {
    expect(derive([stage('BLOCKED'), stage('WAITING')])).toBe('BLOCKED');
    expect(derive([stage('READY')], 1)).toBe('BLOCKED');
  });
  it('completes when every required current stage is completed or skipped', () => {
    expect(derive([stage('COMPLETED'), stage('SKIPPED')])).toBe('COMPLETED');
    expect(
      derive([stage('COMPLETED'), stage('WAITING', { isRequired: false })]),
    ).toBe('COMPLETED');
    expect(derive([stage('COMPLETED'), stage('READY')])).not.toBe('COMPLETED');
    expect(derive([])).toBe('PLANNED');
  });
  it('ignores superseded (reworked) occurrences', () => {
    const old = new Date();
    expect(
      derive([
        stage('FAILED', { supersededAt: old }),
        stage('COMPLETED'),
        stage('READY'),
      ]),
    ).toBe('IN_PROGRESS');
    expect(
      derive([
        stage('FAILED', { supersededAt: old }),
        stage('COMPLETED', { supersededAt: old }),
        stage('COMPLETED'),
      ]),
    ).toBe('COMPLETED');
  });
  it('lets a blocker win over progress but never over completion', () => {
    expect(derive([stage('COMPLETED'), stage('BLOCKED')])).toBe('BLOCKED');
    expect(derive([stage('COMPLETED')], 1)).toBe('COMPLETED');
  });
});

describe('workflow graph', () => {
  const s = (sequence: number, stageCode: string, extra: object = {}) => ({
    sequence,
    stageCode,
    isQcStage: false,
    ...extra,
  });

  it('defaults to a sequential chain', () => {
    const resolved = resolveDependencies([s(3, 'C'), s(1, 'A'), s(2, 'B')]);
    expect(resolved.map((r) => [r.sequence, r.dependsOnSequences])).toEqual([
      [1, []],
      [2, [1]],
      [3, [2]],
    ]);
  });
  it('accepts explicit parallel branches that join', () => {
    const stages = [
      s(1, 'CUT'),
      s(2, 'PRINT', { dependsOnSequences: [1] }),
      s(3, 'EMB', { dependsOnSequences: [1] }),
      s(4, 'SEW', { dependsOnSequences: [2, 3] }),
    ];
    expect(validateWorkflow(stages)).toEqual([]);
    expect(
      resolveDependencies(stages).find((r) => r.sequence === 4)!
        .dependsOnSequences,
    ).toEqual([2, 3]);
    expect(
      validateWorkflow([s(1, 'A'), s(2, 'B', { dependsOnSequences: [] })]),
    ).toEqual([]); // two roots
  });
  it('rejects empty, duplicate, unknown, self and cyclic definitions', () => {
    expect(validateWorkflow([])).toEqual([
      'a workflow needs at least one stage',
    ]);
    expect(validateWorkflow([s(1, 'A'), s(1, 'B')])[0]).toMatch(
      /more than once/,
    );
    expect(
      validateWorkflow([s(1, 'A'), s(2, 'B', { dependsOnSequences: [9] })])[0],
    ).toMatch(/unknown sequence 9/);
    expect(
      validateWorkflow([s(1, 'A'), s(2, 'B', { dependsOnSequences: [2] })])[0],
    ).toMatch(/itself/);
    expect(
      validateWorkflow([
        s(1, 'A', { dependsOnSequences: [2] }),
        s(2, 'B', { dependsOnSequences: [1] }),
      ]),
    ).toContain('the dependencies contain a cycle');
    expect(
      validateWorkflow([
        s(1, 'A'),
        s(2, 'B', { dependsOnSequences: [1, 1] }),
      ])[0],
    ).toMatch(/twice/);
  });
  it('requires a QC gate to follow the work it inspects', () => {
    expect(validateWorkflow([s(1, 'QC', { isQcStage: true })])[0]).toMatch(
      /must depend on/,
    );
    expect(
      validateWorkflow([s(1, 'CUT'), s(2, 'QC', { isQcStage: true })]),
    ).toEqual([]);
  });
});
