/**
 * Connections and query execution. This module knows nothing about domain meaning:
 * no validation, no business rules, no HTTP. Domain modules pass SQL and parameters.
 */

import pg from 'pg';

const { Pool, types } = pg;

// bigint and numeric arrive as strings by default. Every bigint here is an id or an
// integer amount that fits in a JS safe integer, and the one numeric column (liters)
// is a small decimal, so parsing both to number keeps the domain layer free of casts.
types.setTypeParser(20, (value: string) => Number(value)); // int8
types.setTypeParser(1700, (value: string) => Number(value)); // numeric

export type QueryParam = string | number | boolean | Date | null | undefined | object;

export interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly QueryParam[],
  ): Promise<T[]>;
}

function isLocal(connectionString: string): boolean {
  return connectionString.includes('localhost') || connectionString.includes('127.0.0.1');
}

/**
 * TLS is verified by default. Turning verification off would leave the connection
 * open to anyone who can sit between the function and the database, and every amount
 * in this system travels over it, so it is opt-in and loud rather than the default.
 * A provider whose certificate chain Node does not carry needs DATABASE_SSL_CA, or
 * DATABASE_SSL_NO_VERIFY=true as a deliberate, documented exception.
 */
function sslOptions(connectionString: string): pg.PoolConfig['ssl'] {
  if (isLocal(connectionString)) return undefined;
  if (process.env.DATABASE_SSL_NO_VERIFY === 'true') {
    console.warn('DATABASE_SSL_NO_VERIFY is set: the database connection is not verified');
    return { rejectUnauthorized: false };
  }
  const ca = process.env.DATABASE_SSL_CA;
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool === null) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new Pool({
      connectionString,
      max: Number(process.env.DB_POOL_MAX ?? 4),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      ssl: sslOptions(connectionString),
    });
  }
  return pool;
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: readonly QueryParam[] = [],
): Promise<T[]> {
  const result = await getPool().query(sql, params as unknown[]);
  return result.rows as T[];
}

export async function maybeOne<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: readonly QueryParam[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/**
 * Runs fn inside a transaction on a single dedicated connection. Everything the
 * bill-issuing path does must go through the client passed to fn, or it will run
 * outside the transaction on a different connection.
 */
export async function transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const tx: Queryable = {
      async query(sql, params = []) {
        const result = await client.query(sql, params as unknown[]);
        return result.rows as never;
      },
    };
    const value = await fn(tx);
    await client.query('commit');
    return value;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool !== null) {
    const closing = pool;
    pool = null;
    await closing.end();
  }
}
