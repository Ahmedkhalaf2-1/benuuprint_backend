import { workingClock } from './working-time.js';
import {
  computeJobEta,
  estimateFor,
  lowestQuality,
  type EtaStageInput,
} from './eta.js';

const now = new Date('2030-01-15T08:00:00Z');
const at = (min: number) => new Date(now.getTime() + min * 60_000);

const stage = (
  id: string,
  over: Partial<EtaStageInput> = {},
): EtaStageInput => ({
  id,
  stageCode: id.toUpperCase(),
  stageName: id,
  status: 'WAITING',
  startedAt: null,
  dependsOn: [],
  historicalAverageMinutes: null,
  historicalSamples: 0,
  expectedDurationMinutes: 60,
  stagesAhead: 0,
  workers: 1,
  ...over,
});
const run = (
  stages: EtaStageInput[],
  extra: Partial<Parameters<typeof computeJobEta>[0]> = {},
) =>
  computeJobEta({
    now,
    jobStatus: 'IN_PROGRESS',
    completedAt: null,
    stages,
    openBlockers: [],
    minSamples: 5,
    ...extra,
  });

describe('estimateFor', () => {
  it('uses history only with enough samples, else the configured duration, else nothing', () => {
    const h = {
      historicalAverageMinutes: 42,
      historicalSamples: 5,
      expectedDurationMinutes: 60,
    };
    expect(estimateFor(h, 5)).toEqual({ minutes: 42, source: 'HISTORICAL' });
    expect(estimateFor({ ...h, historicalSamples: 4 }, 5)).toEqual({
      minutes: 60,
      source: 'CONFIGURED',
    });
    expect(
      estimateFor(
        { ...h, historicalSamples: 0, expectedDurationMinutes: null },
        5,
      ),
    ).toEqual({ minutes: null, source: 'NONE' });
  });
});

describe('computeJobEta', () => {
  it('chains dependent stages (critical path) with the configured fallback', () => {
    const r = run([
      stage('a', { status: 'READY', expectedDurationMinutes: 60 }),
      stage('b', { dependsOn: ['a'], expectedDurationMinutes: 120 }),
      stage('c', { dependsOn: ['b'], expectedDurationMinutes: 30 }),
    ]);
    expect(r.estimatedCompletionAt).toEqual(at(210));
    expect(r.dataQuality).toBe('MEDIUM');
    expect(r.stages.map((s) => s.source)).toEqual([
      'CONFIGURED',
      'CONFIGURED',
      'CONFIGURED',
    ]);
    expect(r.basis[0]).toBe('3 stages remaining');
  });
  it('parallel branches: the slowest branch decides', () => {
    const r = run([
      stage('a', { status: 'READY', expectedDurationMinutes: 10 }),
      stage('x', { dependsOn: ['a'], expectedDurationMinutes: 100 }),
      stage('y', { dependsOn: ['a'], expectedDurationMinutes: 40 }),
      stage('z', { dependsOn: ['x', 'y'], expectedDurationMinutes: 5 }),
    ]);
    expect(r.estimatedCompletionAt).toEqual(at(115));
  });
  it('history beats the configured duration and gives HIGH quality when everything uses it', () => {
    const h = {
      historicalAverageMinutes: 30,
      historicalSamples: 8,
      expectedDurationMinutes: 90,
    };
    const r = run([
      stage('a', { ...h, status: 'READY' }),
      stage('b', { ...h, dependsOn: ['a'] }),
    ]);
    expect(r.estimatedCompletionAt).toEqual(at(60));
    expect(r.dataQuality).toBe('HIGH');
    expect(r.basis.join('|')).toMatch(/historical average 30min/);
  });
  it('an in-progress stage counts only what is left of its estimate, never negative', () => {
    const running = stage('a', {
      status: 'IN_PROGRESS',
      startedAt: at(-20),
      expectedDurationMinutes: 60,
    });
    expect(run([running]).estimatedCompletionAt).toEqual(at(40));
    const overrun = stage('a', {
      status: 'IN_PROGRESS',
      startedAt: at(-200),
      expectedDurationMinutes: 60,
    });
    expect(run([overrun]).estimatedCompletionAt).toEqual(at(0));
  });
  it('a READY stage waits for the queue ahead of it', () => {
    const r = run([
      stage('a', {
        status: 'READY',
        expectedDurationMinutes: 60,
        historicalAverageMinutes: 60,
        historicalSamples: 1,
        stagesAhead: 4,
        workers: 2,
      }),
    ]);
    expect(r.stages[0]!.queueMinutes).toBe(120); // 4 × 60 ÷ 2
    expect(r.estimatedCompletionAt).toEqual(at(180));
    expect(r.basis.join('|')).toMatch(/queue adds 2\.0h/);
  });
  it('blocked or held jobs are LOW quality and say so', () => {
    const blocked = run([stage('a', { status: 'BLOCKED' })], {
      openBlockers: [{ type: 'MATERIAL_UNAVAILABLE', createdAt: at(-300) }],
    });
    expect(blocked.blocked).toBe(true);
    expect(blocked.dataQuality).toBe('LOW');
    expect(blocked.basis.join('|')).toMatch(
      /Blocked since .*MATERIAL_UNAVAILABLE.*resolved now/,
    );
    const held = run([stage('a')], { jobStatus: 'ON_HOLD' });
    expect(held.dataQuality).toBe('LOW');
    expect(held.onHold).toBe(true);
  });
  it('a stage without any estimate is reported, counted as zero and lowers quality', () => {
    const r = run([
      stage('a', { expectedDurationMinutes: null }),
      stage('b', { dependsOn: ['a'], expectedDurationMinutes: 30 }),
    ]);
    expect(r.estimatedCompletionAt).toEqual(at(30));
    expect(r.dataQuality).toBe('LOW');
    expect(r.basis.join('|')).toMatch(/no historical or configured duration/);
  });
  it('completed jobs report the actual completion; cancelled ones none', () => {
    const done = run([], { jobStatus: 'COMPLETED', completedAt: at(-5) });
    expect(done).toMatchObject({
      estimatedCompletionAt: at(-5),
      dataQuality: 'HIGH',
    });
    expect(
      run([], { jobStatus: 'CANCELLED' }).estimatedCompletionAt,
    ).toBeNull();
  });
  it('ignores stages that are already done', () => {
    const r = run([
      stage('a', { status: 'COMPLETED' }),
      stage('b', { dependsOn: ['a'], expectedDurationMinutes: 45 }),
    ]);
    expect(r.estimatedCompletionAt).toEqual(at(45));
  });
  it('lowestQuality picks the weakest', () => {
    expect(lowestQuality(['HIGH', 'MEDIUM'])).toBe('MEDIUM');
    expect(lowestQuality(['HIGH', 'LOW', 'MEDIUM'])).toBe('LOW');
    expect(lowestQuality([])).toBe('LOW');
  });
});

describe('computeJobEta on the working calendar', () => {
  // Sun–Thu 09:00–17:00 in Cairo (UTC+2); "now" is Thursday 16:00 local = 14:00Z
  const nine = { start: 540, end: 1020 };
  const sch = {
    timezone: 'Africa/Cairo',
    weekly: [nine, nine, nine, nine, nine, null, null],
    exceptions: new Map(),
  };
  const clock = workingClock(sch);
  const thu = new Date('2031-01-09T14:00:00Z');
  const stage2 = (
    id: string,
    over: Partial<EtaStageInput> = {},
  ): EtaStageInput => ({ ...stage(id), ...over });

  it('skips the weekend and counts working minutes', () => {
    const r = computeJobEta({
      now: thu,
      jobStatus: 'IN_PROGRESS',
      completedAt: null,
      openBlockers: [],
      minSamples: 5,
      clock,
      stages: [
        stage2('a', { status: 'READY', expectedDurationMinutes: 120 }),
        stage2('b', { dependsOn: ['a'], expectedDurationMinutes: 60 }),
      ],
    });
    // 60 min Thursday + 60 min Sunday for a; b: Sunday 10:00→11:00 local
    expect(r.stages[0]!.estimatedEndAt.toISOString()).toBe(
      '2031-01-12T08:00:00.000Z',
    );
    expect(r.estimatedCompletionAt?.toISOString()).toBe(
      '2031-01-12T09:00:00.000Z',
    );
    expect(r.basis.join('|')).toMatch(/Working time/);
  });
  it('starts at the next working moment when asked outside working hours', () => {
    const fri = new Date('2031-01-10T10:00:00Z'); // Friday
    const r = computeJobEta({
      now: fri,
      jobStatus: 'IN_PROGRESS',
      completedAt: null,
      openBlockers: [],
      minSamples: 5,
      clock,
      stages: [stage2('a', { status: 'READY', expectedDurationMinutes: 30 })],
    });
    expect(r.stages[0]!.estimatedStartAt.toISOString()).toBe(
      '2031-01-12T07:00:00.000Z',
    ); // Sunday 09:00 local
    expect(r.estimatedCompletionAt?.toISOString()).toBe(
      '2031-01-12T07:30:00.000Z',
    );
  });
  it('an in-progress stage consumes only working time already spent', () => {
    // started Thursday 15:00 local (2 h before closing), now Sunday 09:30 local: 120 + 30 working minutes spent of 180
    const now = new Date('2031-01-12T07:30:00Z');
    const r = computeJobEta({
      now,
      jobStatus: 'IN_PROGRESS',
      completedAt: null,
      openBlockers: [],
      minSamples: 5,
      clock,
      stages: [
        stage2('a', {
          status: 'IN_PROGRESS',
          startedAt: new Date('2031-01-09T13:00:00Z'),
          expectedDurationMinutes: 180,
        }),
      ],
    });
    expect(r.stages[0]!.remainingMinutes).toBe(30);
    expect(r.estimatedCompletionAt?.toISOString()).toBe(
      '2031-01-12T08:00:00.000Z',
    );
  });
});
