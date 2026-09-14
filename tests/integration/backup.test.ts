import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureSchema, resetTables, shutdown, createStaff, createSubscriber } from './helpers.js';
import { query } from '../../lib/db.js';
import { runBackup, BACKUP_TABLES } from '../../scripts/backup.js';
import { restoreBackup } from '../../scripts/restore.js';

let directory: string;

beforeAll(async () => {
  await ensureSchema();
});

beforeEach(async () => {
  await resetTables();
  directory = await mkdtemp(path.join(tmpdir(), 'moteur-backup-'));
});

afterAll(async () => {
  await shutdown();
});

async function seedSomething() {
  const owner = await createStaff('owner', 'sami');
  const subscriber = await createSubscriber('1001', '482100', 'Sami Haddad', 'A');
  const cycle = await query<{ id: number }>(
    `insert into billing_cycles (period, usd_per_kwh_cents, lbp_rate, status, issued_at, opened_by)
     values ('2026-09', 30, 89000, 'issued', now(), $1) returning id`,
    [owner.id],
  );
  await query(
    `insert into bills (subscriber_id, cycle_id, kwh, usd_per_kwh_cents, amount_usd_cents, lbp_rate, amount_lbp)
     values ($1, $2, 1250, 30, 37500, 89000, 33375000)`,
    [subscriber.id, cycle[0]!.id],
  );
  await query(
    `insert into payments (subscriber_id, amount_usd_cents, paid_currency, received_by)
     values ($1, 20000, 'USD', $2)`,
    [subscriber.id, owner.id],
  );
  return { owner, subscriber };
}

describe('backup', () => {
  it('writes one JSON and one CSV per table, into a timestamped folder', async () => {
    await seedSomething();
    const result = await runBackup(directory);

    const files = await readdir(result.directory);
    for (const table of BACKUP_TABLES) {
      expect(files).toContain(`${table}.json`);
      expect(files).toContain(`${table}.csv`);
    }
    expect(files).toContain('manifest.json');
    expect(path.basename(result.directory)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('records the row counts it wrote', async () => {
    await seedSomething();
    const result = await runBackup(directory);
    expect(result.counts.bills).toBe(1);
    expect(result.counts.payments).toBe(1);
    expect(result.counts.subscribers).toBe(1);

    const manifest = JSON.parse(
      await readFile(path.join(result.directory, 'manifest.json'), 'utf8'),
    ) as { counts: Record<string, number> };
    expect(manifest.counts.bills).toBe(1);
  });

  it('writes money as integers, never as a float or a string', async () => {
    await seedSomething();
    const result = await runBackup(directory);
    const bills = JSON.parse(
      await readFile(path.join(result.directory, 'bills.json'), 'utf8'),
    ) as { amount_usd_cents: number; amount_lbp: number }[];
    expect(bills[0]!.amount_usd_cents).toBe(37_500);
    expect(Number.isInteger(bills[0]!.amount_lbp)).toBe(true);
  });
});

describe('restore', () => {
  it('puts every row back after the tables are emptied', async () => {
    await seedSomething();
    const backup = await runBackup(directory);

    await resetTables();
    const empty = await query<{ count: number }>(
      'select count(*)::bigint as count from bills',
    );
    expect(empty[0]!.count).toBe(0);

    const restored = await restoreBackup(backup.directory);
    expect(restored.counts.bills).toBe(1);

    const bills = await query<{ amount_usd_cents: number; kwh: number }>(
      'select amount_usd_cents, kwh from bills',
    );
    expect(bills).toHaveLength(1);
    expect(bills[0]!.amount_usd_cents).toBe(37_500);
    expect(bills[0]!.kwh).toBe(1_250);

    const balance = await query<{ balance_usd_cents: number }>(
      'select balance_usd_cents from subscriber_balances',
    );
    expect(balance[0]!.balance_usd_cents).toBe(17_500);
  });

  it('leaves the sequences past the restored ids, so the next insert does not collide', async () => {
    const { owner } = await seedSomething();
    const backup = await runBackup(directory);
    await resetTables();
    await restoreBackup(backup.directory);

    const inserted = await query<{ id: number }>(
      `insert into staff (username, password_hash, name, role)
       values ('another', 'hash', 'Another', 'collector') returning id`,
    );
    expect(inserted[0]!.id).toBeGreaterThan(owner.id);
  });

  it('refuses a directory that has no manifest', async () => {
    await expect(restoreBackup(directory)).rejects.toThrow(/manifest/);
  });
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
