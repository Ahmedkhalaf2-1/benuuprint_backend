import { OrderStatus, SampleStatus } from '../../../generated/prisma/client.js';
import {
  ATTENTION_TYPES,
  BASE_SCORE,
  attentionScore,
  compareAttention,
  severityFor,
} from './attention.js';
import { ORDER_PIPELINE, SAMPLE_PIPELINE, groupCounts } from './pipeline.js';

describe('needs-attention ranking', () => {
  it('every type has a base score', () => {
    for (const t of ATTENTION_TYPES) expect(BASE_SCORE[t]).toBeGreaterThan(0);
  });
  it('priority, overdue days and age add up (documented formula)', () => {
    expect(attentionScore({ type: 'BLOCKED_STAGE' })).toBe(700);
    expect(attentionScore({ type: 'BLOCKED_STAGE', priority: 'URGENT' })).toBe(
      900,
    );
    expect(
      attentionScore({
        type: 'OVERDUE_ORDER',
        priority: 'HIGH',
        overdueMinutes: 5 * 1440,
      }),
    ).toBe(650 + 100 + 50);
    expect(attentionScore({ type: 'OPEN_REWORK', ageMinutes: 3 * 1440 })).toBe(
      450 + 15,
    );
  });
  it('caps overdue days at 30 and age at 14 days', () => {
    expect(
      attentionScore({ type: 'OVERDUE_JOB', overdueMinutes: 400 * 1440 }),
    ).toBe(600 + 300);
    expect(
      attentionScore({ type: 'OPEN_REWORK', ageMinutes: 400 * 1440 }),
    ).toBe(450 + 70);
  });
  it('an approaching deadline gets more urgent as it nears', () => {
    const far = attentionScore({
      type: 'APPROACHING_DEADLINE',
      minutesLeft: 47 * 60,
      windowMinutes: 48 * 60,
    });
    const near = attentionScore({
      type: 'APPROACHING_DEADLINE',
      minutesLeft: 60,
      windowMinutes: 48 * 60,
    });
    expect(near).toBeGreaterThan(far);
    expect(near).toBeLessThanOrEqual(200 + 48);
  });
  it('severity thresholds', () => {
    expect(severityFor(800)).toBe('CRITICAL');
    expect(severityFor(799)).toBe('WARNING');
    expect(severityFor(450)).toBe('WARNING');
    expect(severityFor(449)).toBe('INFO');
  });
  it('failures and blocks outrank soft signals; ties are stable', () => {
    const failed = {
      score: attentionScore({ type: 'SHIPMENT_FAILED' }),
      dueAt: null,
      entityId: 'x',
    };
    const unassigned = {
      score: attentionScore({ type: 'UNASSIGNED_READY_STAGE' }),
      dueAt: null,
      entityId: 'y',
    };
    expect(compareAttention(failed, unassigned)).toBeLessThan(0);
    const early = { score: 500, dueAt: new Date(1), entityId: 'b' };
    const late = { score: 500, dueAt: new Date(2), entityId: 'a' };
    expect(compareAttention(early, late)).toBeLessThan(0);
    expect(
      compareAttention(
        { ...early, dueAt: null, entityId: 'a' },
        { ...early, dueAt: null, entityId: 'b' },
      ),
    ).toBeLessThan(0);
  });
});

describe('pipelines', () => {
  it('place every sample and order status in exactly one group', () => {
    const flat = (g: Record<string, readonly string[]>) =>
      Object.values(g).flat();
    expect(flat(SAMPLE_PIPELINE).sort()).toEqual(
      Object.values(SampleStatus).sort(),
    );
    expect(flat(ORDER_PIPELINE).sort()).toEqual(
      Object.values(OrderStatus).sort(),
    );
  });
  it('sums counts per group', () => {
    const counts = groupCounts(
      ORDER_PIPELINE,
      new Map([
        ['IN_PRODUCTION', 2],
        ['PACKAGING', 3],
        ['READY_FOR_PACKAGING', 1],
      ] as [OrderStatus, number][]),
    );
    expect(counts.production).toBe(2);
    expect(counts.packaging).toBe(4);
    expect(counts.cancelled).toBe(0);
  });
});
