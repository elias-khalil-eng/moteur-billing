import { describe, it, expect } from 'vitest';
import { deriveKwh, isOutlier, OUTLIER_MULTIPLIER } from '../../lib/readings.js';
import { ValidationError } from '../../lib/errors.js';

describe('deriveKwh', () => {
  it('subtracts the previous value from the current one', () => {
    expect(deriveKwh({ previousValue: 1_000, currentValue: 1_250 })).toBe(250);
  });

  it('allows a reading that did not move', () => {
    expect(deriveKwh({ previousValue: 1_000, currentValue: 1_000 })).toBe(0);
  });

  it('rejects a current value below the previous one, naming both numbers', () => {
    expect(() => deriveKwh({ previousValue: 1_000, currentValue: 900 })).toThrow(ValidationError);
    expect(() => deriveKwh({ previousValue: 1_000, currentValue: 900 })).toThrow(/1,?000/);
    expect(() => deriveKwh({ previousValue: 1_000, currentValue: 900 })).toThrow(/900/);
  });

  it('treats the whole current value as consumption when the meter was reset', () => {
    expect(
      deriveKwh({
        previousValue: 9_990,
        currentValue: 120,
        meterReset: true,
        note: 'old meter ended at 10,050',
      }),
    ).toBe(120);
  });

  it('requires a note when the meter was reset, because the old final value must be recorded', () => {
    expect(() =>
      deriveKwh({ previousValue: 9_990, currentValue: 120, meterReset: true }),
    ).toThrow(ValidationError);
    expect(() =>
      deriveKwh({ previousValue: 9_990, currentValue: 120, meterReset: true, note: '   ' }),
    ).toThrow(/note/);
  });

  it('rejects a negative or non-integer reading', () => {
    expect(() => deriveKwh({ previousValue: 0, currentValue: -1 })).toThrow(ValidationError);
    expect(() => deriveKwh({ previousValue: 0, currentValue: 10.5 })).toThrow(ValidationError);
    expect(() => deriveKwh({ previousValue: -5, currentValue: 10 })).toThrow(ValidationError);
  });
});

describe('isOutlier', () => {
  it('flags a reading more than three times the trailing mean', () => {
    expect(isOutlier(12_500, 1_250)).toBe(true);
  });

  it('does not flag a reading exactly three times the mean', () => {
    expect(isOutlier(3_750, 1_250)).toBe(false);
  });

  it('does not flag a reading just under the threshold', () => {
    expect(isOutlier(3_749, 1_250)).toBe(false);
  });

  it('flags a reading one kWh over the threshold', () => {
    expect(isOutlier(3_751, 1_250)).toBe(true);
  });

  it('never flags a subscriber with no usable history', () => {
    expect(isOutlier(99_999, null)).toBe(false);
    expect(isOutlier(99_999, 0)).toBe(false);
  });

  it('uses a multiplier of three', () => {
    expect(OUTLIER_MULTIPLIER).toBe(3);
  });
});
