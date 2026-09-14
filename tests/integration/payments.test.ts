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
    `insert into billing_cycles (period, usd_per_kwh_cents, lbp_rate, status, issued_at, opened_by)
     values ('2026-09', 30, 89000, 'issued', now(), $1) returning id`,
    [owner.id],
  );
  cycleId = rows[0]!.id;
  await query(
    `insert into bills (subscriber_id, cycle_id, kwh, usd_per_kwh_cents, amount_usd_cents, lbp_rate, amount_lbp)
     values ($1, $2, 1250, 30, 37500, 89000, 33375000)`,
    [subscriber.id, cycleId],
  );
});

afterAll(async () => {
  await shutdown();
});

interface PaymentResponse {
  payment: {
    id: number;
    amountUsdCents: number;
    paidCurrency: string;
    amountLbp: number | null;
    lbpRateUsed: number | null;
    voidedAt: string | null;
  };
  balanceUsdCents: number;
}

describe('POST /api/payments', () => {
  it('records a cash payment in USD and reduces the balance', async () => {
    const res = await call<PaymentResponse>({
      method: 'POST',
      path: '/api/payments',
      token: collector.token,
      body: { subscriberId: subscriber.id, paidCurrency: 'USD', amountUsdCents: 20_000 },
    });
    expect(res.status).toBe(201);
    expect(res.body.payment.amountUsdCents).toBe(20_000);
    expect(res.body.balanceUsdCents).toBe(17_500);
  });

  it('records a payment in LBP, converting on the server', async () => {
    const res = await call<PaymentResponse>({
      method: 'POST',
      path: '/api/payments',
      token: collector.token,
      body: {
        subscriberId: subscriber.id,
        paidCurrency: 'LBP',
        amountLbp: 17_800_000,
        lbpRateUsed: 89_000,
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.payment.amountUsdCents).toBe(20_000);
    expect(res.body.payment.amountLbp).toBe(17_800_000);
    expect(res.body.payment.lbpRateUsed).toBe(89_000);
    expect(res.body.balanceUsdCents).toBe(17_500);
  });

  it('accepts a partial payment and leaves the rest owing', async () => {
    await call({
      method: 'POST',
      path: '/api/payments',
      token: collector.token,
      body: { subscriberId: subscriber.id, paidCurrency: 'USD', amountUsdCents: 5_000 },
    });
    const second = await call<PaymentResponse>({
      method: 'POST',
      path: '/api/payments',
      token: collector.token,
      body: { subscriberId: subscriber.id, paidCurrency: 'USD', amountUsdCents: 5_000 },
    });
    expect(second.body.balanceUsdCents).toBe(27_500);
  });

  it('refuses a subscriber trying to record their own payment', async () => {
    const res = await call({
      method: 'POST',
      path: '/api/payments',
      token: subscriber.token,
      body: { subscriberId: subscriber.id, paidCurrency: 'USD', amountUsdCents: 100 },
    });
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown subscriber and 400 for a bad amount', async () => {
    const missing = await call({
      method: 'POST',
      path: '/api/payments',
      token: collector.token,
      body: { subscriberId: 999_999, paidCurrency: 'USD', amountUsdCents: 100 },
    });
    expect(missing.status).toBe(404);

    const bad = await call({
      method: 'POST',
      path: '/api/payments',
      token: collector.token,
      body: { subscriberId: subscriber.id, paidCurrency: 'USD', amountUsdCents: 0 },
    });
    expect(bad.status).toBe(400);
  });
});

describe('POST /api/payments/:id/void', () => {
  async function record(amountUsdCents = 20_000) {
    const res = await call<PaymentResponse>({
      method: 'POST',
      path: '/api/payments',
      token: collector.token,
      body: { subscriberId: subscriber.id, paidCurrency: 'USD', amountUsdCents },
    });
    return res.body.payment.id;
  }

  it('restores the balance and leaves the row in place', async () => {
    const paymentId = await record();
    const res = await call<PaymentResponse>({
      method: 'POST',
      path: `/api/payments/${paymentId}/void`,
      token: owner.token,
      body: { reason: 'entered twice' },
    });
    expect(res.status).toBe(200);
    expect(res.body.balanceUsdCents).toBe(37_500);
    expect(res.body.payment.voidedAt).not.toBeNull();

    const rows = await query<{ void_reason: string; voided_by: number }>(
      'select void_reason, voided_by from payments where id = $1',
      [paymentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.void_reason).toBe('entered twice');
    expect(rows[0]!.voided_by).toBe(owner.id);
  });

  it('leaves an audit trail', async () => {
    const paymentId = await record();
    await call({
      method: 'POST',
      path: `/api/payments/${paymentId}/void`,
      token: owner.token,
      body: { reason: 'entered twice' },
    });
    const rows = await query<{ action: string }>(
      "select action from audit_log where entity = 'payment' order by id",
    );
    expect(rows.map((r) => r.action)).toEqual(['payment.record', 'payment.void']);
  });

  it('requires a reason', async () => {
    const paymentId = await record();
    const res = await call({
      method: 'POST',
      path: `/api/payments/${paymentId}/void`,
      token: owner.token,
      body: {},
    });
    expect(res.status).toBe(400);
  });

  it('refuses a second void of the same payment', async () => {
    const paymentId = await record();
    await call({
      method: 'POST',
      path: `/api/payments/${paymentId}/void`,
      token: owner.token,
      body: { reason: 'entered twice' },
    });
    const again = await call({
      method: 'POST',
      path: `/api/payments/${paymentId}/void`,
      token: owner.token,
      body: { reason: 'again' },
    });
    expect(again.status).toBe(409);
  });

  it('rejects a collector with 403', async () => {
    const paymentId = await record();
    const res = await call({
      method: 'POST',
      path: `/api/payments/${paymentId}/void`,
      token: collector.token,
      body: { reason: 'entered twice' },
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/payments and /api/me/payments', () => {
  beforeEach(async () => {
    await call({
      method: 'POST',
      path: '/api/payments',
      token: collector.token,
      body: { subscriberId: subscriber.id, paidCurrency: 'USD', amountUsdCents: 5_000 },
    });
  });

  it('lists payments for staff with the name of who took them', async () => {
    const res = await call<{ payments: { amountUsdCents: number; receivedByName: string }[] }>({
      path: '/api/payments',
      token: owner.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.payments[0]!.amountUsdCents).toBe(5_000);
    expect(res.body.payments[0]!.receivedByName).toBe('nabil');
  });

  it('filters by who received the payment', async () => {
    const mine = await call<{ payments: unknown[] }>({
      path: `/api/payments?receivedBy=${collector.id}`,
      token: collector.token,
    });
    expect(mine.body.payments).toHaveLength(1);

    const theirs = await call<{ payments: unknown[] }>({
      path: `/api/payments?receivedBy=${owner.id}`,
      token: collector.token,
    });
    expect(theirs.body.payments).toHaveLength(0);
  });

  it('shows a subscriber their own payments only', async () => {
    const other = await createSubscriber('1002');
    await call({
      method: 'POST',
      path: '/api/payments',
      token: collector.token,
      body: { subscriberId: other.id, paidCurrency: 'USD', amountUsdCents: 9_900 },
    });

    const res = await call<{ payments: { amountUsdCents: number }[] }>({
      path: `/api/me/payments?subscriberId=${other.id}`,
      token: subscriber.token,
    });
    expect(res.body.payments.map((p) => p.amountUsdCents)).toEqual([5_000]);
  });
});

describe('what recording a payment tells the subscriber', () => {
  it('adds a payment_recorded notification with the new balance in both languages', async () => {
    await call({
      method: 'POST',
      path: '/api/payments',
      token: collector.token,
      body: { subscriberId: subscriber.id, paidCurrency: 'USD', amountUsdCents: 20_000 },
    });

    const rows = await query<{ type: string; body_en: string; body_ar: string }>(
      'select type, body_en, body_ar from notifications where subscriber_id = $1',
      [subscriber.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('payment_recorded');
    expect(rows[0]!.body_en).toContain('$200.00');
    expect(rows[0]!.body_en).toContain('$175.00');
    expect(rows[0]!.body_ar.length).toBeGreaterThan(0);
  });

  it('adds no notification when the payment is voided', async () => {
    const recorded = await call<PaymentResponse>({
      method: 'POST',
      path: '/api/payments',
      token: collector.token,
      body: { subscriberId: subscriber.id, paidCurrency: 'USD', amountUsdCents: 20_000 },
    });
    await call({
      method: 'POST',
      path: `/api/payments/${recorded.body.payment.id}/void`,
      token: owner.token,
      body: { reason: 'entered twice' },
    });

    const rows = await query<{ count: number }>(
      'select count(*)::bigint as count from notifications where subscriber_id = $1',
      [subscriber.id],
    );
    expect(rows[0]!.count).toBe(1);
  });
});
