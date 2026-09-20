/**
 * Environment parsing.
 *
 * Everything is optional-with-defaults except the three credentials, and the
 * credential checks are deferred until the feature that needs them is used.
 * That keeps `next build`, `npm test` and `npm run lint` working with no
 * secrets present (important for CI), while failing loudly at runtime if a
 * feature is used without its key.
 */
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { ConfigError } from '@/lib/errors';

/**
 * Load `.env.local` / `.env` once, before anything reads `process.env`.
 *
 * Next.js does this itself for the app, but standalone scripts, the Render
 * worker and the Vitest process do not — and a script that silently sees no
 * `DATABASE_URL` is a confusing failure. dotenv never overwrites values that are
 * already set, so platform-provided variables always win.
 */
let envFilesLoaded = false;
function loadEnvFiles(): void {
  if (envFilesLoaded) return;
  envFilesLoaded = true;
  try {
    loadDotenv({ path: '.env.local' });
    loadDotenv({ path: '.env' });
  } catch {
    // A missing dotenv or missing files is not fatal: production platforms inject
    // real environment variables.
  }
}

const boolFromString = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((value) => {
      if (typeof value === 'boolean') return value;
      const normalized = value.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
      if (['0', 'false', 'no', 'off', ''].includes(normalized)) return false;
      return defaultValue;
    });

const intFromString = (defaultValue: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .union([z.number(), z.string()])
    .default(defaultValue)
    .transform((value, ctx) => {
      const parsed = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected an integer, received "${value}"` });
        return z.NEVER;
      }
      if (parsed < min || parsed > max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected ${min}..${max}, received ${parsed}` });
        return z.NEVER;
      }
      return parsed;
    });

const floatFromString = (defaultValue: number, min = 0, max = 1) =>
  z
    .union([z.number(), z.string()])
    .default(defaultValue)
    .transform((value, ctx) => {
      const parsed = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected ${min}..${max}, received "${value}"` });
        return z.NEVER;
      }
      return parsed;
    });

const optionalString = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = (value ?? '').trim();
    return trimmed.length ? trimmed : undefined;
  });

/**
 * A URL that tolerates a missing scheme.
 *
 * `new URL('yourapp.vercel.app')` throws, but that is exactly what people type
 * into a `NEXT_PUBLIC_APP_URL` field, and the resulting build failure reads
 * `TypeError: Invalid URL` with no hint about which variable was at fault.
 * `http://` is assumed when no scheme is present, the hostname is required, and
 * anything still unparseable fails with the variable's name in the message.
 */
const urlFromString = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value, ctx) => {
      const raw = value.trim();
      if (!raw) return fallback;
      // A dashboard that stored the literal string wins over a missing value:
      // `NEXT_PUBLIC_APP_URL=undefined` would otherwise parse as http://undefined
      // and silently produce broken canonical and Open Graph URLs.
      if (['undefined', 'null', 'none', 'false'].includes(raw.toLowerCase())) return fallback;
      const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
      try {
        const parsed = new URL(candidate);
        if (!parsed.hostname) throw new Error('missing hostname');
        // Normalise: drop a trailing slash so callers can append paths safely.
        return candidate.replace(/\/+$/, '');
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `expected an absolute URL such as "https://your-app.vercel.app", received "${value}"`,
        });
        return z.NEVER;
      }
    });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: optionalString,
  DATABASE_URL_UNPOOLED: optionalString,

  GROQ_API_KEY: optionalString,
  GROQ_BASE_URL: urlFromString('https://api.groq.com/openai/v1'),
  GROQ_MODEL_ACCURATE: z.string().default('llama-3.3-70b-versatile'),
  GROQ_MODEL_BULK: z.string().default('llama-3.1-8b-instant'),

  ENRICH_PROVIDER: z.enum(['companyenrich', 'contextdev', 'none']).default('companyenrich'),
  ENRICH_API_KEY: optionalString,
  ENRICH_BASE_URL: optionalString,
  ENRICH_MONTHLY_CREDIT_LIMIT: intFromString(500, 0, 1_000_000),
  ENRICH_CONCURRENCY: intFromString(3, 1, 20),

  WORKER_SECRET: optionalString,
  WORKER_SECRET_ALLOWLIST: optionalString,
  CRON_SECRET: optionalString,
  /** Shared secret protecting the dashboard and every mutating endpoint. */
  DASHBOARD_SECRET: optionalString,
  /** Set to 'false' to disable the development auth bypass (never in production). */
  ALLOW_UNAUTHENTICATED_DEV: boolFromString(true),

  NEXT_PUBLIC_APP_URL: urlFromString('http://localhost:3000'),
  /** Canonical public origin used for SEO metadata, sitemap and OG URLs. */
  SITE_URL: z
    .string()
    .optional()
    .transform((value, ctx) => {
      const raw = (value ?? '').trim();
      if (!raw) return undefined;
      if (['undefined', 'null', 'none', 'false'].includes(raw.toLowerCase())) return undefined;
      const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
      try {
        const parsed = new URL(candidate);
        if (!parsed.hostname) throw new Error('missing hostname');
        return candidate.replace(/\/+$/, '');
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `expected an absolute URL such as "https://your-domain.com", received "${value}"`,
        });
        return z.NEVER;
      }
    }),
  /**
   * Whether search engines may index the app.
   *
   * Defaults to false: this is an authenticated internal tool, and letting a
   * dashboard that lists your suppliers and spend be indexed is a data-leak risk.
   * Set to true only for a public demo deployment.
   */
  ALLOW_INDEXING: boolFromString(false),
  APP_ACTOR: z.string().default('dashboard'),
  ADMIN_EMAILS: optionalString,

  SYNC_STALE_DAYS: intFromString(30, 1, 3650),
  SYNC_BATCH_SIZE: intFromString(25, 1, 500),
  SYNC_MAX_BATCHES_PER_RUN: intFromString(12, 1, 1000),
  CLASSIFY_CONFIDENCE_THRESHOLD: floatFromString(0.7),
  CLASSIFY_MODEL_STRATEGY: z.enum(['tiered', 'accurate', 'bulk']).default('tiered'),
  LLM_BATCH_SIZE: intFromString(10, 1, 10),
  LLM_MAX_REQUESTS_PER_MINUTE: intFromString(25, 1, 1000),
  LLM_MAX_REQUESTS_PER_DAY_70B: intFromString(1000, 1, 100_000),
  LLM_MAX_REQUESTS_PER_DAY_8B: intFromString(14400, 1, 1_000_000),
  LLM_DAILY_BUDGET_RESERVE: intFromString(50, 0, 10_000),

  PORT: intFromString(10000, 1, 65535),
  CRON_SYNC: z.string().default('0 3 * * *'),
  CRON_REPORT: z.string().default('0 6 * * 1'),
  WEEKLY_REPORT_ENABLED: boolFromString(true),
  SAMPLE_CSV_PATH: z.string().default('samples/suppliers.csv'),

  UNSPSC_SEED_CSV: optionalString,
  UNSPSC_VERSION: z.string().default('v26.0801'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * Parse `process.env`. Throws `ConfigError` with a readable summary when a
 * value is structurally invalid (not when it is merely absent).
 */
export function getEnv(): Env {
  if (cached) return cached;
  loadEnvFiles();
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid environment configuration: ${issues}`, {
      issues: parsed.error.issues as unknown as Record<string, unknown>,
    });
  }
  cached = parsed.data;
  return cached;
}

/** Test helper — drop the memoised env (used by `tests/env.test.ts`). */
export function resetEnvCache(): void {
  cached = null;
}

export function isDatabaseConfigured(): boolean {
  return Boolean(getEnv().DATABASE_URL);
}

export function isGroqConfigured(): boolean {
  return Boolean(getEnv().GROQ_API_KEY);
}

export function isEnrichmentConfigured(): boolean {
  const env = getEnv();
  return env.ENRICH_PROVIDER !== 'none' && Boolean(env.ENRICH_API_KEY);
}

/** Lazily require a credential, with an actionable message. */
export function requireGroqApiKey(): string {
  const key = getEnv().GROQ_API_KEY;
  if (!key) {
    throw new ConfigError(
      'GROQ_API_KEY is not set. Add it to .env.local (local) or the Vercel/Render project env vars.',
    );
  }
  return key;
}

export function requireDatabaseUrl(): string {
  const url = getEnv().DATABASE_URL;
  if (!url) {
    throw new ConfigError(
      'DATABASE_URL is not set. Add your Neon connection string to .env.local or the Vercel/Render env vars.',
    );
  }
  return url;
}

export function requireWorkerSecret(): string {
  const env = getEnv();
  if (env.WORKER_SECRET) return env.WORKER_SECRET;
  if (env.NODE_ENV === 'production') {
    throw new ConfigError('WORKER_SECRET must be set in production to protect worker-only endpoints.');
  }
  return 'dev-worker-secret';
}

/**
 * Secret protecting the dashboard and all mutating endpoints.
 *
 * Falls back to `WORKER_SECRET` so a single value secures both surfaces, which is
 * what most deployments will want.
 */
export function dashboardSecret(): string | null {
  const env = getEnv();
  return env.DASHBOARD_SECRET ?? env.WORKER_SECRET ?? null;
}

/**
 * Whether requests may proceed without a session.
 *
 * Only ever true outside production, and only when no secret is configured — so
 * `npm run dev` works immediately while any real deployment is locked down.
 */
export function isAuthDisabled(): boolean {
  const env = getEnv();
  if (env.NODE_ENV === 'production') return false;
  if (!env.ALLOW_UNAUTHENTICATED_DEV) return false;
  return dashboardSecret() === null;
}

/** All secrets accepted by worker-only endpoints (rotation support). */
export function workerSecrets(): string[] {
  const env = getEnv();
  const extra = (env.WORKER_SECRET_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [env.WORKER_SECRET, ...extra].filter((s): s is string => Boolean(s));
}

export function adminEmails(): string[] {
  return (getEnv().ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isEnrichmentProviderNone(): boolean {
  return getEnv().ENRICH_PROVIDER === 'none';
}
