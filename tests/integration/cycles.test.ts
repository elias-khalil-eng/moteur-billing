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

interface Cycle {
  id: number;
  period: string;
  usdPerKwhCents: number;
  lbpRate: number;
  status: string;
}

async function openCycle(period = '2026-09', usdPerKwhCents = 30, lbpRate = 89_000) {
  const res = await call<{ cycle: Cycle }>({
    method: 'POST',
    path: '/api/cycles',
    token: owner.token,
    body: { period, usdPerKwhCents, lbpRate },
  });
  return res;
}

describe('POST /api/cycles', () => {
  it('opens a cycle with a price and a rate', async () => {
    const res = await openCycle();
    expect(res.status).toBe(201);
    expect(res.body.cycle.period).toBe('2026-09');
    expect(res.body.cycle.status).toBe('open');
    expect(res.body.cycle.usdPerKwhCents).toBe(30);
  });

  it('refuses a second open cycle', async () => {
    await openCycle('2026-09');
    const second = await openCycle('2026-10');
    expect(second.status).toBe(409);
  });

  it('refuses a period that already exists', async () => {
    await openCycle('2026-09');
    await query("update billing_cycles set status = 'issued', issued_at = now()");
    const again = await openCycle('2026-09');
    expect(again.status).toBe(409);
  });

  it('rejects a collector with 403', async () => {
    const res = await call({
      method: 'POST',
      path: '/api/cycles',
      token: collector.token,
      body: { period: '2026-09', usdPerKwhCents: 30, lbpRate: 89_000 },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a malformed period and a zero price', async () => {
    expect((await openCycle('2026-9')).status).toBe(400);
    expect((await openCycle('2026-09', 0)).status).toBe(400);
  });
});

describe('PATCH /api/cycles/:id', () => {
  it('changes the price and rate while the cycle is open', async () => {
    const created = await openCycle();
    const res = await call<{ cycle: Cycle }>({
      method: 'PATCH',
      path: `/api/cycles/${created.body.cycle.id}`,
      token: owner.token,
      body: { usdPerKwhCents: 28, lbpRate: 90_000 },
    });
    expect(res.status).toBe(200);
    expect(res.body.cycle.usdPerKwhCents).toBe(28);
    expect(res.body.cycle.lbpRate).toBe(90_000);
  });

  it('refuses to change the price once the cycle is issued', async () => {
    const created = await openCycle();
    await query("update billing_cycles set status = 'issued', issued_at = now() where id = $1", [
      created.body.cycle.id,
    ]);
    const res = await call({
      method: 'PATCH',
      path: `/api/cycles/${created.body.cycle.id}`,
      token: owner.token,
      body: { usdPerKwhCents: 28 },
    });
    expect(res.status).toBe(409);
  });

  it('rejects a collector with 403', async () => {
    const created = await openCycle();
    const res = await call({
      method: 'PATCH',
      path: `/api/cycles/${created.body.cycle.id}`,
      token: collector.token,
      body: { usdPerKwhCents: 28 },
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/cycles/:id/close', () => {
  it('closes an issued cycle', async () => {
    const created = await openCycle();
    await query("update billing_cycles set status = 'issued', issued_at = now() where id = $1", [
      created.body.cycle.id,
    ]);
    const res = await call<{ cycle: Cycle }>({
      method: 'POST',
      path: `/api/cycles/${created.body.cycle.id}/close`,
      token: owner.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.cycle.status).toBe('closed');
  });

  it('refuses to close a cycle that was never issued', async () => {
    const created = await openCycle();
    const res = await call({
      method: 'POST',
      path: `/api/cycles/${created.body.cycle.id}/close`,
      token: owner.token,
    });
    expect(res.status).toBe(409);
  });
});

describe('GET /api/cycles/current and progress', () => {
  it('returns the open cycle', async () => {
    await openCycle('2026-09');
    const res = await call<{ cycle: Cycle | null }>({
      path: '/api/cycles/current',
      token: collector.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.cycle?.period).toBe('2026-09');
  });

  it('returns null when no cycle exists at all', async () => {
    const res = await call<{ cycle: Cycle | null }>({
      path: '/api/cycles/current',
      token: owner.token,
    });
    expect(res.body.cycle).toBeNull();
  });

  it('counts readings entered against active subscribers', async () => {
    const created = await openCycle();
    const cycleId = created.body.cycle.id;
    const a = await createSubscriber('1001');
    await createSubscriber('1002');
    await call({
      method: 'PUT',
      path: `/api/cycles/${cycleId}/readings/${a.id}`,
      token: collector.token,
      body: { currentValue: 120 },
    });
    const res = await call<{ readingsEntered: number; activeSubscribers: number }>({
      path: `/api/cycles/${cycleId}/progress`,
      token: collector.token,
    });
    expect(res.body.readingsEntered).toBe(1);
    expect(res.body.activeSubscribers).toBe(2);
  });
});
