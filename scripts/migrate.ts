/**
 * Forward-only migration runner. Applies every .sql file in migrations/ that is not
 * yet recorded in schema_migrations, in filename order, each inside its own transaction.
 * There is no down path: a mistake is corrected by a new numbered migration.
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { query, transaction, closePool } from '../lib/db.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

async function ensureMigrationsTable(): Promise<void> {
  await query(`
    create table if not exists schema_migrations (
      filename   text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

export async function pendingMigrations(): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(
    (await query<{ filename: string }>('select filename from schema_migrations')).map(
      (row) => row.filename,
    ),
  );
  return files.filter((f) => !applied.has(f));
}

export async function migrate(): Promise<string[]> {
  await ensureMigrationsTable();
  const pending = await pendingMigrations();
  // Migrations are ordered and each depends on the last, so they must run one at a time.
  /* eslint-disable no-await-in-loop */
  for (const filename of pending) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
    await transaction(async (tx) => {
      await tx.query(sql);
      await tx.query('insert into schema_migrations (filename) values ($1)', [filename]);
    });
    console.log(`applied ${filename}`);
  }
  /* eslint-enable no-await-in-loop */
  if (pending.length === 0) {
    console.log('no pending migrations');
  }
  return pending;
}

const invokedDirectly = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  migrate()
    .then(() => closePool())
    .catch(async (err: unknown) => {
      console.error(err);
      await closePool();
      process.exit(1);
    });
}
