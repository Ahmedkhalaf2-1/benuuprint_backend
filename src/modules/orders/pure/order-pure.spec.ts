import {
  ORDER_ACTIONS,
  ORDER_TRANSITIONS,
  checkOrderTransition,
} from './order-state-machine.js';
import {
  checkReport,
  deriveBatchProduction,
  deriveOrderProduction,
  progressPercent,
  requiredQuantity,
} from './order-production.js';

describe('order state machine', () => {
  it('has a rule for every action and never leaves terminal CANCELLED / PRODUCTION_COMPLETED', () => {
    for (const a of ORDER_ACTIONS) expect(ORDER_TRANSITIONS[a]).toBeDefined();
    for (const a of ORDER_ACTIONS) {
      expect(ORDER_TRANSITIONS[a].from).not.toContain('CANCELLED');
    }
    expect(ORDER_TRANSITIONS.cancel.from).not.toContain('PRODUCTION_COMPLETED');
    expect(ORDER_TRANSITIONS.hold.from).not.toContain('DRAFT');
  });

  it('walks the happy path', () => {
    const path: [Parameters<typeof checkOrderTransition>[0], string][] = [
      ['submit', 'PENDING_CONFIRMATION'],
      ['confirm', 'CONFIRMED'],
      ['mark-ready', 'READY_FOR_PRODUCTION'],
      ['production-started', 'IN_PRODUCTION'],
      ['production-partial', 'PARTIALLY_COMPLETED'],
      ['production-completed', 'PRODUCTION_COMPLETED'],
    ];
    let status: Parameters<typeof checkOrderTransition>[1] = 'DRAFT';
    for (const [action, to] of path) {
      const r = checkOrderTransition(action, status, null);
      expect(r).toEqual({ ok: true, to });
      status = to as typeof status;
    }
  });

  it('refuses arbitrary jumps', () => {
    expect(checkOrderTransition('mark-ready', 'DRAFT', null).ok).toBe(false);
    expect(checkOrderTransition('confirm', 'IN_PRODUCTION', null).ok).toBe(
      false,
    );
    expect(
      checkOrderTransition('production-started', 'CONFIRMED', null).ok,
    ).toBe(false);
    expect(checkOrderTransition('resume', 'CONFIRMED', null).ok).toBe(false);
    expect(
      checkOrderTransition('cancel', 'PRODUCTION_COMPLETED', null).ok,
    ).toBe(false);
  });

  it('resumes to the status held before', () => {
    expect(checkOrderTransition('resume', 'ON_HOLD', 'IN_PRODUCTION')).toEqual({
      ok: true,
      to: 'IN_PRODUCTION',
    });
    expect(checkOrderTransition('resume', 'ON_HOLD', null)).toEqual({
      ok: false,
      reason: 'NO_PREVIOUS_STATUS',
    });
  });
});

describe('order production derivation', () => {
  const job = (
    o: Partial<
      Parameters<typeof deriveOrderProduction>[0]['jobs'][number]
    > = {},
  ) => ({
    sourceType: 'BULK_ORDER' as const,
    status: 'READY' as const,
    startedAt: null,
    completedQuantity: 0,
    ...o,
  });
  const base = { totalQuantity: 100, batches: [], completedBatchCount: 0 };

  it('no live job → ready; started → in production; some units done → partial; whole job done → completed', () => {
    expect(deriveOrderProduction({ ...base, jobs: [] })).toBe(
      'READY_FOR_PRODUCTION',
    );
    expect(
      deriveOrderProduction({ ...base, jobs: [job({ status: 'CANCELLED' })] }),
    ).toBe('READY_FOR_PRODUCTION');
    expect(deriveOrderProduction({ ...base, jobs: [job()] })).toBe(
      'READY_FOR_PRODUCTION',
    );
    expect(
      deriveOrderProduction({
        ...base,
        jobs: [job({ status: 'IN_PROGRESS', startedAt: new Date() })],
      }),
    ).toBe('IN_PRODUCTION');
    expect(
      deriveOrderProduction({
        ...base,
        jobs: [
          job({
            status: 'IN_PROGRESS',
            startedAt: new Date(),
            completedQuantity: 30,
          }),
        ],
      }),
    ).toBe('PARTIALLY_COMPLETED');
    expect(
      deriveOrderProduction({
        ...base,
        jobs: [job({ status: 'COMPLETED', completedQuantity: 100 })],
      }),
    ).toBe('PRODUCTION_COMPLETED');
  });

  it('batches complete the order only when they cover every unit and are all done', () => {
    const batchJob = (status: 'COMPLETED' | 'IN_PROGRESS') =>
      job({
        sourceType: 'ORDER_BATCH',
        status,
        startedAt: new Date(),
        completedQuantity: status === 'COMPLETED' ? 60 : 0,
      });
    const half = {
      totalQuantity: 100,
      batches: [{ status: 'COMPLETED' as const, quantity: 60 }],
      completedBatchCount: 1,
    };
    expect(
      deriveOrderProduction({ ...half, jobs: [batchJob('COMPLETED')] }),
    ).toBe('PARTIALLY_COMPLETED');
    const full = {
      totalQuantity: 100,
      batches: [
        { status: 'COMPLETED' as const, quantity: 60 },
        { status: 'COMPLETED' as const, quantity: 40 },
      ],
      completedBatchCount: 2,
    };
    expect(
      deriveOrderProduction({
        ...full,
        jobs: [batchJob('COMPLETED'), batchJob('COMPLETED')],
      }),
    ).toBe('PRODUCTION_COMPLETED');
    const cancelledIgnored = {
      ...full,
      batches: [
        ...full.batches,
        { status: 'CANCELLED' as const, quantity: 10 },
      ],
    };
    expect(
      deriveOrderProduction({
        ...cancelledIgnored,
        jobs: [batchJob('COMPLETED'), batchJob('COMPLETED')],
      }),
    ).toBe('PRODUCTION_COMPLETED');
    const oneRunning = { ...full, completedBatchCount: 1 };
    expect(
      deriveOrderProduction({
        ...oneRunning,
        jobs: [batchJob('COMPLETED'), batchJob('IN_PROGRESS')],
      }),
    ).toBe('PARTIALLY_COMPLETED');
  });

  it('derives a batch status from its job', () => {
    expect(
      deriveBatchProduction({
        jobStatus: null,
        started: false,
        completedQuantity: 0,
      }),
    ).toBe('READY');
    expect(
      deriveBatchProduction({
        jobStatus: 'IN_PROGRESS',
        started: true,
        completedQuantity: 0,
      }),
    ).toBe('IN_PRODUCTION');
    expect(
      deriveBatchProduction({
        jobStatus: 'IN_PROGRESS',
        started: true,
        completedQuantity: 5,
      }),
    ).toBe('PARTIALLY_COMPLETED');
    expect(
      deriveBatchProduction({
        jobStatus: 'COMPLETED',
        started: true,
        completedQuantity: 9,
      }),
    ).toBe('COMPLETED');
  });
});

describe('stage quantities', () => {
  it('required quantity subtracts earlier rejections, or is the rework quantity', () => {
    expect(
      requiredQuantity({
        plannedQuantity: 500,
        reworkAffectedQuantity: null,
        rejectedBefore: 0,
      }),
    ).toBe(500);
    expect(
      requiredQuantity({
        plannedQuantity: 500,
        reworkAffectedQuantity: null,
        rejectedBefore: 12,
      }),
    ).toBe(488);
    expect(
      requiredQuantity({
        plannedQuantity: 500,
        reworkAffectedQuantity: 20,
        rejectedBefore: 12,
      }),
    ).toBe(20);
    expect(
      requiredQuantity({
        plannedQuantity: 10,
        reworkAffectedQuantity: null,
        rejectedBefore: 99,
      }),
    ).toBe(0);
  });

  it('accepts partial reports and blocks over-reporting and empty reports', () => {
    expect(
      checkReport({
        required: 500,
        accounted: 0,
        produced: 300,
        rejected: 0,
        rework: 0,
      }),
    ).toEqual({ ok: true, remainingAfter: 200 });
    expect(
      checkReport({
        required: 500,
        accounted: 300,
        produced: 190,
        rejected: 10,
        rework: 0,
      }),
    ).toEqual({ ok: true, remainingAfter: 0 });
    expect(
      checkReport({
        required: 500,
        accounted: 300,
        produced: 201,
        rejected: 0,
        rework: 0,
      }),
    ).toMatchObject({ ok: false, reason: 'OVER_REPORT', remaining: 200 });
    expect(
      checkReport({
        required: 500,
        accounted: 300,
        produced: 150,
        rejected: 51,
        rework: 0,
      }),
    ).toMatchObject({ ok: false, reason: 'OVER_REPORT' });
    expect(
      checkReport({
        required: 500,
        accounted: 0,
        produced: 0,
        rejected: 0,
        rework: 0,
      }),
    ).toMatchObject({ ok: false, reason: 'EMPTY' });
    // rework units are informational and do not count against the remainder
    expect(
      checkReport({
        required: 500,
        accounted: 500,
        produced: 0,
        rejected: 0,
        rework: 20,
      }),
    ).toEqual({ ok: true, remainingAfter: 0 });
  });

  it('progress is units through the final stage over deliverable units, never an average', () => {
    expect(
      progressPercent({
        totalQuantity: 500,
        completedQuantity: 0,
        rejectedQuantity: 0,
      }),
    ).toBe(0);
    expect(
      progressPercent({
        totalQuantity: 500,
        completedQuantity: 250,
        rejectedQuantity: 0,
      }),
    ).toBe(50);
    expect(
      progressPercent({
        totalQuantity: 500,
        completedQuantity: 480,
        rejectedQuantity: 20,
      }),
    ).toBe(100);
    expect(
      progressPercent({
        totalQuantity: 3,
        completedQuantity: 1,
        rejectedQuantity: 0,
      }),
    ).toBe(33.3);
    expect(
      progressPercent({
        totalQuantity: 10,
        completedQuantity: 0,
        rejectedQuantity: 10,
      }),
    ).toBe(100);
  });
});
