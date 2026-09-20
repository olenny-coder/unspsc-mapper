import { defineConfig } from 'drizzle-kit';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!url) {
  // drizzle-kit is also used for `generate`, which does not need a live DB.
  // Emit a placeholder so `drizzle-kit generate` works in CI without secrets.
  console.warn('[drizzle.config] DATABASE_URL is not set — using placeholder for generate.');
}

export default defineConfig({
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: url ?? 'postgresql://postgres:postgres@localhost:5432/unspsc',
  },
  strict: true,
  verbose: true,
});
