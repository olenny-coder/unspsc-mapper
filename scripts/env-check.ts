/**
 * Environment preflight.
 *
 * Validates the environment *without starting a build or a server*, printing one
 * line per problem. Use it to check a set of values before pasting them into
 * Vercel or Render, or to find the variable behind a
 * "Failed to collect page data for /_not-found" build failure.
 *
 *   npm run env:check                    # validates .env.local
 *   npm run env:check -- --strict        # also lists variables that are unset
 *
 * To test values that are not in a file (for example to confirm a Vercel set
 * works before saving it):
 *
 *   $env:CLASSIFY_CONFIDENCE_THRESHOLD='70'
 *   npm run env:check
 *
 * Exit code is 1 when anything is invalid, so it can gate a deploy step.
 */
import '@/lib/env-node';
import { ZodError } from 'zod';
import { resetEnvCache } from '@/lib/env';

/** Mirror of the schema's required-without-default variables, for --strict. */
const REQUIRED: Array<{ name: string; why: string }> = [
  { name: 'DATABASE_URL', why: 'the app cannot start without a database connection' },
];

const RECOMMENDED: Array<{ name: string; why: string }> = [
  { name: 'DASHBOARD_SECRET', why: 'without it every mutating endpoint returns 503 in production' },
  { name: 'WORKER_SECRET', why: 'protects POST /api/sync and the worker endpoints' },
  { name: 'GROQ_API_KEY', why: 'without it classification is skipped' },
];

/**
 * Variables whose wrong *units* are the most common mistake. Printing the
 * expected shape next to the current value makes a bad value self-evident.
 */
const HINTS: Record<string, string> = {
  CLASSIFY_CONFIDENCE_THRESHOLD: 'a probability between 0 and 1 — use 0.7, not 70',
  SYNC_STALE_DAYS: 'a whole number of days — use 30, not "30 days"',
  SYNC_BATCH_SIZE: 'a whole number between 1 and 500',
  SYNC_MAX_BATCHES_PER_RUN: 'a whole number between 1 and 1000',
  LLM_BATCH_SIZE: 'a whole number between 1 and 10 (suppliers per request)',
  LLM_MAX_REQUESTS_PER_MINUTE: 'a whole number between 1 and 1000',
  LLM_MAX_REQUESTS_PER_DAY_70B: 'a whole number, e.g. 1000',
  LLM_MAX_REQUESTS_PER_DAY_8B: 'a whole number, e.g. 14400',
  LLM_DAILY_BUDGET_RESERVE: 'a whole number, e.g. 50',
  ENRICH_MONTHLY_CREDIT_LIMIT: 'a whole number, e.g. 500',
  ENRICH_CONCURRENCY: 'a whole number between 1 and 20',
  PORT: 'a whole number, e.g. 10000',
  SITE_URL: 'an absolute URL, e.g. https://unspsc-mapper.vercel.app',
  APP_ORIGIN: 'an absolute URL, e.g. https://unspsc-mapper.vercel.app',
  NEXT_PUBLIC_APP_URL: 'an absolute URL, e.g. https://unspsc-mapper.vercel.app',
  ENRICH_PROVIDER: 'one of companyenrich | contextdev | none (case-insensitive)',
  CLASSIFY_MODEL_STRATEGY: 'one of tiered | accurate | bulk (case-insensitive)',
};

async function main(): Promise<void> {
  const strict = process.argv.includes('--strict');
  const { getEnv } = await import('@/lib/env');
  resetEnvCache();

  let valid = true;

  try {
    const env = getEnv();
    console.log('Environment is valid.');
    console.log('');
    console.log(`  NODE_ENV                        ${env.NODE_ENV}`);
    console.log(`  DATABASE_URL                    ${env.DATABASE_URL ? redact(env.DATABASE_URL) : '(unset)'}`);
    console.log(`  public origin                   ${env.SITE_URL ?? env.APP_ORIGIN ?? '(auto: Vercel host or localhost)'}`);
    console.log(`  CLASSIFY_CONFIDENCE_THRESHOLD   ${env.CLASSIFY_CONFIDENCE_THRESHOLD}`);
    console.log(`  model strategy                  ${env.CLASSIFY_MODEL_STRATEGY}`);
    console.log(`  enrichment provider             ${env.ENRICH_PROVIDER}`);
    console.log(`  ALLOW_INDEXING                  ${env.ALLOW_INDEXING}`);
  } catch (error) {
    valid = false;
    console.log('Environment is INVALID — this would abort a build with');
    console.log('"Failed to collect page data for /_not-found".');
    console.log('');

    if (error instanceof ZodError) {
      for (const issue of error.issues) {
        const name = issue.path.join('.') || '(root)';
        console.log(`  ✗ ${name}`);
        console.log(`      ${issue.message}`);
        if (HINTS[name]) console.log(`      expected: ${HINTS[name]}`);
      }
    } else if (error instanceof Error) {
      /*
       * ConfigError already formats one line per problem (variable, then message).
       * Printing its structured issues is enough, and keeps the tool consistent
       * with the build-log output. An earlier version printed both the message and
       * the parsed/unparsed values, which read as two separate problems.
       */
      const details = (error as { details?: { issues?: Array<{ variable: string; problem: string }> } }).details;
      if (details?.issues?.length) {
        for (const issue of details.issues) {
          console.log(`  ✗ ${issue.variable}`);
          console.log(`      ${issue.problem}`);
          if (HINTS[issue.variable]) console.log(`      expected: ${HINTS[issue.variable]}`);
        }
      } else {
        console.log(error.message.split('\n').map((line) => `  ${line}`).join('\n'));
      }
    } else {
      console.log(`  ${String(error)}`);
    }
  }

  console.log('');
  console.log('Reminder: only DATABASE_URL is required. Every other variable has a working');
  console.log('default, so deleting a problem variable is a valid fix.');

  if (strict) {
    console.log('');
    const missingRequired = REQUIRED.filter((entry) => !process.env[entry.name]);
    const missingRecommended = RECOMMENDED.filter((entry) => !process.env[entry.name]);
    if (missingRequired.length) {
      console.log('Missing required:');
      for (const entry of missingRequired) console.log(`  ✗ ${entry.name} — ${entry.why}`);
    }
    console.log('Unset (recommended):');
    for (const entry of missingRecommended) {
      console.log(`  ${process.env[entry.name] ? '·' : '○'} ${entry.name} — ${entry.why}`);
    }
  }

  process.exitCode = valid ? 0 : 1;
}

/** Never print credentials. */
function redact(url: string): string {
  return url.replace(/:\/\/[^@]*@/, '://***@');
}

void main();
