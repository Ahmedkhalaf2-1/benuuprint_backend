import { BadRequestException } from '@nestjs/common';
import {
  D,
  computeTotals,
  derivePaymentState,
  fmt,
  looksLikeCardNumber,
  round2,
} from './money.js';

describe('computeTotals', () => {
  it('multiplies, sums, discounts and taxes with exact decimals', () => {
    const t = computeTotals(
      [
        { quantity: 3, unitPrice: '19.99' },
        { quantity: '1.5', unitPrice: 100 },
      ],
      '10.00',
      14,
    );
    expect(t.lineAmounts.map(fmt)).toEqual(['59.97', '150.00']);
    expect(fmt(t.subtotal)).toBe('209.97');
    expect(fmt(t.discount)).toBe('10.00');
    expect(fmt(t.tax)).toBe('28.00'); // (209.97 - 10) * 14% = 27.9958 -> 28.00
    expect(fmt(t.total)).toBe('227.97');
  });

  it('avoids floating-point drift', () => {
    const t = computeTotals([
      { quantity: 1, unitPrice: '0.10' },
      { quantity: 1, unitPrice: '0.20' },
    ]);
    expect(fmt(t.subtotal)).toBe('0.30');
    expect(0.1 + 0.2).not.toBe(0.3); // the float trap this guards against
    expect(
      fmt(computeTotals([{ quantity: 1, unitPrice: '0.07' }], 0, '33.33').tax),
    ).toBe('0.02');
  });

  it('rounds half up to two places', () => {
    expect(fmt(round2(D('1.005')))).toBe('1.01');
    expect(fmt(round2(D('2.675')))).toBe('2.68');
    expect(
      fmt(computeTotals([{ quantity: '0.5', unitPrice: '0.01' }]).subtotal),
    ).toBe('0.01');
  });

  it('supports negative discount-adjustment lines but never a negative subtotal', () => {
    const t = computeTotals([
      { quantity: 1, unitPrice: 100 },
      { quantity: 1, unitPrice: -30 },
    ]);
    expect(fmt(t.subtotal)).toBe('70.00');
    expect(() =>
      computeTotals([
        { quantity: 1, unitPrice: 10 },
        { quantity: 1, unitPrice: -30 },
      ]),
    ).toThrow(BadRequestException);
  });

  it('rejects an excessive discount and a bad tax rate', () => {
    expect(() => computeTotals([{ quantity: 1, unitPrice: 50 }], 60)).toThrow(
      /exceed the subtotal/,
    );
    expect(() => computeTotals([{ quantity: 1, unitPrice: 50 }], -1)).toThrow(
      /negative/,
    );
    expect(() =>
      computeTotals([{ quantity: 1, unitPrice: 50 }], 0, 101),
    ).toThrow(/taxPercent/);
  });

  it('handles an empty draft', () => {
    const t = computeTotals([]);
    expect(fmt(t.total)).toBe('0.00');
  });
});

describe('derivePaymentState', () => {
  it('is UNPAID without an accepted quotation or any verified payment', () => {
    expect(derivePaymentState(null, D(0))).toBe('UNPAID');
    expect(derivePaymentState(D(100), D(0))).toBe('UNPAID');
  });
  it('is PARTIALLY_PAID below the total and PAID at or above it', () => {
    expect(derivePaymentState(D(100), D('99.99'))).toBe('PARTIALLY_PAID');
    expect(derivePaymentState(D(100), D(100))).toBe('PAID');
    expect(derivePaymentState(D('100.00'), D('100.00'))).toBe('PAID');
  });
  it('treats a zero-value quotation as PAID', () => {
    expect(derivePaymentState(D(0), D(0))).toBe('PAID');
  });
});

describe('looksLikeCardNumber', () => {
  it('flags Luhn-valid 13-19 digit sequences, with or without separators', () => {
    expect(looksLikeCardNumber('4111111111111111')).toBe(true);
    expect(looksLikeCardNumber('4111 1111 1111 1111')).toBe(true);
    expect(looksLikeCardNumber('ref 5555-5555-5555-4444 ok')).toBe(true);
  });
  it('allows ordinary transfer references', () => {
    expect(looksLikeCardNumber('INSTAPAY-20261021-88213')).toBe(false);
    expect(looksLikeCardNumber('4111111111111112')).toBe(false); // fails Luhn
    expect(looksLikeCardNumber('TRX 123456789012')).toBe(false); // too short
    expect(looksLikeCardNumber('')).toBe(false);
  });
});
