/**
 * Staff accounts. Owner only. A password hash never leaves this module, and the
 * last active owner cannot be demoted or deactivated: that would lock the business
 * out of its own pricing, issuing and voiding.
 */

import { query, maybeOne } from './db.js';
import { ConflictError, NotFoundError } from './errors.js';
import { assertValidPassword, hashSecret } from './auth.js';
import { writeAudit, actorFields } from './audit.js';
import {
  asObject,
  oneOf,
  optionalBoolean,
  rejectUnknownFields,
  requiredString,
} from './validate.js';
import type { Actor, Role, Staff } from './types.js';

const ROLES = ['owner', 'collector'] as const;
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;

interface StaffRow extends Record<string, unknown> {
  id: number;
  username: string;
  name: string;
  role: Role;
  is_active: boolean;
  created_at: Date;
}

function toStaff(row: StaffRow): Staff {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
  };
}

const STAFF_COLUMNS = 'id, username, name, role, is_active, created_at';

export async function listStaff(): Promise<Staff[]> {
  const rows = await query<StaffRow>(
    `select ${STAFF_COLUMNS} from staff order by is_active desc, name`,
  );
  return rows.map(toStaff);
}

export async function getStaff(id: number): Promise<Staff> {
  const row = await maybeOne<StaffRow>(`select ${STAFF_COLUMNS} from staff where id = $1`, [id]);
  if (row === null) throw new NotFoundError('staff', id);
  return toStaff(row);
}

export async function createStaffAccount(body: unknown, actor: Actor): Promise<Staff> {
  const input = asObject(body);
  rejectUnknownFields(input, ['username', 'name', 'role', 'password']);
  const username = requiredString(input, 'username', {
    pattern: USERNAME_PATTERN,
    message: 'The username must be 3 to 32 lowercase letters, digits, dot, dash or underscore',
  });
  const name = requiredString(input, 'name', { maxLength: 120 });
  const role = oneOf(input, 'role', ROLES);
  const password = input.password;
  assertValidPassword(password);

  const clash = await maybeOne<{ id: number }>('select id from staff where username = $1', [
    username,
  ]);
  if (clash !== null) {
    throw new ConflictError(`The username ${username} is already taken`, { field: 'username' });
  }

  const rows = await query<StaffRow>(
    `insert into staff (username, password_hash, name, role)
     values ($1, $2, $3, $4) returning ${STAFF_COLUMNS}`,
    [username, await hashSecret(password), name, role],
  );
  const staff = toStaff(rows[0]!);
  await writeAudit({
    ...actorFields(actor),
    action: 'staff.create',
    entity: 'staff',
    entityId: staff.id,
    after: staff,
  });
  return staff;
}

/** The business must never be left without an owner who can sign in. */
async function assertNotLastOwner(id: number): Promise<void> {
  const row = await maybeOne<{ count: number }>(
    "select count(*)::bigint as count from staff where role = 'owner' and is_active and id <> $1",
    [id],
  );
  if ((row?.count ?? 0) === 0) {
    throw new ConflictError('This is the last active owner account');
  }
}

export async function updateStaffAccount(
  id: number,
  body: unknown,
  actor: Actor,
): Promise<Staff> {
  const input = asObject(body);
  rejectUnknownFields(input, ['name', 'role', 'isActive']);
  const before = await getStaff(id);

  const name = 'name' in input ? requiredString(input, 'name', { maxLength: 120 }) : null;
  const role = 'role' in input ? oneOf(input, 'role', ROLES) : null;
  const isActive = optionalBoolean(input, 'isActive');
  if (name === null && role === null && isActive === null) {
    throw new ConflictError('There is nothing to change');
  }

  const losesOwnership = before.role === 'owner' && (role === 'collector' || isActive === false);
  if (losesOwnership) await assertNotLastOwner(id);

  const rows = await query<StaffRow>(
    `update staff
        set name = coalesce($1, name),
            role = coalesce($2, role),
            is_active = coalesce($3, is_active)
      where id = $4
      returning ${STAFF_COLUMNS}`,
    [name, role, isActive, id],
  );
  const after = toStaff(rows[0]!);
  await writeAudit({
    ...actorFields(actor),
    action: 'staff.update',
    entity: 'staff',
    entityId: id,
    before,
    after,
  });
  return after;
}

export async function setStaffPassword(id: number, body: unknown, actor: Actor): Promise<void> {
  const input = asObject(body);
  rejectUnknownFields(input, ['password']);
  assertValidPassword(input.password);
  await getStaff(id);

  await query('update staff set password_hash = $1 where id = $2', [
    await hashSecret(input.password),
    id,
  ]);
  await writeAudit({
    ...actorFields(actor),
    action: 'staff.password',
    entity: 'staff',
    entityId: id,
  });
}
