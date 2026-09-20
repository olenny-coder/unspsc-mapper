/**
 * GET /api/auth/session
 *
 * Always reachable (allowlisted in middleware) so the login page and the UI can
 * ask "am I signed in?" without tripping the middleware redirect.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { dynamic, jsonHandler } from '@/lib/api';
import { dashboardSecret, isAuthDisabled } from '@/lib/env';
import { authorizeRequest } from '@/lib/auth';

export { dynamic };

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
      hint:
        secret === null
          ? 'Set DASHBOARD_SECRET (or WORKER_SECRET) in .env.local for local use, and in the Vercel/Render environment for deployments.'
          : null,
    },
  });
});
