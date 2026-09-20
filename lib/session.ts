/**
 * Session-token signing.
 *
 * The dashboard is protected by a single shared secret (`DASHBOARD_SECRET`,
 * falling back to `WORKER_SECRET`). A browser session is granted an
 * HMAC-SHA256-signed cookie; API clients can send the same secret as a bearer
 * token.
 *
 * Why not a full auth provider? This is a single-tenant internal tool
 * (procurement spend is not multi-user data), and the deployment targets are all
 * free tiers. A signed shared-secret cookie is the smallest thing that actually
 * closes the "anyone on the internet can rewrite my classifications" hole.
 *
 * Implemented with Web Crypto (`globalThis.crypto.subtle`) so the identical code
 * runs in Next.js middleware (Edge runtime) and in Node route handlers.
 */

/** Cookie name used for the browser session. */
export const SESSION_COOKIE = 'unspsc_session';

/** Session lifetime in seconds (7 days). */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const withPadding = padded + '='.repeat((4 - (padded.length % 4)) % 4);
    const binary = atob(withPadding);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return bytesToBase64Url(new Uint8Array(signature));
}

/**
 * Compare two strings without leaking length or content through timing.
 * Web Crypto has no constant-time compare, so this is a best-effort equivalent.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** `expiry.signature` — the payload is just the expiry, so nothing secret leaks. */
export async function createSessionToken(
  secret: string,
  options: { ttlSeconds?: number; now?: number } = {},
): Promise<string> {
  const now = options.now ?? Date.now();
  const expiresAt = Math.floor(now / 1000) + (options.ttlSeconds ?? SESSION_TTL_SECONDS);
  const payload = String(expiresAt);
  const signature = await sign(payload, secret);
  return `${payload}.${signature}`;
}

export type SessionVerification = { valid: true; expiresAt: number } | { valid: false; reason: string };

/** Verify a session token's signature and expiry. */
export async function verifySessionToken(
  token: string | undefined | null,
  secret: string,
  options: { now?: number } = {},
): Promise<SessionVerification> {
  if (!token) return { valid: false, reason: 'missing' };

  const separator = token.lastIndexOf('.');
  if (separator <= 0) return { valid: false, reason: 'malformed' };

  const payload = token.slice(0, separator);
  const provided = token.slice(separator + 1);
  if (!payload || !provided) return { valid: false, reason: 'malformed' };

  const expiresAt = Number(payload);
  if (!Number.isFinite(expiresAt)) return { valid: false, reason: 'malformed' };

  const expected = await sign(payload, secret);
  if (!timingSafeEqual(expected, provided)) return { valid: false, reason: 'bad_signature' };

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (expiresAt <= nowSeconds) return { valid: false, reason: 'expired' };

  return { valid: true, expiresAt };
}

/** Serialise a cookie for `Set-Cookie`. */
export function sessionCookieHeader(token: string, options: { secure?: boolean; maxAge?: number } = {}): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${options.maxAge ?? SESSION_TTL_SECONDS}`,
  ];
  // `Secure` is dropped on http://localhost so local development works.
  if (options.secure !== false) parts.push('Secure');
  return parts.join('; ');
}

/** Serialise a cookie that clears the session. */
export function clearedSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export { base64UrlToBytes };
