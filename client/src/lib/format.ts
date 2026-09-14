/**
 * Display formatting only. Nothing here computes a monetary value: amounts arrive
 * from the server already computed, and these functions only render them.
 * Western digits in both languages, which is what Lebanese meter cards and
 * invoices use.
 */

import type { Language } from '../../../lib/types.js';

const TIME_ZONE = 'Asia/Beirut';
const NUMBER_LOCALE = 'en-US';

export function formatUsd(amountUsdCents: number): string {
  const sign = amountUsdCents < 0 ? '-' : '';
  const abs = Math.abs(amountUsdCents);
  const dollars = Math.trunc(abs / 100);
  const cents = abs % 100;
  return `${sign}$${dollars.toLocaleString(NUMBER_LOCALE)}.${String(cents).padStart(2, '0')}`;
}

export function formatLbp(amountLbp: number, language: Language): string {
  const unit = language === 'ar' ? 'ل.ل.' : 'LBP';
  return `${amountLbp.toLocaleString(NUMBER_LOCALE)} ${unit}`;
}

export function formatKwh(kwh: number, language: Language): string {
  const unit = language === 'ar' ? 'ك.و.س' : 'kWh';
  return `${kwh.toLocaleString(NUMBER_LOCALE)} ${unit}`;
}

export function formatNumber(value: number): string {
  return value.toLocaleString(NUMBER_LOCALE);
}

/** A price per kWh is small, so it is shown with its cents rather than rounded. */
export function formatPricePerKwh(usdPerKwhCents: number, language: Language): string {
  const unit = language === 'ar' ? 'ك.و.س' : 'kWh';
  return `${formatUsd(usdPerKwhCents)} / ${unit}`;
}

export function formatPeriod(period: string, language: Language): string {
  const [year, month] = period.split('-');
  if (year === undefined || month === undefined) return period;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, 15));
  return new Intl.DateTimeFormat(language === 'ar' ? 'ar' : 'en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
    numberingSystem: 'latn',
  }).format(date);
}

export function formatDate(iso: string, language: Language): string {
  return new Intl.DateTimeFormat(language === 'ar' ? 'ar' : 'en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: TIME_ZONE,
    numberingSystem: 'latn',
  }).format(new Date(iso));
}

export function formatDateTime(iso: string, language: Language): string {
  return new Intl.DateTimeFormat(language === 'ar' ? 'ar' : 'en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: TIME_ZONE,
    numberingSystem: 'latn',
  }).format(new Date(iso));
}

/**
 * Turns what someone typed into integer cents, by string arithmetic rather than by
 * multiplying a float: 8.35 * 100 is 834.9999999999999 in binary floating point, and
 * a monetary value must never pass through one. Returns null when the text is not a
 * usable amount, so the caller can show the field as invalid.
 */
export function parseUsdToCents(text: string): number | null {
  const trimmed = text.trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (match === null) return null;
  const dollars = Number(match[1]);
  const cents = Number((match[2] ?? '0').padEnd(2, '0'));
  if (!Number.isSafeInteger(dollars) || !Number.isSafeInteger(cents)) return null;
  const total = dollars * 100 + cents;
  return total > 0 ? total : null;
}

const dayKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The Beirut calendar day an instant falls in, as YYYY-MM-DD. */
export function beirutDayKey(iso: string | Date): string {
  return dayKeyFormatter.format(typeof iso === 'string' ? new Date(iso) : iso);
}

/** Hundredths of a cent, as sent by the profit report, shown as cents with two decimals. */
export function formatCentis(centis: number | null, language: Language): string {
  if (centis === null) return '—';
  const sign = centis < 0 ? '-' : '';
  const abs = Math.abs(centis);
  const unit = language === 'ar' ? 'ك.و.س' : 'kWh';
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}¢ / ${unit}`;
}

/** Basis points, as sent by the profit report, shown as a percentage with one decimal. */
export function formatBasisPoints(basisPoints: number | null): string {
  if (basisPoints === null) return '—';
  const whole = Math.trunc(basisPoints / 100);
  const fraction = Math.abs(basisPoints % 100);
  return `${whole}.${String(Math.round(fraction / 10)).padStart(1, '0')}%`;
}
