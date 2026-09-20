/**
 * Database migration runner.
 *
 * Applies every `db/migrations/*.sql` file in order using drizzle-orm's
 * migrator, which keeps a `__drizzle_migrations` table so re-running is safe.
 *
 * Usage:
 *   npm run db:migrate                 # uses DATABASE_URL (pooled is fine)
 *   DATABASE_URL=... npm run db:migrate
 */
import { config as loadEnv } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, '..', 'db', 'migrations');

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) {
    console.error(
      [
        'DATABASE_URL is not set.',
        '',
        'Create a Neon project (free tier), copy the pooled connection string, then:',
        '  echo "DATABASE_URL=postgresql://..." >> .env.local',
        '  npm run db:migrate',
      ].join('\n'),
    );
    process.exit(1);
  }

  const isNeon = /neon\.tech/.test(url);
  console.log(`Running migrations from ${migrationsFolder}`);
  console.log(`Target: ${url.replace(/:\/\/[^@]+@/, '://***@')}${isNeon ? ' (Neon)' : ''}`);

  const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  const db = drizzle(client);

  try {
    await migrate(db, { migrationsFolder });
    console.log('Migrations applied successfully.');

    const tables = await client<Array<{ table_name: string }>>`
      select table_name from information_schema.tables
      where table_schema = 'public'
      order by table_name
    `;
    console.log(`Tables now present: ${tables.map((row) => row.table_name).join(', ')}`);
  } catch (error) {
    console.error('Migration failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await client.end({ timeout: 5 });
  }
}

void main();
