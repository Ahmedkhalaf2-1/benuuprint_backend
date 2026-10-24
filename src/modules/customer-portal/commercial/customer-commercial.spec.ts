import {
  allowedActions,
  nextCommercialAction,
  paymentStatus,
  proofState,
  type ActionFacts,
} from './customer-commercial.js';

const facts = (over: Partial<ActionFacts>): ActionFacts => ({
  sampleStatus: 'DRAFT',
  archived: false,
  actionableQuotation: false,
  canSubmitPayment: false,
  sampleApprovable: false,
  termsRequired: true,
  termsAccepted: false,
  ...over,
});

describe('customer payment state', () => {
  it('is not required before a quotation is accepted', () => {
    expect(
      paymentStatus({ acceptedTotal: null, verified: '0.00', pending: '0.00' }),
    ).toEqual({ status: 'NOT_REQUIRED_YET', remaining: null });
  });

  it('asks for payment, then shows review, then paid', () => {
    expect(
      paymentStatus({
        acceptedTotal: '342.00',
        verified: '0.00',
        pending: '0.00',
      }),
    ).toEqual({ status: 'PAYMENT_REQUIRED', remaining: '342.00' });
    expect(
      paymentStatus({
        acceptedTotal: '342.00',
        verified: '100.00',
        pending: '50.00',
      }),
    ).toEqual({ status: 'PAYMENT_UNDER_REVIEW', remaining: '242.00' });
    expect(
      paymentStatus({
        acceptedTotal: '342.00',
        verified: '342.00',
        pending: '0.00',
      }),
    ).toEqual({ status: 'PAID', remaining: '0.00' });
  });

  it('never shows a negative remainder', () => {
    expect(
      paymentStatus({
        acceptedTotal: '10.00',
        verified: '12.00',
        pending: '0.00',
      }).remaining,
    ).toBe('0.00');
  });

  it('projects the staff payment states to customer verification states', () => {
    expect(proofState('SUBMITTED')).toBe('PENDING_VERIFICATION');
    expect(proofState('UNDER_REVIEW')).toBe('PENDING_VERIFICATION');
    expect(proofState('VERIFIED')).toBe('VERIFIED');
    expect(proofState('REJECTED')).toBe('REJECTED');
    expect(proofState('CANCELLED')).toBe('CANCELLED');
  });
});

describe('customer allowed actions', () => {
  it('lets a draft be edited, accepted terms and submitted', () => {
    expect(allowedActions(facts({ sampleStatus: 'DRAFT' }))).toEqual([
      'EDIT_REQUEST',
      'UPLOAD_FILE',
      'ACCEPT_TERMS',
      'SUBMIT_REQUEST',
    ]);
    expect(
      allowedActions(facts({ sampleStatus: 'DRAFT', termsAccepted: true })),
    ).not.toContain('ACCEPT_TERMS');
  });

  it('offers the quotation decision only for an open quotation', () => {
    expect(
      allowedActions(
        facts({ sampleStatus: 'QUOTED', actionableQuotation: true }),
      ),
    ).toEqual(['ACCEPT_QUOTATION', 'REJECT_QUOTATION']);
    expect(allowedActions(facts({ sampleStatus: 'QUOTED' }))).toEqual([]);
  });

  it('offers a payment proof only while money is owed', () => {
    expect(
      allowedActions(
        facts({ sampleStatus: 'AWAITING_PAYMENT', canSubmitPayment: true }),
      ),
    ).toEqual(['UPLOAD_PAYMENT_PROOF']);
    expect(allowedActions(facts({ sampleStatus: 'AWAITING_PAYMENT' }))).toEqual(
      [],
    );
  });

  it('offers approval only for a finished, approvable sample', () => {
    expect(
      allowedActions(
        facts({ sampleStatus: 'AWAITING_APPROVAL', sampleApprovable: true }),
      ),
    ).toEqual(['APPROVE_SAMPLE', 'REQUEST_CHANGES']);
    expect(
      allowedActions(facts({ sampleStatus: 'AWAITING_APPROVAL' })),
    ).toEqual([]);
  });

  it('offers nothing in later or unrelated states, or when archived', () => {
    for (const s of ['IN_PRODUCTION', 'APPROVED', 'ON_HOLD', 'REJECTED'])
      expect(allowedActions(facts({ sampleStatus: s }))).toEqual([]);
    expect(
      allowedActions(facts({ sampleStatus: 'DRAFT', archived: true })),
    ).toEqual([]);
  });

  it('names the single next commercial action', () => {
    expect(nextCommercialAction(['ACCEPT_QUOTATION', 'REJECT_QUOTATION'])).toBe(
      'REVIEW_QUOTATION',
    );
    expect(nextCommercialAction(['UPLOAD_PAYMENT_PROOF'])).toBe('PAY');
    expect(nextCommercialAction(['APPROVE_SAMPLE', 'REQUEST_CHANGES'])).toBe(
      'REVIEW_SAMPLE',
    );
    expect(nextCommercialAction([])).toBe('NONE');
  });
});
