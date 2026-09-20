/**
 * Postgres connection pool + Drizzle client.
 *
 * Neon serverless Postgres speaks the standard wire protocol, so the plain
 * `postgres` (postgres.js) driver works both on Vercel's Node runtime and in the
 * Render worker. Notes:
 *  - Use the *pooled* connection string (`-pooler`) for the app and worker.
 *  - `prepare: false` keeps compatibility with PgBouncer transaction pooling.
 *  - `max: 1` on Vercel avoids exhausting Neon connections across lambdas.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@/db/schema';
import { getEnv } from '@/lib/env';
import { DatabaseError } from '@/lib/errors';

export type Database = PostgresJsDatabase<typeof schema>;

type GlobalWithDb = typeof globalThis & {
  __unspscDb?: Database;
  __unspscSql?: ReturnType<typeof postgres>;
};

const globalForDb = globalThis as GlobalWithDb;

function createSqlClient(): ReturnType<typeof postgres> {
  const env = getEnv();
  if (!env.DATABASE_URL) {
    throw new DatabaseError(
      'DATABASE_URL is not configured. Set it in .env.local (dev) or in the Vercel/Render environment.',
    );
  }
  const isServerless = Boolean(process.env.VERCEL) || env.NODE_ENV === 'production';

  return postgres(env.DATABASE_URL, {
    max: isServerless ? 1 : 10,
    idle_timeout: isServerless ? 20 : 30,
    connect_timeout: 15,
    // Required for Neon's PgBouncer-compatible pooler.
    prepare: false,
    // Neon free tier: fail fast rather than hanging a serverless invocation.
    max_lifetime: 60 * 10,
    onnotice: () => {},
    transform: { undefined: null },
  });
}

/** Lazily created singleton (per process). */
export function getSql(): ReturnType<typeof postgres> {
  if (!globalForDb.__unspscSql) {
    globalForDb.__unspscSql = createSqlClient();
  }
  return globalForDb.__unspscSql;
}

export function getDb(): Database {
  if (!globalForDb.__unspscDb) {
    globalForDb.__unspscDb = drizzle(getSql(), { schema, logger: false });
  }
  return globalForDb.__unspscDb;
}

/** Close the pool (used by scripts and the worker on shutdown). */
export async function closeDb(): Promise<void> {
  if (globalForDb.__unspscSql) {
    await globalForDb.__unspscSql.end({ timeout: 5 });
    globalForDb.__unspscSql = undefined;
    globalForDb.__unspscDb = undefined;
  }
}

/**
 * Injected-database form used by services, so tests can pass a fake without
 * touching module state.
 */
export type DbLike = Database;

/** Helper: run a callback inside a transaction with a consistent DbLike. */
export async function withTransaction<T>(fn: (tx: DbLike) => Promise<T>): Promise<T> {
  const db = getDb();
  return db.transaction(async (tx) => fn(tx as unknown as DbLike));
}

export { schema };
