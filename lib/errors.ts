/**
 * Typed error hierarchy. Keeping errors typed (instead of stringly-typed
 * throws) lets the API routes map them to HTTP status codes deterministically.
 */

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    options: { code?: string; status?: number; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? 'app_error';
    this.status = options.status ?? 500;
    this.details = options.details;
  }
}

/** 400 — caller sent something we cannot process. */
export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: 'validation_error', status: 400, details });
  }
}

/** 404 — entity missing. */
export class NotFoundError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: 'not_found', status: 404, details });
  }
}

/** 401/403 — worker secret or config problem. */
export class AuthError extends AppError {
  constructor(message = 'Unauthorized', status = 401, details?: Record<string, unknown>) {
    super(message, { code: 'unauthorized', status, details });
  }
}

/** 503 — upstream provider (Groq, CompanyEnrich) unavailable after retries. */
export class ProviderError extends AppError {
  readonly provider: string;
  readonly retryable: boolean;

  constructor(
    provider: string,
    message: string,
    options: { status?: number; retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, {
      code: `provider_error:${provider}`,
      status: options.status ?? 503,
      details: options.details,
      cause: options.cause,
    });
    this.provider = provider;
    this.retryable = options.retryable ?? true;
  }
}

/** 429 — a local rate limiter refused the call (free-tier protection). */
export class RateLimitError extends AppError {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number, details?: Record<string, unknown>) {
    super(message, { code: 'rate_limited', status: 429, details });
    this.retryAfterMs = retryAfterMs;
  }
}

/** 502 — the model returned something that is not usable JSON. */
export class LlmResponseError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: 'llm_bad_response', status: 502, details });
  }
}

/** 500 — database or configuration failure. */
export class ConfigError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: 'config_error', status: 500, details });
  }
}

/**
 * 403 — a demo visitor tried to do something that changes state.
 *
 * A distinct code rather than a plain `unauthorized`, because the UI needs to tell
 * the user "this is a read-only demo, sign in to make changes" rather than the
 * "your session expired, sign in again" treatment a 401 triggers.
 */
export class DemoReadOnlyError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { code: 'demo_read_only', status: 403, details });
  }
}

export class DatabaseError extends AppError {
  constructor(message: string, cause?: unknown, details?: Record<string, unknown>) {
    super(message, { code: 'database_error', status: 500, details, cause });
  }
}

/** Convert any thrown value into a normalised, serialisable shape. */
export function serializeError(error: unknown): {
  name: string;
  message: string;
  code: string;
  status: number;
  details?: Record<string, unknown>;
} {
  if (error instanceof AppError) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      status: error.status,
      details: error.details,
    };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message, code: 'error', status: 500 };
  }
  return { name: 'Error', message: String(error), code: 'error', status: 500 };
}
