import { describe, it, expect } from 'vitest';
import {
  usdCentsToLbp,
  roundLbpToNearestThousand,
  usdCentsToLbpRounded,
  lbpToUsdCents,
  billAmountUsdCents,
  sumUsdCents,
  assertIntegerAmount,
} from '../../lib/money.js';
import { ValidationError } from '../../lib/errors.js';

describe('usdCentsToLbp', () => {
  it('converts whole dollars at the given rate', () => {
    expect(usdCentsToLbp(100, 89_000)).toBe(89_000);
    expect(usdCentsToLbp(1_000, 89_000)).toBe(890_000);
  });

  it('converts a single cent', () => {
    expect(usdCentsToLbp(1, 89_000)).toBe(890);
  });

  it('rounds an exact half away from zero', () => {
    // 1 cent at rate 50 is 50/100 = 0.5 LBP
    expect(usdCentsToLbp(1, 50)).toBe(1);
    expect(usdCentsToLbp(-1, 50)).toBe(-1);
  });

  it('rounds below the half down', () => {
    expect(usdCentsToLbp(1, 49)).toBe(0);
  });

  it('handles a negative amount (a credit balance)', () => {
    expect(usdCentsToLbp(-1_000, 89_000)).toBe(-890_000);
  });

  it('rejects a non-integer amount', () => {
    expect(() => usdCentsToLbp(10.5, 89_000)).toThrow(ValidationError);
  });

  it('rejects a non-positive rate', () => {
    expect(() => usdCentsToLbp(100, 0)).toThrow(ValidationError);
    expect(() => usdCentsToLbp(100, -1)).toThrow(ValidationError);
  });

  it('always returns an integer', () => {
    for (let cents = 0; cents < 500; cents++) {
      expect(Number.isInteger(usdCentsToLbp(cents, 89_357))).toBe(true);
    }
  });
});

describe('roundLbpToNearestThousand', () => {
  it('rounds down below the half', () => {
    expect(roundLbpToNearestThousand(1_499)).toBe(1_000);
    expect(roundLbpToNearestThousand(499)).toBe(0);
  });

  it('rounds an exact half away from zero', () => {
    expect(roundLbpToNearestThousand(500)).toBe(1_000);
    expect(roundLbpToNearestThousand(1_500)).toBe(2_000);
    expect(roundLbpToNearestThousand(-500)).toBe(-1_000);
    expect(roundLbpToNearestThousand(-1_500)).toBe(-2_000);
  });

  it('rounds up above the half', () => {
    expect(roundLbpToNearestThousand(1_501)).toBe(2_000);
  });

  it('leaves an exact multiple of 1000 alone', () => {
    expect(roundLbpToNearestThousand(0)).toBe(0);
    expect(roundLbpToNearestThousand(89_000)).toBe(89_000);
    expect(roundLbpToNearestThousand(-89_000)).toBe(-89_000);
  });

  it('rejects a non-integer input', () => {
    expect(() => roundLbpToNearestThousand(1_500.5)).toThrow(ValidationError);
  });

  it('always returns a multiple of 1000', () => {
    for (let lbp = 0; lbp < 5_000; lbp += 7) {
      expect(roundLbpToNearestThousand(lbp) % 1_000).toBe(0);
    }
  });
});

describe('usdCentsToLbpRounded', () => {
  it('converts then rounds to the nearest thousand', () => {
    // 12.34 USD at 89,000 is 1,098,260 LBP, rounded to 1,098,000
    expect(usdCentsToLbpRounded(1_234, 89_000)).toBe(1_098_000);
  });

  it('rounds a small amount up to the nearest thousand', () => {
    // 0.01 USD at 89,000 is 890 LBP, rounded to 1,000
    expect(usdCentsToLbpRounded(1, 89_000)).toBe(1_000);
  });

  it('rounds a very small amount down to zero', () => {
    // 0.01 USD at 40,000 is 400 LBP, rounded to 0
    expect(usdCentsToLbpRounded(1, 40_000)).toBe(0);
  });
});

describe('lbpToUsdCents', () => {
  it('converts LBP back to cents', () => {
    expect(lbpToUsdCents(890_000, 89_000)).toBe(1_000);
    expect(lbpToUsdCents(89_000, 89_000)).toBe(100);
  });

  it('rounds to the nearest cent, halves away from zero', () => {
    // 445 LBP at 89,000 is 0.5 cents
    expect(lbpToUsdCents(445, 89_000)).toBe(1);
    expect(lbpToUsdCents(444, 89_000)).toBe(0);
  });

  it('round-trips a rounded LBP amount back to about the same cents', () => {
    const cents = 1_234;
    const lbp = usdCentsToLbpRounded(cents, 89_000);
    expect(Math.abs(lbpToUsdCents(lbp, 89_000) - cents)).toBeLessThanOrEqual(1);
  });

  it('rejects a non-integer LBP amount', () => {
    expect(() => lbpToUsdCents(1_000.5, 89_000)).toThrow(ValidationError);
  });
});

describe('billAmountUsdCents', () => {
  it('multiplies kWh by the price per kWh in cents', () => {
    expect(billAmountUsdCents(1_250, 12)).toBe(15_000);
    expect(billAmountUsdCents(0, 12)).toBe(0);
  });

  it('rejects negative kWh', () => {
    expect(() => billAmountUsdCents(-1, 12)).toThrow(ValidationError);
  });

  it('rejects a non-positive price', () => {
    expect(() => billAmountUsdCents(10, 0)).toThrow(ValidationError);
  });

  it('rejects a non-integer kWh', () => {
    expect(() => billAmountUsdCents(10.5, 12)).toThrow(ValidationError);
  });

  it('always returns an integer', () => {
    for (let kwh = 0; kwh < 1_000; kwh += 13) {
      expect(Number.isInteger(billAmountUsdCents(kwh, 17))).toBe(true);
    }
  });
});

describe('sumUsdCents', () => {
  it('sums an empty list to zero', () => {
    expect(sumUsdCents([])).toBe(0);
  });

  it('sums integers exactly', () => {
    expect(sumUsdCents([1, 2, 3])).toBe(6);
    expect(sumUsdCents([1_000, -250])).toBe(750);
  });

  it('rejects a non-integer member', () => {
    expect(() => sumUsdCents([1, 2.5])).toThrow(ValidationError);
  });
});

describe('assertIntegerAmount', () => {
  it('accepts a safe integer', () => {
    expect(() => assertIntegerAmount(0, 'amountUsdCents')).not.toThrow();
  });

  it('rejects NaN, Infinity, floats and non-numbers', () => {
    expect(() => assertIntegerAmount(Number.NaN, 'x')).toThrow(ValidationError);
    expect(() => assertIntegerAmount(Number.POSITIVE_INFINITY, 'x')).toThrow(ValidationError);
    expect(() => assertIntegerAmount(1.1, 'x')).toThrow(ValidationError);
    expect(() => assertIntegerAmount('5' as unknown as number, 'x')).toThrow(ValidationError);
  });

  it('rejects an unsafe integer', () => {
    expect(() => assertIntegerAmount(Number.MAX_SAFE_INTEGER + 2, 'x')).toThrow(ValidationError);
  });

  it('names the field in the message', () => {
    expect(() => assertIntegerAmount(1.1, 'amountUsdCents')).toThrow(/amountUsdCents/);
  });
});
