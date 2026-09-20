/**
 * Retry + backoff primitives. Pure functions with an injectable `sleep` so unit
 * tests run instantly and deterministically.
 */
import { RateLimitError } from '@/lib/errors';

export type RetryOptions = {
  /** Total attempts, including the first. Default 4. */
  attempts?: number;
  /** First backoff delay in ms. Default 500. */
  baseDelayMs?: number;
  /** Upper bound for a single delay. Default 20_000. */
  maxDelayMs?: number;
  /** Growth factor. Default 2 (exponential). */
  factor?: number;
  /** Random jitter ratio applied to each delay, 0..1. Default 0.25. */
  jitter?: number;
  /** Return false to fail fast for a given error. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Called before each backoff, mainly for logging/audit. */
  onRetry?: (info: RetryInfo) => void;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional abort signal checked between attempts. */
  signal?: AbortSignal;
  /** Label used in log lines. */
  label?: string;
};

export type RetryInfo = {
  attempt: number;
  delayMs: number;
  error: unknown;
  label?: string;
};

/** Default sleep implementation. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Compute the delay for a given attempt. Exported for direct unit testing.
 * attempt is 1-based: delay(1) is the wait *after* the first failure.
 */
export function computeBackoffDelay(
  attempt: number,
  options: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'factor' | 'jitter'> = {},
  random: () => number = Math.random,
): number {
  const base = options.baseDelayMs ?? 500;
  const max = options.maxDelayMs ?? 20_000;
  const factor = options.factor ?? 2;
  const jitter = Math.max(0, Math.min(1, options.jitter ?? 0.25));

  const exponential = Math.min(max, base * factor ** Math.max(0, attempt - 1));
  if (jitter === 0) return Math.round(exponential);

  // Full-ish jitter around the exponential value: [exp*(1-j), exp*(1+j))
  const spread = exponential * jitter;
  const value = exponential - spread + random() * spread * 2;
  return Math.max(0, Math.round(Math.min(max, value)));
}

/** Extract a `Retry-After` header (seconds or HTTP date) as milliseconds. */
export function parseRetryAfterMs(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    if (seconds <= 0) return null;
    return Math.min(seconds * 1000, 10 * 60 * 1000);
  }

  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    const delta = date - now;
    return delta > 0 ? Math.min(delta, 10 * 60 * 1000) : null;
  }
  return null;
}

/** HTTP statuses worth retrying (transient upstream/network conditions). */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/**
 * Run `fn` with exponential backoff.
 *
 * - `RateLimitError` carries a `retryAfterMs` that is honoured as a floor.
 * - `AbortSignal` aborts before the next attempt.
 */
export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const sleepFn = options.sleep ?? sleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      if (options.signal?.aborted) throw error;

      const retryable = options.shouldRetry ? options.shouldRetry(error, attempt) : true;
      if (!retryable || attempt >= attempts) throw error;

      let delayMs = computeBackoffDelay(attempt, options);
      if (error instanceof RateLimitError) {
        delayMs = Math.max(delayMs, error.retryAfterMs);
      }
      delayMs = Math.min(delayMs, options.maxDelayMs ?? 20_000);

      options.onRetry?.({ attempt, delayMs, error, label: options.label });
      await sleepFn(delayMs);
      if (options.signal?.aborted) throw error;
    }
  }
  throw lastError;
}

/**
 * `fetch` with a hard timeout. Always clears its timer so the process can exit.
 */
export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 30_000, signal, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);

  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    return await fetch(input, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Run promises with bounded concurrency, preserving input order.
 * Rejections are captured per item so one failure cannot abort the batch.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const size = Math.max(1, Math.floor(limit));
  const results = new Array<{ ok: true; value: R } | { ok: false; error: unknown }>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index] as T;
      try {
        results[index] = { ok: true, value: await worker(item, index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });

  await Promise.all(runners);
  return results;
}
