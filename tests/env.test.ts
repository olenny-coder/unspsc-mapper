/**
 * Environment parsing tests.
 *
 * The governing policy is that an unusable *tuning* value must never take the
 * application down, while a genuinely absent *credential* must still fail loudly.
 * That distinction is not cosmetic: `lib/auth.ts` imports this module, so a throw
 * during parsing killed the Edge middleware and turned every gated route into a
 * bare `MIDDLEWARE_INVOCATION_FAILED`. Nine dashboard fields left at `0` took a
 * whole deployment down with no explanation.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { ConfigError } from '@/lib/errors';
import { getEnv, getEnvIssues, requireDatabaseUrl, requireWorkerSecret, resetEnvCache } from '@/lib/env';

const mutableEnv = process.env as Record<string, string | undefined>;

/** Only the keys these tests vary, so the suite never leaks state into others. */
const TOUCHED = [
  'NODE_ENV',
  'DATABASE_URL',
  'WORKER_SECRET',
  'CLASSIFY_CONFIDENCE_THRESHOLD',
  'SYNC_STALE_DAYS',
  'SYNC_BATCH_SIZE',
  'ENRICH_CONCURRENCY',
  'LLM_BATCH_SIZE',
  'PORT',
  'GROQ_BASE_URL',
  'APP_ORIGIN',
] as const;

let original: Record<string, string | undefined> = {};

beforeEach(() => {
  original = {};
  for (const key of TOUCHED) original[key] = mutableEnv[key];
  resetEnvCache();
});

afterEach(() => {
  for (const key of TOUCHED) {
    if (original[key] === undefined) delete mutableEnv[key];
    else mutableEnv[key] = original[key];
  }
  resetEnvCache();
  vi.restoreAllMocks();
});

describe('unusable values degrade instead of failing', () => {
  it('keeps the app up and names the variable when a numeric value is not a number', () => {
    mutableEnv.SYNC_STALE_DAYS = '30 days';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const env = getEnv();

    expect(env.SYNC_STALE_DAYS).toBe(30);
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('SYNC_STALE_DAYS');
    expect(logged).toContain('30 days');
  });

  it('treats 0 as unusable for a variable whose minimum is 1', () => {
    // The exact shape that broke the live deployment: these are the nine numeric
    // fields a dashboard can end up holding as "0".
    mutableEnv.SYNC_STALE_DAYS = '0';
    mutableEnv.SYNC_BATCH_SIZE = '0';
    mutableEnv.ENRICH_CONCURRENCY = '0';
    mutableEnv.LLM_BATCH_SIZE = '0';
    mutableEnv.PORT = '0';
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const env = getEnv();

    expect(env.SYNC_STALE_DAYS).toBe(30);
    expect(env.SYNC_BATCH_SIZE).toBe(25);
    expect(env.ENRICH_CONCURRENCY).toBe(3);
    expect(env.LLM_BATCH_SIZE).toBe(10);
    expect(env.PORT).toBe(10000);
  });

  it('still accepts 0 where 0 is a legitimate value', () => {
    mutableEnv.CLASSIFY_CONFIDENCE_THRESHOLD = '0';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(getEnv().CLASSIFY_CONFIDENCE_THRESHOLD).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not reset every other setting when one value is bad', () => {
    mutableEnv.DATABASE_URL = 'postgresql://user:pw@ep-x-pooler.eu.neon.tech/db?sslmode=require';
    mutableEnv.SYNC_STALE_DAYS = '0';
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Stripping only the offending key is what keeps a single typo from silently
    // reverting the whole configuration to defaults.
    expect(getEnv().DATABASE_URL).toBe('postgresql://user:pw@ep-x-pooler.eu.neon.tech/db?sslmode=require');
  });

  it('reports every bad variable on one line', () => {
    mutableEnv.SYNC_STALE_DAYS = '0';
    mutableEnv.LLM_BATCH_SIZE = 'lots';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    getEnv();

    // One line per process: this also runs in every prerender worker and every
    // cold serverless instance, so a multi-line block would bury the names.
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] ?? [];
    expect(typeof message).toBe('string');
    expect(message).not.toContain('\n');
    expect(message).toContain('SYNC_STALE_DAYS');
    expect(message).toContain('LLM_BATCH_SIZE');
  });

  it('is silent and reports no issues for a clean environment', () => {
    delete mutableEnv.SYNC_STALE_DAYS;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(getEnv().SYNC_STALE_DAYS).toBe(30);
    expect(getEnvIssues()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('getEnvIssues', () => {
  it('exposes what was ignored, so /api/health can report it', () => {
    mutableEnv.SYNC_STALE_DAYS = '0';
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const issues = getEnvIssues();

    expect(issues).toHaveLength(1);
    expect(issues[0]?.variable).toBe('SYNC_STALE_DAYS');
    expect(issues[0]?.problem).toContain('expected 1..3650');
  });

  it('does not warn when the environment is already parsed and valid', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getEnv();
    getEnvIssues();
    getEnv();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('required credentials still fail loudly', () => {
  it('throws when DATABASE_URL is absent', () => {
    delete mutableEnv.DATABASE_URL;

    expect(() => requireDatabaseUrl()).toThrow(ConfigError);
    expect(() => requireDatabaseUrl()).toThrow(/DATABASE_URL/);
  });

  it('throws when no worker secret is configured in production', () => {
    mutableEnv.NODE_ENV = 'production';
    delete mutableEnv.WORKER_SECRET;
    resetEnvCache();

    expect(() => requireWorkerSecret()).toThrow(/WORKER_SECRET/);
  });

  it('does not let degrading a tuning value mask a missing credential', () => {
    // A bad tuning value and a missing credential in the same environment: the
    // first is absorbed, the second must still be reported.
    mutableEnv.SYNC_STALE_DAYS = '0';
    delete mutableEnv.DATABASE_URL;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(getEnv().SYNC_STALE_DAYS).toBe(30);
    expect(() => requireDatabaseUrl()).toThrow(/DATABASE_URL/);
  });
});

describe('URL handling', () => {
  it('assumes a scheme for a host typed without one', () => {
    mutableEnv.GROQ_BASE_URL = 'api.groq.com/openai/v1';
    expect(getEnv().GROQ_BASE_URL).toBe('http://api.groq.com/openai/v1');
  });

  it('treats dashboard placeholders as unset rather than parsing them', () => {
    mutableEnv.GROQ_BASE_URL = ':';
    expect(getEnv().GROQ_BASE_URL).toBe('https://api.groq.com/openai/v1');
  });

  it('drops an unusable APP_ORIGIN rather than rendering it as a hostname', () => {
    mutableEnv.APP_ORIGIN = 'undefined';
    expect(getEnv().APP_ORIGIN).toBeUndefined();
  });
});
