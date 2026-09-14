/**
 * Dumps every table to timestamped JSON and CSV. Supabase's own backups are the
 * primary; this is the one the owner controls and can read without a vendor.
 *
 * Run it on a schedule, and verify a restore before launch.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query, closePool } from '../lib/db.js';

/** Parents before children, which is also the order restore inserts them in. */
export const BACKUP_TABLES = [
  'staff',
  'subscribers',
  'billing_cycles',
  'meter_readings',
  'bills',
  'payments',
  'expenses',
  'notifications',
  'push_subscriptions',
  'audit_log',
  'login_attempts',
] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];

export interface BackupResult {
  directory: string;
  counts: Record<string, number>;
  takenAt: string;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const columns = Object.keys(rows[0]!);
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export async function runBackup(rootDirectory: string): Promise<BackupResult> {
  const takenAt = new Date().toISOString();
  const directory = path.join(rootDirectory, takenAt.replace(/:/g, '-'));
  await mkdir(directory, { recursive: true });

  const counts: Record<string, number> = {};
  /* eslint-disable no-await-in-loop */
  for (const table of BACKUP_TABLES) {
    const rows = await query<Record<string, unknown>>(`select * from ${table} order by id`);
    counts[table] = rows.length;
    await writeFile(path.join(directory, `${table}.json`), JSON.stringify(rows, null, 2), 'utf8');
    await writeFile(path.join(directory, `${table}.csv`), toCsv(rows), 'utf8');
  }
  /* eslint-enable no-await-in-loop */

  await writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify({ takenAt, tables: BACKUP_TABLES, counts }, null, 2),
    'utf8',
  );

  return { directory, counts, takenAt };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const target = process.argv[2] ?? path.join(process.cwd(), 'backups');
  runBackup(target)
    .then(async (result) => {
      console.log(`backup written to ${result.directory}`);
      for (const [table, count] of Object.entries(result.counts)) {
        console.log(`  ${table}: ${count}`);
      }
      await closePool();
    })
    .catch(async (err: unknown) => {
      console.error(err);
      await closePool();
      process.exit(1);
    });
}
