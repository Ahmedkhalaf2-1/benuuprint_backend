import {
  CUSTOMER_SAMPLE_STATUSES,
  DERIVED_STATUSES,
  INTERNAL_STATUSES_FOR,
  isCustomerEditable,
  projectActivity,
  projectPaymentEvents,
  toCustomerStatus,
  type HistoryRow,
} from './customer-sample-status.js';
import type { SampleStatus } from '../../../generated/prisma/client.js';

const base = (status: SampleStatus) => ({
  status,
  holdPreviousStatus: null,
  changesRequested: false,
});

describe('customer sample status projection', () => {
  it('maps every internal status to a customer status', () => {
    const all: SampleStatus[] = [
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
    for (const s of all) {
      expect(CUSTOMER_SAMPLE_STATUSES).toContain(toCustomerStatus(base(s)));
    }
    expect(toCustomerStatus(base('QUOTED'))).toBe('QUOTATION_READY');
    expect(toCustomerStatus(base('AWAITING_PAYMENT'))).toBe('PAYMENT_REQUIRED');
    expect(toCustomerStatus(base('READY_FOR_PRODUCTION'))).toBe(
      'IN_SAMPLE_PRODUCTION',
    );
    expect(toCustomerStatus(base('REJECTED'))).toBe('CANCELLED');
    expect(toCustomerStatus(base('COMPLETED'))).toBe('APPROVED');
  });

  it('hides a hold: the customer sees the status that was interrupted', () => {
    expect(
      toCustomerStatus({
        status: 'ON_HOLD',
        holdPreviousStatus: 'IN_PRODUCTION',
        changesRequested: false,
      }),
    ).toBe('IN_SAMPLE_PRODUCTION');
  });

  it('shows a draft returned by staff as CHANGES_REQUESTED', () => {
    expect(toCustomerStatus({ ...base('DRAFT'), changesRequested: true })).toBe(
      'CHANGES_REQUESTED',
    );
    expect(toCustomerStatus(base('DRAFT'))).toBe('DRAFT');
  });

  it('lists the internal statuses behind each customer status exactly once', () => {
    const seen = Object.entries(INTERNAL_STATUSES_FOR)
      .filter(([k]) => !(DERIVED_STATUSES as readonly string[]).includes(k))
      .flatMap(([, v]) => v);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('allows customer edits only on drafts', () => {
    expect(isCustomerEditable('DRAFT')).toBe(true);
    expect(isCustomerEditable('SUBMITTED')).toBe(false);
    expect(isCustomerEditable('ON_HOLD')).toBe(false);
  });

  it('builds a customer-safe timeline without internal reasons', () => {
    const t = (n: number) => new Date(2026, 0, n);
    const rows: HistoryRow[] = [
      {
        action: 'create',
        fromStatus: null,
        toStatus: 'DRAFT',
        reason: null,
        createdAt: t(1),
      },
      {
        action: 'submit',
        fromStatus: 'DRAFT',
        toStatus: 'SUBMITTED',
        reason: null,
        createdAt: t(2),
      },
      {
        action: 'start-review',
        fromStatus: 'SUBMITTED',
        toStatus: 'UNDER_REVIEW',
        reason: null,
        createdAt: t(3),
      },
      {
        action: 'hold',
        fromStatus: 'UNDER_REVIEW',
        toStatus: 'ON_HOLD',
        reason: 'INTERNAL: supplier issue',
        createdAt: t(4),
      },
      {
        action: 'resume',
        fromStatus: 'ON_HOLD',
        toStatus: 'UNDER_REVIEW',
        reason: null,
        createdAt: t(5),
      },
      {
        action: 'request-changes',
        fromStatus: 'UNDER_REVIEW',
        toStatus: 'DRAFT',
        reason: 'Please upload a vector logo',
        createdAt: t(6),
      },
    ];
    const events = projectActivity(rows);
    expect(events.map((e) => e.status)).toEqual([
      'DRAFT',
      'SUBMITTED',
      'UNDER_REVIEW',
      'CHANGES_REQUESTED',
    ]);
    expect(JSON.stringify(events)).not.toContain('supplier');
    expect(events.at(-1)?.message).toBe('Please upload a vector logo');
    expect(events[0]?.message).toBeNull();
  });

  it('derives payment-under-review and revision-requested from facts', () => {
    expect(
      toCustomerStatus({ ...base('AWAITING_PAYMENT'), pendingPayment: true }),
    ).toBe('PAYMENT_UNDER_REVIEW');
    expect(toCustomerStatus(base('AWAITING_PAYMENT'))).toBe('PAYMENT_REQUIRED');
    expect(
      toCustomerStatus({ ...base('IN_PRODUCTION'), revisionRequested: true }),
    ).toBe('REVISION_REQUESTED');
    expect(toCustomerStatus(base('IN_PRODUCTION'))).toBe(
      'IN_SAMPLE_PRODUCTION',
    );
    // a pending payment only matters while payment is what we wait for
    expect(
      toCustomerStatus({ ...base('IN_PRODUCTION'), pendingPayment: true }),
    ).toBe('IN_SAMPLE_PRODUCTION');
  });

  it('shows the commercial and approval steps with customer titles', () => {
    const t = (n: number) => new Date(2026, 0, n);
    const row = (
      action: string,
      fromStatus: HistoryRow['fromStatus'],
      toStatus: HistoryRow['toStatus'],
      reason: string | null = null,
      n = 1,
    ): HistoryRow => ({
      action,
      fromStatus,
      toStatus,
      reason,
      createdAt: t(n),
    });
    const events = projectActivity([
      row('quote-sent', 'UNDER_REVIEW', 'QUOTED', null, 1),
      row('quote-accepted', 'QUOTED', 'AWAITING_PAYMENT', null, 2),
      row(
        'payment-covered',
        'AWAITING_PAYMENT',
        'READY_FOR_PRODUCTION',
        null,
        3,
      ),
      row('start-production', 'READY_FOR_PRODUCTION', 'IN_PRODUCTION', null, 4),
      row('finish-production', 'IN_PRODUCTION', 'AWAITING_APPROVAL', null, 5),
      row(
        'sample-rejected',
        'AWAITING_APPROVAL',
        'IN_PRODUCTION',
        'Sleeves too long',
        6,
      ),
    ]);
    expect(events.map((e) => e.title)).toEqual([
      'Quotation ready',
      'Quotation accepted',
      'Payment complete',
      'Sample production started',
      'Sample ready',
      'Changes requested',
    ]);
    expect(events.at(-1)).toMatchObject({
      status: 'REVISION_REQUESTED',
      message: 'Sleeves too long',
    });
  });

  it('builds payment steps from the customer-safe fields only', () => {
    const t = (n: number) => new Date(2026, 0, n);
    const events = projectPaymentEvents([
      {
        status: 'REJECTED',
        createdAt: t(1),
        verifiedAt: null,
        updatedAt: t(2),
        customerMessage: 'The receipt is blurry',
      },
      {
        status: 'VERIFIED',
        createdAt: t(3),
        verifiedAt: t(4),
        updatedAt: t(4),
        customerMessage: null,
      },
    ]);
    expect(events.map((e) => e.title)).toEqual([
      'Payment proof submitted',
      'Payment could not be verified',
      'Payment proof submitted',
      'Payment verified',
    ]);
    expect(events[1]?.message).toBe('The receipt is blurry');
    expect(events.every((e) => e.kind === 'PAYMENT' && e.status === null)).toBe(
      true,
    );
  });
});
