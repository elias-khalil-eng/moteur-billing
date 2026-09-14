/**
 * Remote-read meters. A device signs in with its own serial and secret, and reports
 * what the meter shows. Those rows answer one question for the subscriber: how much
 * have I used since my last bill, and what would it cost at today's price.
 *
 * A device never writes a meter_readings row and never touches a bill. If the two
 * ever disagree, the reading a person took is the one that counts, so a broken or
 * swapped device costs an argument, never money.
 */

import { randomBytes } from 'node:crypto';
import { query, maybeOne } from './db.js';
import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from './errors.js';
import { hashSecret, verifySecret } from './auth.js';
import { writeAudit, actorFields } from './audit.js';
import { billAmountUsdCents, usdCentsToLbpRounded } from './money.js';
import { getCurrentCycle } from './cycles.js';
import { previousValueFor } from './readings.js';
import {
  asObject,
  oneOf,
  optionalString,
  rejectUnknownFields,
  requiredInteger,
  requiredString,
} from './validate.js';
import type {
  Actor,
  DeviceStatus,
  LiveUsage,
  MeterDevice,
  MeterDeviceWithSubscriber,
} from './types.js';

const SERIAL_PATTERN = /^[A-Za-z0-9._-]{4,64}$/;

/** A meter counter is six digits on the hardware in use; the cap only rejects nonsense. */
const VALUE_MAX = 9_999_999;

/** A device with a badly wrong clock would poison the ordering, so its stamp is bounded. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_SKEW_MS = 60 * 60 * 1_000;

const STATUSES: readonly DeviceStatus[] = ['active', 'disabled'];

interface DeviceRow extends Record<string, unknown> {
  id: number;
  subscriber_id: number;
  serial: string;
  status: DeviceStatus;
  installed_at: Date;
  last_seen_at: Date | null;
}

interface DeviceListRow extends DeviceRow {
  subscriber_code: string;
  subscriber_name: string;
  last_value: number | null;
  last_taken_at: Date | null;
}

function toDevice(row: DeviceRow): MeterDevice {
  return {
    id: row.id,
    subscriberId: row.subscriber_id,
    serial: row.serial,
    status: row.status,
    installedAt: row.installed_at.toISOString(),
    lastSeenAt: row.last_seen_at === null ? null : row.last_seen_at.toISOString(),
  };
}

const COLUMNS = 'id, subscriber_id, serial, status, installed_at, last_seen_at';

/** Shown once, at registration or rotation, and only ever stored hashed after that. */
function generateSecret(): string {
  return randomBytes(24).toString('base64url');
}

export interface RegisteredDevice {
  device: MeterDevice;
  secret: string;
}

export function parseDeviceInput(body: unknown): { serial: string } {
  const input = asObject(body);
  rejectUnknownFields(input, ['serial']);
  return {
    serial: requiredString(input, 'serial', {
      pattern: SERIAL_PATTERN,
      message: 'The serial must be 4 to 64 letters, digits, dot, dash or underscore',
    }),
  };
}

export async function registerDevice(
  subscriberId: number,
  body: unknown,
  actor: Actor,
): Promise<RegisteredDevice> {
  const input = parseDeviceInput(body);

  const subscriber = await maybeOne<{ id: number }>(
    'select id from subscribers where id = $1 and deleted_at is null',
    [subscriberId],
  );
  if (subscriber === null) throw new NotFoundError('subscriber', subscriberId);

  const taken = await maybeOne<{ id: number }>(
    'select id from meter_devices where subscriber_id = $1 or serial = $2',
    [subscriberId, input.serial],
  );
  if (taken !== null) {
    throw new ConflictError('That subscriber or that serial already has a device', {
      messageAr: 'هذا المشترك أو هذا الرقم التسلسلي مسجل مسبقا.',
    });
  }

  const secret = generateSecret();
  const rows = await query<DeviceRow>(
    `insert into meter_devices (subscriber_id, serial, secret_hash)
     values ($1, $2, $3)
     returning ${COLUMNS}`,
    [subscriberId, input.serial, await hashSecret(secret)],
  );
  const device = toDevice(rows[0]!);

  await writeAudit({
    ...actorFields(actor),
    action: 'device.register',
    entity: 'meter_device',
    entityId: device.id,
    after: device,
  });

  return { device, secret };
}

export async function listDevices(): Promise<MeterDeviceWithSubscriber[]> {
  const rows = await query<DeviceListRow>(
    `select d.id, d.subscriber_id, d.serial, d.status, d.installed_at, d.last_seen_at,
            s.code as subscriber_code, s.name as subscriber_name,
            latest.value as last_value, latest.taken_at as last_taken_at
       from meter_devices d
       join subscribers s on s.id = d.subscriber_id
       left join lateral (
         select r.value, r.taken_at from device_readings r
          where r.device_id = d.id
          order by r.taken_at desc
          limit 1
       ) latest on true
      order by d.last_seen_at desc nulls last, d.id`,
  );
  return rows.map((row) => ({
    ...toDevice(row),
    subscriberCode: row.subscriber_code,
    subscriberName: row.subscriber_name,
    lastValue: row.last_value,
    lastTakenAt: row.last_taken_at === null ? null : row.last_taken_at.toISOString(),
  }));
}

export async function getDevice(id: number): Promise<MeterDevice> {
  const row = await maybeOne<DeviceRow>(`select ${COLUMNS} from meter_devices where id = $1`, [id]);
  if (row === null) throw new NotFoundError('meter_device', id);
  return toDevice(row);
}

export async function rotateSecret(id: number, actor: Actor): Promise<RegisteredDevice> {
  const before = await getDevice(id);
  const secret = generateSecret();
  const rows = await query<DeviceRow>(
    `update meter_devices set secret_hash = $2 where id = $1 returning ${COLUMNS}`,
    [id, await hashSecret(secret)],
  );
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('meter_device', id);

  await writeAudit({
    ...actorFields(actor),
    action: 'device.rotate',
    entity: 'meter_device',
    entityId: before.id,
  });

  return { device: toDevice(row), secret };
}

export async function setDeviceStatus(
  id: number,
  body: unknown,
  actor: Actor,
): Promise<MeterDevice> {
  const input = asObject(body);
  rejectUnknownFields(input, ['status']);
  const status = oneOf(input, 'status', STATUSES);
  const before = await getDevice(id);

  const rows = await query<DeviceRow>(
    `update meter_devices set status = $2 where id = $1 returning ${COLUMNS}`,
    [id, status],
  );
  const row = rows[0];
  if (row === undefined) throw new NotFoundError('meter_device', id);
  const after = toDevice(row);

  await writeAudit({
    ...actorFields(actor),
    action: 'device.status',
    entity: 'meter_device',
    entityId: after.id,
    before,
    after,
  });

  return after;
}

// --- what a device sends --------------------------------------------------

export interface ReadingReport {
  value: number;
  takenAt: Date;
}

export function parseReadingReport(body: unknown, now = new Date()): ReadingReport {
  const input = asObject(body);
  rejectUnknownFields(input, ['value', 'takenAt']);
  const value = requiredInteger(input, 'value', { min: 0, max: VALUE_MAX });
  const raw = optionalString(input, 'takenAt', { maxLength: 40 });
  if (raw === null) return { value, takenAt: now };

  const takenAt = new Date(raw);
  if (Number.isNaN(takenAt.getTime())) {
    throw new ValidationError('takenAt must be an ISO 8601 instant', { field: 'takenAt' });
  }
  const age = now.getTime() - takenAt.getTime();
  if (age > MAX_AGE_MS || age < -MAX_SKEW_MS) {
    throw new ValidationError('takenAt is too far from now', { field: 'takenAt' });
  }
  return { value, takenAt };
}

/** The bearer here is the device secret, not a person's token, so it never mints a JWT. */
export async function authenticateDevice(serial: string, secret: string): Promise<MeterDevice> {
  const row = await maybeOne<DeviceRow & { secret_hash: string }>(
    `select ${COLUMNS}, secret_hash from meter_devices where serial = $1`,
    [serial],
  );
  if (row === null || !(await verifySecret(secret, row.secret_hash))) {
    throw new UnauthorizedError('That device is not registered');
  }
  if (row.status !== 'active') {
    throw new UnauthorizedError('That device is disabled');
  }
  return toDevice(row);
}

export function deviceSecretFrom(headers: Headers): string {
  const header = headers.get('authorization') ?? '';
  const match = /^Device\s+(.+)$/i.exec(header.trim());
  if (match === null) {
    throw new UnauthorizedError('A device must send its secret');
  }
  return match[1]!.trim();
}

export interface AcceptedReading {
  accepted: boolean;
  value: number;
  takenAt: string;
}

export async function ingestReading(
  serial: string,
  headers: Headers,
  body: unknown,
): Promise<AcceptedReading> {
  const device = await authenticateDevice(serial, deviceSecretFrom(headers));
  const report = parseReadingReport(body);

  // A retry of the same instant is not an error: the device is doing the right thing.
  await query(
    `insert into device_readings (device_id, value, taken_at)
     values ($1, $2, $3)
     on conflict (device_id, taken_at) do nothing`,
    [device.id, report.value, report.takenAt],
  );
  await query('update meter_devices set last_seen_at = now() where id = $1', [device.id]);

  return { accepted: true, value: report.value, takenAt: report.takenAt.toISOString() };
}

// --- what the subscriber sees ---------------------------------------------

export async function liveUsage(subscriberId: number): Promise<LiveUsage> {
  const cycle = await getCurrentCycle();
  const device = await maybeOne<{ id: number }>(
    "select id from meter_devices where subscriber_id = $1 and status = 'active'",
    [subscriberId],
  );

  const usage: LiveUsage = {
    period: cycle?.period ?? null,
    usdPerKwhCents: cycle?.usdPerKwhCents ?? null,
    lbpRate: cycle?.lbpRate ?? null,
    previousValue: null,
    hasDevice: device !== null,
    live: null,
  };
  if (cycle === null) return usage;

  usage.previousValue = await previousValueFor(subscriberId, cycle.id);
  if (device === null) return usage;

  const latest = await maybeOne<{ value: number; taken_at: Date }>(
    `select value, taken_at from device_readings
      where device_id = $1
      order by taken_at desc
      limit 1`,
    [device.id],
  );
  if (latest === null) return usage;

  // Below the last official reading means the meter was replaced or rolled over.
  // Showing a negative or a wrapped figure would be worse than showing none.
  const kwh = latest.value >= usage.previousValue ? latest.value - usage.previousValue : null;
  const amountUsdCents = kwh === null ? null : billAmountUsdCents(kwh, cycle.usdPerKwhCents);

  usage.live = {
    value: latest.value,
    takenAt: latest.taken_at.toISOString(),
    kwh,
    amountUsdCents,
    amountLbp: amountUsdCents === null ? null : usdCentsToLbpRounded(amountUsdCents, cycle.lbpRate),
  };
  return usage;
}
