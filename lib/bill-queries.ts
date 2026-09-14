/**
 * Read models for bills: the staff list and single bill, and the two endpoints a
 * subscriber sees. Every subscriber query is scoped by the id the token carries,
 * never by an id in the request.
 */

import { query, maybeOne } from './db.js';
import { NotFoundError } from './errors.js';
import { getCycle } from './cycles.js';
import { computeBillFigures } from './billing.js';
import { TRAILING_CYCLES } from './readings.js';
import type { Bill } from './types.js';

interface BillRow extends Record<string, unknown> {
  id: number;
  subscriber_id: number;
  cycle_id: number;
  period: string;
  kwh: number;
  usd_per_kwh_cents: number;
  amount_usd_cents: number;
  lbp_rate: number;
  amount_lbp: number;
  issued_at: Date;
}

function toBill(row: BillRow): Bill {
  return {
    id: row.id,
    subscriberId: row.subscriber_id,
    cycleId: row.cycle_id,
    period: row.period,
    kwh: row.kwh,
    usdPerKwhCents: row.usd_per_kwh_cents,
    amountUsdCents: row.amount_usd_cents,
    lbpRate: row.lbp_rate,
    amountLbp: row.amount_lbp,
    issuedAt: row.issued_at.toISOString(),
  };
}

const BILL_COLUMNS = `b.id, b.subscriber_id, b.cycle_id, c.period, b.kwh, b.usd_per_kwh_cents,
                      b.amount_usd_cents, b.lbp_rate, b.amount_lbp, b.issued_at`;

export interface BillFilters {
  cycleId?: string | null;
  subscriberId?: string | null;
  unpaidOnly?: string | null;
}

function optionalId(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export interface BillWithSubscriber extends Bill {
  subscriberCode: string;
  subscriberName: string;
}

export async function listBills(filters: BillFilters): Promise<BillWithSubscriber[]> {
  const rows = await query<BillRow & { code: string; name: string }>(
    `select ${BILL_COLUMNS}, s.code, s.name
       from bills b
       join billing_cycles c on c.id = b.cycle_id
       join subscribers s on s.id = b.subscriber_id
       join subscriber_balances bal on bal.subscriber_id = b.subscriber_id
      where ($1::bigint is null or b.cycle_id = $1)
        and ($2::bigint is null or b.subscriber_id = $2)
        and ($3::boolean is false or bal.balance_usd_cents > 0)
      order by c.period desc, s.name`,
    [optionalId(filters.cycleId), optionalId(filters.subscriberId), filters.unpaidOnly === 'true'],
  );
  return rows.map((row) => ({
    ...toBill(row),
    subscriberCode: row.code,
    subscriberName: row.name,
  }));
}

export async function getBill(id: number): Promise<Bill> {
  const row = await maybeOne<BillRow>(
    `select ${BILL_COLUMNS} from bills b
       join billing_cycles c on c.id = b.cycle_id
      where b.id = $1`,
    [id],
  );
  if (row === null) throw new NotFoundError('bill', id);
  return toBill(row);
}

const HISTORY_LIMIT = 12;

export async function subscriberBills(subscriberId: number): Promise<Bill[]> {
  const rows = await query<BillRow>(
    `select ${BILL_COLUMNS} from bills b
       join billing_cycles c on c.id = b.cycle_id
      where b.subscriber_id = $1
      order by c.period desc
      limit $2`,
    [subscriberId, HISTORY_LIMIT],
  );
  return rows.map(toBill);
}

export interface CurrentBillView {
  bill: Bill | null;
  balanceUsdCents: number;
  billedUsdCents: number;
  paidUsdCents: number;
}

export async function subscriberCurrentBill(subscriberId: number): Promise<CurrentBillView> {
  const bill = await maybeOne<BillRow>(
    `select ${BILL_COLUMNS} from bills b
       join billing_cycles c on c.id = b.cycle_id
      where b.subscriber_id = $1
      order by c.period desc
      limit 1`,
    [subscriberId],
  );
  const balance = await maybeOne<{
    balance_usd_cents: number;
    billed_usd_cents: number;
    paid_usd_cents: number;
  }>('select * from subscriber_balances where subscriber_id = $1', [subscriberId]);

  return {
    bill: bill === null ? null : toBill(bill),
    balanceUsdCents: balance?.balance_usd_cents ?? 0,
    billedUsdCents: balance?.billed_usd_cents ?? 0,
    paidUsdCents: balance?.paid_usd_cents ?? 0,
  };
}

export interface IssuePreview {
  cycleId: number;
  period: string;
  readingsEntered: number;
  missingReadings: number;
  totalUsdCents: number;
  totalLbp: number;
  withEstimates: {
    billsCreated: number;
    totalUsdCents: number;
    totalLbp: number;
  };
}

/**
 * What issuing would produce, computed on the server so the confirmation dialog can
 * show real figures without the browser ever computing money.
 */
export async function previewIssue(cycleId: number): Promise<IssuePreview> {
  const cycle = await getCycle(cycleId);

  const readings = await query<{ kwh: number }>(
    `select r.kwh from meter_readings r
       join subscribers s on s.id = r.subscriber_id
      where r.cycle_id = $1 and s.deleted_at is null`,
    [cycleId],
  );

  const missing = await query<{ id: number }>(
    `select s.id from subscribers s
      where s.deleted_at is null and s.status = 'active'
        and not exists (
          select 1 from meter_readings r where r.subscriber_id = s.id and r.cycle_id = $1
        )`,
    [cycleId],
  );

  const estimates = await query<{ mean: number | null }>(
    `select avg(recent.kwh)::numeric as mean from (
       select b.kwh from bills b
         join billing_cycles c on c.id = b.cycle_id
        where b.subscriber_id = any($1::bigint[])
        order by c.period desc
        limit $2
     ) recent`,
    [missing.map((row) => row.id), TRAILING_CYCLES * Math.max(missing.length, 1)],
  );

  let totalUsdCents = 0;
  let totalLbp = 0;
  for (const reading of readings) {
    const figures = computeBillFigures(reading.kwh, cycle.usdPerKwhCents, cycle.lbpRate);
    totalUsdCents += figures.amountUsdCents;
    totalLbp += figures.amountLbp;
  }

  const estimatedKwhEach = Math.round(estimates[0]?.mean ?? 0);
  const estimateFigures = computeBillFigures(
    estimatedKwhEach,
    cycle.usdPerKwhCents,
    cycle.lbpRate,
  );

  return {
    cycleId: cycle.id,
    period: cycle.period,
    readingsEntered: readings.length,
    missingReadings: missing.length,
    totalUsdCents,
    totalLbp,
    withEstimates: {
      billsCreated: readings.length + missing.length,
      totalUsdCents: totalUsdCents + estimateFigures.amountUsdCents * missing.length,
      totalLbp: totalLbp + estimateFigures.amountLbp * missing.length,
    },
  };
}
