/**
 * Route protection for the dashboard and every mutating endpoint.
 *
 * Two ways in:
 *   1. `Authorization: Bearer <DASHBOARD_SECRET>` (or `x-dashboard-secret`) for
 *      scripts, curl and cron;
 *   2. the HMAC-signed session cookie set by `POST /api/auth/login`, for the
 *      browser UI.
 *
 * Fail-closed rules:
 *   - production with no secret configured → 503 with an actionable message
 *     (the endpoints are disabled rather than silently open);
 *   - a configured secret always requires a valid credential.
 *
 * The only bypass is `isAuthDisabled()`, which requires NODE_ENV !== 'production'
 * AND no secret configured, so it cannot apply to a real deployment.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { AuthError } from '@/lib/errors';
import { dashboardSecret, isAuthDisabled, isDemoMode } from '@/lib/env';
import { SESSION_COOKIE, timingSafeEqual, verifySessionToken } from '@/lib/session';

/** Paths that never require a session. */
export const PUBLIC_PATHS = ['/login', '/api/auth/login', '/api/auth/session', '/api/health'] as const;

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/** Extract a credential from the request headers or the session cookie. */
export function extractCredential(request: {
  headers: { get(name: string): string | null };
  cookies?: { get(name: string): { value: string } | undefined };
}): string | null {
  const header = request.headers.get('authorization');
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match?.[1]) return match[1].trim();
  }
  const explicit = request.headers.get('x-dashboard-secret');
  if (explicit) return explicit.trim();
  const cookie = request.cookies?.get(SESSION_COOKIE)?.value;
  return cookie ?? null;
}

export type AuthOutcome =
  | { authorized: true; via: 'secret' | 'session' | 'disabled' }
  | { authorized: false; reason: 'missing' | 'invalid' | 'not_configured' };

/**
 * Decide whether a request may proceed. Never throws: middleware and route
 * handlers both need to branch on the outcome.
 */
export async function authorizeRequest(request: {
  headers: { get(name: string): string | null };
  cookies?: { get(name: string): { value: string } | undefined };
}): Promise<AuthOutcome> {
  if (isAuthDisabled()) return { authorized: true, via: 'disabled' };

  const secret = dashboardSecret();
  if (!secret) return { authorized: false, reason: 'not_configured' };

  const credential = extractCredential(request);
  if (!credential) return { authorized: false, reason: 'missing' };

  // A raw shared secret (bearer token / header) wins when it matches.
  if (timingSafeEqual(credential, secret)) return { authorized: true, via: 'secret' };

  const session = await verifySessionToken(credential, secret);
  if (session.valid) return { authorized: true, via: 'session' };

  return { authorized: false, reason: 'invalid' };
}

/**
 * What a request is allowed to be.
 *
 * `admin`  — a valid credential was presented, so serve the real application.
 * `demo`   — no credential at all, on a deployment that opted into `DEMO_MODE`.
 * `denied` — everything else, i.e. the normal locked-down case.
 *
 * The distinction between "no credential" and "a credential that failed" matters
 * more than it looks. Only a request carrying *nothing* is a demo visitor. Someone
 * whose session has expired or whose secret was rotated gets a 401 and the sign-in
 * flow, because the alternative — quietly answering them from the demo fixture —
 * would show a person fabricated suppliers and amounts at the exact moment they
 * believe they are looking at their real deployment.
 */
export type RequestRole = 'admin' | 'demo' | 'denied';

export async function resolveRequestRole(request: {
  headers: { get(name: string): string | null };
  cookies?: { get(name: string): { value: string } | undefined };
}): Promise<RequestRole> {
  const outcome = await authorizeRequest(request);
  if (outcome.authorized) return 'admin';
  if (outcome.reason === 'invalid') return 'denied';
  return isDemoMode() ? 'demo' : 'denied';
}

/**
 * Guard a route handler. Throws `AuthError` so `jsonHandler` turns it into the
 * standard JSON error envelope.
 */
export async function requireAuth(request: NextRequest): Promise<void> {
  const outcome = await authorizeRequest(request);
  if (outcome.authorized) return;

  if (outcome.reason === 'not_configured') {
    throw new AuthError(
      'No DASHBOARD_SECRET or WORKER_SECRET is configured, so this endpoint is disabled. Set one in the environment to enable it.',
      503,
    );
  }
  throw new AuthError(
    outcome.reason === 'missing'
      ? 'Authentication required. Send `Authorization: Bearer <DASHBOARD_SECRET>` or sign in at /login.'
      : 'Invalid credentials.',
  );
}

/** JSON 401/503 response for middleware (which cannot use `jsonHandler`). */
export function authErrorResponse(outcome: Extract<AuthOutcome, { authorized: false }>): NextResponse {
  const notConfigured = outcome.reason === 'not_configured';
  return NextResponse.json(
    {
      ok: false,
      error: {
        name: 'AuthError',
        code: notConfigured ? 'auth_not_configured' : 'unauthorized',
        status: notConfigured ? 503 : 401,
        message: notConfigured
          ? 'No DASHBOARD_SECRET or WORKER_SECRET is configured, so the API is disabled.'
          : 'Authentication required. Send `Authorization: Bearer <DASHBOARD_SECRET>` or sign in at /login.',
      },
    },
    { status: notConfigured ? 503 : 401 },
  );
}
