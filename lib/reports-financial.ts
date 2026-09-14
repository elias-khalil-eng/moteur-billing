/**
 * Profit and consumption. Split from reports.ts, which owns arrears and collection,
 * to keep both files near the size the project works to.
 *
 * A range is either a billing period (YYYY-MM, the business identity of a cycle) or
 * an explicit from/to. Every figure is an integer.
 */

import { query, maybeOne } from './db.js';
import { ValidationError } from './errors.js';
import { APP_TIMEZONE, isPeriod, periodRangeUtc } from './dates.js';
import { collectionRateBasisPoints, costPerKwhCentis } from './reports.js';
import type { ExpenseCategory } from './types.js';

export interface RangeQuery {
  period?: string | null;
  from?: string | null;
  to?: string | null;
}

export interface ResolvedRange {
  period: string | null;
  start: Date | null;
  end: Date | null;
}

export function resolveRange(input: RangeQuery): ResolvedRange {
  if (input.period) {
    if (!isPeriod(input.period)) {
      throw new ValidationError('period must be a month in YYYY-MM form, for example 2026-09', {
        field: 'period',
      });
    }
    const { start, end } = periodRangeUtc(input.period);
    return { period: input.period, start, end };
  }

  const parse = (value: string | null | undefined, field: string): Date | null => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new ValidationError(`${field} must be a date`, { field });
    }
    return parsed;
  };
  return { period: null, start: parse(input.from, 'from'), end: parse(input.to, 'to') };
}

export interface ProfitReport {
  period: string | null;
  from: string | null;
  to: string | null;
  revenueBilledUsdCents: number;
  revenueCollectedUsdCents: number;
  kwhSold: number;
  expensesUsdCents: number;
  expensesByCategory: Record<ExpenseCategory, number>;
  dieselLiters: number;
  netCollectedUsdCents: number;
  netBilledUsdCents: number;
  costPerKwhCentis: number | null;
  collectionRateBasisPoints: number | null;
}

const EMPTY_CATEGORIES: Record<ExpenseCategory, number> = {
  diesel: 0,
  maintenance: 0,
  salary: 0,
  other: 0,
};

export async function profitReport(input: RangeQuery): Promise<ProfitReport> {
  const range = resolveRange(input);

  const billed = await maybeOne<{ amount: number; kwh: number }>(
    `select coalesce(sum(b.amount_usd_cents), 0)::bigint as amount,
            coalesce(sum(b.kwh), 0)::bigint as kwh
       from bills b
      where ($1::text is null or b.cycle_id in (select id from billing_cycles where period = $1))
        and ($2::timestamptz is null or b.issued_at >= $2)
        and ($3::timestamptz is null or b.issued_at < $3)`,
    [range.period, range.period === null ? range.start : null, range.period === null ? range.end : null],
  );

  const collected = await maybeOne<{ amount: number }>(
    `select coalesce(sum(amount_usd_cents), 0)::bigint as amount
       from payments
      where voided_at is null
        and ($1::timestamptz is null or paid_at >= $1)
        and ($2::timestamptz is null or paid_at < $2)`,
    [range.start, range.end],
  );

  // spent_at is a calendar date, and the range boundaries are UTC instants of Beirut
  // midnight. Reading them back in UTC put 31 August inside September and left 30
  // September out of it, so the conversion has to go through the app time zone.
  const expenses = await query<{ category: ExpenseCategory; amount: number; liters: number }>(
    `select category,
            coalesce(sum(amount_usd_cents), 0)::bigint as amount,
            coalesce(sum(liters), 0)::numeric as liters
       from expenses
      where deleted_at is null
        and ($1::timestamptz is null or spent_at >= ($1 at time zone $3)::date)
        and ($2::timestamptz is null or spent_at < ($2 at time zone $3)::date)
      group by category`,
    [range.start, range.end, APP_TIMEZONE],
  );

  const expensesByCategory = { ...EMPTY_CATEGORIES };
  let expensesUsdCents = 0;
  let dieselLiters = 0;
  for (const row of expenses) {
    expensesByCategory[row.category] = row.amount;
    expensesUsdCents += row.amount;
    if (row.category === 'diesel') dieselLiters = row.liters;
  }

  const revenueBilledUsdCents = billed?.amount ?? 0;
  const revenueCollectedUsdCents = collected?.amount ?? 0;
  const kwhSold = billed?.kwh ?? 0;

  return {
    period: range.period,
    from: range.start === null ? null : range.start.toISOString(),
    to: range.end === null ? null : range.end.toISOString(),
    revenueBilledUsdCents,
    revenueCollectedUsdCents,
    kwhSold,
    expensesUsdCents,
    expensesByCategory,
    dieselLiters,
    netCollectedUsdCents: revenueCollectedUsdCents - expensesUsdCents,
    netBilledUsdCents: revenueBilledUsdCents - expensesUsdCents,
    costPerKwhCentis: costPerKwhCentis(expensesUsdCents, kwhSold),
    collectionRateBasisPoints: collectionRateBasisPoints(
      revenueCollectedUsdCents,
      revenueBilledUsdCents,
    ),
  };
}

export interface ConsumptionReport {
  period: string | null;
  totalKwh: number;
  subscriberCount: number;
  meanKwh: number | null;
  medianKwh: number | null;
  estimatedCount: number;
  topConsumers: { subscriberId: number; code: string; name: string; kwh: number }[];
}

const TOP_CONSUMERS = 10;

export async function consumptionReport(input: RangeQuery): Promise<ConsumptionReport> {
  const range = resolveRange(input);

  const rows = await query<{ subscriber_id: number; code: string; name: string; kwh: number }>(
    `select b.subscriber_id, s.code, s.name, b.kwh
       from bills b
       join subscribers s on s.id = b.subscriber_id
      where ($1::text is null or b.cycle_id in (select id from billing_cycles where period = $1))
        and ($2::timestamptz is null or b.issued_at >= $2)
        and ($3::timestamptz is null or b.issued_at < $3)
      order by b.kwh desc`,
    [range.period, range.period === null ? range.start : null, range.period === null ? range.end : null],
  );

  const estimated = await maybeOne<{ count: number }>(
    `select count(*)::bigint as count from meter_readings r
      where r.is_estimated
        and ($1::text is null or r.cycle_id in (select id from billing_cycles where period = $1))`,
    [range.period],
  );

  const values = rows.map((row) => row.kwh);
  const totalKwh = values.reduce((sum, kwh) => sum + kwh, 0);
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianKwh =
    sorted.length === 0
      ? null
      : sorted.length % 2 === 1
        ? sorted[middle]!
        : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);

  return {
    period: range.period,
    totalKwh,
    subscriberCount: rows.length,
    meanKwh: rows.length === 0 ? null : Math.round(totalKwh / rows.length),
    medianKwh,
    estimatedCount: estimated?.count ?? 0,
    topConsumers: rows.slice(0, TOP_CONSUMERS).map((row) => ({
      subscriberId: row.subscriber_id,
      code: row.code,
      name: row.name,
      kwh: row.kwh,
    })),
  };
}
