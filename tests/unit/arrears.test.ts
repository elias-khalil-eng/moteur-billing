import { describe, it, expect } from 'vitest';
import { allocateArrears } from '../../lib/reports.js';

const asOf = new Date('2026-09-30T09:00:00Z');

function bill(period: string, issuedAt: string, amountUsdCents: number) {
  return { id: period, period, issuedAt: new Date(issuedAt), amountUsdCents };
}

describe('allocateArrears', () => {
  it('reports nothing owed when payments cover every bill', () => {
    const result = allocateArrears(
      [bill('2026-08', '2026-08-31T09:00:00Z', 3_000)],
      3_000,
      asOf,
    );
    expect(result.balanceUsdCents).toBe(0);
    expect(result.buckets['0-30']).toBe(0);
    expect(result.oldestUnpaidDays).toBeNull();
    expect(result.unpaidCycles).toBe(0);
  });

  it('applies payments to the oldest bill first', () => {
    const result = allocateArrears(
      [
        bill('2026-06', '2026-06-30T09:00:00Z', 3_000),
        bill('2026-09', '2026-09-25T09:00:00Z', 4_000),
      ],
      3_000,
      asOf,
    );
    // The old bill is settled; what remains is the recent one.
    expect(result.balanceUsdCents).toBe(4_000);
    expect(result.buckets['0-30']).toBe(4_000);
    expect(result.buckets['61-90']).toBe(0);
    expect(result.unpaidCycles).toBe(1);
  });

  it('splits a partial payment across the oldest bill', () => {
    const result = allocateArrears(
      [
        bill('2026-06', '2026-06-30T09:00:00Z', 3_000),
        bill('2026-09', '2026-09-25T09:00:00Z', 4_000),
      ],
      1_000,
      asOf,
    );
    expect(result.balanceUsdCents).toBe(6_000);
    expect(result.buckets['0-30']).toBe(4_000);
    // 30 June to 30 September is 92 days, so the remainder ages into the last bucket.
    expect(result.buckets['90+']).toBe(2_000);
    expect(result.unpaidCycles).toBe(2);
  });

  it('buckets by the age of each bill at the exact boundaries', () => {
    const result = allocateArrears(
      [
        bill('a', '2026-08-31T09:00:00Z', 100), // 30 days
        bill('b', '2026-08-30T09:00:00Z', 200), // 31 days
        bill('c', '2026-08-01T09:00:00Z', 400), // 60 days
        bill('d', '2026-07-31T09:00:00Z', 800), // 61 days
        bill('e', '2026-07-02T09:00:00Z', 1_600), // 90 days
        bill('f', '2026-07-01T09:00:00Z', 3_200), // 91 days
      ],
      0,
      asOf,
    );
    expect(result.buckets['0-30']).toBe(100);
    expect(result.buckets['31-60']).toBe(600);
    expect(result.buckets['61-90']).toBe(2_400);
    expect(result.buckets['90+']).toBe(3_200);
  });

  it('reports the age of the oldest bill still unpaid', () => {
    const result = allocateArrears(
      [
        bill('2026-06', '2026-06-30T09:00:00Z', 3_000),
        bill('2026-09', '2026-09-25T09:00:00Z', 4_000),
      ],
      0,
      asOf,
    );
    expect(result.oldestUnpaidDays).toBe(92);
  });

  it('treats an overpayment as a zero balance, never a negative bucket', () => {
    const result = allocateArrears([bill('2026-08', '2026-08-31T09:00:00Z', 3_000)], 5_000, asOf);
    expect(result.balanceUsdCents).toBe(0);
    expect(Object.values(result.buckets).every((value) => value >= 0)).toBe(true);
  });

  it('handles a subscriber with no bills at all', () => {
    const result = allocateArrears([], 0, asOf);
    expect(result.balanceUsdCents).toBe(0);
    expect(result.unpaidCycles).toBe(0);
  });
});
