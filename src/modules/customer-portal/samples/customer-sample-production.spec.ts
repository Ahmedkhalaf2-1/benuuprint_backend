import {
  projectProduction,
  type StageFact,
} from './customer-sample-production.js';

const st = (
  stageCode: string,
  status: string,
  superseded = false,
): StageFact => ({ stageCode, status, superseded });

describe('customer production projection', () => {
  it('has not started without a job or without any progress', () => {
    expect(projectProduction(null, []).phase).toBe('NOT_STARTED');
    const p = projectProduction('IN_PROGRESS', [
      st('FABRIC_PREPARATION', 'READY'),
      st('PATTERN_MAKING', 'WAITING'),
    ]);
    expect(p.phase).toBe('NOT_STARTED');
    expect(p.steps.every((s) => s.state === 'PENDING')).toBe(true);
  });

  it('groups internal stages into six customer steps', () => {
    const p = projectProduction('IN_PROGRESS', [
      st('FABRIC_PREPARATION', 'COMPLETED'),
      st('PATTERN_MAKING', 'COMPLETED'),
      st('CUTTING', 'IN_PROGRESS'),
      st('QC_GATE_1', 'WAITING'),
      st('PRINTING_EMBROIDERY', 'WAITING'),
    ]);
    expect(p.phase).toBe('IN_PROGRESS');
    const state = Object.fromEntries(p.steps.map((s) => [s.code, s.state]));
    expect(state).toMatchObject({
      PREPARING_MATERIALS: 'DONE',
      PATTERN_AND_CUTTING: 'ACTIVE',
      DECORATION: 'PENDING',
      QUALITY_CHECK: 'PENDING',
    });
    expect(p.steps.map((s) => s.code)).toEqual([
      'PREPARING_MATERIALS',
      'PATTERN_AND_CUTTING',
      'DECORATION',
      'SEWING',
      'QUALITY_CHECK',
      'SAMPLE_READY',
    ]);
  });

  it('shows a blocked or failed stage as plain activity, never as a problem', () => {
    const p = projectProduction('IN_PROGRESS', [
      st('SEWING', 'BLOCKED'),
      st('QC_GATE_2', 'FAILED'),
    ]);
    const state = Object.fromEntries(p.steps.map((s) => [s.code, s.state]));
    expect(state.SEWING).toBe('ACTIVE');
    expect(JSON.stringify(p)).not.toMatch(/BLOCK|FAIL|rework/i);
  });

  it('ignores superseded attempts and is complete when the job is', () => {
    const p = projectProduction('COMPLETED', [
      st('CUTTING', 'FAILED', true),
      st('CUTTING', 'COMPLETED'),
    ]);
    expect(p.phase).toBe('COMPLETE');
    expect(p.steps.every((s) => s.state === 'DONE')).toBe(true);
  });

  it('exposes nothing but codes, labels and states', () => {
    const p = projectProduction('IN_PROGRESS', [st('CUTTING', 'IN_PROGRESS')]);
    for (const step of p.steps)
      expect(Object.keys(step).sort()).toEqual(['code', 'label', 'state']);
  });
});
