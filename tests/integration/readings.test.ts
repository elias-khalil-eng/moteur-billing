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

interface ReadingResponse {
  reading: {
    previousValue: number;
    currentValue: number;
    kwh: number;
    meterReset: boolean;
    isEstimated: boolean;
  };
}

function putReading(body: Record<string, unknown>, token = collector.token, subId?: number) {
  return call<ReadingResponse & { error: { code: string; details?: Record<string, unknown> } }>({
    method: 'PUT',
    path: `/api/cycles/${cycleId}/readings/${subId ?? subscriber.id}`,
    token,
    body,
  });
}

describe('PUT /api/cycles/:id/readings/:subscriberId', () => {
  it('derives kWh from the previous value, which starts at zero', async () => {
    const res = await putReading({ currentValue: 1_250 });
    expect(res.status).toBe(200);
    expect(res.body.reading.previousValue).toBe(0);
    expect(res.body.reading.kwh).toBe(1_250);
  });

  it('carries the previous value forward from an earlier cycle', async () => {
    await putReading({ currentValue: 1_000 });
    await query("update billing_cycles set status = 'issued', issued_at = now() where id = $1", [
      cycleId,
    ]);
    const next = await query<{ id: number }>(
      `insert into billing_cycles (period, usd_per_kwh_cents, lbp_rate, opened_by)
       values ('2026-10', 30, 89000, $1) returning id`,
      [owner.id],
    );
    cycleId = next[0]!.id;

    const res = await putReading({ currentValue: 1_250 });
    expect(res.body.reading.previousValue).toBe(1_000);
    expect(res.body.reading.kwh).toBe(250);
  });

  it('overwrites an earlier entry for the same subscriber and cycle', async () => {
    await putReading({ currentValue: 1_250 });
    const corrected = await putReading({ currentValue: 1_260 });
    expect(corrected.body.reading.kwh).toBe(1_260);

    const rows = await query<{ count: number }>(
      'select count(*)::bigint as count from meter_readings where cycle_id = $1',
      [cycleId],
    );
    expect(rows[0]!.count).toBe(1);
  });

  it('rejects a value below the previous reading, naming both numbers', async () => {
    await putReading({ currentValue: 1_000 });
    await query("update billing_cycles set status = 'issued' where id = $1", [cycleId]);
    const next = await query<{ id: number }>(
      `insert into billing_cycles (period, usd_per_kwh_cents, lbp_rate, opened_by)
       values ('2026-10', 30, 89000, $1) returning id`,
      [owner.id],
    );
    cycleId = next[0]!.id;

    const res = await putReading({ currentValue: 900 });
    expect(res.status).toBe(400);
    expect(res.body.error.details?.previousValue).toBe(1_000);
    expect(res.body.error.details?.currentValue).toBe(900);
  });

  it('treats a replaced meter as consuming the whole new value, and needs a note', async () => {
    await putReading({ currentValue: 9_990 });
    await query("update billing_cycles set status = 'issued' where id = $1", [cycleId]);
    const next = await query<{ id: number }>(
      `insert into billing_cycles (period, usd_per_kwh_cents, lbp_rate, opened_by)
       values ('2026-10', 30, 89000, $1) returning id`,
      [owner.id],
    );
    cycleId = next[0]!.id;

    const withoutNote = await putReading({ currentValue: 120, meterReset: true });
    expect(withoutNote.status).toBe(400);

    const withNote = await putReading({
      currentValue: 120,
      meterReset: true,
      note: 'old meter ended at 10,050',
    });
    expect(withNote.status).toBe(200);
    expect(withNote.body.reading.kwh).toBe(120);
    expect(withNote.body.reading.meterReset).toBe(true);
  });

  it('records an estimated reading when asked', async () => {
    const res = await putReading({ currentValue: 300, isEstimated: true });
    expect(res.body.reading.isEstimated).toBe(true);
  });

  it('rejects an unknown field and a negative value', async () => {
    expect((await putReading({ currentValue: 100, kwh: 999 })).status).toBe(400);
    expect((await putReading({ currentValue: -1 })).status).toBe(400);
  });

  it('refuses to write once the cycle is issued', async () => {
    await query("update billing_cycles set status = 'issued', issued_at = now() where id = $1", [
      cycleId,
    ]);
    const res = await putReading({ currentValue: 100 });
    expect(res.status).toBe(409);
  });

  it('returns 404 for an unknown subscriber', async () => {
    const res = await putReading({ currentValue: 100 }, collector.token, 999_999);
    expect(res.status).toBe(404);
  });
});

async function giveHistory(subscriberId: number, kwhPerCycle: number[]) {
  for (const [index, kwh] of kwhPerCycle.entries()) {
    const period = `2025-0${index + 1}`;
    const rows = await query<{ id: number }>(
      `insert into billing_cycles (period, usd_per_kwh_cents, lbp_rate, status, issued_at, opened_by)
       values ($1, 30, 89000, 'closed', now(), $2) returning id`,
      [period, owner.id],
    );
    await query(
      `insert into bills (subscriber_id, cycle_id, kwh, usd_per_kwh_cents, amount_usd_cents, lbp_rate, amount_lbp)
       values ($1, $2, $3, 30, $4, 89000, 0)`,
      [subscriberId, rows[0]!.id, kwh, kwh * 30],
    );
  }
}

describe('the outlier warning', () => {
  it('blocks a reading far above the trailing mean until it is confirmed', async () => {
    await giveHistory(subscriber.id, [1_200, 1_250, 1_300]);

    const warned = await putReading({ currentValue: 12_500 });
    expect(warned.status).toBe(409);
    expect(warned.body.error.details?.requiresConfirmation).toBe(true);
    expect(warned.body.error.details?.kwh).toBe(12_500);

    const confirmed = await putReading({ currentValue: 12_500, confirmOutlier: true });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.reading.kwh).toBe(12_500);
  });

  it('does not warn about a normal reading', async () => {
    await giveHistory(subscriber.id, [1_200, 1_250, 1_300]);
    const res = await putReading({ currentValue: 1_280 });
    expect(res.status).toBe(200);
  });

  it('does not warn when there is no history to compare against', async () => {
    const res = await putReading({ currentValue: 99_999 });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/cycles/:id/route', () => {
  it('lists every active subscriber with their previous value and reading', async () => {
    await createSubscriber('1002', '482100', 'Rania Khoury', 'B');
    await putReading({ currentValue: 1_250 });

    const res = await call<{ rows: { code: string; currentValue: number | null; kwh: number | null }[] }>(
      { path: `/api/cycles/${cycleId}/route`, token: collector.token },
    );
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    const done = res.body.rows.find((r) => r.code === '1001');
    const pending = res.body.rows.find((r) => r.code === '1002');
    expect(done?.kwh).toBe(1_250);
    expect(pending?.currentValue).toBeNull();
  });

  it('filters to pending rows only', async () => {
    await createSubscriber('1002');
    await putReading({ currentValue: 1_250 });
    const res = await call<{ rows: { code: string }[] }>({
      path: `/api/cycles/${cycleId}/route?pending=true`,
      token: collector.token,
    });
    expect(res.body.rows.map((r) => r.code)).toEqual(['1002']);
  });

  it('searches by name or code and filters by zone', async () => {
    await createSubscriber('1002', '482100', 'Rania Khoury', 'B');
    const byName = await call<{ rows: { code: string }[] }>({
      path: `/api/cycles/${cycleId}/route?q=Rania`,
      token: collector.token,
    });
    expect(byName.body.rows.map((r) => r.code)).toEqual(['1002']);

    const byZone = await call<{ rows: { code: string }[] }>({
      path: `/api/cycles/${cycleId}/route?zone=A`,
      token: collector.token,
    });
    expect(byZone.body.rows.map((r) => r.code)).toEqual(['1001']);
  });

  it('leaves out a suspended or deleted subscriber', async () => {
    const suspended = await createSubscriber('1002');
    await query("update subscribers set status = 'suspended' where id = $1", [suspended.id]);
    const deleted = await createSubscriber('1003');
    await query('update subscribers set deleted_at = now() where id = $1', [deleted.id]);

    const res = await call<{ rows: { code: string }[] }>({
      path: `/api/cycles/${cycleId}/route`,
      token: collector.token,
    });
    expect(res.body.rows.map((r) => r.code)).toEqual(['1001']);
  });
});

describe('DELETE /api/cycles/:id/readings/:subscriberId', () => {
  it('lets the owner remove a reading from an open cycle', async () => {
    await putReading({ currentValue: 1_250 });
    const res = await call({
      method: 'DELETE',
      path: `/api/cycles/${cycleId}/readings/${subscriber.id}`,
      token: owner.token,
    });
    expect(res.status).toBe(204);

    const rows = await query<{ count: number }>(
      'select count(*)::bigint as count from meter_readings where cycle_id = $1',
      [cycleId],
    );
    expect(rows[0]!.count).toBe(0);
  });

  it('rejects a collector with 403', async () => {
    await putReading({ currentValue: 1_250 });
    const res = await call({
      method: 'DELETE',
      path: `/api/cycles/${cycleId}/readings/${subscriber.id}`,
      token: collector.token,
    });
    expect(res.status).toBe(403);
  });
});
