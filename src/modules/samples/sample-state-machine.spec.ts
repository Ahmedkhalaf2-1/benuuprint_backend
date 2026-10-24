import {
  SAMPLE_ACTIONS,
  SAMPLE_TRANSITIONS,
  TERMINAL_STATUSES,
  allowedStaffActions,
  areNotesEditable,
  checkTransition,
  isSpecEditable,
  type SampleAction,
} from './sample-state-machine.js';
import type { SampleStatus } from '../../generated/prisma/client.js';

const ALL_STATUSES: SampleStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'QUOTED',
  'AWAITING_PAYMENT',
  'READY_FOR_PRODUCTION',
  'IN_PRODUCTION',
  'AWAITING_APPROVAL',
  'APPROVED',
  'COMPLETED',
  'ON_HOLD',
  'REJECTED',
  'CANCELLED',
];

describe('sample state machine', () => {
  it('walks the happy path DRAFT → … → COMPLETED', () => {
    const path: [SampleAction, SampleStatus][] = [
      ['submit', 'SUBMITTED'],
      ['start-review', 'UNDER_REVIEW'],
      ['quote-sent', 'QUOTED'],
      ['quote-accepted', 'AWAITING_PAYMENT'],
      ['payment-covered', 'READY_FOR_PRODUCTION'],
      ['start-production', 'IN_PRODUCTION'],
      ['finish-production', 'AWAITING_APPROVAL'],
      ['sample-approved', 'APPROVED'],
      ['complete', 'COMPLETED'],
    ];
    let status: SampleStatus = 'DRAFT';
    for (const [action, expected] of path) {
      const result = checkTransition(action, status, null);
      expect(result).toEqual({ ok: true, to: expected });
      status = expected;
    }
  });

  it('only allows each action from its declared source statuses', () => {
    for (const action of SAMPLE_ACTIONS) {
      const rule = SAMPLE_TRANSITIONS[action];
      for (const status of ALL_STATUSES) {
        const result = checkTransition(action, status, 'QUOTED');
        expect(result.ok).toBe(rule.from.includes(status));
      }
    }
  });

  it('never leaves a terminal status', () => {
    for (const terminal of TERMINAL_STATUSES) {
      for (const action of SAMPLE_ACTIONS) {
        expect(checkTransition(action, terminal, 'QUOTED').ok).toBe(false);
      }
      expect(allowedStaffActions(terminal)).toEqual([]);
    }
  });

  it('cannot skip steps or go backwards arbitrarily', () => {
    expect(checkTransition('start-review', 'DRAFT', null).ok).toBe(false);
    expect(checkTransition('quote-accepted', 'UNDER_REVIEW', null).ok).toBe(
      false,
    );
    expect(checkTransition('payment-covered', 'QUOTED', null).ok).toBe(false);
    expect(checkTransition('sample-approved', 'IN_PRODUCTION', null).ok).toBe(
      false,
    );
    expect(checkTransition('submit', 'SUBMITTED', null).ok).toBe(false);
    expect(checkTransition('complete', 'AWAITING_APPROVAL', null).ok).toBe(
      false,
    );
  });

  it('holds from in-flight states and resumes to the stored previous status', () => {
    for (const status of [
      'SUBMITTED',
      'UNDER_REVIEW',
      'QUOTED',
      'AWAITING_PAYMENT',
      'READY_FOR_PRODUCTION',
      'IN_PRODUCTION',
      'AWAITING_APPROVAL',
    ] as const) {
      expect(checkTransition('hold', status, null)).toEqual({
        ok: true,
        to: 'ON_HOLD',
      });
      expect(checkTransition('resume', 'ON_HOLD', status)).toEqual({
        ok: true,
        to: status,
      });
    }
    expect(checkTransition('hold', 'DRAFT', null).ok).toBe(false);
    expect(checkTransition('hold', 'APPROVED', null).ok).toBe(false);
    expect(checkTransition('hold', 'ON_HOLD', 'QUOTED').ok).toBe(false);
    expect(checkTransition('resume', 'ON_HOLD', null)).toEqual({
      ok: false,
      reason: 'NO_PREVIOUS_STATUS',
    });
    expect(checkTransition('resume', 'QUOTED', null).ok).toBe(false);
  });

  it('allows reject and cancel only where the business allows them', () => {
    expect(checkTransition('reject', 'UNDER_REVIEW', null).ok).toBe(true);
    expect(checkTransition('reject', 'ON_HOLD', 'QUOTED').ok).toBe(true);
    expect(checkTransition('reject', 'DRAFT', null).ok).toBe(false);
    expect(checkTransition('reject', 'IN_PRODUCTION', null).ok).toBe(false);
    expect(checkTransition('cancel', 'DRAFT', null).ok).toBe(true);
    expect(checkTransition('cancel', 'READY_FOR_PRODUCTION', null).ok).toBe(
      true,
    );
    expect(checkTransition('cancel', 'IN_PRODUCTION', null).ok).toBe(false); // hold first, then cancel
    expect(checkTransition('cancel', 'ON_HOLD', 'IN_PRODUCTION').ok).toBe(true);
    expect(checkTransition('cancel', 'APPROVED', null).ok).toBe(false);
  });

  it('requires a reason for every destructive or backwards action', () => {
    const required = SAMPLE_ACTIONS.filter(
      (a) => SAMPLE_TRANSITIONS[a].reasonRequired,
    ).sort();
    expect(required).toEqual(
      ['cancel', 'hold', 'reject', 'request-changes', 'sample-rejected'].sort(),
    );
  });

  it('keeps commercial consequences system-only', () => {
    for (const action of [
      'quote-sent',
      'quote-accepted',
      'quote-rejected',
      'payment-covered',
      'sample-approved',
      'sample-rejected',
    ] as const) {
      expect(SAMPLE_TRANSITIONS[action].origin).toBe('SYSTEM');
    }
    const staff = allowedStaffActions('UNDER_REVIEW');
    expect(staff).toEqual(
      expect.arrayContaining(['request-changes', 'hold', 'reject', 'cancel']),
    );
    expect(staff).not.toContain('quote-sent');
  });

  it('exposes the right staff actions per status', () => {
    expect(allowedStaffActions('DRAFT')).toEqual(['submit', 'cancel']);
    expect(allowedStaffActions('APPROVED')).toEqual(['complete']);
    expect(allowedStaffActions('ON_HOLD')).toEqual([
      'resume',
      'reject',
      'cancel',
    ]);
  });

  it('locks the specification after DRAFT but keeps notes editable during review', () => {
    expect(isSpecEditable('DRAFT')).toBe(true);
    for (const s of ALL_STATUSES.filter((x) => x !== 'DRAFT'))
      expect(isSpecEditable(s)).toBe(false);
    expect(areNotesEditable('SUBMITTED')).toBe(true);
    expect(areNotesEditable('UNDER_REVIEW')).toBe(true);
    expect(areNotesEditable('QUOTED')).toBe(false);
    expect(areNotesEditable('APPROVED')).toBe(false);
  });
});
