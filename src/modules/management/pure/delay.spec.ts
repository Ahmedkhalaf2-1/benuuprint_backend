import {
  evaluateJobDelay,
  evaluateOrderDelay,
  type JobDelayInput,
} from './delay.js';

const now = new Date('2030-01-15T12:00:00Z');
const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
const ahead = (h: number) => new Date(now.getTime() + h * 3_600_000);

const stage = (over: Partial<JobDelayInput['stages'][number]> = {}) => ({
  id: 's1',
  stageCode: 'SEWING',
  stageName: 'Sewing',
  departmentType: 'SEWING',
  status: 'IN_PROGRESS',
  dueAt: ahead(2),
  supersededAt: null,
  isOnHold: false,
  ...over,
});
const job = (over: Partial<JobDelayInput> = {}): JobDelayInput => ({
  status: 'IN_PROGRESS',
  targetCompletionDate: ahead(48),
  stages: [stage()],
  openBlockers: [],
  ...over,
});

describe('job delay engine', () => {
  it('is not delayed when everything is on time', () => {
    expect(evaluateJobDelay(job(), now)).toEqual({
      isDelayed: false,
      delayMinutes: 0,
      reasons: [],
    });
  });
  it('an overdue active stage is a reason with its lateness', () => {
    const r = evaluateJobDelay(
      job({ stages: [stage({ dueAt: ago(3) })] }),
      now,
    );
    expect(r.isDelayed).toBe(true);
    expect(r.reasons[0]).toMatchObject({
      code: 'STAGE_OVERDUE',
      minutes: 180,
      refs: ['s1'],
    });
    expect(r.delayMinutes).toBe(180);
  });
  it('a completed or superseded stage is not delayed', () => {
    expect(
      evaluateJobDelay(
        job({ stages: [stage({ status: 'COMPLETED', dueAt: ago(10) })] }),
        now,
      ).isDelayed,
    ).toBe(false);
    expect(
      evaluateJobDelay(
        job({ stages: [stage({ supersededAt: ago(1), dueAt: ago(10) })] }),
        now,
      ).isDelayed,
    ).toBe(false);
    expect(
      evaluateJobDelay(
        job({ stages: [stage({ isOnHold: true, dueAt: ago(10) })] }),
        now,
      ).isDelayed,
    ).toBe(false);
  });
  it('an unresolved blocker is a reason; its age is the delay', () => {
    const r = evaluateJobDelay(
      job({
        openBlockers: [
          { id: 'b1', type: 'MATERIAL_UNAVAILABLE', createdAt: ago(5) },
        ],
      }),
      now,
    );
    expect(r.reasons.map((x) => x.code)).toEqual(['OPEN_BLOCKER']);
    expect(r.delayMinutes).toBe(300);
  });
  it('a passed target date is a reason', () => {
    const r = evaluateJobDelay(job({ targetCompletionDate: ago(24) }), now);
    expect(r.reasons[0]).toMatchObject({
      code: 'TARGET_DATE_EXCEEDED',
      minutes: 1440,
    });
  });
  it('completed, cancelled and held jobs are never delayed', () => {
    for (const status of ['COMPLETED', 'CANCELLED', 'ON_HOLD'])
      expect(
        evaluateJobDelay(job({ status, targetCompletionDate: ago(100) }), now)
          .isDelayed,
      ).toBe(false);
  });
  it('reports several reasons together', () => {
    const r = evaluateJobDelay(
      job({
        targetCompletionDate: ago(1),
        stages: [stage({ dueAt: ago(2) })],
        openBlockers: [{ id: 'b', type: 'OTHER', createdAt: ago(1) }],
      }),
      now,
    );
    expect(r.reasons.map((x) => x.code).sort()).toEqual([
      'OPEN_BLOCKER',
      'STAGE_OVERDUE',
      'TARGET_DATE_EXCEEDED',
    ]);
  });
});

describe('order delay engine', () => {
  const okJob = {
    id: 'j',
    jobNumber: 'JOB-1',
    delay: { isDelayed: false, delayMinutes: 0, reasons: [] },
    delayedPackagingStageIds: [],
  };
  const order = (over = {}) => ({
    status: 'IN_PRODUCTION',
    targetDeliveryDate: ahead(100),
    jobs: [okJob],
    batches: [],
    shipments: [],
    ...over,
  });
  it('on time', () => {
    expect(evaluateOrderDelay(order(), now).isDelayed).toBe(false);
  });
  it('delivery date exceeded', () => {
    const r = evaluateOrderDelay(order({ targetDeliveryDate: ago(48) }), now);
    expect(r.reasons[0]).toMatchObject({
      code: 'DELIVERY_DATE_EXCEEDED',
      minutes: 2880,
    });
  });
  it('delayed job and packaging, batch target, shipment failed / overdue', () => {
    const delayedJob = {
      id: 'j2',
      jobNumber: 'JOB-2',
      delay: {
        isDelayed: true,
        delayMinutes: 60,
        reasons: [
          {
            code: 'STAGE_OVERDUE' as const,
            message: '',
            minutes: 60,
            refs: ['p1'],
          },
        ],
      },
      delayedPackagingStageIds: ['p1'],
    };
    const r = evaluateOrderDelay(
      order({
        jobs: [delayedJob],
        batches: [
          {
            id: 'b',
            batchNumber: 'BAT-1',
            status: 'IN_PRODUCTION',
            targetCompletionDate: ago(2),
          },
        ],
        shipments: [
          {
            id: 's1',
            shipmentNumber: 'SHP-1',
            status: 'FAILED',
            deadline: null,
          },
          {
            id: 's2',
            shipmentNumber: 'SHP-2',
            status: 'IN_TRANSIT',
            deadline: ago(1),
          },
          {
            id: 's3',
            shipmentNumber: 'SHP-3',
            status: 'DELIVERED',
            deadline: ago(100),
          },
        ],
      }),
      now,
    );
    expect(r.reasons.map((x) => x.code).sort()).toEqual([
      'BATCH_TARGET_EXCEEDED',
      'JOB_DELAYED',
      'PACKAGING_DELAYED',
      'SHIPMENT_FAILED',
      'SHIPMENT_OVERDUE',
    ]);
  });
  it('delivered, completed, cancelled and held orders are not delayed', () => {
    for (const status of [
      'DELIVERED',
      'COMPLETED',
      'CANCELLED',
      'ON_HOLD',
      'DRAFT',
    ])
      expect(
        evaluateOrderDelay(order({ status, targetDeliveryDate: ago(500) }), now)
          .isDelayed,
      ).toBe(false);
  });
  it('a completed batch past its target is not a reason', () => {
    const r = evaluateOrderDelay(
      order({
        batches: [
          {
            id: 'b',
            batchNumber: 'BAT-1',
            status: 'COMPLETED',
            targetCompletionDate: ago(50),
          },
        ],
      }),
      now,
    );
    expect(r.isDelayed).toBe(false);
  });
});
