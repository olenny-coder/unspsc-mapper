/**
 * Exhaustive reproduction of "Failed to collect page data for /_not-found".
 *
 * That message means the root layout threw while its metadata was evaluated at
 * build time — before any page rendered. This script enumerates every input that
 * can reach `metadataBase: new URL(...)` and reports which ones throw, including
 * shapes that are *not* covered by `lib/env.ts` validation:
 *
 *   - `VERCEL_PROJECT_PRODUCTION_URL` is read directly from `process.env` and was
 *     historically not validated, so a malformed value bypasses the env schema
 *     entirely and throws a bare `TypeError: Invalid URL` — which is exactly the
 *     shape of a Vercel build failure with no useful message.
 *
 *   npx tsx scripts/diagnose-build.ts
 */
import { resetEnvCache, getEnv } from '@/lib/env';
import { rootMetadata, siteUrl } from '@/lib/seo';

type Case = { label: string; env: Record<string, string | undefined> };

/**
 * Sentinels that are not real values but get typed into dashboards. Vercel's UI
 * prefills fields and copying `undefined`/`null` out of a log is easy.
 */
const PLACEHOLDER = ['undefined', 'null', 'none', 'false', '""', "''"];

const CASES: Case[] = [
  { label: 'nothing set (should default safely)', env: {} },
  { label: 'APP_URL scheme-less', env: { NEXT_PUBLIC_APP_URL: 'x.vercel.app' } },
  { label: 'APP_URL with scheme', env: { NEXT_PUBLIC_APP_URL: 'https://x.vercel.app' } },
  { label: 'APP_URL placeholder "undefined"', env: { NEXT_PUBLIC_APP_URL: 'undefined' } },
  { label: 'SITE_URL scheme-less', env: { SITE_URL: 'x.vercel.app' } },
  { label: 'SITE_URL scheme-less + APP_URL unset', env: { SITE_URL: 'x.vercel.app' } },
  // ---- the gap: this bypasses the env schema entirely ----
  { label: 'VERCEL_PROJECT_PRODUCTION_URL scheme-less', env: { VERCEL_PROJECT_PRODUCTION_URL: 'x.vercel.app' } },
  { label: 'VERCEL_PROJECT_PRODUCTION_URL with scheme', env: { VERCEL_PROJECT_PRODUCTION_URL: 'https://x.vercel.app' } },
  { label: 'VERCEL_PROJECT_PRODUCTION_URL placeholder', env: { VERCEL_PROJECT_PRODUCTION_URL: 'undefined' } },
  { label: 'VERCEL_PROJECT_PRODUCTION_URL = ":"', env: { VERCEL_PROJECT_PRODUCTION_URL: ':' } },
  { label: 'VERCEL_PROJECT_PRODUCTION_URL = "http://"', env: { VERCEL_PROJECT_PRODUCTION_URL: 'http://' } },
  { label: 'VERCEL_PROJECT_PRODUCTION_URL with spaces', env: { VERCEL_PROJECT_PRODUCTION_URL: 'my app.vercel.app' } },
  // ---- numeric/literal env mistakes ----
  { label: 'THRESHOLD = 70 (percent not probability)', env: { NEXT_PUBLIC_APP_URL: 'https://x.vercel.app', CLASSIFY_CONFIDENCE_THRESHOLD: '70' } },
  { label: 'THRESHOLD = 0.7 (correct)', env: { NEXT_PUBLIC_APP_URL: 'https://x.vercel.app', CLASSIFY_CONFIDENCE_THRESHOLD: '0.7' } },
  { label: 'SYNC_STALE_DAYS = "30 days"', env: { NEXT_PUBLIC_APP_URL: 'https://x.vercel.app', SYNC_STALE_DAYS: '30 days' } },
  { label: 'LLM_BATCH_SIZE = ten', env: { NEXT_PUBLIC_APP_URL: 'https://x.vercel.app', LLM_BATCH_SIZE: 'ten' } },
  { label: 'ENRICH_CONCURRENCY = 0', env: { NEXT_PUBLIC_APP_URL: 'https://x.vercel.app', ENRICH_CONCURRENCY: '0' } },
  { label: 'PORT = abc', env: { NEXT_PUBLIC_APP_URL: 'https://x.vercel.app', PORT: 'abc' } },
  { label: 'ENRICH_PROVIDER = CompanyEnrich (case)', env: { NEXT_PUBLIC_APP_URL: 'https://x.vercel.app', ENRICH_PROVIDER: 'CompanyEnrich' } },
  { label: 'CLASSIFY_MODEL_STRATEGY = Tiered (case)', env: { NEXT_PUBLIC_APP_URL: 'https://x.vercel.app', CLASSIFY_MODEL_STRATEGY: 'Tiered' } },
];

const MANAGED = [
  'NEXT_PUBLIC_APP_URL',
  'SITE_URL',
  'VERCEL_PROJECT_PRODUCTION_URL',
  'CLASSIFY_CONFIDENCE_THRESHOLD',
  'SYNC_STALE_DAYS',
  'LLM_BATCH_SIZE',
  'ENRICH_CONCURRENCY',
  'PORT',
  'ENRICH_PROVIDER',
  'CLASSIFY_MODEL_STRATEGY',
];

function main(): void {
  const mutableEnv = process.env as Record<string, string | undefined>;
  const saved = Object.fromEntries(MANAGED.map((key) => [key, mutableEnv[key]]));

  const failures: string[] = [];

  console.log('Simulating "next build" metadata evaluation (NODE_ENV=production)');
  console.log('');

  for (const testCase of CASES) {
    for (const key of MANAGED) delete mutableEnv[key];
    mutableEnv.NODE_ENV = 'production';
    Object.assign(mutableEnv, testCase.env);
    resetEnvCache();

    try {
      // Exactly what app/layout.tsx evaluates at module scope.
      const metadata = rootMetadata();
      const env = getEnv();
      console.log(
        `  ok   ${testCase.label.padEnd(44)} metadataBase=${String(metadata.metadataBase)} (enrich=${env.ENRICH_PROVIDER}, strategy=${env.CLASSIFY_MODEL_STRATEGY})`,
      );
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      const message = error instanceof Error ? error.message : String(error);
      const details = (error as { details?: unknown }).details;
      failures.push(testCase.label);
      console.log(
        `  FAIL ${testCase.label.padEnd(44)} ${name}: ${message.slice(0, 120)}` +
          (details ? `\n         details=${JSON.stringify(details).slice(0, 160)}` : ''),
      );
    }
  }

  for (const key of MANAGED) {
    if (saved[key] === undefined) delete mutableEnv[key];
    else mutableEnv[key] = saved[key];
  }
  resetEnvCache();

  console.log('');
  if (failures.length) {
    console.log(`${failures.length} input shape(s) crash the build:`);
    for (const label of failures) console.log(`  - ${label}`);
    process.exitCode = 1;
  } else {
    console.log('No input shape crashed the build.');
  }
}

main();
