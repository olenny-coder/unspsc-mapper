/**
 * Environment parsing tests.
 *
 * Two properties matter, and they pull in opposite directions:
 *
 *  - at **build** time an unusable value must never fail the deploy. Next.js
 *    evaluates `app/layout.tsx` while collecting page data, so a throw there
 *    surfaces only as `Failed to collect page data for /_not-found` — no file, no
 *    variable, no cause. That message cost a full debugging session;
 *  - at **runtime** an unusable value must still throw, naming the variable, so a
 *    genuine misconfiguration is not silently absorbed by a default.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { ConfigError } from '@/lib/errors';
import { getEnv, resetEnvCache } from '@/lib/env';

const mutableEnv = process.env as Record<string, string | undefined>;

/** Only the keys these tests vary, so the suite never leaks state into others. */
const TOUCHED = [
  'CLASSIFY_CONFIDENCE_THRESHOLD',
  'SYNC_STALE_DAYS',
  'GROQ_BASE_URL',
  'APP_ORIGIN',
  'NEXT_PHASE',
] as const;

const BUILD_PHASE = 'phase-production-build';

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

describe('runtime validation', () => {
  it('throws ConfigError naming the offending variable', () => {
    mutableEnv.CLASSIFY_CONFIDENCE_THRESHOLD = '70';
    delete mutableEnv.NEXT_PHASE;

    expect(() => getEnv()).toThrow(ConfigError);
    expect(() => getEnv()).toThrow(/CLASSIFY_CONFIDENCE_THRESHOLD/);
  });

  it('reports every bad variable at once, not just the first', () => {
    mutableEnv.CLASSIFY_CONFIDENCE_THRESHOLD = '70';
    mutableEnv.SYNC_STALE_DAYS = '30 days';
    delete mutableEnv.NEXT_PHASE;

    let message = '';
    try {
      getEnv();
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('CLASSIFY_CONFIDENCE_THRESHOLD');
    expect(message).toContain('SYNC_STALE_DAYS');
    // Each problem is on its own line, variable name first, so it survives the
    // tail-truncation that Vercel and GitHub Actions apply to build logs.
    expect(message.split('\n').filter((line) => line.startsWith('  '))).toHaveLength(2);
  });

  it('does not degrade into a bare "Invalid URL"', () => {
    mutableEnv.APP_ORIGIN = 'not a url at all';
    delete mutableEnv.NEXT_PHASE;

    expect(() => getEnv()).not.toThrow(/^Invalid URL$/);
    expect(() => getEnv()).toThrow(/APP_ORIGIN/);
  });
});

describe('build-phase tolerance', () => {
  it('warns and uses defaults instead of failing the build', () => {
    mutableEnv.NEXT_PHASE = BUILD_PHASE;
    mutableEnv.CLASSIFY_CONFIDENCE_THRESHOLD = '70';
    mutableEnv.SYNC_STALE_DAYS = '30 days';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const env = getEnv();

    expect(env.CLASSIFY_CONFIDENCE_THRESHOLD).toBe(0.7);
    expect(env.SYNC_STALE_DAYS).toBe(30);

    const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logged).toContain('CLASSIFY_CONFIDENCE_THRESHOLD');
    expect(logged).toContain('SYNC_STALE_DAYS');
  });

  it('keeps the build warning to one line, because it fires once per prerender worker', () => {
    mutableEnv.NEXT_PHASE = BUILD_PHASE;
    mutableEnv.CLASSIFY_CONFIDENCE_THRESHOLD = '70';
    mutableEnv.SYNC_STALE_DAYS = '30 days';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    getEnv();

    // Memoised per process, so a second read must not repeat it.
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] ?? [];
    expect(typeof message).toBe('string');
    expect(message).not.toContain('\n');
    expect(message).toContain('CLASSIFY_CONFIDENCE_THRESHOLD');
  });

  it('still honours valid values during a build', () => {
    mutableEnv.NEXT_PHASE = BUILD_PHASE;
    mutableEnv.CLASSIFY_CONFIDENCE_THRESHOLD = '0.55';

    expect(getEnv().CLASSIFY_CONFIDENCE_THRESHOLD).toBe(0.55);
  });

  it('leaves a perfectly good environment untouched and silent', () => {
    delete mutableEnv.NEXT_PHASE;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(getEnv().CLASSIFY_CONFIDENCE_THRESHOLD).toBe(0.7);
    expect(warn).not.toHaveBeenCalled();
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
