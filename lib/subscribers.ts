/**
 * Subscriber validation and queries. Balance always comes from the
 * subscriber_balances view so a list screen is one query, never N+1.
 */

import { query, maybeOne } from './db.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { hashSecret, generatePin } from './auth.js';
import { writeAudit, actorFields } from './audit.js';
import {
  asObject,
  oneOf,
  optionalString,
  rejectUnknownFields,
  requiredString,
} from './validate.js';
import type { Actor, Subscriber, SubscriberStatus } from './types.js';

const CODE_PATTERN = /^\d{1,12}$/;
export const STATUSES = ['active', 'suspended', 'disconnected'] as const;
const EDITABLE = ['code', 'name', 'phone', 'zone', 'address', 'meterSerial', 'notes'] as const;

export interface SubscriberRow extends Record<string, unknown> {
  id: number;
  code: string;
  name: string;
  phone: string | null;
  zone: string | null;
  address: string | null;
  meter_serial: string | null;
  status: SubscriberStatus;
  notes: string | null;
  created_at: Date;
}

export function toSubscriber(row: SubscriberRow): Subscriber {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    phone: row.phone,
    zone: row.zone,
    address: row.address,
    meterSerial: row.meter_serial,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
  };
}

const SELECT_COLUMNS = `id, code, name, phone, zone, address, meter_serial, status, notes, created_at`;

export interface SubscriberInput {
  code: string;
  name: string;
  phone: string | null;
  zone: string | null;
  address: string | null;
  meterSerial: string | null;
  notes: string | null;
}

export function parseSubscriberInput(body: unknown): SubscriberInput {
  const input = asObject(body);
  rejectUnknownFields(input, EDITABLE);
  return {
    code: requiredString(input, 'code', {
      pattern: CODE_PATTERN,
      message: 'The subscriber number must be digits only',
    }),
    name: requiredString(input, 'name', { maxLength: 120 }),
    phone: optionalString(input, 'phone', { maxLength: 32 }),
    zone: optionalString(input, 'zone', { maxLength: 32 }),
    address: optionalString(input, 'address', { maxLength: 240 }),
    meterSerial: optionalString(input, 'meterSerial', { maxLength: 64 }),
    notes: optionalString(input, 'notes', { maxLength: 1_000 }),
  };
}

export function parseSubscriberPatch(body: unknown): Partial<SubscriberInput> {
  const input = asObject(body);
  rejectUnknownFields(input, EDITABLE);
  if (Object.keys(input).length === 0) {
    throw new ValidationError('There is nothing to change');
  }
  const patch: Partial<SubscriberInput> = {};
  if ('code' in input) {
    patch.code = requiredString(input, 'code', {
      pattern: CODE_PATTERN,
      message: 'The subscriber number must be digits only',
    });
  }
  if ('name' in input) patch.name = requiredString(input, 'name', { maxLength: 120 });
  if ('phone' in input) patch.phone = optionalString(input, 'phone', { maxLength: 32 });
  if ('zone' in input) patch.zone = optionalString(input, 'zone', { maxLength: 32 });
  if ('address' in input) patch.address = optionalString(input, 'address', { maxLength: 240 });
  if ('meterSerial' in input) {
    patch.meterSerial = optionalString(input, 'meterSerial', { maxLength: 64 });
  }
  if ('notes' in input) patch.notes = optionalString(input, 'notes', { maxLength: 1_000 });
  return patch;
}

export async function getSubscriber(id: number): Promise<Subscriber> {
  const row = await maybeOne<SubscriberRow>(
    `select ${SELECT_COLUMNS} from subscribers where id = $1 and deleted_at is null`,
    [id],
  );
  if (row === null) throw new NotFoundError('subscriber', id);
  return toSubscriber(row);
}

async function assertCodeIsFree(code: string, exceptId?: number): Promise<void> {
  const clash = await maybeOne<{ id: number }>(
    'select id from subscribers where code = $1 and ($2::bigint is null or id <> $2)',
    [code, exceptId ?? null],
  );
  if (clash !== null) {
    throw new ConflictError(`Subscriber number ${code} is already in use`, { field: 'code' });
  }
}

export interface CreatedSubscriber {
  subscriber: Subscriber;
  /** Shown to staff once, at creation, and never retrievable again. */
  pin: string;
}

export async function createSubscriber(
  body: unknown,
  actor: Actor,
): Promise<CreatedSubscriber> {
  const input = parseSubscriberInput(body);
  await assertCodeIsFree(input.code);
  const pin = generatePin();
  const rows = await query<SubscriberRow>(
    `insert into subscribers (code, pin_hash, name, phone, zone, address, meter_serial, notes)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning ${SELECT_COLUMNS}`,
    [
      input.code,
      await hashSecret(pin),
      input.name,
      input.phone,
      input.zone,
      input.address,
      input.meterSerial,
      input.notes,
    ],
  );
  const subscriber = toSubscriber(rows[0]!);
  await writeAudit({
    ...actorFields(actor),
    action: 'subscriber.create',
    entity: 'subscriber',
    entityId: subscriber.id,
    after: subscriber,
  });
  return { subscriber, pin };
}

const PATCH_COLUMNS: Record<keyof SubscriberInput, string> = {
  code: 'code',
  name: 'name',
  phone: 'phone',
  zone: 'zone',
  address: 'address',
  meterSerial: 'meter_serial',
  notes: 'notes',
};

export async function updateSubscriber(
  id: number,
  body: unknown,
  actor: Actor,
): Promise<Subscriber> {
  const patch = parseSubscriberPatch(body);
  const before = await getSubscriber(id);
  if (patch.code !== undefined) await assertCodeIsFree(patch.code, id);

  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const [field, column] of Object.entries(PATCH_COLUMNS)) {
    const key = field as keyof SubscriberInput;
    if (patch[key] !== undefined) {
      values.push(patch[key]);
      assignments.push(`${column} = $${values.length}`);
    }
  }
  values.push(id);

  const rows = await query<SubscriberRow>(
    `update subscribers set ${assignments.join(', ')}
      where id = $${values.length} and deleted_at is null
      returning ${SELECT_COLUMNS}`,
    values as never,
  );
  // The row can be soft-deleted between the read and the write; that is a 404,
  // not a crash.
  const updated = rows[0];
  if (updated === undefined) throw new NotFoundError('subscriber', id);
  const after = toSubscriber(updated);
  await writeAudit({
    ...actorFields(actor),
    action: 'subscriber.update',
    entity: 'subscriber',
    entityId: id,
    before,
    after,
  });
  return after;
}

export async function setSubscriberStatus(
  id: number,
  body: unknown,
  actor: Actor,
): Promise<Subscriber> {
  const input = asObject(body);
  rejectUnknownFields(input, ['status', 'reason']);
  const status = oneOf(input, 'status', STATUSES);
  const reason = optionalString(input, 'reason', { maxLength: 240 });
  const before = await getSubscriber(id);

  const rows = await query<SubscriberRow>(
    `update subscribers set status = $1 where id = $2 and deleted_at is null
     returning ${SELECT_COLUMNS}`,
    [status, id],
  );
  const updated = rows[0];
  if (updated === undefined) throw new NotFoundError('subscriber', id);
  const after = toSubscriber(updated);
  await writeAudit({
    ...actorFields(actor),
    action: 'subscriber.status',
    entity: 'subscriber',
    entityId: id,
    before: { status: before.status },
    after: { status, reason },
  });
  return after;
}

export async function resetPin(id: number, actor: Actor): Promise<{ pin: string }> {
  await getSubscriber(id);
  const pin = generatePin();
  // Bumping token_version is what makes every token issued before this moment invalid.
  await query(
    'update subscribers set pin_hash = $1, token_version = token_version + 1 where id = $2',
    [await hashSecret(pin), id],
  );
  await writeAudit({
    ...actorFields(actor),
    action: 'subscriber.pinReset',
    entity: 'subscriber',
    entityId: id,
  });
  return { pin };
}

export async function softDeleteSubscriber(id: number, actor: Actor): Promise<void> {
  const before = await getSubscriber(id);
  await query('update subscribers set deleted_at = now() where id = $1', [id]);
  await writeAudit({
    ...actorFields(actor),
    action: 'subscriber.delete',
    entity: 'subscriber',
    entityId: id,
    before,
  });
}
