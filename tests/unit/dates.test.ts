import { describe, it, expect } from 'vitest';
import {
  assertPeriod,
  isPeriod,
  currentPeriod,
  nextPeriod,
  previousPeriod,
  comparePeriods,
  periodRangeUtc,
  periodOf,
  beirutDayKey,
  daysBetween,
  sqlTimeZone,
} from '../../lib/dates.js';
import { ValidationError } from '../../lib/errors.js';

describe('period validation', () => {
  it('accepts a well formed YYYY-MM', () => {
    expect(isPeriod('2026-09')).toBe(true);
    expect(isPeriod('2026-01')).toBe(true);
    expect(isPeriod('2026-12')).toBe(true);
  });

  it('rejects a malformed or impossible period', () => {
    expect(isPeriod('2026-13')).toBe(false);
    expect(isPeriod('2026-00')).toBe(false);
    expect(isPeriod('2026-9')).toBe(false);
    expect(isPeriod('26-09')).toBe(false);
    expect(isPeriod('2026/09')).toBe(false);
    expect(isPeriod('')).toBe(false);
  });

  it('assertPeriod throws a ValidationError naming the field', () => {
    expect(() => assertPeriod('2026-13')).toThrow(ValidationError);
    expect(() => assertPeriod('2026-13')).toThrow(/period/);
    expect(() => assertPeriod('2026-09')).not.toThrow();
  });
});

describe('period arithmetic', () => {
  it('steps to the next period, rolling the year', () => {
    expect(nextPeriod('2026-09')).toBe('2026-10');
    expect(nextPeriod('2026-12')).toBe('2027-01');
  });

  it('steps to the previous period, rolling the year', () => {
    expect(previousPeriod('2026-09')).toBe('2026-08');
    expect(previousPeriod('2026-01')).toBe('2025-12');
  });

  it('compares periods chronologically', () => {
    expect(comparePeriods('2026-09', '2026-10')).toBeLessThan(0);
    expect(comparePeriods('2027-01', '2026-12')).toBeGreaterThan(0);
    expect(comparePeriods('2026-09', '2026-09')).toBe(0);
  });
});

describe('periodRangeUtc', () => {
  it('spans a summer month from Beirut midnight to Beirut midnight (UTC+3)', () => {
    const { start, end } = periodRangeUtc('2026-09');
    expect(start.toISOString()).toBe('2026-08-31T21:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-30T21:00:00.000Z');
  });

  it('spans a winter month at UTC+2', () => {
    const { start, end } = periodRangeUtc('2026-01');
    expect(start.toISOString()).toBe('2025-12-31T22:00:00.000Z');
    expect(end.toISOString()).toBe('2026-01-31T22:00:00.000Z');
  });

  it('rejects a malformed period', () => {
    expect(() => periodRangeUtc('2026-13')).toThrow(ValidationError);
  });
});

describe('periodOf and currentPeriod', () => {
  it('names the Beirut month an instant falls in', () => {
    expect(periodOf(new Date('2026-09-15T10:00:00Z'))).toBe('2026-09');
  });

  it('uses the Beirut calendar, not UTC, at the month edge', () => {
    // 2026-08-31 22:00 UTC is already 2026-09-01 01:00 in Beirut
    expect(periodOf(new Date('2026-08-31T22:00:00Z'))).toBe('2026-09');
  });

  it('currentPeriod is the period of the given instant', () => {
    expect(currentPeriod(new Date('2026-09-15T10:00:00Z'))).toBe('2026-09');
  });
});

describe('beirutDayKey', () => {
  it('formats an instant as the Beirut calendar day', () => {
    expect(beirutDayKey(new Date('2026-09-15T10:00:00Z'))).toBe('2026-09-15');
  });

  it('rolls to the next day after Beirut midnight', () => {
    // 21:30 UTC is 00:30 the next day in Beirut during summer time
    expect(beirutDayKey(new Date('2026-09-15T21:30:00Z'))).toBe('2026-09-16');
  });

  it('stays on the same day just before Beirut midnight', () => {
    expect(beirutDayKey(new Date('2026-09-15T20:30:00Z'))).toBe('2026-09-15');
  });
});

describe('daysBetween', () => {
  it('counts whole Beirut calendar days', () => {
    expect(daysBetween(new Date('2026-09-01T09:00:00Z'), new Date('2026-09-01T20:00:00Z'))).toBe(0);
    expect(daysBetween(new Date('2026-09-01T09:00:00Z'), new Date('2026-09-02T05:00:00Z'))).toBe(1);
    expect(daysBetween(new Date('2026-09-01T09:00:00Z'), new Date('2026-10-01T09:00:00Z'))).toBe(30);
  });

  it('counts across a DST change without losing or gaining a day', () => {
    // Lebanon leaves summer time on the last Sunday of October 2026, the 25th
    expect(daysBetween(new Date('2026-10-20T09:00:00Z'), new Date('2026-10-30T09:00:00Z'))).toBe(10);
  });

  it('is negative when the second instant is earlier', () => {
    expect(daysBetween(new Date('2026-09-10T09:00:00Z'), new Date('2026-09-01T09:00:00Z'))).toBe(-9);
  });
});

describe('sqlTimeZone', () => {
  it('returns the configured zone when it is a plain IANA name', () => {
    expect(sqlTimeZone('Asia/Beirut')).toBe('Asia/Beirut');
    expect(sqlTimeZone('UTC')).toBe('UTC');
    expect(sqlTimeZone('America/Argentina/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires');
  });

  it('refuses anything that could close a quote or run another statement', () => {
    // This value is interpolated into SQL, so the guard is the whole point.
    for (const bad of ["Asia/Beirut'; drop table bills; --", 'Asia Beirut', "'", '', 'a"b']) {
      expect(() => sqlTimeZone(bad), bad).toThrow();
    }
  });
});
