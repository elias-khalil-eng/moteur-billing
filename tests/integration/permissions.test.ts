import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { ensureSchema, resetTables, shutdown, call, createStaff, createSubscriber } from './helpers.js';
import { query } from '../../lib/db.js';
import type { StaffFixture, SubscriberFixture } from './helpers.js';

let owner: StaffFixture;
let collector: StaffFixture;
let subscriber: SubscriberFixture;
let cycleId: number;
let paymentId: number;

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetTables();
  owner = await createStaff('owner', 'sami');
  collector = await createStaff('collector', 'nabil');
  subscriber = await createSubscriber('1001');
  const cycle = await query<{ id: number }>(
    `insert into billing_cycles (period, usd_per_kwh_cents, lbp_rate, opened_by)
     values ('2026-09', 30, 89000, $1) returning id`,
    [owner.id],
  );
  cycleId = cycle[0]!.id;
  const payment = await query<{ id: number }>(
    `insert into payments (subscriber_id, amount_usd_cents, paid_currency, received_by)
     values ($1, 1000, 'USD', $2) returning id`,
    [subscriber.id, collector.id],
  );
  paymentId = payment[0]!.id;
});

afterAll(async () => {
  await shutdown();
});

describe('a collector token is refused by the server', () => {
  it('on every expense, profit, pricing, cycle-management and payment-void endpoint', async () => {
    const forbidden: { method: string; path: () => string; body?: unknown }[] = [
      { method: 'GET', path: () => '/api/expenses' },
      {
        method: 'POST',
        path: () => '/api/expenses',
        body: { category: 'other', amountUsdCents: 100, spentAt: '2026-09-15' },
      },
      { method: 'PATCH', path: () => '/api/expenses/1', body: { amountUsdCents: 100 } },
      { method: 'DELETE', path: () => '/api/expenses/1' },
      { method: 'GET', path: () => '/api/reports/profit?period=2026-09' },
      { method: 'GET', path: () => '/api/reports/consumption?period=2026-09' },
      { method: 'GET', path: () => '/api/reports/arrears' },
      {
        method: 'POST',
        path: () => '/api/cycles',
        body: { period: '2026-10', usdPerKwhCents: 30, lbpRate: 89_000 },
      },
      { method: 'PATCH', path: () => `/api/cycles/${cycleId}`, body: { usdPerKwhCents: 31 } },
      { method: 'POST', path: () => `/api/cycles/${cycleId}/close` },
      { method: 'GET', path: () => `/api/cycles/${cycleId}/issue-preview` },
      { method: 'POST', path: () => `/api/cycles/${cycleId}/issue`, body: {} },
      {
        method: 'POST',
        path: () => `/api/payments/${paymentId}/void`,
        body: { reason: 'no reason' },
      },
      { method: 'DELETE', path: () => `/api/cycles/${cycleId}/readings/${subscriber.id}` },
      {
        method: 'POST',
        path: () => '/api/subscribers',
        body: { code: '9999', name: 'Nope' },
      },
      { method: 'PATCH', path: () => `/api/subscribers/${subscriber.id}`, body: { name: 'Nope' } },
      { method: 'DELETE', path: () => `/api/subscribers/${subscriber.id}` },
      { method: 'POST', path: () => `/api/subscribers/${subscriber.id}/pin-reset` },
      { method: 'GET', path: () => '/api/staff' },
      {
        method: 'POST',
        path: () => '/api/staff',
        body: { username: 'nope', name: 'Nope', role: 'owner', password: 'a-long-password' },
      },
      { method: 'PATCH', path: () => `/api/staff/${collector.id}`, body: { name: 'Nope' } },
      {
        method: 'POST',
        path: () => `/api/staff/${collector.id}/password`,
        body: { password: 'a-long-password' },
      },
      { method: 'GET', path: () => '/api/requests' },
      { method: 'PATCH', path: () => '/api/requests/1', body: { status: 'resolved' } },
      { method: 'POST', path: () => '/api/messages', body: { title: 'No', body: 'Not yours' } },
    ];

    for (const route of forbidden) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call({
        method: route.method,
        path: route.path(),
        token: collector.token,
        ...(route.body === undefined ? {} : { body: route.body }),
      });
      expect(res.status, `${route.method} ${route.path()}`).toBe(403);
    }
  });

  it('but lets a collector do their own job', async () => {
    const allowed = [
      { method: 'GET', path: '/api/subscribers' },
      { method: 'GET', path: `/api/subscribers/${subscriber.id}` },
      { method: 'GET', path: '/api/cycles' },
      { method: 'GET', path: '/api/cycles/current' },
      { method: 'GET', path: `/api/cycles/${cycleId}/route` },
      { method: 'GET', path: `/api/cycles/${cycleId}/progress` },
      { method: 'GET', path: '/api/bills' },
      { method: 'GET', path: '/api/payments' },
      { method: 'GET', path: '/api/reports/collection' },
    ];

    for (const route of allowed) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call({ method: route.method, path: route.path, token: collector.token });
      expect(res.status, `${route.method} ${route.path}`).toBe(200);
    }
  });
});

describe('a subscriber token', () => {
  it('is refused on every staff route', async () => {
    const staffOnly = [
      '/api/subscribers',
      `/api/subscribers/${subscriber.id}`,
      '/api/cycles',
      '/api/bills',
      '/api/payments',
      '/api/expenses',
      '/api/reports/arrears',
      '/api/staff',
      '/api/requests',
    ];

    for (const path of staffOnly) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call({ path, token: subscriber.token });
      expect(res.status, path).toBe(403);
    }
  });

  it('cannot reach another subscriber by passing an id anywhere', async () => {
    const other = await createSubscriber('1002');
    await query(
      `insert into notifications (subscriber_id, type, title_ar, title_en, body_ar, body_en)
       values ($1, 'bill_issued', 'ع', 'Theirs', 'ع', 'theirs')`,
      [other.id],
    );
    await query(
      `insert into payments (subscriber_id, amount_usd_cents, paid_currency, received_by)
       values ($1, 5555, 'USD', $2)`,
      [other.id, owner.id],
    );

    const notifications = await call<{ notifications: { titleEn: string }[] }>({
      path: `/api/me/notifications?subscriberId=${other.id}`,
      token: subscriber.token,
    });
    expect(notifications.body.notifications).toHaveLength(0);

    const payments = await call<{ payments: { amountUsdCents: number }[] }>({
      path: `/api/me/payments?subscriberId=${other.id}`,
      token: subscriber.token,
    });
    expect(payments.body.payments.map((p) => p.amountUsdCents)).not.toContain(5_555);

    await query(
      `insert into service_requests (subscriber_id, kind, body)
       values ($1, 'other', 'Theirs to read')`,
      [other.id],
    );
    const requests = await call<{ requests: { body: string }[] }>({
      path: `/api/me/requests?subscriberId=${other.id}`,
      token: subscriber.token,
    });
    expect(requests.body.requests).toHaveLength(0);
  });
});
