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
import type { StaffFixture, SubscriberFixture } from './helpers.js';
import type { LiveUsage, MeterDevice, MeterDeviceWithSubscriber } from '../../lib/types.js';

let owner: StaffFixture;
let collector: StaffFixture;
let subscriber: SubscriberFixture;
let cycleId: number;

const SERIAL = 'MTR-0001';

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
});

afterAll(async () => {
  await shutdown();
});

async function register(
  serial = SERIAL,
): Promise<{ status: number; device: MeterDevice; secret: string }> {
  const res = await call<{ device: MeterDevice; secret: string }>({
    method: 'POST',
    path: `/api/subscribers/${subscriber.id}/device`,
    token: owner.token,
    body: { serial },
  });
  return { status: res.status, device: res.body?.device, secret: res.body?.secret };
}

function report(serial: string, secret: string, value: number, takenAt?: string) {
  return call<{ accepted: boolean }>({
    method: 'POST',
    path: `/api/ingest/${serial}/readings`,
    headers: { authorization: `Device ${secret}` },
    body: takenAt === undefined ? { value } : { value, takenAt },
  });
}

/** An earlier cycle's reading is where the open cycle counts from. */
async function officialReading(value: number): Promise<void> {
  const older = await query<{ id: number }>(
    `insert into billing_cycles (period, usd_per_kwh_cents, lbp_rate, opened_by, status,
                                 issued_at, closed_at)
     values ('2026-08', 30, 89000, $1, 'closed', now(), now()) returning id`,
    [owner.id],
  );
  await query(
    `insert into meter_readings
       (subscriber_id, cycle_id, previous_value, current_value, kwh, entered_by)
     values ($1, $2, 0, $3, $3, $4)`,
    [subscriber.id, older[0]!.id, value, owner.id],
  );
}

describe('registering a device', () => {
  it('returns the secret once and never again', async () => {
    const created = await register();
    expect(created.status).toBe(201);
    expect(created.secret).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(created.device.serial).toBe(SERIAL);
    expect(created.device.status).toBe('active');
    expect(created.device.lastSeenAt).toBeNull();

    const listed = await call<{ devices: MeterDeviceWithSubscriber[] }>({
      path: '/api/devices',
      token: owner.token,
    });
    expect(listed.body.devices).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(created.secret);
    expect(JSON.stringify(listed.body)).not.toContain('secret');
  });

  it('refuses a second device for the same subscriber or the same serial', async () => {
    await register();
    expect((await register('MTR-0002')).status).toBe(409);

    const other = await createSubscriber('1002');
    const clash = await call({
      method: 'POST',
      path: `/api/subscribers/${other.id}/device`,
      token: owner.token,
      body: { serial: SERIAL },
    });
    expect(clash.status).toBe(409);
  });

  it('refuses a bad serial, an unknown subscriber, a collector and a subscriber', async () => {
    expect((await register('no')).status).toBe(400);
    expect(
      (
        await call({
          method: 'POST',
          path: '/api/subscribers/9999/device',
          token: owner.token,
          body: { serial: SERIAL },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call({
          method: 'POST',
          path: `/api/subscribers/${subscriber.id}/device`,
          token: collector.token,
          body: { serial: SERIAL },
        })
      ).status,
    ).toBe(403);
    expect((await call({ path: '/api/devices', token: subscriber.token })).status).toBe(403);
  });
});

describe('a device reporting a reading', () => {
  it('accepts the reading and marks the device seen', async () => {
    const created = await register();
    const res = await report(SERIAL, created.secret, 10_432);
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);

    const listed = await call<{ devices: MeterDeviceWithSubscriber[] }>({
      path: '/api/devices',
      token: owner.token,
    });
    expect(listed.body.devices[0]!.lastValue).toBe(10_432);
    expect(listed.body.devices[0]!.lastSeenAt).not.toBeNull();
  });

  it('takes a retry of the same instant without doubling the row', async () => {
    const created = await register();
    const at = '2026-09-10T09:00:00.000Z';
    expect((await report(SERIAL, created.secret, 10_432, at)).status).toBe(202);
    expect((await report(SERIAL, created.secret, 10_432, at)).status).toBe(202);

    const rows = await query<{ count: number }>(
      'select count(*)::bigint as count from device_readings',
    );
    expect(rows[0]!.count).toBe(1);
  });

  it('refuses a wrong secret, no secret, an unknown serial and a disabled device', async () => {
    const created = await register();

    expect((await report(SERIAL, 'not-the-secret', 10_432)).status).toBe(401);
    expect(
      (
        await call({
          method: 'POST',
          path: `/api/ingest/${SERIAL}/readings`,
          body: { value: 10_432 },
        })
      ).status,
    ).toBe(401);
    expect((await report('MTR-9999', created.secret, 10_432)).status).toBe(401);

    await call({
      method: 'PATCH',
      path: `/api/devices/${created.device.id}`,
      token: owner.token,
      body: { status: 'disabled' },
    });
    expect((await report(SERIAL, created.secret, 10_432)).status).toBe(401);
  });

  it('refuses a stamp far from now, a negative value and an unknown field', async () => {
    const created = await register();
    expect((await report(SERIAL, created.secret, 10_432, '2020-01-01T00:00:00.000Z')).status).toBe(
      400,
    );
    expect((await report(SERIAL, created.secret, -1)).status).toBe(400);
    expect(
      (
        await call({
          method: 'POST',
          path: `/api/ingest/${SERIAL}/readings`,
          headers: { authorization: `Device ${created.secret}` },
          body: { value: 10_432, subscriberId: 1 },
        })
      ).status,
    ).toBe(400);
  });

  it('stops working after the secret is rotated, and works with the new one', async () => {
    const created = await register();
    const rotated = await call<{ secret: string }>({
      method: 'POST',
      path: `/api/devices/${created.device.id}/rotate`,
      token: owner.token,
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body.secret).not.toBe(created.secret);

    expect((await report(SERIAL, created.secret, 10_432)).status).toBe(401);
    expect((await report(SERIAL, rotated.body.secret, 10_432)).status).toBe(202);
  });
});

describe('GET /api/me/usage', () => {
  it('shows the open cycle price even with no device installed', async () => {
    const res = await call<LiveUsage>({ path: '/api/me/usage', token: subscriber.token });
    expect(res.status).toBe(200);
    expect(res.body.period).toBe('2026-09');
    expect(res.body.usdPerKwhCents).toBe(30);
    expect(res.body.lbpRate).toBe(89_000);
    expect(res.body.hasDevice).toBe(false);
    expect(res.body.live).toBeNull();
  });

  it('counts from the last official reading, priced at the open cycle', async () => {
    await officialReading(10_000);
    const created = await register();
    await report(SERIAL, created.secret, 10_432);

    const res = await call<LiveUsage>({ path: '/api/me/usage', token: subscriber.token });
    expect(res.body.previousValue).toBe(10_000);
    expect(res.body.hasDevice).toBe(true);
    expect(res.body.live).not.toBeNull();
    expect(res.body.live!.value).toBe(10_432);
    expect(res.body.live!.kwh).toBe(432);
    // 432 kWh at 30 cents is $129.60, and 12,960 cents at 89,000 rounds to 11,534,000 LBP.
    expect(res.body.live!.amountUsdCents).toBe(12_960);
    expect(res.body.live!.amountLbp).toBe(11_534_000);
  });

  it('shows no figure when the meter reads below the last official one', async () => {
    await officialReading(10_000);
    const created = await register();
    await report(SERIAL, created.secret, 40);

    const res = await call<LiveUsage>({ path: '/api/me/usage', token: subscriber.token });
    expect(res.body.live!.value).toBe(40);
    expect(res.body.live!.kwh).toBeNull();
    expect(res.body.live!.amountUsdCents).toBeNull();
    expect(res.body.live!.amountLbp).toBeNull();
  });

  it('never writes a meter reading or a bill', async () => {
    await officialReading(10_000);
    const created = await register();
    await report(SERIAL, created.secret, 10_432);

    const readings = await query<{ count: number }>(
      'select count(*)::bigint as count from meter_readings where cycle_id = $1',
      [cycleId],
    );
    const bills = await query<{ count: number }>('select count(*)::bigint as count from bills');
    expect(readings[0]!.count).toBe(0);
    expect(bills[0]!.count).toBe(0);
  });

  it('is refused for staff, who read the route instead', async () => {
    expect((await call({ path: '/api/me/usage', token: owner.token })).status).toBe(403);
  });
});
