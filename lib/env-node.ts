/**
 * Node-only environment loading.
 *
 * Import this **first** from any entry point that runs outside Next.js — the
 * `scripts/*` CLIs, the Render worker, and tests — so `.env.local` is populated
 * before anything calls `getEnv()`.
 *
 * It exists as a separate module because `lib/env.ts` is in the Edge Runtime
 * graph (middleware imports `lib/auth.ts`), and neither a static `dotenv` import
 * nor `eval('require')` is acceptable there. Keeping the loader here means the
 * Edge bundle never sees it.
 *
 * Next.js loads the env files itself for the app, so this is only for the
 * out-of-band entry points.
 *
 * @example
 *   import '@/lib/env-node';
 *   import { getEnv } from '@/lib/env';
 */
import { config as loadDotenv } from 'dotenv';

let loaded = false;

/** Idempotent: safe to import from several modules in one process. */
export function loadEnvFiles(): void {
  if (loaded) return;
  loaded = true;
  // dotenv never overwrites an existing value, so real environment variables
  // (Vercel, Render, CI) always take precedence over the files.
  loadDotenv({ path: '.env.local' });
  loadDotenv({ path: '.env' });
}

loadEnvFiles();

export {};
