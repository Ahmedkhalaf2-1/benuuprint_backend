import type { SampleStatus } from '../../../generated/prisma/client.js';

/**
 * What a customer sees instead of the internal sample workflow. Derived from SampleStatus (no
 * second state machine, no new enum): the internal status stays the single source of truth.
 */
export const CUSTOMER_SAMPLE_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'QUOTATION_READY',
  'PAYMENT_REQUIRED',
  'PAYMENT_UNDER_REVIEW',
  'IN_SAMPLE_PRODUCTION',
  'REVISION_REQUESTED',
  'AWAITING_CUSTOMER_APPROVAL',
  'APPROVED',
  'CHANGES_REQUESTED',
  'CANCELLED',
] as const;

export type CustomerSampleStatus = (typeof CUSTOMER_SAMPLE_STATUSES)[number];

/** Internal statuses behind each customer status (ON_HOLD follows the status it interrupted). */
export const INTERNAL_STATUSES_FOR: Record<
  CustomerSampleStatus,
  readonly SampleStatus[]
> = {
  DRAFT: ['DRAFT'],
  SUBMITTED: ['SUBMITTED'],
  UNDER_REVIEW: ['UNDER_REVIEW'],
  QUOTATION_READY: ['QUOTED'],
  PAYMENT_REQUIRED: ['AWAITING_PAYMENT'],
  // internally still AWAITING_PAYMENT, with a payment waiting for staff review
  PAYMENT_UNDER_REVIEW: ['AWAITING_PAYMENT'],
  IN_SAMPLE_PRODUCTION: ['READY_FOR_PRODUCTION', 'IN_PRODUCTION'],
  // the customer sent the finished sample back: IN_PRODUCTION with a rejected SAMPLE approval and no live job yet
  REVISION_REQUESTED: ['IN_PRODUCTION'],
  AWAITING_CUSTOMER_APPROVAL: ['AWAITING_APPROVAL'],
  APPROVED: ['APPROVED', 'COMPLETED'],
  // staff returned the request to the customer: internally a DRAFT that has a request-changes history row
  CHANGES_REQUESTED: ['DRAFT'],
  CANCELLED: ['CANCELLED', 'REJECTED'],
};

/** Statuses that refine another one using extra facts (history, payments, approvals), not the status alone. */
export const DERIVED_STATUSES: readonly CustomerSampleStatus[] = [
  'CHANGES_REQUESTED',
  'PAYMENT_UNDER_REVIEW',
  'REVISION_REQUESTED',
];

const INTERNAL_TO_CUSTOMER: Partial<
  Record<SampleStatus, CustomerSampleStatus>
> = {};
for (const status of CUSTOMER_SAMPLE_STATUSES) {
  if (DERIVED_STATUSES.includes(status)) continue;
  for (const internal of INTERNAL_STATUSES_FOR[status])
    INTERNAL_TO_CUSTOMER[internal] = status;
}

export interface StatusSource {
  status: SampleStatus;
  /** The status an ON_HOLD sample returns to; a hold is not shown to the customer. */
  holdPreviousStatus: SampleStatus | null;
  /** A request-changes transition exists in the sample's history. */
  changesRequested: boolean;
  /** A payment of the sample is waiting for staff review (SUBMITTED / UNDER_REVIEW). */
  pendingPayment?: boolean;
  /** The customer rejected the finished sample and staff have not started a new production job yet. */
  revisionRequested?: boolean;
}

export function toCustomerStatus(s: StatusSource): CustomerSampleStatus {
  const effective =
    s.status === 'ON_HOLD'
      ? (s.holdPreviousStatus ?? 'UNDER_REVIEW')
      : s.status;
  if (effective === 'DRAFT' && s.changesRequested) return 'CHANGES_REQUESTED';
  if (effective === 'AWAITING_PAYMENT' && s.pendingPayment)
    return 'PAYMENT_UNDER_REVIEW';
  if (effective === 'IN_PRODUCTION' && s.revisionRequested)
    return 'REVISION_REQUESTED';
  return INTERNAL_TO_CUSTOMER[effective] ?? 'UNDER_REVIEW';
}

/** Only a draft (including one returned for changes) can be edited or submitted by the customer. */
export const isCustomerEditable = (status: SampleStatus): boolean =>
  status === 'DRAFT';

export const NEXT_STEP: Record<CustomerSampleStatus, string> = {
  DRAFT:
    'Complete your request, accept the terms and submit it when you are ready.',
  SUBMITTED: 'Our team is reviewing your request.',
  UNDER_REVIEW: 'Our team is reviewing your request.',
  QUOTATION_READY: 'Review your quotation.',
  PAYMENT_REQUIRED: 'Payment is required.',
  PAYMENT_UNDER_REVIEW: 'Your payment proof is being reviewed.',
  IN_SAMPLE_PRODUCTION: 'Your sample is being produced.',
  AWAITING_CUSTOMER_APPROVAL: 'Review your completed sample.',
  APPROVED: 'Your sample is approved and can be used for bulk production.',
  CHANGES_REQUESTED:
    'Our team asked for changes. Update your request and submit it again.',
  REVISION_REQUESTED: 'Our team will review your requested changes.',
  CANCELLED: 'This request is closed.',
};

export const STATUS_LABEL: Record<CustomerSampleStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  QUOTATION_READY: 'Quotation ready',
  PAYMENT_REQUIRED: 'Payment required',
  PAYMENT_UNDER_REVIEW: 'Payment under review',
  IN_SAMPLE_PRODUCTION: 'In sample production',
  AWAITING_CUSTOMER_APPROVAL: 'Awaiting your approval',
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes requested',
  REVISION_REQUESTED: 'Revision in progress',
  CANCELLED: 'Closed',
};

export interface HistoryRow {
  action: string;
  fromStatus: SampleStatus | null;
  toStatus: SampleStatus;
  reason: string | null;
  createdAt: Date;
}

export interface CustomerActivityEvent {
  at: Date;
  kind: 'STATUS' | 'PAYMENT';
  /** The customer status after the event; null for events that do not change it (payment steps). */
  status: CustomerSampleStatus | null;
  title: string;
  /** Only text addressed to / written by the customer; never an internal reason. */
  message: string | null;
}

/** Titles of the commercial and production steps (system and staff transitions the customer can follow). */
const ACTION_TITLE: Record<string, string> = {
  create: 'Request created',
  'create-revision': 'Revision created',
  'quote-sent': 'Quotation ready',
  'quote-accepted': 'Quotation accepted',
  'quote-rejected': 'Quotation declined',
  'payment-covered': 'Payment complete',
  'start-production': 'Sample production started',
  'finish-production': 'Sample ready',
  'sample-approved': 'Sample approved',
  'sample-rejected': 'Changes requested',
};
/** These matter to the customer even though the customer status label stays the same. */
const ALWAYS_SHOWN = new Set(['create', 'start-production', 'sample-rejected']);

/**
 * The customer-safe timeline: one event per change the customer can tell apart. Holds, resumes and
 * other transitions that do not change the customer status are dropped; internal reasons are never
 * copied except the message of a request for changes (addressed to the customer) and the customer's own
 * note when they sent a finished sample back.
 */
export function projectActivity(rows: HistoryRow[]): CustomerActivityEvent[] {
  const out: CustomerActivityEvent[] = [];
  for (const row of rows) {
    const revision = row.action === 'sample-rejected';
    const after: CustomerSampleStatus = revision
      ? 'REVISION_REQUESTED'
      : toCustomerStatus({
          status: row.toStatus,
          holdPreviousStatus:
            row.toStatus === 'ON_HOLD' ? row.fromStatus : null,
          changesRequested: row.action === 'request-changes',
        });
    const before = row.fromStatus
      ? toCustomerStatus({
          status: row.fromStatus,
          holdPreviousStatus: null,
          changesRequested: false,
        })
      : null;
    if (before === after && !ALWAYS_SHOWN.has(row.action)) continue;
    const showMessage =
      (row.action === 'request-changes' || revision) && row.reason?.trim();
    out.push({
      at: row.createdAt,
      kind: 'STATUS',
      status: after,
      title: ACTION_TITLE[row.action] ?? STATUS_LABEL[after],
      message: showMessage ? row.reason!.trim() : null,
    });
  }
  return out;
}

export interface PaymentEventRow {
  status: string;
  createdAt: Date;
  verifiedAt: Date | null;
  updatedAt: Date;
  customerMessage: string | null;
}

/** Payment steps of the customer's own payments; the internal rejection reason is never used. */
export function projectPaymentEvents(
  payments: PaymentEventRow[],
): CustomerActivityEvent[] {
  const out: CustomerActivityEvent[] = [];
  for (const p of payments) {
    out.push({
      at: p.createdAt,
      kind: 'PAYMENT',
      status: null,
      title: 'Payment proof submitted',
      message: null,
    });
    if (p.status === 'VERIFIED' && p.verifiedAt)
      out.push({
        at: p.verifiedAt,
        kind: 'PAYMENT',
        status: null,
        title: 'Payment verified',
        message: null,
      });
    if (p.status === 'REJECTED')
      out.push({
        at: p.updatedAt,
        kind: 'PAYMENT',
        status: null,
        title: 'Payment could not be verified',
        message: p.customerMessage?.trim() || null,
      });
  }
  return out;
}

export const byTime = (a: { at: Date }, b: { at: Date }): number =>
  a.at.getTime() - b.at.getTime();
