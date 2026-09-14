/**
 * Read models for subscriber list and detail screens. Split from subscribers.ts,
 * which owns validation and writes, to keep both files inside the size the project
 * works to. Balance always comes from the subscriber_balances view.
 */

import { query, maybeOne } from './db.js';
import { ValidationError } from './errors.js';
import { oneOf } from './validate.js';
import { getSubscriber, toSubscriber, STATUSES } from './subscribers.js';
import { getCurrentCycle } from './cycles.js';
import { usdCentsToLbpRounded } from './money.js';
import type { SubscriberRow } from './subscribers.js';
import type { Paged, Subscriber, SubscriberWithBalance } from './types.js';

export interface ListQuery {
  q?: string | null;
  status?: string | null;
  zone?: string | null;
  hasDebt?: string | null;
  page?: string | null;
  pageSize?: string | null;
}

const MAX_PAGE_SIZE = 200;

function positiveIntParam(value: string | null | undefined, fallback: number, max: number): number {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ValidationError('page and pageSize must be whole numbers above zero');
  }
  return Math.min(parsed, max);
}

interface ListRow extends SubscriberRow {
  balance_usd_cents: number;
  billed_usd_cents: number;
  paid_usd_cents: number;
  total: number;
}

export async function listSubscribers(params: ListQuery): Promise<Paged<SubscriberWithBalance>> {
  const page = positiveIntParam(params.page, 1, 10_000);
  const pageSize = positiveIntParam(params.pageSize, 50, MAX_PAGE_SIZE);
  const status = params.status ? oneOf({ status: params.status }, 'status', STATUSES) : null;
  const search = params.q?.trim() ? `%${params.q.trim()}%` : null;
  const zone = params.zone?.trim() ? params.zone.trim() : null;
  const hasDebt = params.hasDebt === 'true';

  const rows = await query<ListRow>(
    `select s.id, s.code, s.name, s.phone, s.zone, s.address, s.meter_serial, s.status,
            s.notes, s.created_at,
            b.balance_usd_cents, b.billed_usd_cents, b.paid_usd_cents,
            count(*) over ()::bigint as total
       from subscribers s
       join subscriber_balances b on b.subscriber_id = s.id
      where s.deleted_at is null
        and ($1::text is null or s.status = $1)
        and ($2::text is null or s.zone = $2)
        and ($3::text is null or s.name ilike $3 or s.code ilike $3)
        and ($4::boolean is false or b.balance_usd_cents > 0)
      order by s.name, s.code
      limit $5 offset $6`,
    [status, zone, search, hasDebt, pageSize, (page - 1) * pageSize],
  );

  return {
    items: rows.map((row) => ({
      ...toSubscriber(row),
      balanceUsdCents: row.balance_usd_cents,
      billedUsdCents: row.billed_usd_cents,
      paidUsdCents: row.paid_usd_cents,
    })),
    page,
    pageSize,
    total: rows[0]?.total ?? 0,
  };
}

export interface SubscriberDetail {
  subscriber: Subscriber;
  balanceUsdCents: number;
  billedUsdCents: number;
  paidUsdCents: number;
  /** The balance in LBP at the rate of the cycle in force, for a payment taken in cash. */
  balanceLbp: number | null;
  lbpRate: number | null;
  bills: {
    id: number;
    period: string;
    kwh: number;
    usdPerKwhCents: number;
    amountUsdCents: number;
    lbpRate: number;
    amountLbp: number;
    issuedAt: string;
  }[];
  payments: {
    id: number;
    amountUsdCents: number;
    paidCurrency: string;
    amountLbp: number | null;
    lbpRateUsed: number | null;
    paidAt: string;
    receivedByName: string;
    note: string | null;
    voidedAt: string | null;
    voidReason: string | null;
  }[];
}

const RECENT_BILLS = 12;
const RECENT_PAYMENTS = 24;

export async function getSubscriberDetail(id: number): Promise<SubscriberDetail> {
  const subscriber = await getSubscriber(id);
  const balance = await maybeOne<{
    balance_usd_cents: number;
    billed_usd_cents: number;
    paid_usd_cents: number;
  }>('select * from subscriber_balances where subscriber_id = $1', [id]);

  const bills = await query<{
    id: number;
    period: string;
    kwh: number;
    usd_per_kwh_cents: number;
    amount_usd_cents: number;
    lbp_rate: number;
    amount_lbp: number;
    issued_at: Date;
  }>(
    `select b.id, c.period, b.kwh, b.usd_per_kwh_cents, b.amount_usd_cents, b.lbp_rate,
            b.amount_lbp, b.issued_at
       from bills b join billing_cycles c on c.id = b.cycle_id
      where b.subscriber_id = $1
      order by c.period desc
      limit $2`,
    [id, RECENT_BILLS],
  );

  const payments = await query<{
    id: number;
    amount_usd_cents: number;
    paid_currency: string;
    amount_lbp: number | null;
    lbp_rate_used: number | null;
    paid_at: Date;
    received_by_name: string;
    note: string | null;
    voided_at: Date | null;
    void_reason: string | null;
  }>(
    `select p.id, p.amount_usd_cents, p.paid_currency, p.amount_lbp, p.lbp_rate_used,
            p.paid_at, st.name as received_by_name, p.note, p.voided_at, p.void_reason
       from payments p join staff st on st.id = p.received_by
      where p.subscriber_id = $1
      order by p.paid_at desc
      limit $2`,
    [id, RECENT_PAYMENTS],
  );

  const cycle = await getCurrentCycle();
  const balanceUsdCents = balance?.balance_usd_cents ?? 0;

  return {
    subscriber,
    balanceUsdCents,
    billedUsdCents: balance?.billed_usd_cents ?? 0,
    paidUsdCents: balance?.paid_usd_cents ?? 0,
    balanceLbp: cycle === null ? null : usdCentsToLbpRounded(balanceUsdCents, cycle.lbpRate),
    lbpRate: cycle?.lbpRate ?? null,
    bills: bills.map((b) => ({
      id: b.id,
      period: b.period,
      kwh: b.kwh,
      usdPerKwhCents: b.usd_per_kwh_cents,
      amountUsdCents: b.amount_usd_cents,
      lbpRate: b.lbp_rate,
      amountLbp: b.amount_lbp,
      issuedAt: b.issued_at.toISOString(),
    })),
    payments: payments.map((p) => ({
      id: p.id,
      amountUsdCents: p.amount_usd_cents,
      paidCurrency: p.paid_currency,
      amountLbp: p.amount_lbp,
      lbpRateUsed: p.lbp_rate_used,
      paidAt: p.paid_at.toISOString(),
      receivedByName: p.received_by_name,
      note: p.note,
      voidedAt: p.voided_at === null ? null : p.voided_at.toISOString(),
      voidReason: p.void_reason,
    })),
  };
}
