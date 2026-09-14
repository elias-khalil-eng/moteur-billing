/**
 * All monetary arithmetic. USD is integer cents, LBP is integer LBP (no subunit),
 * lbpRate is integer LBP per 1 USD. No function here may produce a non-integer,
 * so every division goes through divRoundHalfAwayFromZero rather than through
 * Math.round on a float quotient.
 */

import { ValidationError } from './errors.js';

const CENTS_PER_USD = 100;
const LBP_ROUNDING_UNIT = 1_000;

export function assertIntegerAmount(value: number, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ValidationError(`${field} must be a whole number`, { field, value });
  }
  if (!Number.isSafeInteger(value)) {
    throw new ValidationError(`${field} is out of the safe range`, { field, value });
  }
}

export function assertPositiveInteger(value: number, field: string): void {
  assertIntegerAmount(value, field);
  if (value <= 0) {
    throw new ValidationError(`${field} must be greater than zero`, { field, value });
  }
}

export function assertNonNegativeInteger(value: number, field: string): void {
  assertIntegerAmount(value, field);
  if (value < 0) {
    throw new ValidationError(`${field} must not be negative`, { field, value });
  }
}

/**
 * Integer division rounding halves away from zero, so -0.5 becomes -1 and 0.5
 * becomes 1. Symmetric rounding keeps a credit balance the mirror of a debit.
 */
function divRoundHalfAwayFromZero(numerator: number, denominator: number): number {
  const sign = numerator < 0 ? -1 : 1;
  const abs = Math.abs(numerator);
  const quotient = Math.trunc(abs / denominator);
  const remainder = abs - quotient * denominator;
  const roundUp = remainder * 2 >= denominator;
  return sign * (quotient + (roundUp ? 1 : 0));
}

export function usdCentsToLbp(amountUsdCents: number, lbpRate: number): number {
  assertIntegerAmount(amountUsdCents, 'amountUsdCents');
  assertPositiveInteger(lbpRate, 'lbpRate');
  return divRoundHalfAwayFromZero(amountUsdCents * lbpRate, CENTS_PER_USD);
}

/** Notes below 1,000 LBP are not in circulation, so every LBP figure shown or paid is rounded here. */
export function roundLbpToNearestThousand(amountLbp: number): number {
  assertIntegerAmount(amountLbp, 'amountLbp');
  return divRoundHalfAwayFromZero(amountLbp, LBP_ROUNDING_UNIT) * LBP_ROUNDING_UNIT;
}

export function usdCentsToLbpRounded(amountUsdCents: number, lbpRate: number): number {
  return roundLbpToNearestThousand(usdCentsToLbp(amountUsdCents, lbpRate));
}

export function lbpToUsdCents(amountLbp: number, lbpRate: number): number {
  assertIntegerAmount(amountLbp, 'amountLbp');
  assertPositiveInteger(lbpRate, 'lbpRate');
  return divRoundHalfAwayFromZero(amountLbp * CENTS_PER_USD, lbpRate);
}

export function billAmountUsdCents(kwh: number, usdPerKwhCents: number): number {
  assertNonNegativeInteger(kwh, 'kwh');
  assertPositiveInteger(usdPerKwhCents, 'usdPerKwhCents');
  return kwh * usdPerKwhCents;
}

export function sumUsdCents(amounts: readonly number[]): number {
  let total = 0;
  for (const amount of amounts) {
    assertIntegerAmount(amount, 'amountUsdCents');
    total += amount;
  }
  assertIntegerAmount(total, 'amountUsdCents');
  return total;
}
