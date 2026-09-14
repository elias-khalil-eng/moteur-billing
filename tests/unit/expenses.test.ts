import { describe, it, expect } from 'vitest';
import { parseExpenseInput, parseExpensePatch } from '../../lib/expenses.js';
import { costPerKwhCentis, collectionRateBasisPoints } from '../../lib/reports.js';
import { ValidationError } from '../../lib/errors.js';

describe('parseExpenseInput', () => {
  it('accepts a diesel expense with litres', () => {
    const input = parseExpenseInput({
      category: 'diesel',
      amountUsdCents: 45_000,
      liters: 320.5,
      vendor: 'Station Aoun',
      spentAt: '2026-09-15',
    });
    expect(input.category).toBe('diesel');
    expect(input.amountUsdCents).toBe(45_000);
    expect(input.liters).toBe(320.5);
    expect(input.spentAt).toBe('2026-09-15');
  });

  it('accepts the other categories without litres', () => {
    for (const category of ['maintenance', 'salary', 'other'] as const) {
      const input = parseExpenseInput({ category, amountUsdCents: 1_000, spentAt: '2026-09-15' });
      expect(input.liters).toBeNull();
    }
  });

  it('rejects litres on anything but diesel', () => {
    expect(() =>
      parseExpenseInput({
        category: 'salary',
        amountUsdCents: 1_000,
        liters: 10,
        spentAt: '2026-09-15',
      }),
    ).toThrow(ValidationError);
  });

  it('rejects an unknown category and a zero amount', () => {
    expect(() =>
      parseExpenseInput({ category: 'bribes', amountUsdCents: 1_000, spentAt: '2026-09-15' }),
    ).toThrow(ValidationError);
    expect(() =>
      parseExpenseInput({ category: 'other', amountUsdCents: 0, spentAt: '2026-09-15' }),
    ).toThrow(ValidationError);
  });

  it('rejects a malformed or missing date', () => {
    expect(() =>
      parseExpenseInput({ category: 'other', amountUsdCents: 100, spentAt: '15/09/2026' }),
    ).toThrow(ValidationError);
    expect(() => parseExpenseInput({ category: 'other', amountUsdCents: 100 })).toThrow(
      ValidationError,
    );
  });

  it('rejects an unknown field', () => {
    expect(() =>
      parseExpenseInput({
        category: 'other',
        amountUsdCents: 100,
        spentAt: '2026-09-15',
        deletedAt: null,
      }),
    ).toThrow(ValidationError);
  });
});

describe('parseExpensePatch', () => {
  it('changes only what was sent', () => {
    expect(parseExpensePatch({ vendor: 'Station Aoun' }, 'diesel')).toEqual({
      vendor: 'Station Aoun',
    });
  });

  it('rejects an empty patch', () => {
    expect(() => parseExpensePatch({}, 'diesel')).toThrow(ValidationError);
  });

  it('judges litres against the category the expense already has', () => {
    expect(parseExpensePatch({ liters: 300 }, 'diesel')).toEqual({ liters: 300 });
    expect(() => parseExpensePatch({ liters: 300 }, 'salary')).toThrow(ValidationError);
  });

  it('judges litres against a category the patch itself changes to', () => {
    expect(parseExpensePatch({ category: 'diesel', liters: 300 }, 'salary')).toEqual({
      category: 'diesel',
      liters: 300,
    });
    expect(() => parseExpensePatch({ category: 'salary', liters: 300 }, 'diesel')).toThrow(
      ValidationError,
    );
  });
});

describe('costPerKwhCentis', () => {
  it('is expenses over kWh sold, in hundredths of a cent', () => {
    // $450 of expenses over 2,000 kWh is 22.5 cents per kWh
    expect(costPerKwhCentis(45_000, 2_000)).toBe(2_250);
  });

  it('rounds to the nearest hundredth of a cent', () => {
    expect(costPerKwhCentis(1_000, 3)).toBe(33_333);
  });

  it('is null when nothing was sold, rather than dividing by zero', () => {
    expect(costPerKwhCentis(45_000, 0)).toBeNull();
  });

  it('is zero when there were no expenses', () => {
    expect(costPerKwhCentis(0, 2_000)).toBe(0);
  });
});

describe('collectionRateBasisPoints', () => {
  it('is collected over billed, in basis points', () => {
    expect(collectionRateBasisPoints(7_500, 10_000)).toBe(7_500);
    expect(collectionRateBasisPoints(10_000, 10_000)).toBe(10_000);
  });

  it('rounds to the nearest basis point', () => {
    expect(collectionRateBasisPoints(1, 3)).toBe(3_333);
  });

  it('is null when nothing was billed', () => {
    expect(collectionRateBasisPoints(0, 0)).toBeNull();
  });

  it('can exceed one hundred percent when old debt is paid off', () => {
    expect(collectionRateBasisPoints(12_000, 10_000)).toBe(12_000);
  });
});
