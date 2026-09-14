import { describe, it, expect } from 'vitest';
import { parsePaymentInput, parseVoidReason } from '../../lib/payments.js';
import { ValidationError } from '../../lib/errors.js';

describe('parsePaymentInput in USD', () => {
  it('takes the cents as sent', () => {
    const input = parsePaymentInput({
      subscriberId: 7,
      paidCurrency: 'USD',
      amountUsdCents: 3_000,
    });
    expect(input.amountUsdCents).toBe(3_000);
    expect(input.amountLbp).toBeNull();
    expect(input.lbpRateUsed).toBeNull();
  });

  it('rejects a zero or negative amount', () => {
    expect(() =>
      parsePaymentInput({ subscriberId: 7, paidCurrency: 'USD', amountUsdCents: 0 }),
    ).toThrow(ValidationError);
    expect(() =>
      parsePaymentInput({ subscriberId: 7, paidCurrency: 'USD', amountUsdCents: -100 }),
    ).toThrow(ValidationError);
  });

  it('rejects a non-integer amount, which is how a float would reach the ledger', () => {
    expect(() =>
      parsePaymentInput({ subscriberId: 7, paidCurrency: 'USD', amountUsdCents: 30.5 }),
    ).toThrow(ValidationError);
  });

  it('rejects LBP fields on a USD payment', () => {
    expect(() =>
      parsePaymentInput({
        subscriberId: 7,
        paidCurrency: 'USD',
        amountUsdCents: 3_000,
        amountLbp: 100_000,
        lbpRateUsed: 89_000,
      }),
    ).toThrow(ValidationError);
  });
});

describe('parsePaymentInput in LBP', () => {
  it('derives the USD cents from the LBP amount and the rate used', () => {
    const input = parsePaymentInput({
      subscriberId: 7,
      paidCurrency: 'LBP',
      amountLbp: 2_670_000,
      lbpRateUsed: 89_000,
    });
    expect(input.amountLbp).toBe(2_670_000);
    expect(input.lbpRateUsed).toBe(89_000);
    expect(input.amountUsdCents).toBe(3_000);
  });

  it('requires both the amount and the rate', () => {
    expect(() =>
      parsePaymentInput({ subscriberId: 7, paidCurrency: 'LBP', amountLbp: 2_670_000 }),
    ).toThrow(ValidationError);
    expect(() =>
      parsePaymentInput({ subscriberId: 7, paidCurrency: 'LBP', lbpRateUsed: 89_000 }),
    ).toThrow(ValidationError);
  });

  it('rejects a derived amount of zero, so a token payment cannot be recorded', () => {
    expect(() =>
      parsePaymentInput({
        subscriberId: 7,
        paidCurrency: 'LBP',
        amountLbp: 400,
        lbpRateUsed: 89_000,
      }),
    ).toThrow(ValidationError);
  });

  it('ignores an amountUsdCents sent alongside, rather than trusting the client', () => {
    expect(() =>
      parsePaymentInput({
        subscriberId: 7,
        paidCurrency: 'LBP',
        amountLbp: 2_670_000,
        lbpRateUsed: 89_000,
        amountUsdCents: 1,
      }),
    ).toThrow(ValidationError);
  });
});

describe('parsePaymentInput, other fields', () => {
  it('accepts an explicit paid date and a note', () => {
    const input = parsePaymentInput({
      subscriberId: 7,
      paidCurrency: 'USD',
      amountUsdCents: 3_000,
      paidAt: '2026-09-15T10:00:00.000Z',
      note: 'paid at the shop',
    });
    expect(input.paidAt?.toISOString()).toBe('2026-09-15T10:00:00.000Z');
    expect(input.note).toBe('paid at the shop');
  });

  it('rejects a paid date that is not a real date', () => {
    expect(() =>
      parsePaymentInput({
        subscriberId: 7,
        paidCurrency: 'USD',
        amountUsdCents: 3_000,
        paidAt: 'yesterday',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects a missing subscriber and an unknown currency', () => {
    expect(() => parsePaymentInput({ paidCurrency: 'USD', amountUsdCents: 100 })).toThrow(
      ValidationError,
    );
    expect(() =>
      parsePaymentInput({ subscriberId: 7, paidCurrency: 'EUR', amountUsdCents: 100 }),
    ).toThrow(ValidationError);
  });

  it('rejects an unknown field', () => {
    expect(() =>
      parsePaymentInput({
        subscriberId: 7,
        paidCurrency: 'USD',
        amountUsdCents: 100,
        voidedAt: null,
      }),
    ).toThrow(ValidationError);
  });
});

describe('parseVoidReason', () => {
  it('requires a reason, because a void must be explainable', () => {
    expect(parseVoidReason({ reason: 'entered twice' })).toBe('entered twice');
    expect(() => parseVoidReason({})).toThrow(ValidationError);
    expect(() => parseVoidReason({ reason: '   ' })).toThrow(ValidationError);
  });
});
