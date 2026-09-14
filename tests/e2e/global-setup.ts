/**
 * Applies the migrations and puts the database into a known state before the smoke
 * suite runs: one owner, one collector, and nothing else. The flows create the rest
 * through the interface, which is the point of the exercise.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

function loadTestEnv(): void {
  const file = path.join(process.cwd(), '.env.test');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]!] === undefined) {
      process.env[match[1]!] = match[2]!;
    }
  }
}

export const OWNER = { username: 'owner-e2e', password: 'owner-password-1' };
export const COLLECTOR = { username: 'collector-e2e', password: 'collector-password-1' };

export default async function globalSetup(): Promise<void> {
  loadTestEnv();

  const { migrate } = await import('../../scripts/migrate.js');
  const { query, closePool } = await import('../../lib/db.js');
  const { hashSecret } = await import('../../lib/auth.js');

  await migrate();
  await query(
    `truncate table audit_log, login_attempts, push_subscriptions, notifications, payments,
                    bills, meter_readings, billing_cycles, expenses, subscribers, staff
     restart identity cascade`,
  );

  for (const [account, role] of [
    [OWNER, 'owner'],
    [COLLECTOR, 'collector'],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop
    await query('insert into staff (username, password_hash, name, role) values ($1, $2, $3, $4)', [
      account.username,
      await hashSecret(account.password),
      account.username,
      role,
    ]);
  }

  await closePool();
}
