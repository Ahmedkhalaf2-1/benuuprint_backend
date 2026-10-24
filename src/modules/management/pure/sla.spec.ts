import { workingClock } from './working-time.js';
import {
  effectiveThreshold,
  evaluateSla,
  resolveDateOrRuleDeadline,
  resolveStageDeadline,
  validatePriorityMultipliers,
} from './sla.js';

const t0 = new Date('2030-01-15T08:00:00Z');
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
const rule = {
  thresholdMinutes: 120,
  warningBeforeMinutes: 30,
  priorityMultipliers: { URGENT: 0.5 },
};

describe('SLA deadlines', () => {
  it('a rule deadline is readyAt + threshold, scaled by priority', () => {
    expect(effectiveThreshold(rule, 'URGENT')).toBe(60);
    expect(effectiveThreshold(rule, 'NORMAL')).toBe(120);
    const d = resolveStageDeadline(
      { readyAt: t0, dueAt: at(999), expectedDurationMinutes: 5 },
      rule,
      'URGENT',
    );
    expect(d).toMatchObject({ source: 'RULE', expectedMinutes: 60 });
    expect(d.deadline).toEqual(at(60));
  });
  it('without a rule: dueAt, then readyAt + expected duration, then nothing', () => {
    expect(
      resolveStageDeadline(
        { readyAt: t0, dueAt: at(50), expectedDurationMinutes: 90 },
        null,
        'NORMAL',
      ).source,
    ).toBe('DUE_AT');
    const e = resolveStageDeadline(
      { readyAt: t0, dueAt: null, expectedDurationMinutes: 90 },
      null,
      'NORMAL',
    );
    expect(e.source).toBe('EXPECTED_DURATION');
    expect(e.deadline).toEqual(at(90));
    expect(
      resolveStageDeadline(
        { readyAt: t0, dueAt: null, expectedDurationMinutes: null },
        null,
        'NORMAL',
      ).source,
    ).toBe('NONE');
  });
  it('an explicit date beats a rule for jobs/orders/shipments', () => {
    const r = resolveDateOrRuleDeadline(
      at(500),
      'TARGET_DATE',
      t0,
      rule,
      'NORMAL',
      t0,
    );
    expect(r.source).toBe('TARGET_DATE');
    expect(r.deadline).toEqual(at(500));
    const fallback = resolveDateOrRuleDeadline(
      null,
      'TARGET_DATE',
      t0,
      rule,
      'NORMAL',
      t0,
    );
    expect(fallback).toMatchObject({ source: 'RULE' });
    expect(fallback.deadline).toEqual(at(120));
    expect(
      resolveDateOrRuleDeadline(null, 'SCHEDULED', null, rule, 'NORMAL', t0)
        .source,
    ).toBe('NONE');
  });
});

describe('evaluateSla', () => {
  const base = {
    startAt: t0,
    deadline: at(120),
    completedAt: null,
    warningBeforeMinutes: 30,
  };
  it('on track', () => {
    const e = evaluateSla({ ...base, now: at(30) });
    expect(e).toMatchObject({
      state: 'ON_TRACK',
      remainingMinutes: 90,
      elapsedMinutes: 30,
      breached: false,
      warning: false,
    });
  });
  it('warning inside the warning window (inclusive)', () => {
    expect(evaluateSla({ ...base, now: at(90) })).toMatchObject({
      state: 'WARNING',
      remainingMinutes: 30,
      warning: true,
    });
  });
  it('exactly at the deadline is not a breach; one minute later is', () => {
    expect(evaluateSla({ ...base, now: at(120) }).breached).toBe(false);
    expect(evaluateSla({ ...base, now: at(125) })).toMatchObject({
      state: 'BREACHED',
      breachMinutes: 5,
      remainingMinutes: null,
    });
  });
  it('a completed stage is never reported as currently late', () => {
    const late = evaluateSla({ ...base, completedAt: at(150), now: at(1000) });
    expect(late).toMatchObject({
      state: 'COMPLETED_LATE',
      breachMinutes: 30,
      elapsedMinutes: 150,
    });
    const ok = evaluateSla({ ...base, completedAt: at(100), now: at(1000) });
    expect(ok).toMatchObject({
      state: 'COMPLETED_ON_TIME',
      breached: false,
      remainingMinutes: null,
    });
  });
  it('no deadline → NO_SLA', () => {
    expect(
      evaluateSla({ ...base, deadline: null, now: at(5000) }),
    ).toMatchObject({ state: 'NO_SLA', breached: false });
  });
  it('validates priority multipliers', () => {
    expect(validatePriorityMultipliers({ URGENT: 0.5 })).toBeNull();
    expect(validatePriorityMultipliers({ URGENT: 0 })).toMatch(
      /between 0.1 and 10/,
    );
    expect(validatePriorityMultipliers({ SUPER: 1 })).toMatch(
      /unknown priority/,
    );
    expect(validatePriorityMultipliers([1])).toMatch(/object/);
  });
});

describe('SLA on the working calendar', () => {
  // Sun–Thu 09:00–17:00 Cairo (UTC+2 in January); 2031-01-09 is a Thursday
  const nine = { start: 540, end: 1020 };
  const sch = {
    timezone: 'Africa/Cairo',
    weekly: [nine, nine, nine, nine, nine, null, null],
    exceptions: new Map(),
  };
  const clock = workingClock(sch);
  const utc = (s: string) => new Date(s);

  it('a rule threshold is counted in working minutes', () => {
    // ready Thursday 16:00 local with a 120 min rule → 60 min Thursday + 60 min Sunday = Sunday 10:00 local
    const d = resolveStageDeadline(
      {
        readyAt: utc('2031-01-09T14:00:00Z'),
        dueAt: null,
        expectedDurationMinutes: null,
      },
      {
        thresholdMinutes: 120,
        warningBeforeMinutes: null,
        priorityMultipliers: null,
      },
      'NORMAL',
      clock,
    );
    expect(d.deadline?.toISOString()).toBe('2031-01-12T08:00:00.000Z');
    // calendar time would have said Thursday 18:00 local
    const cal = resolveStageDeadline(
      {
        readyAt: utc('2031-01-09T14:00:00Z'),
        dueAt: null,
        expectedDurationMinutes: null,
      },
      {
        thresholdMinutes: 120,
        warningBeforeMinutes: null,
        priorityMultipliers: null,
      },
      'NORMAL',
    );
    expect(cal.deadline?.toISOString()).toBe('2031-01-09T16:00:00.000Z');
  });
  it('remaining and breach minutes skip the weekend', () => {
    const deadline = utc('2031-01-12T08:00:00Z'); // Sunday 10:00 local
    const open = evaluateSla({
      startAt: utc('2031-01-09T14:00:00Z'),
      deadline,
      completedAt: null,
      warningBeforeMinutes: 30,
      now: utc('2031-01-10T12:00:00Z'),
      clock,
    });
    // Friday noon: only the 60 working minutes on Sunday remain
    expect(open).toMatchObject({
      state: 'ON_TRACK',
      remainingMinutes: 60,
      elapsedMinutes: 60,
    });
    const warn = evaluateSla({
      startAt: utc('2031-01-09T14:00:00Z'),
      deadline,
      completedAt: null,
      warningBeforeMinutes: 90,
      now: utc('2031-01-10T12:00:00Z'),
      clock,
    });
    expect(warn.state).toBe('WARNING');
    const late = evaluateSla({
      startAt: utc('2031-01-09T14:00:00Z'),
      deadline,
      completedAt: null,
      warningBeforeMinutes: 30,
      now: utc('2031-01-12T09:30:00Z'),
      clock,
    });
    expect(late).toMatchObject({ state: 'BREACHED', breachMinutes: 90 }); // 10:00 → 11:30 local on Sunday
    const doneLate = evaluateSla({
      startAt: utc('2031-01-09T14:00:00Z'),
      deadline,
      completedAt: utc('2031-01-13T07:00:00Z'),
      warningBeforeMinutes: 30,
      now: utc('2031-02-01T00:00:00Z'),
      clock,
    });
    expect(doneLate).toMatchObject({
      state: 'COMPLETED_LATE',
      breachMinutes: 420,
    });
  });
});
