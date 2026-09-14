/**
 * Period and time-zone helpers. Every timestamp is stored in UTC; every business
 * boundary (a billing month, a collector's day, the age of a bill) is a Beirut
 * wall-clock boundary, so the conversion happens here and nowhere else.
 */

import { ValidationError } from './errors.js';

export const APP_TIMEZONE = process.env.APP_TIMEZONE ?? 'Asia/Beirut';

const PERIOD_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MS_PER_DAY = 86_400_000;

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TIMEZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClockIn(instant: Date): WallClock {
  const parts = partsFormatter.formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };
  // Intl renders midnight as hour 24 in some ICU versions; normalise it to 0.
  const hour = read('hour') % 24;
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour,
    minute: read('minute'),
    second: read('second'),
  };
}

/** Offset of the app time zone, in milliseconds, at a given instant. */
function zoneOffsetMs(instant: Date): number {
  const wall = wallClockIn(instant);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Turn a Beirut wall-clock time into the UTC instant it names. The offset depends
 * on the instant, so it is resolved twice: the first pass gets close enough that
 * the second pass lands on the right side of a DST change.
 */
function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  let offset = zoneOffsetMs(new Date(naive));
  offset = zoneOffsetMs(new Date(naive - offset));
  return new Date(naive - offset);
}

export function isPeriod(value: unknown): value is string {
  return typeof value === 'string' && PERIOD_PATTERN.test(value);
}

export function assertPeriod(value: unknown): asserts value is string {
  if (!isPeriod(value)) {
    throw new ValidationError('period must be a month in YYYY-MM form, for example 2026-09', {
      field: 'period',
      value,
    });
  }
}

function splitPeriod(period: string): { year: number; month: number } {
  assertPeriod(period);
  const match = PERIOD_PATTERN.exec(period);
  // The pattern matched, so both groups are present.
  return { year: Number(match![1]), month: Number(match![2]) };
}

function toPeriod(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

export function nextPeriod(period: string): string {
  const { year, month } = splitPeriod(period);
  return month === 12 ? toPeriod(year + 1, 1) : toPeriod(year, month + 1);
}

export function previousPeriod(period: string): string {
  const { year, month } = splitPeriod(period);
  return month === 1 ? toPeriod(year - 1, 12) : toPeriod(year, month - 1);
}

export function comparePeriods(a: string, b: string): number {
  assertPeriod(a);
  assertPeriod(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Half-open range [start, end) covering the Beirut month, expressed in UTC. */
export function periodRangeUtc(period: string): { start: Date; end: Date } {
  const { year, month } = splitPeriod(period);
  const start = zonedWallClockToUtc(year, month, 1);
  const nextMonth = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  const end = zonedWallClockToUtc(nextMonth.year, nextMonth.month, 1);
  return { start, end };
}

export function periodOf(instant: Date): string {
  const wall = wallClockIn(instant);
  return toPeriod(wall.year, wall.month);
}

export function currentPeriod(now: Date = new Date()): string {
  return periodOf(now);
}

export function beirutDayKey(instant: Date): string {
  const wall = wallClockIn(instant);
  return `${toPeriod(wall.year, wall.month)}-${String(wall.day).padStart(2, '0')}`;
}

/**
 * Whole Beirut calendar days from one instant to another. Counting calendar days
 * rather than 24-hour spans is what makes "this bill is 31 days old" match what
 * the owner sees on a calendar, and keeps arrears buckets stable across DST.
 */
export function daysBetween(from: Date, to: Date): number {
  const fromMidnight = Date.parse(`${beirutDayKey(from)}T00:00:00Z`);
  const toMidnight = Date.parse(`${beirutDayKey(to)}T00:00:00Z`);
  return Math.round((toMidnight - fromMidnight) / MS_PER_DAY);
}

const TIME_ZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

/**
 * A time zone name that is safe to interpolate into SQL. Postgres takes a parameter
 * for `at time zone` in most places, but not where the expression itself is chosen
 * conditionally, so this guard exists for those. The value comes from the operator's
 * own environment, and it still has to be a plain IANA name.
 */
export function sqlTimeZone(zone: string = APP_TIMEZONE): string {
  if (!TIME_ZONE_PATTERN.test(zone) || zone.length > 64) {
    throw new ValidationError('APP_TIMEZONE is not a valid time zone name', { field: 'timezone' });
  }
  return zone;
}
