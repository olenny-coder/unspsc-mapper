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
import { authErrorResponse, authorizeRequest, isPublicPath } from '@/lib/auth';

export const config = {
  // Skip static assets and the favicon; everything else is checked.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|webmanifest)$).*)'],
};

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) return NextResponse.next();

  const outcome = await authorizeRequest(request);
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
