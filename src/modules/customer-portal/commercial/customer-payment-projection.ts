import { D, fmt } from '../../commercial/money.js';
import type { CustomerPaymentDto } from '../dto/customer-commercial.dto.js';
import { proofState } from './customer-commercial.js';

export const paymentSelect = {
  id: true,
  paymentNumber: true,
  amount: true,
  currency: true,
  method: true,
  status: true,
  transactionReference: true,
  receivedAt: true,
  verifiedAt: true,
  customerMessage: true,
  createdAt: true,
  createdByCustomerId: true,
  proofAsset: { select: { originalName: true } },
} as const;

export interface PaymentRow {
  id: string;
  paymentNumber: string;
  amount: unknown;
  currency: string;
  method: string;
  status: string;
  transactionReference: string | null;
  receivedAt: Date | null;
  verifiedAt: Date | null;
  customerMessage: string | null;
  createdAt: Date;
  createdByCustomerId: string | null;
  proofAsset: { originalName: string } | null;
}

/** A payment as the customer sees it: verification state, own proof name, and only the message staff wrote for them. */
export function toCustomerPayment(
  p: PaymentRow,
  customerId: string,
): CustomerPaymentDto {
  const state = proofState(p.status);
  return {
    id: p.id,
    paymentNumber: p.paymentNumber,
    amount: fmt(D(p.amount as never)),
    currency: p.currency,
    method: p.method,
    status: state,
    transactionReference: p.transactionReference,
    proofFileName: p.proofAsset?.originalName ?? null,
    hasProof: !!p.proofAsset,
    receivedAt: p.receivedAt,
    submittedAt: p.createdAt,
    verifiedAt: p.verifiedAt,
    message: state === 'REJECTED' ? p.customerMessage : null,
    canReplaceProof:
      p.status === 'SUBMITTED' && p.createdByCustomerId === customerId,
  };
}
