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

async function billFrom(subscriberId: number, period: string, daysAgo: number, cents: number) {
  const cycle = await query<{ id: number }>(
    `insert into billing_cycles (period, usd_per_kwh_cents, lbp_rate, status, issued_at, opened_by)
     values ($1, 30, 89000, 'closed', now(), $2)
     on conflict (period) do update set period = excluded.period
     returning id`,
    [period, owner.id],
  );
  await query(
    `insert into bills (subscriber_id, cycle_id, kwh, usd_per_kwh_cents, amount_usd_cents, lbp_rate, amount_lbp, issued_at)
     values ($1, $2, 100, 30, $3, 89000, 0, now() - make_interval(days => $4))`,
    [subscriberId, cycle[0]!.id, cents, daysAgo],
  );
}

interface ArrearsResponse {
  totals: Record<string, number>;
  totalOwedUsdCents: number;
  thresholdUsdCents: number;
  entries: {
    code: string;
    balanceUsdCents: number;
    unpaidCycles: number;
    disconnectCandidate: boolean;
    buckets: Record<string, number>;
  }[];
}

describe('GET /api/reports/arrears', () => {
  it('ages debt into buckets and leaves out anyone who has paid', async () => {
    const owing = await createSubscriber('1001');
    const settled = await createSubscriber('1002');
    await billFrom(owing.id, '2026-08', 45, 3_000);
    await billFrom(settled.id, '2026-07', 100, 2_000);
    await query(
      `insert into payments (subscriber_id, amount_usd_cents, paid_currency, received_by)
       values ($1, 2000, 'USD', $2)`,
      [settled.id, owner.id],
    );

    const res = await call<ArrearsResponse>({ path: '/api/reports/arrears', token: owner.token });
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e) => e.code)).toEqual(['1001']);
    expect(res.body.totals['31-60']).toBe(3_000);
    expect(res.body.totalOwedUsdCents).toBe(3_000);
  });

  it('sorts the worst debtors first', async () => {
    const small = await createSubscriber('1001');
    const large = await createSubscriber('1002');
    await billFrom(small.id, '2026-08', 10, 1_000);
    await billFrom(large.id, '2026-07', 10, 9_000);

    const res = await call<ArrearsResponse>({ path: '/api/reports/arrears', token: owner.token });
    expect(res.body.entries.map((e) => e.code)).toEqual(['1002', '1001']);
  });

  it('marks a subscriber over the threshold as a disconnect candidate', async () => {
    const big = await createSubscriber('1001');
    const smallDebt = await createSubscriber('1002');
    await billFrom(big.id, '2026-08', 10, 6_000);
    await billFrom(smallDebt.id, '2026-07', 10, 500);

    const res = await call<ArrearsResponse>({ path: '/api/reports/arrears', token: owner.token });
    const byCode = new Map(res.body.entries.map((e) => [e.code, e]));
    expect(res.body.thresholdUsdCents).toBe(5_000);
    expect(byCode.get('1001')?.disconnectCandidate).toBe(true);
    expect(byCode.get('1002')?.disconnectCandidate).toBe(false);
  });

  it('marks a subscriber with three unpaid cycles as a candidate, whatever the amount', async () => {
    const persistent = await createSubscriber('1001');
    await billFrom(persistent.id, '2026-06', 100, 300);
    await billFrom(persistent.id, '2026-07', 70, 300);
    await billFrom(persistent.id, '2026-08', 40, 300);

    const res = await call<ArrearsResponse>({ path: '/api/reports/arrears', token: owner.token });
    expect(res.body.entries[0]!.unpaidCycles).toBe(3);
    expect(res.body.entries[0]!.disconnectCandidate).toBe(true);
  });

  it('rejects a collector with 403', async () => {
    const res = await call({ path: '/api/reports/arrears', token: collector.token });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/reports/collection', () => {
  beforeEach(async () => {
    const sub = await createSubscriber('1001');
    await query(
      `insert into payments (subscriber_id, amount_usd_cents, paid_currency, received_by, paid_at)
       values ($1, 5000, 'USD', $2, now()), ($1, 3000, 'USD', $3, now())`,
      [sub.id, owner.id, collector.id],
    );
    await query(
      `insert into payments (subscriber_id, amount_usd_cents, paid_currency, received_by, voided_at, void_reason)
       values ($1, 9900, 'USD', $2, now(), 'entered twice')`,
      [sub.id, collector.id],
    );
  });

  it('totals collections by collector, excluding voided payments', async () => {
    const res = await call<{ totalUsdCents: number; rows: { label: string; amountUsdCents: number }[] }>(
      { path: '/api/reports/collection?groupBy=collector', token: owner.token },
    );
    expect(res.status).toBe(200);
    expect(res.body.totalUsdCents).toBe(8_000);
    const byLabel = new Map(res.body.rows.map((r) => [r.label, r.amountUsdCents]));
    expect(byLabel.get('sami')).toBe(5_000);
    expect(byLabel.get('nabil')).toBe(3_000);
  });

  it('groups by Beirut day by default', async () => {
    const res = await call<{ groupBy: string; rows: { key: string }[] }>({
      path: '/api/reports/collection',
      token: owner.token,
    });
    expect(res.body.groupBy).toBe('day');
    expect(res.body.rows[0]!.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('shows a collector only their own collections', async () => {
    const res = await call<{ totalUsdCents: number; rows: { label: string }[] }>({
      path: '/api/reports/collection?groupBy=collector',
      token: collector.token,
    });
    expect(res.body.totalUsdCents).toBe(3_000);
    expect(res.body.rows.map((r) => r.label)).toEqual(['nabil']);
  });
});
