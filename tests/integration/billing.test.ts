import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { ensureSchema, resetTables, shutdown, call, createStaff, createSubscriber } from './helpers.js';
import { query } from '../../lib/db.js';
import type { StaffFixture, SubscriberFixture } from './helpers.js';

let owner: StaffFixture;
let collector: StaffFixture;
let subscriber: SubscriberFixture;
let cycleId: number;

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetTables();
  owner = await createStaff('owner', 'sami');
  collector = await createStaff('collector', 'nabil');
  subscriber = await createSubscriber('1001', '482100', 'Sami Haddad', 'A');
  const rows = await query<{ id: number }>(
    `insert into billing_cycles (period, usd_per_kwh_cents, lbp_rate, opened_by)
     values ('2026-09', 30, 89000, $1) returning id`,
    [owner.id],
  );
  cycleId = rows[0]!.id;
});

afterAll(async () => {
  await shutdown();
});

interface IssueResponse {
  cycle: { status: string };
  billsCreated: number;
  estimatedReadings: number;
  totalUsdCents: number;
  totalLbp: number;
  alreadyIssued: boolean;
}

async function enterReading(subscriberId: number, currentValue: number) {
  return call({
    method: 'PUT',
    path: `/api/cycles/${cycleId}/readings/${subscriberId}`,
    token: collector.token,
    body: { currentValue },
  });
}

function issue(body?: Record<string, unknown>, token = owner.token) {
  return call<IssueResponse & { error: { code: string; details?: Record<string, unknown> } }>({
    method: 'POST',
    path: `/api/cycles/${cycleId}/issue`,
    token,
    body: body ?? {},
  });
}

describe('POST /api/cycles/:id/issue', () => {
  it('creates one bill per reading, snapshotting the price and rate', async () => {
    await enterReading(subscriber.id, 1_250);
    const res = await issue();

    expect(res.status).toBe(200);
    expect(res.body.billsCreated).toBe(1);
    expect(res.body.cycle.status).toBe('issued');
    expect(res.body.totalUsdCents).toBe(37_500);

    const bills = await query<{
      kwh: number;
      usd_per_kwh_cents: number;
      amount_usd_cents: number;
      lbp_rate: number;
      amount_lbp: number;
    }>('select * from bills where cycle_id = $1', [cycleId]);
    expect(bills).toHaveLength(1);
    expect(bills[0]!.kwh).toBe(1_250);
    expect(bills[0]!.usd_per_kwh_cents).toBe(30);
    expect(bills[0]!.amount_usd_cents).toBe(37_500);
    expect(bills[0]!.lbp_rate).toBe(89_000);
    expect(bills[0]!.amount_lbp).toBe(33_375_000);
  });

  it('is safe to trigger twice: the second call creates no extra bills', async () => {
    await enterReading(subscriber.id, 1_250);
    const first = await issue();
    const second = await issue();

    expect(first.body.alreadyIssued).toBe(false);
    expect(second.status).toBe(200);
    expect(second.body.alreadyIssued).toBe(true);

    const rows = await query<{ count: number }>(
      'select count(*)::bigint as count from bills where cycle_id = $1',
      [cycleId],
    );
    expect(rows[0]!.count).toBe(1);
  });

  it('refuses to issue while an active subscriber has no reading', async () => {
    await createSubscriber('1002');
    await enterReading(subscriber.id, 1_250);

    const res = await issue();
    expect(res.status).toBe(400);
    expect(res.body.error.details?.missingReadings).toBe(1);
    expect(res.body.error.details?.requiresEstimateConfirmation).toBe(true);

    const rows = await query<{ count: number }>(
      'select count(*)::bigint as count from bills where cycle_id = $1',
      [cycleId],
    );
    expect(rows[0]!.count).toBe(0);
  });
});

describe('issuing with estimates', () => {
  it('estimates the missing readings when the owner confirms', async () => {
    const other = await createSubscriber('1002');
    await enterReading(subscriber.id, 1_250);

    const res = await issue({ estimateMissing: true });
    expect(res.status).toBe(200);
    expect(res.body.billsCreated).toBe(2);
    expect(res.body.estimatedReadings).toBe(1);

    const estimated = await query<{ kwh: number; is_estimated: boolean }>(
      'select kwh, is_estimated from meter_readings where subscriber_id = $1 and cycle_id = $2',
      [other.id, cycleId],
    );
    // No billed history, so the estimate is zero rather than a guess.
    expect(estimated[0]!.kwh).toBe(0);
    expect(estimated[0]!.is_estimated).toBe(true);
  });

  it('estimates from the mean of the last three billed cycles', async () => {
    const other = await createSubscriber('1002');
    for (const [index, kwh] of [1_200, 1_250, 1_300].entries()) {
      const past = await query<{ id: number }>(
        `insert into billing_cycles (period, usd_per_kwh_cents, lbp_rate, status, issued_at, opened_by)
         values ($1, 30, 89000, 'closed', now(), $2) returning id`,
        [`2025-0${index + 1}`, owner.id],
      );
      await query(
        `insert into bills (subscriber_id, cycle_id, kwh, usd_per_kwh_cents, amount_usd_cents, lbp_rate, amount_lbp)
         values ($1, $2, $3, 30, $4, 89000, 0)`,
        [other.id, past[0]!.id, kwh, kwh * 30],
      );
    }
    await enterReading(subscriber.id, 1_250);

    await issue({ estimateMissing: true });
    const estimated = await query<{ kwh: number }>(
      'select kwh from meter_readings where subscriber_id = $1 and cycle_id = $2',
      [other.id, cycleId],
    );
    expect(estimated[0]!.kwh).toBe(1_250);
  });
});

describe('what issuing leaves behind', () => {
  it('writes one notification per subscriber, in both languages', async () => {
    await enterReading(subscriber.id, 1_250);
    await issue();

    const rows = await query<{ type: string; title_ar: string; title_en: string; bill_id: number }>(
      'select type, title_ar, title_en, bill_id from notifications where subscriber_id = $1',
      [subscriber.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('bill_issued');
    expect(rows[0]!.title_ar.length).toBeGreaterThan(0);
    expect(rows[0]!.title_en).toBe('New bill');
    expect(rows[0]!.bill_id).not.toBeNull();
  });

  it('records the issue in the audit log', async () => {
    await enterReading(subscriber.id, 1_250);
    await issue();
    const rows = await query<{ action: string }>(
      "select action from audit_log where entity = 'cycle' and action = 'cycle.issue'",
    );
    expect(rows).toHaveLength(1);
  });

  it('rejects a collector with 403', async () => {
    await enterReading(subscriber.id, 1_250);
    const res = await issue({}, collector.token);
    expect(res.status).toBe(403);
  });

  it('locks readings once the cycle is issued', async () => {
    await enterReading(subscriber.id, 1_250);
    await issue();
    const res = await enterReading(subscriber.id, 1_300);
    expect(res.status).toBe(409);
  });

  it('leaves an issued bill untouched when the next cycle uses a different price', async () => {
    await enterReading(subscriber.id, 1_250);
    await issue();
    await call({ method: 'POST', path: `/api/cycles/${cycleId}/close`, token: owner.token });
    await call({
      method: 'POST',
      path: '/api/cycles',
      token: owner.token,
      body: { period: '2026-10', usdPerKwhCents: 45, lbpRate: 95_000 },
    });

    const bills = await query<{ usd_per_kwh_cents: number; amount_usd_cents: number }>(
      'select usd_per_kwh_cents, amount_usd_cents from bills where cycle_id = $1',
      [cycleId],
    );
    expect(bills[0]!.usd_per_kwh_cents).toBe(30);
    expect(bills[0]!.amount_usd_cents).toBe(37_500);
  });
});

describe('the bills API', () => {
  async function issuedBill() {
    await enterReading(subscriber.id, 1_250);
    await issue();
    const rows = await query<{ id: number }>('select id from bills where cycle_id = $1', [cycleId]);
    return rows[0]!.id;
  }

  it('lists bills for staff, filtered by cycle', async () => {
    await issuedBill();
    const res = await call<{ bills: { period: string; amountUsdCents: number }[] }>({
      path: `/api/bills?cycleId=${cycleId}`,
      token: collector.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.bills).toHaveLength(1);
    expect(res.body.bills[0]!.period).toBe('2026-09');
  });

  it('filters to subscribers who still owe something', async () => {
    await issuedBill();
    const paid = await createSubscriber('1002');
    await query(
      `insert into payments (subscriber_id, amount_usd_cents, paid_currency, received_by)
       values ($1, 999999, 'USD', $2)`,
      [paid.id, owner.id],
    );

    const res = await call<{ bills: { subscriberId: number }[] }>({
      path: '/api/bills?unpaidOnly=true',
      token: owner.token,
    });
    expect(res.body.bills.map((b) => b.subscriberId)).toEqual([subscriber.id]);
  });

  it('returns one bill by id for staff', async () => {
    const billId = await issuedBill();
    const res = await call<{ bill: { id: number; kwh: number } }>({
      path: `/api/bills/${billId}`,
      token: collector.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.bill.kwh).toBe(1_250);
  });

  it('refuses a subscriber token on the staff bills routes', async () => {
    await issuedBill();
    const res = await call({ path: '/api/bills', token: subscriber.token });
    expect(res.status).toBe(403);
  });
});

describe('what a subscriber can see', () => {
  beforeEach(async () => {
    await enterReading(subscriber.id, 1_250);
    await issue();
  });

  it('sees their own bill history', async () => {
    const res = await call<{ bills: { period: string; amountUsdCents: number; amountLbp: number }[] }>(
      { path: '/api/me/bills', token: subscriber.token },
    );
    expect(res.status).toBe(200);
    expect(res.body.bills).toHaveLength(1);
    expect(res.body.bills[0]!.amountUsdCents).toBe(37_500);
    expect(res.body.bills[0]!.amountLbp).toBe(33_375_000);
  });

  it('sees the current bill and the balance behind it', async () => {
    const res = await call<{
      bill: { period: string; kwh: number; amountUsdCents: number } | null;
      balanceUsdCents: number;
    }>({ path: '/api/me/bills/current', token: subscriber.token });
    expect(res.status).toBe(200);
    expect(res.body.bill?.period).toBe('2026-09');
    expect(res.body.balanceUsdCents).toBe(37_500);
  });

  it('never sees another subscriber, whatever id is passed', async () => {
    const other = await createSubscriber('1002');
    await query(
      `insert into bills (subscriber_id, cycle_id, kwh, usd_per_kwh_cents, amount_usd_cents, lbp_rate, amount_lbp)
       values ($1, $2, 999, 30, 29970, 89000, 0)`,
      [other.id, cycleId],
    );

    const res = await call<{ bills: { kwh: number }[] }>({
      path: `/api/me/bills?subscriberId=${other.id}`,
      token: subscriber.token,
    });
    expect(res.body.bills.map((b) => b.kwh)).toEqual([1_250]);
  });

  it('refuses a staff token on the subscriber routes', async () => {
    const res = await call({ path: '/api/me/bills', token: owner.token });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/cycles/:id/issue-preview', () => {
  it('reports what issuing would produce, without writing anything', async () => {
    await enterReading(subscriber.id, 1_250);
    await createSubscriber('1002');

    const res = await call<{
      readingsEntered: number;
      missingReadings: number;
      totalUsdCents: number;
      totalLbp: number;
      withEstimates: { billsCreated: number };
    }>({ path: `/api/cycles/${cycleId}/issue-preview`, token: owner.token });

    expect(res.status).toBe(200);
    expect(res.body.readingsEntered).toBe(1);
    expect(res.body.missingReadings).toBe(1);
    expect(res.body.totalUsdCents).toBe(37_500);
    expect(res.body.totalLbp).toBe(33_375_000);
    expect(res.body.withEstimates.billsCreated).toBe(2);

    const bills = await query<{ count: number }>(
      'select count(*)::bigint as count from bills where cycle_id = $1',
      [cycleId],
    );
    expect(bills[0]!.count).toBe(0);
  });

  it('rejects a collector with 403', async () => {
    const res = await call({
      path: `/api/cycles/${cycleId}/issue-preview`,
      token: collector.token,
    });
    expect(res.status).toBe(403);
  });
});
