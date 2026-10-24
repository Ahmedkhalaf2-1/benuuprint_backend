import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';

export type Decimal = Prisma.Decimal;
export type DecimalInput = number | string | Decimal;
export const D = (value: DecimalInput): Decimal => new Prisma.Decimal(value);
/** Money is exact: two decimals, half-up, never JS floats. */
export const round2 = (value: Decimal): Decimal =>
  value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
export const ZERO = D(0);
export const fmt = (value: Decimal): string => value.toFixed(2);

export interface LineInput {
  quantity: number | string;
  unitPrice: number | string;
}

export interface Totals {
  lineAmounts: Decimal[];
  subtotal: Decimal;
  discount: Decimal;
  taxPercent: Decimal;
  tax: Decimal;
  total: Decimal;
}

/**
 * Server-side quotation arithmetic (clients never send totals).
 * amount = round(quantity × unitPrice); subtotal = Σ amounts;
 * tax = round((subtotal − discount) × taxPercent / 100); total = subtotal − discount + tax.
 */
export function computeTotals(
  lines: LineInput[],
  discount: number | string = 0,
  taxPercent: number | string = 0,
): Totals {
  const lineAmounts = lines.map((l) =>
    round2(D(l.quantity).mul(D(l.unitPrice))),
  );
  const subtotal = lineAmounts.reduce((sum, a) => sum.add(a), ZERO);
  const disc = round2(D(discount));
  const pct = round2(D(taxPercent));
  if (subtotal.lt(0))
    throw new BadRequestException('The line items add up to a negative amount');
  if (disc.lt(0)) throw new BadRequestException('discount cannot be negative');
  if (disc.gt(subtotal))
    throw new BadRequestException('discount cannot exceed the subtotal');
  if (pct.lt(0) || pct.gt(100))
    throw new BadRequestException('taxPercent must be between 0 and 100');
  const net = subtotal.sub(disc);
  const tax = round2(net.mul(pct).div(100));
  return {
    lineAmounts,
    subtotal,
    discount: disc,
    taxPercent: pct,
    tax,
    total: net.add(tax),
  };
}

export type PaymentStateValue = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';

/** Payment state relative to the accepted quotation total (UNPAID when nothing is accepted yet). */
export function derivePaymentState(
  acceptedTotal: Decimal | null,
  verifiedPaid: Decimal,
): PaymentStateValue {
  if (!acceptedTotal) return 'UNPAID';
  if (acceptedTotal.lte(0)) return 'PAID';
  if (verifiedPaid.lte(0)) return 'UNPAID';
  return verifiedPaid.gte(acceptedTotal) ? 'PAID' : 'PARTIALLY_PAID';
}

/** Luhn check, used to refuse anything that looks like a card number in free-text references. */
export function looksLikeCardNumber(text: string): boolean {
  for (const match of text.matchAll(/\d[\d -]{11,22}\d/g)) {
    const digits = match[0].replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = Number(digits[i]);
      if (double) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      double = !double;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}
