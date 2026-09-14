/**
 * Restores a backup written by scripts/backup.ts into the database DATABASE_URL
 * points at. Intended for a rehearsal against an empty database, and for the real
 * thing on the worst day. It refuses to run against tables that already hold rows,
 * so a restore cannot quietly duplicate a live ledger.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query, transaction, closePool } from '../lib/db.js';
import { BACKUP_TABLES } from './backup.js';

const COLUMN_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Column names come out of a file on disk and are interpolated into the insert, so
 * they are checked rather than trusted. A tampered or corrupt backup should fail
 * here, not reach the database.
 */
function assertColumnName(column: string): string {
  if (!COLUMN_NAME.test(column) || column.length > 63) {
    throw new Error(`Refusing to restore: ${column} is not a valid column name`);
  }
  return column;
}

export interface RestoreResult {
  counts: Record<string, number>;
  takenAt: string;
}

interface Manifest {
  takenAt: string;
  counts: Record<string, number>;
}

async function readManifest(directory: string): Promise<Manifest> {
  try {
    return JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    throw new Error(`No manifest.json in ${directory}: that is not a backup folder`);
  }
}

export async function assertEmpty(): Promise<void> {
  for (const table of BACKUP_TABLES) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await query<{ count: number }>(`select count(*)::bigint as count from ${table}`);
    if ((rows[0]?.count ?? 0) > 0) {
      throw new Error(`Table ${table} is not empty. Restore into an empty database.`);
    }
  }
}

export async function restoreBackup(directory: string): Promise<RestoreResult> {
  const manifest = await readManifest(directory);
  await assertEmpty();

  const counts: Record<string, number> = {};

  await transaction(async (tx) => {
    /* eslint-disable no-await-in-loop */
    for (const table of BACKUP_TABLES) {
      const rows = JSON.parse(
        await readFile(path.join(directory, `${table}.json`), 'utf8'),
      ) as Record<string, unknown>[];
      counts[table] = rows.length;
      if (rows.length === 0) continue;

      const columns = Object.keys(rows[0]!).map(assertColumnName);
      for (const row of rows) {
        const values = columns.map((column) => {
          const value = row[column];
          return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
        });
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
        await tx.query(
          `insert into ${table} (${columns.join(', ')}) values (${placeholders})`,
          values as never,
        );
      }

      // Every table uses a bigserial id, so the sequence has to skip past what was restored.
      await tx.query(
        `select setval(pg_get_serial_sequence('${table}', 'id'),
                       coalesce((select max(id) from ${table}), 1))`,
      );
    }
    /* eslint-enable no-await-in-loop */
  });

  return { counts, takenAt: manifest.takenAt };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const directory = process.argv[2];
  if (directory === undefined) {
    console.error('usage: tsx scripts/restore.ts <backup directory>');
    process.exit(1);
  }
  restoreBackup(directory)
    .then(async (result) => {
      console.log(`restored the backup taken at ${result.takenAt}`);
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
