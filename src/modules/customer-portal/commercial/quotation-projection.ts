import { D, fmt } from '../../commercial/money.js';
import type { CustomerQuotationsDto } from '../dto/customer-commercial.dto.js';

interface LineRow {
  type: string;
  description: string;
  quantity: unknown;
  unitPrice: unknown;
  amount: unknown;
}
export interface VersionRow {
  id: string;
  versionNumber: number;
  status: string;
  subtotal: unknown;
  discount: unknown;
  taxPercent: unknown;
  tax: unknown;
  total: unknown;
  validUntil: Date | null;
  sentAt: Date | null;
  acceptedAt: Date | null;
  rejectedAt: Date | null;
  supersededAt: Date | null;
  invalidatedAt: Date | null;
  customerNotes: string | null;
  lineItems: LineRow[];
}
export interface QuotationRow {
  id: string;
  quotationNumber: string;
  currency: string;
  status: string;
  versions: VersionRow[];
}

/**
 * What the customer sees of the quotations of a sample or an order. Only versions that were SENT to them
 * (versions are passed already filtered), customer fields only, and the single open offer marked
 * `actionable`. Shared by samples and orders so both follow the same rules.
 */
export function projectQuotations(
  quotations: QuotationRow[],
  isOpen: (v: VersionRow, now: Date) => boolean,
  reapprovalRequired = false,
): CustomerQuotationsDto {
  const now = new Date();
  let actionableVersionId: string | null = null;
  const out = quotations.map((q) => {
    const newest = q.versions.at(-1)?.versionNumber;
    const versions = q.versions.map((v) => {
      const open = isOpen(v, now);
      if (open) actionableVersionId = v.id;
      return {
        id: v.id,
        versionNumber: v.versionNumber,
        status: v.status,
        isCurrent: v.versionNumber === newest,
        actionable: open,
        // an accepted/open offer ended by a change of the order: it no longer applies
        endedByChange: !!v.invalidatedAt,
        currency: q.currency,
        lineItems: v.lineItems.map((l) => ({
          type: l.type,
          description: l.description,
          quantity: fmt(D(l.quantity as never)),
          unitPrice: fmt(D(l.unitPrice as never)),
          amount: fmt(D(l.amount as never)),
        })),
        subtotal: fmt(D(v.subtotal as never)),
        discount: fmt(D(v.discount as never)),
        taxPercent: fmt(D(v.taxPercent as never)),
        tax: fmt(D(v.tax as never)),
        total: fmt(D(v.total as never)),
        validUntil: v.validUntil,
        sentAt: v.sentAt,
        acceptedAt: v.acceptedAt,
        rejectedAt: v.rejectedAt,
        supersededAt: v.supersededAt,
        notes: v.customerNotes,
      };
    });
    return {
      id: q.id,
      quotationNumber: q.quotationNumber,
      currency: q.currency,
      status: q.versions.at(-1)?.status ?? q.status,
      versions,
    };
  });
  const open = out.flatMap((q) => q.versions).find((v) => v.actionable);
  const earlierSent =
    !!open &&
    out.some((q) =>
      q.versions.some(
        (v) =>
          v.id !== open.id &&
          (v.sentAt?.getTime() ?? 0) <= (open.sentAt?.getTime() ?? 0),
      ),
    );
  const requiresReview = !!open && (earlierSent || reapprovalRequired);
  return {
    quotations: out,
    actionableVersionId,
    requiresReview,
    notice: requiresReview
      ? 'A new quotation requires your review.'
      : !open && reapprovalRequired
        ? 'Your order changed, so the previous quotation no longer applies. Our team will send a new one.'
        : null,
  };
}
