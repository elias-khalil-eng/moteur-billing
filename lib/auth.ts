/**
 * Hashing, tokens, authentication, the role gate and login rate limiting.
 * Knows nothing about HTTP beyond reading a Headers object for the bearer token.
 */

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomInt } from 'node:crypto';
import { query } from './db.js';
import {
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
  RateLimitError,
} from './errors.js';
import { asObject, rejectUnknownFields, requiredString } from './validate.js';
import type { Actor, Role, StaffActor, SubscriberActor } from './types.js';

const BCRYPT_COST = 10;
/** Pinned, so a token cannot arrive claiming a different algorithm than the one we sign with. */
const JWT_ALGORITHM = 'HS256' as const;
const STAFF_TOKEN_SECONDS = 8 * 60 * 60;
const SUBSCRIBER_TOKEN_SECONDS = 30 * 24 * 60 * 60;
const PIN_DIGITS = 6;

export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const LOGIN_MAX_FAILURES = 5;

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set');
  }
  return secret;
}

export async function hashSecret(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifySecret(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/** Staff never see a stored PIN; this value is shown once at creation and then only hashed. */
export function generatePin(): string {
  let pin = '';
  for (let i = 0; i < PIN_DIGITS; i++) {
    pin += String(randomInt(0, 10));
  }
  return pin;
}

export function assertValidPin(pin: unknown): asserts pin is string {
  if (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) {
    throw new ValidationError('The PIN must be 4 to 6 digits', { field: 'pin' });
  }
}

export function assertValidPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < 8) {
    throw new ValidationError('The password must be at least 8 characters', { field: 'password' });
  }
}

export interface TokenPayload {
  sub: string;
  kind: 'staff' | 'subscriber';
  role?: Role;
  tv?: number;
}

export function signStaffToken(staff: Pick<StaffActor, 'id' | 'role'>): string {
  return jwt.sign({ kind: 'staff', role: staff.role }, jwtSecret(), {
    algorithm: JWT_ALGORITHM,
    subject: String(staff.id),
    expiresIn: STAFF_TOKEN_SECONDS,
  });
}

export function signSubscriberToken(
  subscriber: Pick<SubscriberActor, 'id'>,
  tokenVersion: number,
): string {
  return jwt.sign({ kind: 'subscriber', tv: tokenVersion }, jwtSecret(), {
    algorithm: JWT_ALGORITHM,
    subject: String(subscriber.id),
    expiresIn: SUBSCRIBER_TOKEN_SECONDS,
  });
}

export function verifyToken(token: string): TokenPayload {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, jwtSecret(), { algorithms: [JWT_ALGORITHM] });
  } catch {
    throw new UnauthorizedError('Your session has expired. Sign in again.');
  }
  if (decoded === null || typeof decoded !== 'object') {
    throw new UnauthorizedError();
  }
  const payload = decoded as Record<string, unknown>;
  if (typeof payload.sub !== 'string') {
    throw new UnauthorizedError();
  }
  if (payload.kind !== 'staff' && payload.kind !== 'subscriber') {
    throw new UnauthorizedError();
  }
  return {
    sub: payload.sub,
    kind: payload.kind,
    role: payload.role as Role | undefined,
    tv: typeof payload.tv === 'number' ? payload.tv : undefined,
  };
}

export function bearerToken(headers: Headers): string | null {
  const header = headers.get('authorization');
  if (!header) return null;
  const match = /^bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

export function requireStaff(actor: Actor | null): StaffActor {
  if (actor === null) throw new UnauthorizedError();
  if (actor.kind !== 'staff') throw new ForbiddenError('This is a staff area');
  return actor;
}

export function requireSubscriber(actor: Actor | null): SubscriberActor {
  if (actor === null) throw new UnauthorizedError();
  if (actor.kind !== 'subscriber') throw new ForbiddenError('This is a subscriber area');
  return actor;
}

/** An owner satisfies a collector gate; a collector never satisfies an owner gate. */
export function requireRole(actor: Actor | null, role: Role): StaffActor {
  const staff = requireStaff(actor);
  if (role === 'owner' && staff.role !== 'owner') {
    throw new ForbiddenError('Only the owner can do that');
  }
  return staff;
}

interface StaffRow extends Record<string, unknown> {
  id: number;
  username: string;
  name: string;
  role: Role;
}

interface SubscriberAuthRow extends Record<string, unknown> {
  id: number;
  code: string;
  name: string;
  token_version: number;
  pin_hash: string;
}

export async function authenticate(headers: Headers): Promise<Actor | null> {
  const token = bearerToken(headers);
  if (token === null) return null;
  const payload = verifyToken(token);
  const id = Number(payload.sub);
  if (!Number.isSafeInteger(id)) throw new UnauthorizedError();

  if (payload.kind === 'staff') {
    const rows = await query<StaffRow>(
      'select id, username, name, role from staff where id = $1 and is_active',
      [id],
    );
    const row = rows[0];
    if (!row) throw new UnauthorizedError('This account is no longer active');
    return { kind: 'staff', id: row.id, role: row.role, name: row.name, username: row.username };
  }

  const rows = await query<SubscriberAuthRow>(
    'select id, code, name, token_version from subscribers where id = $1 and deleted_at is null',
    [id],
  );
  const row = rows[0];
  if (!row) throw new UnauthorizedError();
  // A PIN reset bumps token_version, which invalidates every token issued before it.
  if (row.token_version !== payload.tv) {
    throw new UnauthorizedError('Your PIN was changed. Sign in again.');
  }
  return { kind: 'subscriber', id: row.id, code: row.code, name: row.name };
}

export function clientIp(headers: Headers): string | null {
  return (
    headers.get('x-nf-client-connection-ip') ??
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    null
  );
}

async function recentFailures(column: 'identifier' | 'ip', value: string): Promise<number> {
  const rows = await query<{ failures: number }>(
    `select count(*)::bigint as failures from login_attempts
      where ${column} = $1 and succeeded = false
        and created_at > now() - make_interval(secs => $2)`,
    [value, LOGIN_WINDOW_SECONDS],
  );
  return rows[0]?.failures ?? 0;
}

/**
 * Blocks once five failures for the same identifier, or the same IP, land inside the
 * window — whether or not this attempt's credentials are correct. A four digit PIN is
 * a 10,000 wide space, so the block has to precede the credential check.
 */
export async function assertNotRateLimited(identifier: string, ip: string | null): Promise<void> {
  if ((await recentFailures('identifier', identifier)) >= LOGIN_MAX_FAILURES) {
    throw new RateLimitError(LOGIN_WINDOW_SECONDS);
  }
  if (ip !== null && (await recentFailures('ip', ip)) >= LOGIN_MAX_FAILURES) {
    throw new RateLimitError(LOGIN_WINDOW_SECONDS);
  }
}

export async function recordLoginAttempt(
  identifier: string,
  kind: 'staff' | 'subscriber',
  succeeded: boolean,
  ip: string | null,
): Promise<void> {
  await query(
    'insert into login_attempts (identifier, kind, succeeded, ip) values ($1, $2, $3, $4)',
    [identifier, kind, succeeded, ip],
  );
}

export interface StaffLoginResult {
  token: string;
  staff: { id: number; username: string; name: string; role: Role };
}

export async function loginStaff(
  body: unknown,
  ip: string | null,
): Promise<StaffLoginResult> {
  const input = asObject(body);
  rejectUnknownFields(input, ['username', 'password']);
  const username = requiredString(input, 'username', { maxLength: 64 });
  const password = requiredString(input, 'password', { maxLength: 200 });

  await assertNotRateLimited(username, ip);

  const rows = await query<StaffRow & { password_hash: string }>(
    `select id, username, name, role, password_hash
       from staff where username = $1 and is_active`,
    [username],
  );
  const row = rows[0];
  const ok = row !== undefined && (await verifySecret(password, row.password_hash));
  await recordLoginAttempt(username, 'staff', ok, ip);
  if (!ok || row === undefined) {
    // One message for both cases, so the response never reveals which usernames exist.
    throw new UnauthorizedError('Those sign in details are not correct', {
      messageAr: 'بيانات الدخول غير صحيحة',
    });
  }

  return {
    token: signStaffToken({ id: row.id, role: row.role }),
    staff: { id: row.id, username: row.username, name: row.name, role: row.role },
  };
}

export interface SubscriberLoginResult {
  token: string;
  subscriber: { id: number; code: string; name: string };
}

export async function loginSubscriber(
  body: unknown,
  ip: string | null,
): Promise<SubscriberLoginResult> {
  const input = asObject(body);
  rejectUnknownFields(input, ['code', 'pin']);
  const code = requiredString(input, 'code', { maxLength: 32 });
  const pin = requiredString(input, 'pin', { maxLength: 6 });

  await assertNotRateLimited(code, ip);

  const rows = await query<SubscriberAuthRow>(
    `select id, code, name, token_version, pin_hash
       from subscribers where code = $1 and deleted_at is null`,
    [code],
  );
  const row = rows[0];
  const ok = row !== undefined && (await verifySecret(pin, row.pin_hash));
  await recordLoginAttempt(code, 'subscriber', ok, ip);
  if (!ok || row === undefined) {
    throw new UnauthorizedError('Those sign in details are not correct', {
      messageAr: 'رقم الاشتراك أو الرمز السري غير صحيح',
    });
  }

  return {
    token: signSubscriberToken({ id: row.id }, row.token_version),
    subscriber: { id: row.id, code: row.code, name: row.name },
  };
}
