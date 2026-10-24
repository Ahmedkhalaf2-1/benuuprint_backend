import {
  etaView,
  projectOrderProduction,
  type JobFacts,
} from './customer-order-production.js';

const job = (
  status: string,
  stages: [string, string][],
  superseded = false,
): JobFacts => ({
  status,
  stages: stages.map(([stageCode, s]) => ({
    stageCode,
    status: s,
    superseded,
  })),
});

describe('customer order production projection', () => {
  it('has not started without jobs', () => {
    expect(projectOrderProduction([]).phase).toBe('NOT_STARTED');
  });

  it('uses seven coarse steps including packaging and shipment readiness', () => {
    const p = projectOrderProduction([
      job('IN_PROGRESS', [
        ['FABRIC_PREPARATION', 'COMPLETED'],
        ['PATTERN_MAKING', 'COMPLETED'],
        ['CUTTING', 'IN_PROGRESS'],
        ['PACKAGING', 'WAITING'],
        ['READY', 'WAITING'],
      ]),
    ]);
    expect(p.steps.map((s) => s.code)).toEqual([
      'PREPARING_MATERIALS',
      'PATTERN_AND_CUTTING',
      'DECORATION',
      'SEWING',
      'QUALITY_CHECK',
      'PACKAGING',
      'READY_FOR_SHIPMENT',
    ]);
    expect(p.phase).toBe('IN_PROGRESS');
    expect(p.steps[0]?.state).toBe('DONE');
    expect(p.steps[1]?.state).toBe('ACTIVE');
  });

  it('aggregates several batch jobs without exposing batches', () => {
    const p = projectOrderProduction([
      job('COMPLETED', [
        ['CUTTING', 'COMPLETED'],
        ['SEWING', 'COMPLETED'],
      ]),
      job('IN_PROGRESS', [
        ['CUTTING', 'COMPLETED'],
        ['SEWING', 'IN_PROGRESS'],
      ]),
    ]);
    const state = Object.fromEntries(p.steps.map((s) => [s.code, s.state]));
    expect(state.PATTERN_AND_CUTTING).toBe('DONE');
    // one batch is still sewing: the step is not done for the order
    expect(state.SEWING).toBe('ACTIVE');
    expect(p.phase).toBe('IN_PROGRESS');
  });

  it('ignores cancelled jobs and superseded attempts; complete when every live job is', () => {
    const p = projectOrderProduction([
      job('CANCELLED', [['CUTTING', 'IN_PROGRESS']]),
      {
        status: 'COMPLETED',
        stages: [
          { stageCode: 'CUTTING', status: 'FAILED', superseded: true },
          { stageCode: 'CUTTING', status: 'COMPLETED', superseded: false },
        ],
      },
    ]);
    expect(p.phase).toBe('COMPLETE');
    expect(p.steps.every((s) => s.state === 'DONE')).toBe(true);
  });

  it('never leaks blocked or failed as such and exposes only codes, labels and states', () => {
    const p = projectOrderProduction([
      job('IN_PROGRESS', [
        ['SEWING', 'BLOCKED'],
        ['QC_GATE_2', 'FAILED'],
      ]),
    ]);
    expect(JSON.stringify(p)).not.toMatch(/BLOCK|FAIL|rework|QC_GATE/i);
    for (const s of p.steps)
      expect(Object.keys(s).sort()).toEqual(['code', 'label', 'state']);
  });
});

describe('customer ETA wording', () => {
  it('is empty without an estimate', () => {
    expect(etaView(null, 'HIGH')).toBeNull();
  });
  it('calls a reliable estimate "estimated" and everything else "approximate"', () => {
    const d = new Date(2026, 5, 1);
    expect(etaView(d, 'HIGH')?.confidence).toBe('ESTIMATED');
    expect(etaView(d, 'MEDIUM')?.confidence).toBe('APPROXIMATE');
    expect(etaView(d, 'LOW')?.confidence).toBe('APPROXIMATE');
    expect(JSON.stringify(etaView(d, 'LOW'))).not.toMatch(
      /LOW|quality|samples/i,
    );
  });
});
