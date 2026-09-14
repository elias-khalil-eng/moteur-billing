/**
 * Bill generation and the ledger derived from it.
 *
 * Issuing a cycle happens in one transaction: readings in, bills out, cycle marked
 * issued, notifications written, audit entry recorded. Push goes out afterwards,
 * outside the transaction, because a failed push must never roll back a bill.
 */

import { query, transaction } from './db.js';
import type { Queryable } from './db.js';
import { ConflictError, ValidationError } from './errors.js';
import { assertIntegerAmount, billAmountUsdCents, usdCentsToLbpRounded } from './money.js';
import { assertTransition, getCycle, toCycle } from './cycles.js';
import { writeAudit, actorFields } from './audit.js';
import { asObject, optionalBoolean, rejectUnknownFields } from './validate.js';
import { TRAILING_CYCLES } from './readings.js';
import { billIssuedText, insertNotifications } from './notify.js';
import { dispatchToSubscribers } from './push.js';
import type { Actor, BillingCycle } from './types.js';

export const ARREARS_BUCKETS = ['0-30', '31-60', '61-90', '90+'] as const;
export type ArrearsBucket = (typeof ARREARS_BUCKETS)[number];

export interface BillFigures {
  amountUsdCents: number;
  amountLbp: number;
}

export function computeBillFigures(
  kwh: number,
  usdPerKwhCents: number,
  lbpRate: number,
): BillFigures {
  const amountUsdCents = billAmountUsdCents(kwh, usdPerKwhCents);
  return { amountUsdCents, amountLbp: usdCentsToLbpRounded(amountUsdCents, lbpRate) };
}

export function deriveBalance(billedUsdCents: number, paidUsdCents: number): number {
  assertIntegerAmount(billedUsdCents, 'billedUsdCents');
  assertIntegerAmount(paidUsdCents, 'paidUsdCents');
  return billedUsdCents - paidUsdCents;
}

/** The mean of whatever billed history exists, rounded to whole kWh; 0 with none. */
export function estimateKwh(recentKwh: readonly number[]): number {
  if (recentKwh.length === 0) return 0;
  const total = recentKwh.reduce((sum, kwh) => sum + kwh, 0);
  return Math.round(total / recentKwh.length);
}

export function arrearsBucket(ageDays: number): ArrearsBucket {
  if (ageDays <= 30) return '0-30';
  if (ageDays <= 60) return '31-60';
  if (ageDays <= 90) return '61-90';
  return '90+';
}

export interface IssueSummary {
  cycle: BillingCycle;
  billsCreated: number;
  estimatedReadings: number;
  totalUsdCents: number;
  totalLbp: number;
  alreadyIssued: boolean;
}

interface ReadingForBilling extends Record<string, unknown> {
  subscriber_id: number;
  kwh: number;
}

async function missingReadingSubscribers(tx: Queryable, cycleId: number): Promise<number[]> {
  const rows = await tx.query<{ id: number }>(
    `select s.id from subscribers s
      where s.deleted_at is null and s.status = 'active'
        and not exists (
          select 1 from meter_readings r
           where r.subscriber_id = s.id and r.cycle_id = $1
        )`,
    [cycleId],
  );
  return rows.map((row) => row.id);
}

async function estimateFor(tx: Queryable, subscriberId: number): Promise<number> {
  const rows = await tx.query<{ kwh: number }>(
    `select b.kwh from bills b
       join billing_cycles c on c.id = b.cycle_id
      where b.subscriber_id = $1
      order by c.period desc
      limit $2`,
    [subscriberId, TRAILING_CYCLES],
  );
  return estimateKwh(rows.map((row) => row.kwh));
}

interface IssueOptions {
  estimateMissing: boolean;
}

function parseIssueOptions(body: unknown): IssueOptions {
  if (body === undefined) return { estimateMissing: false };
  const input = asObject(body);
  rejectUnknownFields(input, ['estimateMissing']);
  return { estimateMissing: optionalBoolean(input, 'estimateMissing') ?? false };
}

/**
 * Everything a bill depends on happens in one transaction. The unique constraint on
 * (subscriber_id, cycle_id) plus the status assertion means a double tap cannot
 * double-bill: the second call finds the cycle already issued and returns what the
 * first one produced.
 */
export async function issueCycle(
  cycleId: number,
  body: unknown,
  actor: Actor,
): Promise<IssueSummary> {
  const options = parseIssueOptions(body);
  const existing = await getCycle(cycleId);
  if (existing.status === 'issued' || existing.status === 'closed') {
    return { ...(await summariseIssued(existing)), alreadyIssued: true };
  }
  assertTransition(existing.status, 'issued');

  const summary = await runIssueTransaction(cycleId, options, actor);

  // Outside the transaction on purpose: a push failure must never roll back a bill.
  if (!summary.alreadyIssued && summary.billsCreated > 0) {
    const recipients = await query<{ subscriber_id: number }>(
      'select subscriber_id from bills where cycle_id = $1',
      [cycleId],
    );
    await dispatchToSubscribers(
      recipients.map((row) => row.subscriber_id),
      {
        title: 'New bill',
        body: `${summary.cycle.period}`,
        url: '/',
      },
    ).catch((err: unknown) => {
      console.error(JSON.stringify({ action: 'push.dispatch', cycleId, error: String(err) }));
    });
  }

  return summary;
}

async function runIssueTransaction(
  cycleId: number,
  options: IssueOptions,
  actor: Actor,
): Promise<IssueSummary> {
  return transaction(async (tx) => {
    const locked = await tx.query<Record<string, unknown>>(
      `select id, period, usd_per_kwh_cents, lbp_rate, status, opened_at, issued_at, closed_at,
              opened_by
         from billing_cycles where id = $1 for update`,
      [cycleId],
    );
    const row = locked[0];
    if (row === undefined) throw new ConflictError('That cycle no longer exists');
    const cycle = toCycle(row as never);
    if (cycle.status !== 'open') {
      // Another request issued it while this one waited for the row lock.
      // On the transaction's own connection: the row lock is still held here.
      return { ...(await summariseIssued(cycle, tx)), alreadyIssued: true };
    }

    const missing = await missingReadingSubscribers(tx, cycleId);
    if (missing.length > 0 && !options.estimateMissing) {
      throw new ValidationError(
        `${missing.length} active subscribers have no reading for this cycle. ` +
          'Enter them, or confirm estimating them.',
        {
          missingReadings: missing.length,
          requiresEstimateConfirmation: true,
          messageAr:
            `${missing.length} مشترك فعّال بلا قراءة في هذه الدورة. ` +
            'أدخل القراءات أو أكّد التقدير.',
        },
      );
    }

    for (const subscriberId of missing) {
      // Sequential: each estimate reads that subscriber's own billed history.
      // eslint-disable-next-line no-await-in-loop
      const kwh = await estimateFor(tx, subscriberId);
      // eslint-disable-next-line no-await-in-loop
      const previous = await tx.query<{ current_value: number }>(
        `select r.current_value from meter_readings r
           join billing_cycles c on c.id = r.cycle_id
          where r.subscriber_id = $1 and r.cycle_id <> $2
          order by c.period desc limit 1`,
        [subscriberId, cycleId],
      );
      const previousValue = previous[0]?.current_value ?? 0;
      // eslint-disable-next-line no-await-in-loop
      await tx.query(
        `insert into meter_readings
           (subscriber_id, cycle_id, previous_value, current_value, kwh, is_estimated, entered_by, note)
         values ($1, $2, $3, $4, $5, true, $6, 'estimated at issue from the last three cycles')`,
        [subscriberId, cycleId, previousValue, previousValue + kwh, kwh, actor.id],
      );
    }

    const readings = await tx.query<ReadingForBilling>(
      `select r.subscriber_id, r.kwh from meter_readings r
         join subscribers s on s.id = r.subscriber_id
        where r.cycle_id = $1 and s.deleted_at is null`,
      [cycleId],
    );

    let totalUsdCents = 0;
    let totalLbp = 0;
    const notifications = [];
    for (const reading of readings) {
      const figures = computeBillFigures(reading.kwh, cycle.usdPerKwhCents, cycle.lbpRate);
      totalUsdCents += figures.amountUsdCents;
      totalLbp += figures.amountLbp;
      // eslint-disable-next-line no-await-in-loop
      const inserted = await tx.query<{ id: number }>(
        `insert into bills
           (subscriber_id, cycle_id, kwh, usd_per_kwh_cents, amount_usd_cents, lbp_rate, amount_lbp)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (subscriber_id, cycle_id) do nothing
         returning id`,
        [
          reading.subscriber_id,
          cycleId,
          reading.kwh,
          cycle.usdPerKwhCents,
          figures.amountUsdCents,
          cycle.lbpRate,
          figures.amountLbp,
        ],
      );
      const billId = inserted[0]?.id ?? null;
      notifications.push({
        subscriberId: reading.subscriber_id,
        type: 'bill_issued' as const,
        billId,
        text: billIssuedText({
          period: cycle.period,
          kwh: reading.kwh,
          amountUsdCents: figures.amountUsdCents,
          amountLbp: figures.amountLbp,
        }),
      });
    }

    const updated = await tx.query<Record<string, unknown>>(
      `update billing_cycles set status = 'issued', issued_at = now()
        where id = $1 and status = 'open'
        returning id, period, usd_per_kwh_cents, lbp_rate, status, opened_at, issued_at,
                  closed_at, opened_by`,
      [cycleId],
    );
    const issued = toCycle(updated[0] as never);

    await insertNotifications(tx, notifications);
    await writeAudit(
      {
        ...actorFields(actor),
        action: 'cycle.issue',
        entity: 'cycle',
        entityId: cycleId,
        after: {
          billsCreated: readings.length,
          estimatedReadings: missing.length,
          totalUsdCents,
          totalLbp,
        },
      },
      tx,
    );

    return {
      cycle: issued,
      billsCreated: readings.length,
      estimatedReadings: missing.length,
      totalUsdCents,
      totalLbp,
      alreadyIssued: false,
    };
  });
}

async function summariseIssued(
  cycle: BillingCycle,
  tx?: Queryable,
): Promise<Omit<IssueSummary, 'alreadyIssued'>> {
  const run = tx ? tx.query.bind(tx) : query;
  const rows = await run<{
    bills: number;
    estimated: number;
    total_usd_cents: number;
    total_lbp: number;
  }>(
    `select count(*)::bigint as bills,
            count(*) filter (where r.is_estimated)::bigint as estimated,
            coalesce(sum(b.amount_usd_cents), 0)::bigint as total_usd_cents,
            coalesce(sum(b.amount_lbp), 0)::bigint as total_lbp
       from bills b
       left join meter_readings r
         on r.cycle_id = b.cycle_id and r.subscriber_id = b.subscriber_id
      where b.cycle_id = $1`,
    [cycle.id],
  );
  const row = rows[0];
  return {
    cycle,
    billsCreated: row?.bills ?? 0,
    estimatedReadings: row?.estimated ?? 0,
    totalUsdCents: row?.total_usd_cents ?? 0,
    totalLbp: row?.total_lbp ?? 0,
  };
}
