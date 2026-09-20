/**
 * Authentication tests.
 *
 * These cover the properties that matter for a shared-secret session cookie:
 * signatures are bound to the secret, expiry is enforced, tampering is rejected,
 * and the fail-closed rules hold (no secret configured ⇒ endpoints disabled, not
 * open).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  SESSION_COOKIE,
  clearedSessionCookieHeader,
  createSessionToken,
  sessionCookieHeader,
  timingSafeEqual,
  verifySessionToken,
} from '@/lib/session';
import { authorizeRequest, extractCredential, isPublicPath } from '@/lib/auth';
import { getEnv, resetEnvCache } from '@/lib/env';

const SECRET = 'test-dashboard-secret-value';

/** `process.env.NODE_ENV` is typed read-only; these tests need a mutable view. */
const mutableEnv = process.env as Record<string, string | undefined>;

function headers(map: Record<string, string> = {}) {
  const lower = new Map(Object.entries(map).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

function cookies(map: Record<string, string> = {}) {
  return { get: (name: string) => (map[name] === undefined ? undefined : { value: map[name]! }) };
}

describe('timingSafeEqual', () => {
  it('compares equal and unequal strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

describe('session tokens', () => {
  it('round-trips a token created with the same secret', async () => {
    const token = await createSessionToken(SECRET);
    const result = await verifySessionToken(token, SECRET);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await createSessionToken(SECRET);
    const result = await verifySessionToken(token, 'a-different-secret');
    expect(result).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects a tampered expiry (privilege escalation attempt)', async () => {
    const token = await createSessionToken(SECRET, { ttlSeconds: 60 });
    const [expiry, signature] = token.split('.');
    const extended = `${Number(expiry) + 100_000}.${signature}`;
    const result = await verifySessionToken(extended, SECRET);
    expect(result).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects an expired token', async () => {
    const now = Date.now();
    const token = await createSessionToken(SECRET, { ttlSeconds: 10, now });
    const result = await verifySessionToken(token, SECRET, { now: now + 11_000 });
    expect(result).toEqual({ valid: false, reason: 'expired' });
  });

  it('rejects missing and malformed tokens', async () => {
    expect(await verifySessionToken(undefined, SECRET)).toEqual({ valid: false, reason: 'missing' });
    expect(await verifySessionToken('', SECRET)).toEqual({ valid: false, reason: 'missing' });
    expect(await verifySessionToken('no-separator', SECRET)).toEqual({ valid: false, reason: 'malformed' });
    expect(await verifySessionToken('.signature', SECRET)).toEqual({ valid: false, reason: 'malformed' });
    expect(await verifySessionToken('notanumber.signature', SECRET)).toEqual({ valid: false, reason: 'malformed' });
  });

  it('honours a custom TTL', async () => {
    const now = Date.now();
    const token = await createSessionToken(SECRET, { ttlSeconds: 120, now });
    const soon = await verifySessionToken(token, SECRET, { now: now + 60_000 });
    const later = await verifySessionToken(token, SECRET, { now: now + 130_000 });
    expect(soon.valid).toBe(true);
    expect(later.valid).toBe(false);
  });
});

describe('cookie serialisation', () => {
  it('sets HttpOnly, SameSite and a path', () => {
    const header = sessionCookieHeader('token-value', { secure: true, maxAge: 60 });
    expect(header).toContain(`${SESSION_COOKIE}=token-value`);
    expect(header).toContain('Path=/');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Secure');
    expect(header).toContain('Max-Age=60');
  });

  it('omits Secure on plain http so localhost development works', () => {
    expect(sessionCookieHeader('t', { secure: false })).not.toContain('Secure');
  });

  it('clears the cookie', () => {
    const header = clearedSessionCookieHeader();
    expect(header).toContain(`${SESSION_COOKIE}=;`);
    expect(header).toContain('Max-Age=0');
  });
});

describe('extractCredential', () => {
  it('reads bearer tokens, the explicit header and the cookie', () => {
    expect(extractCredential({ headers: headers({ authorization: 'Bearer abc' }) })).toBe('abc');
    expect(extractCredential({ headers: headers({ authorization: 'bearer abc' }) })).toBe('abc');
    expect(extractCredential({ headers: headers({ 'x-dashboard-secret': 'xyz' }) })).toBe('xyz');
    expect(extractCredential({ headers: headers(), cookies: cookies({ [SESSION_COOKIE]: 'cookie-token' }) })).toBe(
      'cookie-token',
    );
  });

  it('prefers the authorization header over the cookie', () => {
    expect(
      extractCredential({
        headers: headers({ authorization: 'Bearer header-token' }),
        cookies: cookies({ [SESSION_COOKIE]: 'cookie-token' }),
      }),
    ).toBe('header-token');
  });

  it('returns null when nothing is present', () => {
    expect(extractCredential({ headers: headers(), cookies: cookies() })).toBeNull();
    expect(extractCredential({ headers: headers({ authorization: 'Basic abc' }) })).toBeNull();
  });
});

describe('isPublicPath', () => {
  it('allowlists only the login page and health endpoint', () => {
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/api/auth/login')).toBe(true);
    expect(isPublicPath('/api/auth/session')).toBe(true);
    expect(isPublicPath('/api/health')).toBe(true);
  });

  it('protects everything else', () => {
    expect(isPublicPath('/')).toBe(false);
    expect(isPublicPath('/review')).toBe(false);
    expect(isPublicPath('/api/suppliers')).toBe(false);
    expect(isPublicPath('/api/settings')).toBe(false);
    expect(isPublicPath('/api/upload')).toBe(false);
    expect(isPublicPath('/api/metrics')).toBe(false);
  });
});

describe('authorizeRequest', () => {
  /**
   * Restore by DELETING the keys this suite sets.
   *
   * Never assign `process.env = { ...snapshot }`: that detaches the object
   * `tests/setup.ts` captured, so subsequent mutations land on a different
   * object. That mistake made these tests pass in isolation and fail in a full
   * run.
   */
  const keysToRestore = ['DASHBOARD_SECRET', 'WORKER_SECRET', 'ALLOW_UNAUTHENTICATED_DEV', 'NODE_ENV'] as const;

  beforeEach(() => {
    mutableEnv.DASHBOARD_SECRET = SECRET;
    mutableEnv.WORKER_SECRET = '';
    mutableEnv.ALLOW_UNAUTHENTICATED_DEV = 'true';
    mutableEnv.NODE_ENV = 'production';
    resetEnvCache();
  });

  afterEach(() => {
    for (const key of keysToRestore) delete mutableEnv[key];
    resetEnvCache();
  });

  it('accepts the raw shared secret as a bearer token', async () => {
    const outcome = await authorizeRequest({ headers: headers({ authorization: `Bearer ${SECRET}` }) });
    expect(outcome).toEqual({ authorized: true, via: 'secret' });
  });

  it('accepts a valid session cookie', async () => {
    const token = await createSessionToken(SECRET);
    const outcome = await authorizeRequest({
      headers: headers(),
      cookies: cookies({ [SESSION_COOKIE]: token }),
    });
    expect(outcome).toEqual({ authorized: true, via: 'session' });
  });

  it('rejects a request with no credential', async () => {
    const outcome = await authorizeRequest({ headers: headers(), cookies: cookies() });
    expect(outcome).toEqual({ authorized: false, reason: 'missing' });
  });

  it('rejects a wrong secret', async () => {
    const outcome = await authorizeRequest({ headers: headers({ authorization: 'Bearer wrong' }) });
    expect(outcome).toEqual({ authorized: false, reason: 'invalid' });
  });

  it('rejects a forged cookie', async () => {
    const forged = await createSessionToken('attacker-secret');
    const outcome = await authorizeRequest({
      headers: headers(),
      cookies: cookies({ [SESSION_COOKIE]: forged }),
    });
    expect(outcome).toEqual({ authorized: false, reason: 'invalid' });
  });

  it('fails closed when no secret is configured', async () => {
    mutableEnv.DASHBOARD_SECRET = '';
    mutableEnv.WORKER_SECRET = '';
    resetEnvCache();

    const outcome = await authorizeRequest({ headers: headers({ authorization: 'Bearer anything' }) });
    expect(outcome).toEqual({ authorized: false, reason: 'not_configured' });
    expect(getEnv().NODE_ENV).toBe('production');
  });

  it('falls back to WORKER_SECRET when DASHBOARD_SECRET is absent', async () => {
    mutableEnv.DASHBOARD_SECRET = '';
    mutableEnv.WORKER_SECRET = 'worker-secret-value';
    resetEnvCache();

    const outcome = await authorizeRequest({ headers: headers({ authorization: 'Bearer worker-secret-value' }) });
    expect(outcome).toEqual({ authorized: true, via: 'secret' });

    // The unrelated value is still refused.
    const rejected = await authorizeRequest({ headers: headers({ authorization: `Bearer ${SECRET}` }) });
    expect(rejected).toEqual({ authorized: false, reason: 'invalid' });
  });

  it('bypasses auth only outside production AND with no secret configured', async () => {
    mutableEnv.NODE_ENV = 'development';
    mutableEnv.DASHBOARD_SECRET = '';
    mutableEnv.WORKER_SECRET = '';
    mutableEnv.ALLOW_UNAUTHENTICATED_DEV = 'true';
    resetEnvCache();
    expect(getEnv().NODE_ENV).toBe('development');

    const outcome = await authorizeRequest({ headers: headers(), cookies: cookies() });
    expect(outcome).toEqual({ authorized: true, via: 'disabled' });
  });

  it('does not bypass auth in production, even with the dev flag set', async () => {
    mutableEnv.ALLOW_UNAUTHENTICATED_DEV = 'true';
    resetEnvCache();
    expect(getEnv().NODE_ENV).toBe('production');

    const outcome = await authorizeRequest({ headers: headers(), cookies: cookies() });
    expect(outcome).toEqual({ authorized: false, reason: 'missing' });
  });

  it('does not bypass auth outside production when a secret is configured', async () => {
    mutableEnv.NODE_ENV = 'development';
    resetEnvCache();

    const outcome = await authorizeRequest({ headers: headers(), cookies: cookies() });
    expect(outcome).toEqual({ authorized: false, reason: 'missing' });
  });
});
