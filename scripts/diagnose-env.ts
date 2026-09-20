/**
 * Reproduce the Vercel build failure by testing env-var shapes.
 *
 * The Vercel build fails at "collect page data for /_not-found", which means the
 * root layout throws while its metadata is evaluated. `lib/seo.ts` parses the
 * public origin with `new URL(...)` at module scope, so a malformed
 * `NEXT_PUBLIC_APP_URL` / `SITE_URL` would do exactly that.
 *
 *   npx tsx scripts/diagnose-env.ts
 */
import { resetEnvCache, getEnv } from '@/lib/env';
import { siteUrl, rootMetadata } from '@/lib/seo';

type Case = { label: string; env: Record<string, string | undefined> };

const CASES: Case[] = [
  { label: 'no URL vars at all', env: {} },
  { label: 'NEXT_PUBLIC_APP_URL without scheme', env: { NEXT_PUBLIC_APP_URL: 'example.vercel.app' } },
  { label: 'NEXT_PUBLIC_APP_URL with scheme', env: { NEXT_PUBLIC_APP_URL: 'https://example.vercel.app' } },
  { label: 'NEXT_PUBLIC_APP_URL with trailing slash', env: { NEXT_PUBLIC_APP_URL: 'https://example.vercel.app/' } },
  { label: 'NEXT_PUBLIC_APP_URL = localhost (no scheme)', env: { NEXT_PUBLIC_APP_URL: 'localhost:3000' } },
  { label: 'SITE_URL without scheme', env: { SITE_URL: 'example.vercel.app' } },
  { label: 'SITE_URL with scheme', env: { SITE_URL: 'https://example.vercel.app' } },
  { label: 'SITE_URL empty string + APP_URL unset', env: { SITE_URL: '' } },
  { label: 'only VERCEL_PROJECT_PRODUCTION_URL', env: { VERCEL_PROJECT_PRODUCTION_URL: 'example.vercel.app' } },
  { label: 'APP_URL = "undefined" (string literal)', env: { NEXT_PUBLIC_APP_URL: 'undefined' } },
  { label: 'bad LLM_BATCH_SIZE', env: { NEXT_PUBLIC_APP_URL: 'https://x.vercel.app', LLM_BATCH_SIZE: 'ten' } },
  { label: 'bad SYNC_STALE_DAYS', env: { NEXT_PUBLIC_APP_URL: 'https://x.vercel.app', SYNC_STALE_DAYS: '30 days' } },
  { label: 'bad ALLOW_INDEXING', env: { NEXT_PUBLIC_APP_URL: 'https://x.vercel.app', ALLOW_INDEXING: 'maybe' } },
  { label: 'bad CLASSIFY_CONFIDENCE_THRESHOLD = 70', env: { NEXT_PUBLIC_APP_URL: 'https://x.vercel.app', CLASSIFY_CONFIDENCE_THRESHOLD: '70' } },
  { label: 'bad CRON_SYNC', env: { NEXT_PUBLIC_APP_URL: 'https://x.vercel.app', CRON_SYNC: 'daily' } },
];

const MANAGED = [
  'NEXT_PUBLIC_APP_URL',
  'SITE_URL',
  'VERCEL_PROJECT_PRODUCTION_URL',
  'LLM_BATCH_SIZE',
  'SYNC_STALE_DAYS',
  'ALLOW_INDEXING',
  'CLASSIFY_CONFIDENCE_THRESHOLD',
  'CRON_SYNC',
  'NODE_ENV',
];

function main(): void {
  const saved = Object.fromEntries(MANAGED.map((key) => [key, process.env[key]]));
  // `process.env.NODE_ENV` is typed read-only.
  const mutableEnv = process.env as Record<string, string | undefined>;

  for (const testCase of CASES) {
    for (const key of MANAGED) delete mutableEnv[key];
    mutableEnv.NODE_ENV = 'production';
    Object.assign(mutableEnv, testCase.env);
    resetEnvCache();

    let outcome: string;
    try {
      const env = getEnv();
      const base = siteUrl();
      // The exact expression the layout evaluates at build time.
      const metadata = rootMetadata();
      outcome = `OK   base=${base} metadataBase=${metadata.metadataBase} allowIndexing=${env.ALLOW_INDEXING}`;
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      const message = error instanceof Error ? error.message : String(error);
      const details = (error as { details?: unknown }).details;
      outcome = `THROW ${name}: ${message.slice(0, 150)}${details ? ` | details=${JSON.stringify(details).slice(0, 200)}` : ''}`;
    }

    const fails = outcome.startsWith('THROW');
    console.log(`${fails ? '!!' : '  '} ${testCase.label.padEnd(46)} ${outcome}`);
  }

  for (const key of MANAGED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetEnvCache();
}

main();
