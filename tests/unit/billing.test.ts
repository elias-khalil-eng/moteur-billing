import { describe, it, expect } from 'vitest';
import { arrearsBucket, ARREARS_BUCKETS, computeBillFigures, estimateKwh, deriveBalance } from '../../lib/billing.js';
import { ValidationError } from '../../lib/errors.js';

describe('computeBillFigures', () => {
  it('computes the USD and LBP amounts from kWh, price and rate', () => {
    expect(computeBillFigures(1_250, 30, 89_000)).toEqual({
      amountUsdCents: 37_500,
      amountLbp: 33_375_000,
    });
  });

  it('rounds the LBP amount to the nearest thousand', () => {
    // 7 kWh at 30 cents is $2.10, which is 186,900 LBP, rounded to 187,000
    expect(computeBillFigures(7, 30, 89_000).amountLbp).toBe(187_000);
  });

  it('bills zero for zero kWh', () => {
    expect(computeBillFigures(0, 30, 89_000)).toEqual({ amountUsdCents: 0, amountLbp: 0 });
  });

  it('rejects a non-integer or negative kWh', () => {
    expect(() => computeBillFigures(1.5, 30, 89_000)).toThrow(ValidationError);
    expect(() => computeBillFigures(-1, 30, 89_000)).toThrow(ValidationError);
  });
});

describe('deriveBalance', () => {
  it('is billed minus paid', () => {
    expect(deriveBalance(10_000, 4_000)).toBe(6_000);
  });

  it('is negative when a subscriber has overpaid', () => {
    expect(deriveBalance(10_000, 12_000)).toBe(-2_000);
  });

  it('is zero for a subscriber with no history', () => {
    expect(deriveBalance(0, 0)).toBe(0);
  });

  it('rejects a non-integer input, which is how a float would reach a balance', () => {
    expect(() => deriveBalance(10_000.5, 0)).toThrow(ValidationError);
  });
});

describe('estimateKwh', () => {
  it('is the mean of the last three billed cycles', () => {
    expect(estimateKwh([1_200, 1_250, 1_300])).toBe(1_250);
  });

  it('rounds the mean to a whole kWh', () => {
    expect(estimateKwh([1_200, 1_250, 1_301])).toBe(1_250);
    expect(estimateKwh([1_200, 1_251, 1_301])).toBe(1_251);
  });

  it('uses whatever history exists when there are fewer than three cycles', () => {
    expect(estimateKwh([1_200])).toBe(1_200);
    expect(estimateKwh([1_200, 1_300])).toBe(1_250);
  });

  it('is zero for a subscriber with no history at all', () => {
    expect(estimateKwh([])).toBe(0);
  });
});

describe('arrearsBucket', () => {
  it('puts a new bill in the first bucket', () => {
    expect(arrearsBucket(0)).toBe('0-30');
    expect(arrearsBucket(30)).toBe('0-30');
  });

  it('moves to the next bucket at exactly 31 days', () => {
    expect(arrearsBucket(31)).toBe('31-60');
    expect(arrearsBucket(60)).toBe('31-60');
  });

  it('moves again at exactly 61 days', () => {
    expect(arrearsBucket(61)).toBe('61-90');
    expect(arrearsBucket(90)).toBe('61-90');
  });

  it('puts anything past 90 days in the last bucket', () => {
    expect(arrearsBucket(91)).toBe('90+');
    expect(arrearsBucket(400)).toBe('90+');
  });

  it('treats a bill dated in the future as new rather than overdue', () => {
    expect(arrearsBucket(-1)).toBe('0-30');
  });

  it('lists the four buckets in order', () => {
    expect(ARREARS_BUCKETS).toEqual(['0-30', '31-60', '61-90', '90+']);
  });
});
