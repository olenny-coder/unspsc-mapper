/**
 * Tests for the build-time Vercel origin guard.
 *
 * This is the exact shape that broke a real deploy: `VERCEL_PROJECT_PRODUCTION_URL`
 * holding something that is not a bare host made Next.js throw `TypeError: Invalid
 * URL` once per prerendered page, failing the build with no variable named. The
 * guard must therefore both repair what is recoverable and remove what is not.
 */
import { describe, expect, it, vi } from 'vitest';
import { VERCEL_ORIGIN_VARS, sanitizeVercelOrigins } from '@/lib/vercel-origin.mjs';

/** Fresh mutable env plus a capturing warn sink. */
function harness(initial: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...initial };
  const warn = vi.fn();
  return { env, warn, run: () => sanitizeVercelOrigins(env, warn) };
}

describe('sanitizeVercelOrigins', () => {
  it('treats a bare host as valid', () => {
    const { env, run, warn } = harness({ VERCEL_PROJECT_PRODUCTION_URL: 'unspsc-mapper.vercel.app' });

    expect(run()).toEqual([]);
    expect(env.VERCEL_PROJECT_PRODUCTION_URL).toBe('unspsc-mapper.vercel.app');
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts a host with a port', () => {
    const { env, run } = harness({ VERCEL_URL: 'localhost:3000' });

    expect(run()).toEqual([]);
    expect(env.VERCEL_URL).toBe('localhost:3000');
  });

  it('trims surrounding whitespace instead of parsing it', () => {
    const { env, run, warn } = harness({ VERCEL_URL: '  app.vercel.app  ' });

    expect(run()).toEqual([]);
    expect(env.VERCEL_URL).toBe('app.vercel.app');
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops a bare ":" so Next falls back to its own default', () => {
    const { env, run, warn } = harness({ VERCEL_PROJECT_PRODUCTION_URL: ':' });

    expect(run()).toEqual(['VERCEL_PROJECT_PRODUCTION_URL']);
    expect(env.VERCEL_PROJECT_PRODUCTION_URL).toBeUndefined();
    expect(warn.mock.calls[0]?.[0]).toContain('VERCEL_PROJECT_PRODUCTION_URL');
  });

  it('drops text that is not a URL at all', () => {
    const { env, run } = harness({ VERCEL_PROJECT_PRODUCTION_URL: 'not a url' });

    expect(run()).toEqual(['VERCEL_PROJECT_PRODUCTION_URL']);
    expect(env.VERCEL_PROJECT_PRODUCTION_URL).toBeUndefined();
  });

  it('recovers a full URL by narrowing it to its host', () => {
    const { env, run, warn } = harness({ VERCEL_PROJECT_PRODUCTION_URL: 'https://unspsc-mapper.vercel.app' });

    expect(run()).toEqual(['VERCEL_PROJECT_PRODUCTION_URL']);
    expect(env.VERCEL_PROJECT_PRODUCTION_URL).toBe('unspsc-mapper.vercel.app');
    expect(warn.mock.calls[0]?.[0]).toContain('unspsc-mapper.vercel.app');
  });

  it('keeps a full URL with a port and drops its path', () => {
    const { env, run } = harness({ VERCEL_URL: 'https://example.com:8443/some/path' });

    expect(run()).toEqual(['VERCEL_URL']);
    expect(env.VERCEL_URL).toBe('example.com:8443');
  });

  it('ignores the variables it does not own', () => {
    const { env, run } = harness({ SITE_URL: ':', APP_ORIGIN: 'nonsense' });

    expect(run()).toEqual([]);
    expect(env.SITE_URL).toBe(':');
    expect(env.APP_ORIGIN).toBe('nonsense');
  });

  it('leaves an unset environment alone', () => {
    const { env, run, warn } = harness();

    expect(run()).toEqual([]);
    expect(Object.keys(env)).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('covers every variable Next.js interpolates into `https://${...}`', () => {
    // resolve-url.js reads exactly these three; a fourth added there must be added here.
    expect(VERCEL_ORIGIN_VARS).toEqual(['VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_URL', 'VERCEL_BRANCH_URL']);
  });
});
