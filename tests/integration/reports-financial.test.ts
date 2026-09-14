import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { ensureSchema, resetTables, shutdown, call, createStaff, createSubscriber } from './helpers.js';
import { query } from '../../lib/db.js';
import type { StaffFixture } from './helpers.js';

let owner: StaffFixture;
let collector: StaffFixture;

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetTables();
  owner = await createStaff('owner', 'sami');
  collector = await createStaff('collector', 'nabil');
});

afterAll(async () => {
  await shutdown();
});

async function cycleFor(period: string) {
  const rows = await query<{ id: number }>(
    `insert into billing_cycles (period, usd_per_kwh_cents, lbp_rate, status, issued_at, opened_by)
     values ($1, 30, 89000, 'issued', now(), $2) returning id`,
    [period, owner.id],
  );
  return rows[0]!.id;
}

async function billFor(cycleId: number, code: string, kwh: number, amountUsdCents: number) {
  const sub = await createSubscriber(code);
  await query(
    `insert into bills (subscriber_id, cycle_id, kwh, usd_per_kwh_cents, amount_usd_cents, lbp_rate, amount_lbp)
     values ($1, $2, $3, 30, $4, 89000, 0)`,
    [sub.id, cycleId, kwh, amountUsdCents],
  );
  return sub.id;
}

describe('GET /api/reports/profit', () => {
  it('reports billed, collected, expenses, net, cost per kWh and the collection rate', async () => {
    const cycleId = await cycleFor('2026-09');
    const subscriberId = await billFor(cycleId, '1001', 2_000, 60_000);
    await query(
      `insert into payments (subscriber_id, amount_usd_cents, paid_currency, received_by)
       values ($1, 45000, 'USD', $2)`,
      [subscriberId, owner.id],
    );
    await call({
      method: 'POST',
      path: '/api/expenses',
      token: owner.token,
      body: { category: 'diesel', amountUsdCents: 30_000, liters: 200, spentAt: '2026-09-10' },
    });
    await call({
      method: 'POST',
      path: '/api/expenses',
      token: owner.token,
      body: { category: 'salary', amountUsdCents: 10_000, spentAt: '2026-09-28' },
    });

    const res = await call<{
      revenueBilledUsdCents: number;
      revenueCollectedUsdCents: number;
      kwhSold: number;
      expensesUsdCents: number;
      expensesByCategory: Record<string, number>;
      dieselLiters: number;
      netCollectedUsdCents: number;
      costPerKwhCentis: number;
      collectionRateBasisPoints: number;
    }>({ path: '/api/reports/profit?period=2026-09', token: owner.token });

    expect(res.status).toBe(200);
    expect(res.body.revenueBilledUsdCents).toBe(60_000);
    expect(res.body.revenueCollectedUsdCents).toBe(45_000);
    expect(res.body.kwhSold).toBe(2_000);
    expect(res.body.expensesUsdCents).toBe(40_000);
    expect(res.body.expensesByCategory.diesel).toBe(30_000);
    expect(res.body.dieselLiters).toBe(200);
    expect(res.body.netCollectedUsdCents).toBe(5_000);
    // $400 of expenses over 2,000 kWh is 20 cents per kWh
    expect(res.body.costPerKwhCentis).toBe(2_000);
    expect(res.body.collectionRateBasisPoints).toBe(7_500);
  });

  it('leaves a soft deleted expense out of the totals', async () => {
    const created = await call<{ expense: { id: number } }>({
      method: 'POST',
      path: '/api/expenses',
      token: owner.token,
      body: { category: 'other', amountUsdCents: 5_000, spentAt: '2026-09-10' },
    });
    await call({
      method: 'DELETE',
      path: `/api/expenses/${created.body.expense.id}`,
      token: owner.token,
    });

    const res = await call<{ expensesUsdCents: number }>({
      path: '/api/reports/profit?period=2026-09',
      token: owner.token,
    });
    expect(res.body.expensesUsdCents).toBe(0);
  });

  it('rejects a malformed period and a collector', async () => {
    expect(
      (await call({ path: '/api/reports/profit?period=2026-9', token: owner.token })).status,
    ).toBe(400);
    expect(
      (await call({ path: '/api/reports/profit?period=2026-09', token: collector.token })).status,
    ).toBe(403);
  });
});

describe('GET /api/reports/consumption', () => {
  it('totals kWh with the mean, the median and the top consumers', async () => {
    const cycleId = await cycleFor('2026-09');
    await billFor(cycleId, '2001', 100, 3_000);
    await billFor(cycleId, '2002', 200, 6_000);
    await billFor(cycleId, '2003', 900, 27_000);

    const res = await call<{
      totalKwh: number;
      subscriberCount: number;
      meanKwh: number;
      medianKwh: number;
      topConsumers: { kwh: number }[];
    }>({ path: '/api/reports/consumption?period=2026-09', token: owner.token });

    expect(res.status).toBe(200);
    expect(res.body.totalKwh).toBe(1_200);
    expect(res.body.subscriberCount).toBe(3);
    expect(res.body.meanKwh).toBe(400);
    expect(res.body.medianKwh).toBe(200);
    expect(res.body.topConsumers[0]!.kwh).toBe(900);
  });

  it('counts how many readings were estimated', async () => {
    const cycleId = await cycleFor('2026-09');
    const subscriberId = await billFor(cycleId, '2001', 100, 3_000);
    await query(
      `insert into meter_readings (subscriber_id, cycle_id, previous_value, current_value, kwh, is_estimated, entered_by)
       values ($1, $2, 0, 100, 100, true, $3)`,
      [subscriberId, cycleId, owner.id],
    );

    const res = await call<{ estimatedCount: number }>({
      path: '/api/reports/consumption?period=2026-09',
      token: owner.token,
    });
    expect(res.body.estimatedCount).toBe(1);
  });

  it('rejects a collector', async () => {
    const res = await call({
      path: '/api/reports/consumption?period=2026-09',
      token: collector.token,
    });
    expect(res.status).toBe(403);
  });
});

describe('the expense window of a profit report', () => {
  it('counts an expense by its Beirut calendar day, at both edges of the month', async () => {
    // 31 August belongs to August; 30 September belongs to September.
    for (const [spentAt, amountUsdCents] of [
      ['2026-08-31', 1_100],
      ['2026-09-01', 2_200],
      ['2026-09-30', 4_400],
      ['2026-10-01', 8_800],
    ] as const) {
      await call({
        method: 'POST',
        path: '/api/expenses',
        token: owner.token,
        body: { category: 'other', amountUsdCents, spentAt },
      });
    }

    const september = await call<{ expensesUsdCents: number }>({
      path: '/api/reports/profit?period=2026-09',
      token: owner.token,
    });
    expect(september.body.expensesUsdCents).toBe(6_600);

    const august = await call<{ expensesUsdCents: number }>({
      path: '/api/reports/profit?period=2026-08',
      token: owner.token,
    });
    expect(august.body.expensesUsdCents).toBe(1_100);
  });
});
