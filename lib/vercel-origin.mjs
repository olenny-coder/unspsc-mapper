/**
 * Build-time guard for the Vercel origin variables.
 *
 * While resolving social-image metadata Next.js runs, with no try/catch:
 *
 *   `new URL(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`)`
 *
 * (see `node_modules/next/dist/lib/metadata/resolvers/resolve-url.js`). It reads
 * that variable even when the application supplies its own `metadataBase`, so the
 * app cannot defend itself from inside `metadata`. A value that is not a bare
 * hostname — a bare `":"`, a full URL including its scheme, a stray quote, a blank
 * — therefore aborts the whole build with `TypeError: Invalid URL` repeated once
 * per prerendered page and with no mention of the variable at fault.
 *
 * This module is plain `.mjs` rather than TypeScript so that `next.config.mjs` can
 * import it directly (Next 14 loads a JS config, not a TS one) and so that it can
 * be unit-tested without re-importing the whole Next config.
 *
 * A full URL is narrowed to its host and anything unusable is dropped, which is
 * safe because these variables only ever hold a bare `host` or `host:port`.
 */

/** Variables Next.js reads and prefixes with `https://`. */
export const VERCEL_ORIGIN_VARS = ['VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_URL', 'VERCEL_BRANCH_URL'];

/** A bare `host` or `host:port`, which is all Next can accept here. */
const BARE_HOST = /^[a-z0-9.-]+(:\d+)?$/i;

/**
 * Rewrite or remove malformed Vercel origin values, in place.
 *
 * @param {Record<string, string | undefined>} [env] Mutable environment to fix up.
 * @param {(message: string) => void} [warn] Sink for the audit line; one is
 *   emitted per correction so a surprising deploy still explains itself.
 * @returns {string[]} Names of the variables that were changed or dropped.
 */
export function sanitizeVercelOrigins(env = process.env, warn = console.warn) {
  const repaired = [];

  for (const name of VERCEL_ORIGIN_VARS) {
    const value = env[name];
    if (!value) continue;

    const trimmed = value.trim();
    if (BARE_HOST.test(trimmed)) {
      env[name] = trimmed;
      continue;
    }

    // A full URL is a common paste mistake and is trivially recoverable.
    let host;
    try {
      host = new URL(trimmed).host;
    } catch {
      host = '';
    }

    if (host) {
      warn(`[next.config] ${name}="${value}" is not a bare host; using "${host}".`);
      env[name] = host;
    } else {
      warn(`[next.config] Ignoring malformed ${name}="${value}"; falling back to the default origin.`);
      delete env[name];
    }
    repaired.push(name);
  }

  return repaired;
}
