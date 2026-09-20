/**
 * Edge middleware: the single choke point for authentication.
 *
 * Deny-by-default. Only explicitly public paths (the login page and the health
 * endpoint an uptime monitor needs) pass through unauthenticated; everything else
 * requires either a bearer secret or a signed session cookie.
 *
 * Page requests are redirected to `/login`; API requests get a JSON 401/503.
 *
 * Note: this runs on the Edge runtime, so it uses Web Crypto only (see
 * `lib/session.ts`). The route handlers re-check with `requireAuth()` so the
 * protection does not depend on middleware alone.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { authErrorResponse, authorizeRequest, isPublicPath, type AuthOutcome } from '@/lib/auth';

export const config = {
  // Skip static assets and the favicon; everything else is checked.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|webmanifest)$).*)'],
};

/**
 * Fail closed, loudly.
 *
 * `authorizeRequest` is written not to throw, but if it ever does the platform
 * reports only `MIDDLEWARE_INVOCATION_FAILED` on every gated route: the app is
 * entirely down and the response explains nothing. That happened for real — a bad
 * environment value reached `getEnv()` through `lib/auth.ts` — so an unexpected
 * error is converted into an explicit, diagnosable denial rather than a crash.
 */
function unavailableResponse(pathname: string, error: unknown): NextResponse {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[middleware] could not evaluate authorization for ${pathname}: ${detail}`);

  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          name: 'AuthError',
          code: 'auth_unavailable',
          status: 503,
          message: `Authentication could not be evaluated: ${detail}`,
        },
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return new NextResponse('Authentication is temporarily unavailable. See /api/health for details.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) return NextResponse.next();

  let outcome: AuthOutcome;
  try {
    outcome = await authorizeRequest(request);
  } catch (error) {
    return unavailableResponse(pathname, error);
  }

  if (outcome.authorized) return NextResponse.next();

  // API routes answer with JSON so scripts and the UI client surface the reason.
  if (pathname.startsWith('/api/')) {
    return authErrorResponse(outcome);
  }

  // Page requests go to the login form, remembering where the user was headed.
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = '/login';
  loginUrl.search = '';
  if (pathname !== '/') loginUrl.searchParams.set('next', pathname);
  return NextResponse.redirect(loginUrl);
}
