/**
 * Route-handler helpers: authentication for worker-only endpoints, body
 * parsing, and consistent JSON error envelopes.
 */
import { NextResponse, type NextRequest } from 'next/server';
import type { z } from 'zod';
import { AppError, AuthError, ValidationError, serializeError } from '@/lib/errors';
import { getEnv, isDemoMode, workerSecrets } from '@/lib/env';
import { resolveRequestRole } from '@/lib/auth';
import { demoRespond } from '@/lib/demo/responses';
import { parseReportFilters, reportFiltersSchema, type ReportFilters } from '@/lib/validation';

/** Runtime for every API route in this app (Neon + postgres.js need Node). */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Constant-time-ish comparison to avoid leaking secret length via timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** Extract a bearer token from the Authorization header or `x-worker-secret`. */
export function extractToken(request: NextRequest): string | null {
  const header = request.headers.get('authorization');
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match?.[1]) return match[1].trim();
  }
  const explicit = request.headers.get('x-worker-secret');
  if (explicit) return explicit.trim();
  const querySecret = request.nextUrl.searchParams.get('secret');
  if (querySecret) return querySecret.trim();
  return null;
}

/**
 * Guard a worker-only route. Accepts any of the configured worker secrets
 * (rotation support) and fails closed in production when none is configured.
 */
export function requireWorkerAuth(request: NextRequest): void {
  const token = extractToken(request);
  const secrets = workerSecrets();

  if (!secrets.length) {
    if (getEnv().NODE_ENV === 'production') {
      throw new AuthError(
        'WORKER_SECRET is not configured on this deployment, so worker endpoints are disabled.',
        503,
      );
    }
    // Development convenience: no secret configured means local calls are allowed.
    return;
  }

  if (!token) {
    throw new AuthError('Missing worker secret. Send `Authorization: Bearer <WORKER_SECRET>`.');
  }
  if (!secrets.some((secret) => safeEqual(secret, token))) {
    throw new AuthError('Invalid worker secret.');
  }
}

/** Parse and validate a JSON body. */
export async function readJsonBody<T>(request: NextRequest, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
  let raw: unknown;
  try {
    const text = await request.text();
    raw = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new ValidationError('Request body must be valid JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Request body failed validation.', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return parsed.data as T;
}

/** Read optional query-string parameters validated by a Zod schema. */
export function readQuery<T>(request: NextRequest, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
  const record: Record<string, string> = {};
  for (const [key, value] of request.nextUrl.searchParams.entries()) {
    record[key] = value;
  }
  const parsed = schema.safeParse(record);
  if (!parsed.success) {
    throw new ValidationError('Query parameters failed validation.', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return parsed.data as T;
}

/** Report filters straight off the query string. */
export function readFilters(request: NextRequest): ReportFilters {
  return parseReportFilters(request.nextUrl.searchParams);
}

/** Validate a partial filter object that arrived inside a JSON body. */
export function mergeFilters(base: ReportFilters, override: unknown): ReportFilters {
  if (!override || typeof override !== 'object') return base;
  const merged = { ...base, ...(override as Record<string, unknown>) };
  const parsed = reportFiltersSchema.safeParse(merged);
  return parsed.success ? parsed.data : base;
}

/** JSON error envelope shared by every route. */
export function errorResponse(error: unknown): NextResponse {
  const serialized = serializeError(error);
  const status = error instanceof AppError ? error.status : serialized.status;
  if (status >= 500) {
    console.error(`[api] ${serialized.code}: ${serialized.message}`, error instanceof Error ? error.stack : '');
  }
  return NextResponse.json({ ok: false, error: serialized }, { status });
}

/**
 * Wrap a handler so thrown errors become JSON responses.
 *
 * This is also where the read-only demo is enforced, and that placement is the
 * point. Every API route in the app goes through here, so a demo request is
 * answered from `lib/demo/` *instead of* running the route's own handler: no query
 * executes, no provider is called, and no mutation is possible. Adding an endpoint
 * therefore cannot accidentally expose it to anonymous visitors — an unlisted path
 * is refused rather than served.
 *
 * A signed-in caller is never diverted, so the same deployment serves both.
 */
export function jsonHandler<Args extends unknown[]>(
  handler: (request: NextRequest, ...args: Args) => Promise<NextResponse>,
): (request: NextRequest, ...args: Args) => Promise<NextResponse> {
  return async (request: NextRequest, ...args: Args) => {
    try {
      if (isDemoMode() && (await resolveRequestRole(request)) === 'demo') {
        return demoRespond(request);
      }
      return await handler(request, ...args);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data }, init);
}

/**
 * Wrap binary data in a `Response` body.
 *
 * Node's `Buffer` is a `Uint8Array` at runtime but its generic parameter makes
 * it structurally incompatible with the DOM `BodyInit` union that Next's types
 * expect, so the conversion is funnelled through this one helper.
 */
export function binaryBody(bytes: Uint8Array): BodyInit {
  return bytes as unknown as BodyInit;
}

/** Parse a route param that must be a positive integer. */
export function parseIdParam(value: string | undefined, label = 'id'): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ValidationError(`Invalid ${label}: expected a positive integer, received "${value ?? ''}".`);
  }
  return id;
}
