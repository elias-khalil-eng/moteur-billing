/**
 * Integration-test harness. Tests run against a real Postgres with the real
 * migrations applied, and call the real Netlify function handler with a real
 * Request object. Nothing is mocked.
 */

import { query, closePool } from '../../lib/db.js';
import { migrate } from '../../scripts/migrate.js';
import handler from '../../netlify/functions/api.js';

let migrated = false;

export async function ensureSchema(): Promise<void> {
  if (!migrated) {
    await migrate();
    migrated = true;
  }
}

const TABLES = [
  'audit_log',
  'login_attempts',
  'push_subscriptions',
  'notifications',
  'service_requests',
  'device_readings',
  'meter_devices',
  'payments',
  'bills',
  'meter_readings',
  'billing_cycles',
  'expenses',
  'subscribers',
  'staff',
];

/** Empties every table in the disposable test database between tests. */
export async function resetTables(): Promise<void> {
  await query(`truncate table ${TABLES.join(', ')} restart identity cascade`);
}

export async function shutdown(): Promise<void> {
  await closePool();
}

export interface ApiCall {
  method?: string;
  path: string;
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
}

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

const ORIGIN = 'http://localhost:8888';

export async function call<T = unknown>(options: ApiCall): Promise<ApiResult<T>> {
  const headers = new Headers(options.headers ?? {});
  if (options.token) {
    headers.set('authorization', `Bearer ${options.token}`);
  }
  const init: RequestInit = { method: options.method ?? 'GET', headers };
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(options.body);
  }
  const response = await handler(new Request(`${ORIGIN}${options.path}`, init));
  const text = await response.text();
  return {
    status: response.status,
    body: (text === '' ? null : JSON.parse(text)) as T,
  };
}

// --- fixtures -------------------------------------------------------------

import { hashSecret, signStaffToken, signSubscriberToken } from '../../lib/auth.js';
import type { Role } from '../../lib/types.js';

export interface StaffFixture {
  id: number;
  username: string;
  password: string;
  role: Role;
  token: string;
}

export async function createStaff(
  role: Role,
  username = role === 'owner' ? 'owner' : 'collector',
  password = 'correct-horse',
): Promise<StaffFixture> {
  const rows = await query<{ id: number }>(
    `insert into staff (username, password_hash, name, role)
     values ($1, $2, $3, $4) returning id`,
    [username, await hashSecret(password), username, role],
  );
  const id = rows[0]!.id;
  return { id, username, password, role, token: signStaffToken({ id, role }) };
}

export interface SubscriberFixture {
  id: number;
  code: string;
  pin: string;
  token: string;
}

export async function createSubscriber(
  code: string,
  pin = '482100',
  name = `Subscriber ${code}`,
  zone: string | null = null,
): Promise<SubscriberFixture> {
  const rows = await query<{ id: number; token_version: number }>(
    `insert into subscribers (code, pin_hash, name, zone)
     values ($1, $2, $3, $4) returning id, token_version`,
    [code, await hashSecret(pin), name, zone],
  );
  const row = rows[0]!;
  return { id: row.id, code, pin, token: signSubscriberToken({ id: row.id }, row.token_version) };
}
