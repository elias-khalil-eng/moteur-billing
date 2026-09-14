/**
 * Reports. Arrears ages a subscriber's debt by allocating their payments to their
 * oldest bills first, because a payment is applied to the balance rather than to a
 * named bill and the debt still has to be aged somehow.
 */

import { query } from './db.js';
import { ValidationError } from './errors.js';
import { arrearsBucket, ARREARS_BUCKETS } from './billing.js';
import type { ArrearsBucket } from './billing.js';
import { daysBetween, sqlTimeZone } from './dates.js';

export interface AgeableBill {
  id: string | number;
  period: string;
  issuedAt: Date;
  amountUsdCents: number;
}

export interface ArrearsAllocation {
  balanceUsdCents: number;
  buckets: Record<ArrearsBucket, number>;
  oldestUnpaidDays: number | null;
  unpaidCycles: number;
}

function emptyBuckets(): Record<ArrearsBucket, number> {
  return { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
}

/**
 * Oldest bill first. Anything a subscriber has paid clears their oldest debt, which
 * is both what actually happens at the door and what keeps the buckets honest.
 */
export function allocateArrears(
  bills: readonly AgeableBill[],
  paidUsdCents: number,
  asOf: Date,
): ArrearsAllocation {
  const ordered = [...bills].sort((a, b) => a.issuedAt.getTime() - b.issuedAt.getTime());
  const buckets = emptyBuckets();
  let remainingPayment = Math.max(0, paidUsdCents);
  let balanceUsdCents = 0;
  let oldestUnpaidDays: number | null = null;
  let unpaidCycles = 0;

  for (const bill of ordered) {
    const applied = Math.min(remainingPayment, bill.amountUsdCents);
    remainingPayment -= applied;
    const outstanding = bill.amountUsdCents - applied;
    if (outstanding <= 0) continue;

    const ageDays = daysBetween(bill.issuedAt, asOf);
    buckets[arrearsBucket(ageDays)] += outstanding;
    balanceUsdCents += outstanding;
    unpaidCycles += 1;
    if (oldestUnpaidDays === null) oldestUnpaidDays = ageDays;
  }

  return { balanceUsdCents, buckets, oldestUnpaidDays, unpaidCycles };
}

function disconnectThresholdUsdCents(): number {
  const raw = Number(process.env.DISCONNECT_THRESHOLD_USD_CENTS ?? 5_000);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 5_000;
}

const DISCONNECT_UNPAID_CYCLES = 3;

export interface ArrearsEntry {
  subscriberId: number;
  code: string;
  name: string;
  zone: string | null;
  status: string;
  balanceUsdCents: number;
  buckets: Record<ArrearsBucket, number>;
  oldestUnpaidDays: number | null;
  unpaidCycles: number;
  disconnectCandidate: boolean;
}

export interface ArrearsReport {
  asOf: string;
  thresholdUsdCents: number;
  totals: Record<ArrearsBucket, number>;
  totalOwedUsdCents: number;
  entries: ArrearsEntry[];
}

export async function arrearsReport(asOf: Date = new Date()): Promise<ArrearsReport> {
  const bills = await query<{
    subscriber_id: number;
    id: number;
    period: string;
    issued_at: Date;
    amount_usd_cents: number;
  }>(
    `select b.subscriber_id, b.id, c.period, b.issued_at, b.amount_usd_cents
       from bills b
       join billing_cycles c on c.id = b.cycle_id
       join subscribers s on s.id = b.subscriber_id
      where s.deleted_at is null
      order by b.issued_at`,
  );

  const subscribers = await query<{
    id: number;
    code: string;
    name: string;
    zone: string | null;
    status: string;
    paid_usd_cents: number;
  }>(
    `select s.id, s.code, s.name, s.zone, s.status, bal.paid_usd_cents
       from subscribers s
       join subscriber_balances bal on bal.subscriber_id = s.id
      where s.deleted_at is null`,
  );

  const billsBySubscriber = new Map<number, AgeableBill[]>();
  for (const bill of bills) {
    const list = billsBySubscriber.get(bill.subscriber_id) ?? [];
    list.push({
      id: bill.id,
      period: bill.period,
      issuedAt: bill.issued_at,
      amountUsdCents: bill.amount_usd_cents,
    });
    billsBySubscriber.set(bill.subscriber_id, list);
  }

  const threshold = disconnectThresholdUsdCents();
  const totals = emptyBuckets();
  const entries: ArrearsEntry[] = [];

  for (const subscriber of subscribers) {
    const allocation = allocateArrears(
      billsBySubscriber.get(subscriber.id) ?? [],
      subscriber.paid_usd_cents,
      asOf,
    );
    if (allocation.balanceUsdCents <= 0) continue;

    for (const bucket of ARREARS_BUCKETS) {
      totals[bucket] += allocation.buckets[bucket];
    }
    entries.push({
      subscriberId: subscriber.id,
      code: subscriber.code,
      name: subscriber.name,
      zone: subscriber.zone,
      status: subscriber.status,
      balanceUsdCents: allocation.balanceUsdCents,
      buckets: allocation.buckets,
      oldestUnpaidDays: allocation.oldestUnpaidDays,
      unpaidCycles: allocation.unpaidCycles,
      disconnectCandidate:
        allocation.balanceUsdCents >= threshold ||
        allocation.unpaidCycles >= DISCONNECT_UNPAID_CYCLES,
    });
  }

  entries.sort((a, b) => b.balanceUsdCents - a.balanceUsdCents);

  return {
    asOf: asOf.toISOString(),
    thresholdUsdCents: threshold,
    totals,
    totalOwedUsdCents: entries.reduce((sum, entry) => sum + entry.balanceUsdCents, 0),
    entries,
  };
}

export interface CollectionRow {
  key: string;
  label: string;
  amountUsdCents: number;
  paymentCount: number;
}

export interface CollectionReport {
  groupBy: 'day' | 'collector';
  from: string | null;
  to: string | null;
  totalUsdCents: number;
  rows: CollectionRow[];
}

export interface CollectionFilters {
  from?: string | null;
  to?: string | null;
  groupBy?: string | null;
  receivedBy?: number | null;
}

function optionalDate(value: string | null | undefined, field: string): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(`${field} must be a date`, { field });
  }
  return parsed;
}

export async function collectionReport(filters: CollectionFilters): Promise<CollectionReport> {
  const groupBy = filters.groupBy === 'collector' ? 'collector' : 'day';
  const from = optionalDate(filters.from, 'from');
  const to = optionalDate(filters.to, 'to');

  // sqlTimeZone rejects anything but a plain IANA name, because this one is
  // interpolated: the grouping expression itself changes with groupBy, so the zone
  // cannot travel as a bound parameter here.
  const groupExpression =
    groupBy === 'collector'
      ? 's.id::text'
      : `to_char(p.paid_at at time zone '${sqlTimeZone()}', 'YYYY-MM-DD')`;
  const labelExpression = groupBy === 'collector' ? 's.name' : groupExpression;

  const rows = await query<{
    key: string;
    label: string;
    amount_usd_cents: number;
    payment_count: number;
  }>(
    `select ${groupExpression} as key,
            ${labelExpression} as label,
            sum(p.amount_usd_cents)::bigint as amount_usd_cents,
            count(*)::bigint as payment_count
       from payments p
       join staff s on s.id = p.received_by
      where p.voided_at is null
        and ($1::timestamptz is null or p.paid_at >= $1)
        and ($2::timestamptz is null or p.paid_at < $2)
        and ($3::bigint is null or p.received_by = $3)
      group by key, label
      order by key desc`,
    [from, to, filters.receivedBy ?? null],
  );

  return {
    groupBy,
    from: from === null ? null : from.toISOString(),
    to: to === null ? null : to.toISOString(),
    totalUsdCents: rows.reduce((sum, row) => sum + row.amount_usd_cents, 0),
    rows: rows.map((row) => ({
      key: row.key,
      label: row.label,
      amountUsdCents: row.amount_usd_cents,
      paymentCount: row.payment_count,
    })),
  };
}

/**
 * Cost per kWh in hundredths of a cent. A whole-cent figure would be too coarse to
 * compare against a price of 30 cents, and a float has no place near money, so the
 * scale is finer and the value stays an integer.
 */
export function costPerKwhCentis(totalExpensesUsdCents: number, kwhSold: number): number | null {
  if (kwhSold <= 0) return null;
  return Math.round((totalExpensesUsdCents * 100) / kwhSold);
}

/** Collected over billed, in basis points, so the ratio is an integer too. */
export function collectionRateBasisPoints(
  collectedUsdCents: number,
  billedUsdCents: number,
): number | null {
  if (billedUsdCents <= 0) return null;
  return Math.round((collectedUsdCents * 10_000) / billedUsdCents);
}
