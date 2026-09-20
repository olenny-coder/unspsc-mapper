/**
 * Session endpoints.
 *
 *   GET    /api/auth/session  — is a session active, and how much longer?
 *   POST   /api/auth/login    — exchange the shared secret for a signed cookie
 *   DELETE /api/auth/login    — clear the session
 *
 * All three are reachable without a session (the middleware allowlists them), and
 * the shared secret is compared in constant time.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { dynamic, jsonHandler, readJsonBody } from '@/lib/api';
import { dashboardSecret, isAuthDisabled } from '@/lib/env';
import { AuthError, ValidationError } from '@/lib/errors';
import { SESSION_TTL_SECONDS, clearedSessionCookieHeader, createSessionToken, sessionCookieHeader, timingSafeEqual } from '@/lib/session';
import { authorizeRequest } from '@/lib/auth';
import { recordAudit } from '@/services/audit';
import { z } from 'zod';

export { dynamic };

const loginSchema = z.object({
  secret: z.string().min(1, 'The shared secret is required.'),
});

const isHttps = (request: NextRequest): boolean => {
  const proto = request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(':', '');
  return proto === 'https';
};

/** GET /api/auth/session */
export const GET = jsonHandler(async (request: NextRequest) => {
  const outcome = await authorizeRequest(request);
  const secret = dashboardSecret();

  return NextResponse.json({
    ok: true,
    data: {
      authenticated: outcome.authorized,
      via: outcome.authorized ? outcome.via : null,
      authConfigured: secret !== null,
      authDisabled: isAuthDisabled(),
      // Never echo the secret; only whether one exists and where to set it.
      hint:
        secret === null
          ? 'Set DASHBOARD_SECRET (or WORKER_SECRET) in .env.local for local use, and in the Vercel/Render environment for deployments.'
          : null,
    },
  });
});

/** POST /api/auth/login */
export const POST = jsonHandler(async (request: NextRequest) => {
  const secret = dashboardSecret();
  if (!secret) {
    throw new ValidationError(
      'No DASHBOARD_SECRET or WORKER_SECRET is configured, so there is nothing to sign in with. Set one in .env.local (local) or in the Vercel/Render environment variables.',
    );
  }

  const { secret: submitted } = await readJsonBody(request, loginSchema);
  if (!timingSafeEqual(submitted.trim(), secret)) {
    await recordAudit({
      entity: 'settings',
      entityId: null,
      action: 'updated',
      details: { event: 'login_failed', ip: request.headers.get('x-forwarded-for') ?? 'unknown' },
      actor: 'anonymous',
    });
    // 401 (not 400) so a failed credential is never confused with a malformed
    // request by the client or by a log-based alarm.
    throw new AuthError('That secret is not correct.');
  }

  const token = await createSessionToken(secret);
  const response = NextResponse.json({
    ok: true,
    data: { authenticated: true, expiresInSeconds: SESSION_TTL_SECONDS },
  });
  response.headers.set('Set-Cookie', sessionCookieHeader(token, { secure: isHttps(request) }));

  await recordAudit({
    entity: 'settings',
    entityId: null,
    action: 'updated',
    details: { event: 'login_succeeded' },
    actor: 'dashboard',
  });

  return response;
});

/** DELETE /api/auth/login */
export const DELETE = jsonHandler(async () => {
  const response = NextResponse.json({ ok: true, data: { authenticated: false } });
  response.headers.set('Set-Cookie', clearedSessionCookieHeader());
  return response;
});
