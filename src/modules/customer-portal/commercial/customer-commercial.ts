import { D, ZERO, fmt } from '../../commercial/money.js';

/** What the signed-in customer can do with a request right now (computed on the server). */
export const CUSTOMER_ACTIONS = [
  'EDIT_REQUEST',
  'UPLOAD_FILE',
  'ACCEPT_TERMS',
  'SUBMIT_REQUEST',
  'ACCEPT_QUOTATION',
  'REJECT_QUOTATION',
  'UPLOAD_PAYMENT_PROOF',
  'APPROVE_SAMPLE',
  'REQUEST_CHANGES',
] as const;
export type CustomerAction = (typeof CUSTOMER_ACTIONS)[number];

export type CustomerPaymentStatus =
  'NOT_REQUIRED_YET' | 'PAYMENT_REQUIRED' | 'PAYMENT_UNDER_REVIEW' | 'PAID';

export type CustomerProofState =
  'PENDING_VERIFICATION' | 'VERIFIED' | 'REJECTED' | 'CANCELLED';

export const proofState = (status: string): CustomerProofState => {
  switch (status) {
    case 'VERIFIED':
      return 'VERIFIED';
    case 'REJECTED':
      return 'REJECTED';
    case 'CANCELLED':
      return 'CANCELLED';
    default:
      return 'PENDING_VERIFICATION';
  }
};

export interface PaymentFacts {
  /** Total of the accepted quotation (null until a quotation is accepted). */
  acceptedTotal: string | null;
  verified: string;
  pending: string;
}

/**
 * Customer view of the money state, derived from the backend's own figures (accepted quotation vs
 * VERIFIED payments); nothing is recalculated differently here, and amounts of different currencies are
 * never combined (a sample has one quotation currency).
 */
export function paymentStatus(f: PaymentFacts): {
  status: CustomerPaymentStatus;
  remaining: string | null;
} {
  if (f.acceptedTotal === null)
    return { status: 'NOT_REQUIRED_YET', remaining: null };
  const remainingD = D(f.acceptedTotal).sub(D(f.verified));
  const remaining = remainingD.lt(0) ? ZERO : remainingD;
  if (remaining.lte(0)) return { status: 'PAID', remaining: fmt(ZERO) };
  if (D(f.pending).gt(0))
    return { status: 'PAYMENT_UNDER_REVIEW', remaining: fmt(remaining) };
  return { status: 'PAYMENT_REQUIRED', remaining: fmt(remaining) };
}

export interface ActionFacts {
  sampleStatus: string;
  archived: boolean;
  /** An unexpired SENT quotation version exists. */
  actionableQuotation: boolean;
  /** Money still owed on the accepted quotation and room for another pending submission. */
  canSubmitPayment: boolean;
  /** The finished sample can be approved (no freeze blockers). */
  sampleApprovable: boolean;
  termsRequired: boolean;
  termsAccepted: boolean;
}

export function allowedActions(f: ActionFacts): CustomerAction[] {
  if (f.archived) return [];
  const out: CustomerAction[] = [];
  switch (f.sampleStatus) {
    case 'DRAFT':
      out.push('EDIT_REQUEST', 'UPLOAD_FILE');
      if (f.termsRequired && !f.termsAccepted) out.push('ACCEPT_TERMS');
      out.push('SUBMIT_REQUEST');
      break;
    case 'QUOTED':
      if (f.actionableQuotation)
        out.push('ACCEPT_QUOTATION', 'REJECT_QUOTATION');
      break;
    case 'AWAITING_PAYMENT':
      if (f.canSubmitPayment) out.push('UPLOAD_PAYMENT_PROOF');
      break;
    case 'AWAITING_APPROVAL':
      if (f.sampleApprovable) out.push('APPROVE_SAMPLE', 'REQUEST_CHANGES');
      break;
    default:
      break;
  }
  return out;
}

/** The single next thing the customer has to do commercially (for the summary banner). */
export function nextCommercialAction(
  actions: CustomerAction[],
): 'REVIEW_QUOTATION' | 'PAY' | 'REVIEW_SAMPLE' | 'NONE' {
  if (actions.includes('ACCEPT_QUOTATION')) return 'REVIEW_QUOTATION';
  if (actions.includes('UPLOAD_PAYMENT_PROOF')) return 'PAY';
  if (actions.includes('APPROVE_SAMPLE')) return 'REVIEW_SAMPLE';
  return 'NONE';
}
