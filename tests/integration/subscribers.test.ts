import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  ensureSchema,
  resetTables,
  shutdown,
  call,
  createStaff,
  createSubscriber,
} from './helpers.js';
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

interface CreateResponse {
  subscriber: { id: number; code: string; name: string; status: string };
  pin: string;
}

describe('POST /api/subscribers', () => {
  it('creates a subscriber and returns the generated PIN exactly once', async () => {
    const res = await call<CreateResponse>({
      method: 'POST',
      path: '/api/subscribers',
      token: owner.token,
      body: { code: '1042', name: 'Sami Haddad', zone: 'A', phone: '03123456' },
    });
    expect(res.status).toBe(201);
    expect(res.body.pin).toMatch(/^\d{6}$/);
    expect(res.body.subscriber.code).toBe('1042');
    expect(res.body.subscriber.status).toBe('active');

    const fetched = await call<Record<string, unknown>>({
      path: `/api/subscribers/${res.body.subscriber.id}`,
      token: owner.token,
    });
    expect(JSON.stringify(fetched.body)).not.toContain(res.body.pin);
  });

  it('stores only a hash of the PIN', async () => {
    const res = await call<CreateResponse>({
      method: 'POST',
      path: '/api/subscribers',
      token: owner.token,
      body: { code: '1042', name: 'Sami Haddad' },
    });
    const rows = await query<{ pin_hash: string }>(
      'select pin_hash from subscribers where id = $1',
      [res.body.subscriber.id],
    );
    expect(rows[0]!.pin_hash).not.toContain(res.body.pin);
  });

  it('lets the new subscriber sign in with the returned PIN', async () => {
    const created = await call<CreateResponse>({
      method: 'POST',
      path: '/api/subscribers',
      token: owner.token,
      body: { code: '1042', name: 'Sami Haddad' },
    });
    const login = await call({
      method: 'POST',
      path: '/api/auth/subscriber/login',
      body: { code: '1042', pin: created.body.pin },
    });
    expect(login.status).toBe(200);
  });

  it('rejects a collector with 403', async () => {
    const res = await call({
      method: 'POST',
      path: '/api/subscribers',
      token: collector.token,
      body: { code: '1042', name: 'Sami Haddad' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a duplicate code with 409', async () => {
    await createSubscriber('1042');
    const res = await call<{ error: { code: string } }>({
      method: 'POST',
      path: '/api/subscribers',
      token: owner.token,
      body: { code: '1042', name: 'Someone Else' },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
  });

  it('rejects a non-numeric code and a missing name, naming the field', async () => {
    const badCode = await call<{ error: { details?: { field?: string } } }>({
      method: 'POST',
      path: '/api/subscribers',
      token: owner.token,
      body: { code: '10-42', name: 'Sami' },
    });
    expect(badCode.status).toBe(400);
    expect(badCode.body.error.details?.field).toBe('code');

    const noName = await call({
      method: 'POST',
      path: '/api/subscribers',
      token: owner.token,
      body: { code: '1043' },
    });
    expect(noName.status).toBe(400);
  });

  it('rejects an unknown field', async () => {
    const res = await call({
      method: 'POST',
      path: '/api/subscribers',
      token: owner.token,
      body: { code: '1044', name: 'Sami', balanceUsdCents: -100000 },
    });
    expect(res.status).toBe(400);
  });
});

interface ListResponse {
  items: {
    id: number;
    code: string;
    name: string;
    zone: string | null;
    status: string;
    balanceUsdCents: number;
  }[];
  total: number;
  page: number;
  pageSize: number;
}

async function billAndPay(subscriberId: number, billCents: number, paidCents: number) {
  const cycle = await query<{ id: number }>(
    `insert into billing_cycles (period, usd_per_kwh_cents, lbp_rate, status, opened_by)
     values ('2026-01', 30, 89000, 'issued', $1) returning id`,
    [owner.id],
  );
  await query(
    `insert into bills (subscriber_id, cycle_id, kwh, usd_per_kwh_cents, amount_usd_cents, lbp_rate, amount_lbp)
     values ($1, $2, 100, 30, $3, 89000, 0)`,
    [subscriberId, cycle[0]!.id, billCents],
  );
  if (paidCents > 0) {
    await query(
      `insert into payments (subscriber_id, amount_usd_cents, paid_currency, received_by)
       values ($1, $2, 'USD', $3)`,
      [subscriberId, paidCents, owner.id],
    );
  }
}

describe('GET /api/subscribers', () => {
  it('lists subscribers with their derived balance', async () => {
    const sub = await createSubscriber('1042', '482100', 'Sami Haddad', 'A');
    await billAndPay(sub.id, 3_000, 1_000);

    const res = await call<ListResponse>({ path: '/api/subscribers', token: collector.token });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]!.balanceUsdCents).toBe(2_000);
  });

  it('excludes a voided payment from the balance', async () => {
    const sub = await createSubscriber('1042');
    await billAndPay(sub.id, 3_000, 1_000);
    await query('update payments set voided_at = now() where subscriber_id = $1', [sub.id]);

    const res = await call<ListResponse>({ path: '/api/subscribers', token: owner.token });
    expect(res.body.items[0]!.balanceUsdCents).toBe(3_000);
  });

  it('searches by name and by code', async () => {
    await createSubscriber('1042', '482100', 'Sami Haddad', 'A');
    await createSubscriber('2050', '482100', 'Rania Khoury', 'B');

    const byName = await call<ListResponse>({
      path: '/api/subscribers',
      token: owner.token,
      headers: {},
    });
    expect(byName.body.total).toBe(2);

    const search = await call<ListResponse>({
      path: '/api/subscribers?q=Rania',
      token: owner.token,
    });
    expect(search.body.items.map((i) => i.code)).toEqual(['2050']);

    const byCode = await call<ListResponse>({ path: '/api/subscribers?q=1042', token: owner.token });
    expect(byCode.body.items.map((i) => i.code)).toEqual(['1042']);
  });

  it('filters by zone, status and debt', async () => {
    const a = await createSubscriber('1042', '482100', 'Sami Haddad', 'A');
    const b = await createSubscriber('2050', '482100', 'Rania Khoury', 'B');
    await billAndPay(a.id, 3_000, 0);
    await query("update subscribers set status = 'suspended' where id = $1", [b.id]);

    const zoneA = await call<ListResponse>({ path: '/api/subscribers?zone=A', token: owner.token });
    expect(zoneA.body.items.map((i) => i.code)).toEqual(['1042']);

    const suspended = await call<ListResponse>({
      path: '/api/subscribers?status=suspended',
      token: owner.token,
    });
    expect(suspended.body.items.map((i) => i.code)).toEqual(['2050']);

    const inDebt = await call<ListResponse>({
      path: '/api/subscribers?hasDebt=true',
      token: owner.token,
    });
    expect(inDebt.body.items.map((i) => i.code)).toEqual(['1042']);
  });

  it('pages the results', async () => {
    for (const code of ['1001', '1002', '1003']) {
      await createSubscriber(code);
    }
    const page = await call<ListResponse>({
      path: '/api/subscribers?page=2&pageSize=2',
      token: owner.token,
    });
    expect(page.body.total).toBe(3);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.page).toBe(2);
  });

  it('hides a soft deleted subscriber', async () => {
    const sub = await createSubscriber('1042');
    await query('update subscribers set deleted_at = now() where id = $1', [sub.id]);
    const res = await call<ListResponse>({ path: '/api/subscribers', token: owner.token });
    expect(res.body.total).toBe(0);
  });

  it('refuses an unauthenticated request', async () => {
    const res = await call({ path: '/api/subscribers' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/subscribers/:id', () => {
  it('returns the profile, balance, recent bills and payments', async () => {
    const sub = await createSubscriber('1042', '482100', 'Sami Haddad', 'A');
    await billAndPay(sub.id, 3_000, 1_000);

    const res = await call<{
      subscriber: { code: string; zone: string | null };
      balanceUsdCents: number;
      bills: { amountUsdCents: number; period: string }[];
      payments: { amountUsdCents: number; receivedByName: string }[];
    }>({ path: `/api/subscribers/${sub.id}`, token: collector.token });

    expect(res.status).toBe(200);
    expect(res.body.subscriber.code).toBe('1042');
    expect(res.body.balanceUsdCents).toBe(2_000);
    expect(res.body.bills[0]!.period).toBe('2026-01');
    expect(res.body.payments[0]!.receivedByName).toBe('sami');
  });

  it('returns 404 for an unknown or soft deleted subscriber', async () => {
    const missing = await call({ path: '/api/subscribers/999999', token: owner.token });
    expect(missing.status).toBe(404);

    const sub = await createSubscriber('1042');
    await query('update subscribers set deleted_at = now() where id = $1', [sub.id]);
    const deleted = await call({ path: `/api/subscribers/${sub.id}`, token: owner.token });
    expect(deleted.status).toBe(404);
  });
});

describe('PATCH /api/subscribers/:id', () => {
  it('updates the fields the owner sent and leaves the rest alone', async () => {
    const sub = await createSubscriber('1042', '482100', 'Sami Haddad', 'A');
    const res = await call<{ subscriber: { name: string; zone: string | null; phone: string | null } }>({
      method: 'PATCH',
      path: `/api/subscribers/${sub.id}`,
      token: owner.token,
      body: { phone: '03999888' },
    });
    expect(res.status).toBe(200);
    expect(res.body.subscriber.phone).toBe('03999888');
    expect(res.body.subscriber.name).toBe('Sami Haddad');
    expect(res.body.subscriber.zone).toBe('A');
  });

  it('rejects a collector with 403', async () => {
    const sub = await createSubscriber('1042');
    const res = await call({
      method: 'PATCH',
      path: `/api/subscribers/${sub.id}`,
      token: collector.token,
      body: { phone: '03999888' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a code that another subscriber already uses', async () => {
    await createSubscriber('1042');
    const other = await createSubscriber('2050');
    const res = await call({
      method: 'PATCH',
      path: `/api/subscribers/${other.id}`,
      token: owner.token,
      body: { code: '1042' },
    });
    expect(res.status).toBe(409);
  });

  it('writes an audit entry with the before and after values', async () => {
    const sub = await createSubscriber('1042', '482100', 'Sami Haddad');
    await call({
      method: 'PATCH',
      path: `/api/subscribers/${sub.id}`,
      token: owner.token,
      body: { name: 'Sami H.' },
    });
    const rows = await query<{ action: string; before_data: { name: string }; after_data: { name: string } }>(
      "select action, before_data, after_data from audit_log where entity = 'subscriber' and entity_id = $1",
      [sub.id],
    );
    expect(rows[0]!.action).toBe('subscriber.update');
    expect(rows[0]!.before_data.name).toBe('Sami Haddad');
    expect(rows[0]!.after_data.name).toBe('Sami H.');
  });
});

describe('POST /api/subscribers/:id/pin-reset', () => {
  it('returns a new PIN once and invalidates the previous token', async () => {
    const sub = await createSubscriber('1042', '482100');
    const before = await call({ path: '/api/me', token: sub.token });
    expect(before.status).toBe(200);

    const res = await call<{ pin: string }>({
      method: 'POST',
      path: `/api/subscribers/${sub.id}/pin-reset`,
      token: owner.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.pin).toMatch(/^\d{6}$/);

    const after = await call({ path: '/api/me', token: sub.token });
    expect(after.status).toBe(401);

    const login = await call({
      method: 'POST',
      path: '/api/auth/subscriber/login',
      body: { code: '1042', pin: res.body.pin },
    });
    expect(login.status).toBe(200);
  });

  it('rejects a collector with 403', async () => {
    const sub = await createSubscriber('1042');
    const res = await call({
      method: 'POST',
      path: `/api/subscribers/${sub.id}/pin-reset`,
      token: collector.token,
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/subscribers/:id/status', () => {
  it('changes the status and records the reason in the audit log', async () => {
    const sub = await createSubscriber('1042');
    const res = await call<{ subscriber: { status: string } }>({
      method: 'POST',
      path: `/api/subscribers/${sub.id}/status`,
      token: owner.token,
      body: { status: 'disconnected', reason: 'unpaid for three cycles' },
    });
    expect(res.status).toBe(200);
    expect(res.body.subscriber.status).toBe('disconnected');

    const rows = await query<{ action: string; after_data: { reason: string } }>(
      "select action, after_data from audit_log where entity = 'subscriber' and entity_id = $1",
      [sub.id],
    );
    expect(rows[0]!.action).toBe('subscriber.status');
    expect(rows[0]!.after_data.reason).toBe('unpaid for three cycles');
  });

  it('rejects an unknown status', async () => {
    const sub = await createSubscriber('1042');
    const res = await call({
      method: 'POST',
      path: `/api/subscribers/${sub.id}/status`,
      token: owner.token,
      body: { status: 'gone', reason: 'x' },
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/subscribers/:id', () => {
  it('soft deletes: the row stays, the subscriber disappears and can no longer sign in', async () => {
    const sub = await createSubscriber('1042', '482100');
    const res = await call({
      method: 'DELETE',
      path: `/api/subscribers/${sub.id}`,
      token: owner.token,
    });
    expect(res.status).toBe(204);

    const rows = await query<{ deleted_at: string | null }>(
      'select deleted_at from subscribers where id = $1',
      [sub.id],
    );
    expect(rows[0]!.deleted_at).not.toBeNull();

    const login = await call({
      method: 'POST',
      path: '/api/auth/subscriber/login',
      body: { code: '1042', pin: '482100' },
    });
    expect(login.status).toBe(401);
  });

  it('rejects a collector with 403', async () => {
    const sub = await createSubscriber('1042');
    const res = await call({
      method: 'DELETE',
      path: `/api/subscribers/${sub.id}`,
      token: collector.token,
    });
    expect(res.status).toBe(403);
  });
});

describe('the LBP figures on a subscriber detail', () => {
  it('converts the balance with the rate of the cycle in force, rounded to a thousand', async () => {
    const sub = await createSubscriber('1042');
    await query(
      `insert into billing_cycles (period, usd_per_kwh_cents, lbp_rate, opened_by)
       values ('2026-09', 30, 89000, $1)`,
      [owner.id],
    );
    await billAndPay(sub.id, 3_000, 1_000);

    const res = await call<{ balanceUsdCents: number; balanceLbp: number; lbpRate: number }>({
      path: `/api/subscribers/${sub.id}`,
      token: owner.token,
    });
    expect(res.body.balanceUsdCents).toBe(2_000);
    expect(res.body.lbpRate).toBe(89_000);
    // 2,000 cents at 89,000 is 1,780,000 LBP, already a multiple of a thousand.
    expect(res.body.balanceLbp).toBe(1_780_000);
  });

  it('reports a null rate and a null LBP balance when no cycle exists yet', async () => {
    const sub = await createSubscriber('1042');
    const res = await call<{ balanceLbp: number | null; lbpRate: number | null }>({
      path: `/api/subscribers/${sub.id}`,
      token: owner.token,
    });
    expect(res.body.lbpRate).toBeNull();
    expect(res.body.balanceLbp).toBeNull();
  });
});
