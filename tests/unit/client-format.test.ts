import { describe, it, expect } from 'vitest';
import {
  formatUsd,
  formatLbp,
  formatKwh,
  parseUsdToCents,
} from '../../client/src/lib/format.js';

describe('formatUsd', () => {
  it('renders cents as dollars with two decimals and thousands separators', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(5)).toBe('$0.05');
    expect(formatUsd(3_750)).toBe('$37.50');
    expect(formatUsd(1_234_567)).toBe('$12,345.67');
  });

  it('renders a credit balance with a leading minus', () => {
    expect(formatUsd(-3_750)).toBe('-$37.50');
  });
});

describe('formatLbp and formatKwh', () => {
  it('use Western digits in both languages', () => {
    expect(formatLbp(1_780_000, 'ar')).toBe('1,780,000 ل.ل.');
    expect(formatLbp(1_780_000, 'en')).toBe('1,780,000 LBP');
    expect(formatKwh(1_250, 'en')).toBe('1,250 kWh');
    expect(formatKwh(1_250, 'ar')).toBe('1,250 ك.و.س');
  });
});

describe('parseUsdToCents', () => {
  it('parses a whole number of dollars', () => {
    expect(parseUsdToCents('37')).toBe(3_700);
  });

  it('parses one and two decimal places', () => {
    expect(parseUsdToCents('37.5')).toBe(3_750);
    expect(parseUsdToCents('37.50')).toBe(3_750);
    expect(parseUsdToCents('0.05')).toBe(5);
  });

  it('parses without floating point drift', () => {
    // 8.35 * 100 is 834.9999999999999 in binary floating point
    expect(parseUsdToCents('8.35')).toBe(835);
    expect(parseUsdToCents('1.15')).toBe(115);
  });

  it('ignores extra decimal places rather than rounding a cent into existence', () => {
    expect(parseUsdToCents('37.509')).toBeNull();
  });

  it('returns null for an empty or malformed value', () => {
    expect(parseUsdToCents('')).toBeNull();
    expect(parseUsdToCents('   ')).toBeNull();
    expect(parseUsdToCents('abc')).toBeNull();
    expect(parseUsdToCents('37.5.0')).toBeNull();
    expect(parseUsdToCents('-5')).toBeNull();
  });

  it('returns null for zero, which is never a payment', () => {
    expect(parseUsdToCents('0')).toBeNull();
    expect(parseUsdToCents('0.00')).toBeNull();
  });
});

describe('beirutDayKey', () => {
  it('names the Beirut calendar day of an instant', async () => {
    const { beirutDayKey } = await import('../../client/src/lib/format.js');
    expect(beirutDayKey('2026-09-15T10:00:00Z')).toBe('2026-09-15');
  });

  it('rolls over after Beirut midnight, not UTC midnight', async () => {
    const { beirutDayKey } = await import('../../client/src/lib/format.js');
    expect(beirutDayKey('2026-09-15T21:30:00Z')).toBe('2026-09-16');
    expect(beirutDayKey('2026-09-15T20:30:00Z')).toBe('2026-09-15');
  });
});
