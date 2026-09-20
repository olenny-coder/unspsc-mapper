/**
 * Environment parsing.
 *
 * Everything is optional-with-defaults except the three credentials, and the
 * credential checks are deferred until the feature that needs them is used.
 * That keeps `next build`, `npm test` and `npm run lint` working with no
 * secrets present (important for CI), while failing loudly at runtime if a
 * feature is used without its key.
 */
import { z } from 'zod';
import { ConfigError } from '@/lib/errors';

/*
 * IMPORTANT — this module is imported by `middleware.ts` (via `lib/auth.ts`) and
 * therefore runs in the Edge Runtime. It must not reach for Node APIs, `eval`,
 * or `dotenv`:
 *
 *   - a static `import 'dotenv'` pulls in `process.cwd()` calls, which the Edge
 *     Runtime rejects with a stream of warnings;
 *   - `eval('require')` to hide it fails the build outright with
 *     "Dynamic Code Evaluation ... not allowed in Edge Runtime".
 *
 * Loading `.env.local` for standalone scripts and the Render worker therefore
 * lives in `lib/env-node.ts`, which those entry points import explicitly. Next.js
 * already loads the env files for the app and middleware, so nothing is lost.
 */


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
      if (isPlaceholder(raw)) return fallback;
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

/**
 * Strings that appear when someone copies a placeholder out of a dashboard or a
 * log line. Treating these as "unset" is safer than parsing them: a literal
 * `undefined` would otherwise become `http://undefined`.
 */
function isPlaceholder(value: string): boolean {
  return ['undefined', 'null', 'none', 'false', '""', "''", ':', 'http://', 'https://'].includes(
    value.trim().toLowerCase(),
  );
}

/**
 * Case-insensitive enum.
 *
 * Dashboards and copy-paste produce `Tiered` or `CompanyEnrich`, and rejecting
 * those with a hard build failure is hostile when the intent is unambiguous.
 * Values are lower-cased before matching.
 *
 * The type parameter must be given explicitly: TypeScript cannot infer a literal
 * union through a runtime `includes` lookup, so without it the output widens to
 * `string | undefined` and every consumer loses its narrow type.
 *
 * @example enumFromString<'tiered' | 'bulk'>(['tiered', 'bulk'], 'tiered')
 */
const enumFromString = <T extends string>(
  values: readonly [T, ...T[]],
  fallback: T,
): z.ZodType<T, z.ZodTypeDef, unknown> =>
  z
    .string()
    .optional()
    .transform((value, ctx): T => {
      const raw = (value ?? '').trim();
      if (!raw) return fallback;
      const lowered = raw.toLowerCase();
      if ((values as readonly string[]).includes(lowered)) return lowered as T;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `expected one of ${values.join(' | ')} (case-insensitive), received "${value}"`,
      });
      return fallback;
    }) as unknown as z.ZodType<T, z.ZodTypeDef, unknown>;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: optionalString,
  DATABASE_URL_UNPOOLED: optionalString,

  GROQ_API_KEY: optionalString,
  GROQ_BASE_URL: urlFromString('https://api.groq.com/openai/v1'),
  GROQ_MODEL_ACCURATE: z.string().default('llama-3.3-70b-versatile'),
  GROQ_MODEL_BULK: z.string().default('llama-3.1-8b-instant'),

  ENRICH_PROVIDER: enumFromString<'companyenrich' | 'contextdev' | 'none'>(['companyenrich', 'contextdev', 'none'], 'companyenrich'),
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

  /**
   * Public origin, used for canonical URLs, the sitemap and Open Graph tags.
   *
   * Deliberately NOT `NEXT_PUBLIC_APP_URL`: Next.js replaces every `NEXT_PUBLIC_*`
   * reference with the literal value present at build time, so such a variable is
   * not reliably readable at runtime and cannot be varied in tests. It is still
   * honoured as a fallback for backwards compatibility.
   */
  APP_ORIGIN: z
    .string()
    .optional()
    .transform((value, ctx) => {
      const raw = (value ?? '').trim();
      if (!raw) return undefined;
      if (isPlaceholder(raw)) return undefined;
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
  CLASSIFY_MODEL_STRATEGY: enumFromString<'tiered' | 'accurate' | 'bulk'>(['tiered', 'accurate', 'bulk'], 'tiered'),
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
let cachedIssues: EnvIssue[] = [];

type EnvIssue = { variable: string; problem: string };

/**
 * One compact line naming every variable that was ignored.
 *
 * Single-line on purpose. `getEnv()` is memoised per process, but it runs in very
 * many short-lived processes — sixteen prerender workers during a build, and a
 * fresh serverless instance per cold start — so a multi-line block repeated that
 * often buries the variable names it exists to surface.
 */
function formatIssues(issues: EnvIssue[]): string {
  const noun = issues.length === 1 ? 'variable' : 'variables';
  const detail = issues.map((entry) => `${entry.variable} (${entry.problem})`).join('; ');
  return (
    `[env] Ignoring ${issues.length} unusable environment ${noun}: ${detail}. ` +
    'Built-in defaults are in use, and the rest of the configuration is unaffected. Only ' +
    'DATABASE_URL is required — deleting the offending variable is a valid fix. ' +
    'In Vercel, saving a value is not enough: redeploy.'
  );
}

/**
 * Re-parse with the offending keys removed.
 *
 * Stripping only the bad keys — rather than discarding the whole environment —
 * means one mistyped value cannot silently reset every *other* setting to its
 * default, which would be a far more confusing failure than the one it replaced.
 */
function parseIgnoring(issues: EnvIssue[]): Env {
  const stripped = { ...process.env } as Record<string, unknown>;
  for (const issue of issues) delete stripped[issue.variable];

  const retry = envSchema.safeParse(stripped);
  if (retry.success) return retry.data;

  // Last resort: every field in this schema has a default, so this always parses.
  return envSchema.parse({});
}

/**
 * Parse `process.env`, degrading to defaults rather than failing.
 *
 * Every field that can fail validation here is a *tuning* value that has a working
 * default (`SYNC_STALE_DAYS`, `LLM_BATCH_SIZE`, `ENRICH_CONCURRENCY`, `PORT`, …).
 * None is worth an outage — and because `lib/auth.ts` imports this module, a throw
 * here did not surface as a clear error: it killed the Edge middleware, so every
 * gated route returned a bare `MIDDLEWARE_INVOCATION_FAILED`. Nine dashboard
 * fields left at `0` took the entire deployment down with no explanation.
 *
 * The values that genuinely must be present — `DATABASE_URL`, the API keys, the
 * shared secrets — are enforced where they are used, by the `require*` helpers
 * below, so degrading here does not weaken them. The problems are not swallowed:
 * they are logged and reported by `GET /api/health`.
 */
export function getEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (parsed.success) {
    cachedIssues = [];
    cached = parsed.data;
    return cached;
  }

  const issues: EnvIssue[] = parsed.error.issues.map((issue) => ({
    variable: issue.path.join('.') || '(root)',
    problem: issue.message,
  }));

  const resolved = parseIgnoring(issues);
  console.warn(formatIssues(issues));

  cachedIssues = issues;
  cached = resolved;
  return cached;
}

/**
 * Variables that were present but unusable, and so were replaced by defaults.
 *
 * Reported by `GET /api/health` so a misconfiguration is visible from outside the
 * process, instead of only in a log nobody reads until something breaks.
 */
export function getEnvIssues(): EnvIssue[] {
  getEnv();
  return cachedIssues;
}

/** Test helper — drop the memoised env (used by `tests/env.test.ts`). */
export function resetEnvCache(): void {
  cached = null;
  cachedIssues = [];
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
