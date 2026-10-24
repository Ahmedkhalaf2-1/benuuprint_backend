import type { SampleStatus } from '../../generated/prisma/client.js';

/**
 * The sample lifecycle as data. Status is never written directly: every change
 * is a named action validated against this table (and applied compare-and-set
 * in SampleTransitionsService). Actions marked SYSTEM are consequences of other
 * records (a quotation sent/accepted, a payment verified, an approval recorded)
 * and are not exposed as endpoints.
 */
export const SAMPLE_ACTIONS = [
  'submit',
  'start-review',
  'request-changes',
  'quote-sent',
  'quote-accepted',
  'quote-rejected',
  'payment-covered',
  'start-production',
  'finish-production',
  'sample-approved',
  'sample-rejected',
  'complete',
  'hold',
  'resume',
  'reject',
  'cancel',
] as const;

export type SampleAction = (typeof SAMPLE_ACTIONS)[number];

export interface TransitionRule {
  from: readonly SampleStatus[];
  /** 'PREVIOUS' resumes the status stored when the sample was put on hold. */
  to: SampleStatus | 'PREVIOUS';
  reasonRequired: boolean;
  origin: 'STAFF' | 'SYSTEM';
}

const IN_FLIGHT: readonly SampleStatus[] = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'QUOTED',
  'AWAITING_PAYMENT',
  'READY_FOR_PRODUCTION',
  'IN_PRODUCTION',
  'AWAITING_APPROVAL',
];

export const SAMPLE_TRANSITIONS: Record<SampleAction, TransitionRule> = {
  submit: {
    from: ['DRAFT'],
    to: 'SUBMITTED',
    reasonRequired: false,
    origin: 'STAFF',
  },
  'start-review': {
    from: ['SUBMITTED'],
    to: 'UNDER_REVIEW',
    reasonRequired: false,
    origin: 'STAFF',
  },
  'request-changes': {
    from: ['SUBMITTED', 'UNDER_REVIEW'],
    to: 'DRAFT',
    reasonRequired: true,
    origin: 'STAFF',
  },
  'quote-sent': {
    from: ['UNDER_REVIEW'],
    to: 'QUOTED',
    reasonRequired: false,
    origin: 'SYSTEM',
  },
  'quote-accepted': {
    from: ['QUOTED'],
    to: 'AWAITING_PAYMENT',
    reasonRequired: false,
    origin: 'SYSTEM',
  },
  'quote-rejected': {
    from: ['QUOTED'],
    to: 'UNDER_REVIEW',
    reasonRequired: false,
    origin: 'SYSTEM',
  },
  'payment-covered': {
    from: ['AWAITING_PAYMENT'],
    to: 'READY_FOR_PRODUCTION',
    reasonRequired: false,
    origin: 'SYSTEM',
  },
  // Phase 4 (factory jobs) will drive these two; until then staff can record them.
  'start-production': {
    from: ['READY_FOR_PRODUCTION'],
    to: 'IN_PRODUCTION',
    reasonRequired: false,
    origin: 'STAFF',
  },
  'finish-production': {
    from: ['IN_PRODUCTION'],
    to: 'AWAITING_APPROVAL',
    reasonRequired: false,
    origin: 'STAFF',
  },
  'sample-approved': {
    from: ['AWAITING_APPROVAL'],
    to: 'APPROVED',
    reasonRequired: false,
    origin: 'SYSTEM',
  },
  'sample-rejected': {
    from: ['AWAITING_APPROVAL'],
    to: 'IN_PRODUCTION',
    reasonRequired: true,
    origin: 'SYSTEM',
  },
  complete: {
    from: ['APPROVED'],
    to: 'COMPLETED',
    reasonRequired: false,
    origin: 'STAFF',
  },
  hold: {
    from: IN_FLIGHT,
    to: 'ON_HOLD',
    reasonRequired: true,
    origin: 'STAFF',
  },
  resume: {
    from: ['ON_HOLD'],
    to: 'PREVIOUS',
    reasonRequired: false,
    origin: 'STAFF',
  },
  reject: {
    from: [
      'SUBMITTED',
      'UNDER_REVIEW',
      'QUOTED',
      'AWAITING_PAYMENT',
      'ON_HOLD',
    ],
    to: 'REJECTED',
    reasonRequired: true,
    origin: 'STAFF',
  },
  cancel: {
    from: [
      'DRAFT',
      'SUBMITTED',
      'UNDER_REVIEW',
      'QUOTED',
      'AWAITING_PAYMENT',
      'READY_FOR_PRODUCTION',
      'ON_HOLD',
    ],
    to: 'CANCELLED',
    reasonRequired: true,
    origin: 'STAFF',
  },
};

export const TERMINAL_STATUSES: readonly SampleStatus[] = [
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
];

export type TransitionCheck =
  | { ok: true; to: SampleStatus }
  | { ok: false; reason: 'NOT_ALLOWED' | 'NO_PREVIOUS_STATUS' };

export function checkTransition(
  action: SampleAction,
  current: SampleStatus,
  holdPreviousStatus: SampleStatus | null,
): TransitionCheck {
  const rule = SAMPLE_TRANSITIONS[action];
  if (!rule.from.includes(current)) return { ok: false, reason: 'NOT_ALLOWED' };
  if (rule.to === 'PREVIOUS') {
    return holdPreviousStatus
      ? { ok: true, to: holdPreviousStatus }
      : { ok: false, reason: 'NO_PREVIOUS_STATUS' };
  }
  return { ok: true, to: rule.to };
}

/** Staff-triggerable actions available from a status (for UIs and API responses). */
export function allowedStaffActions(status: SampleStatus): SampleAction[] {
  return SAMPLE_ACTIONS.filter((action) => {
    const rule = SAMPLE_TRANSITIONS[action];
    return rule.origin === 'STAFF' && rule.from.includes(status);
  });
}

/** Only a DRAFT's specification can be edited. */
export const isSpecEditable = (status: SampleStatus): boolean =>
  status === 'DRAFT';

/** Free-text instruction fields stay editable while staff are still reviewing. */
export const areNotesEditable = (status: SampleStatus): boolean =>
  status === 'DRAFT' || status === 'SUBMITTED' || status === 'UNDER_REVIEW';

/** Statuses in which a sample can still be revised by cloning (everything after DRAFT). */
export const isRevisable = (status: SampleStatus): boolean =>
  status !== 'DRAFT';
