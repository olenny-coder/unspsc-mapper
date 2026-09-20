import { describe, expect, it, vi } from 'vitest';
import {
  computeBackoffDelay,
  fetchWithTimeout,
  isRetryableStatus,
  mapLimit,
  parseRetryAfterMs,
  retry,
} from '@/lib/retry';
import { ProviderError, RateLimitError } from '@/lib/errors';

const noSleep = async () => undefined;

describe('computeBackoffDelay', () => {
  it('grows exponentially and is capped', () => {
    const options = { baseDelayMs: 100, factor: 2, maxDelayMs: 1000, jitter: 0 };
    expect(computeBackoffDelay(1, options)).toBe(100);
    expect(computeBackoffDelay(2, options)).toBe(200);
    expect(computeBackoffDelay(3, options)).toBe(400);
    expect(computeBackoffDelay(4, options)).toBe(800);
    expect(computeBackoffDelay(5, options)).toBe(1000);
    expect(computeBackoffDelay(50, options)).toBe(1000);
  });

  it('applies jitter inside the configured band', () => {
    const options = { baseDelayMs: 1000, factor: 2, maxDelayMs: 10_000, jitter: 0.25 };
    // random() = 0 -> lower edge; random() = 1 -> upper edge
    expect(computeBackoffDelay(1, options, () => 0)).toBe(750);
    expect(computeBackoffDelay(1, options, () => 1)).toBe(1250);
    const mid = computeBackoffDelay(1, options, () => 0.5);
    expect(mid).toBe(1000);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs('0')).toBeNull();
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
    const now = Date.parse('2024-01-01T00:00:00Z');
    expect(parseRetryAfterMs('Mon, 01 Jan 2024 00:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfterMs('Mon, 01 Jan 2020 00:00:00 GMT', now)).toBeNull();
  });

  it('caps absurd values', () => {
    expect(parseRetryAfterMs('100000')).toBe(10 * 60 * 1000);
  });
});

describe('isRetryableStatus', () => {
  it('retries 429 and 5xx, not 4xx client errors', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });
});

describe('retry', () => {
  it('returns the first successful result without sleeping', async () => {
    const sleep = vi.fn(async () => undefined);
    const result = await retry(async () => 'ok', { sleep });
    expect(result).toBe('ok');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries failures and eventually succeeds', async () => {
    let attempts = 0;
    const onRetry = vi.fn();
    const result = await retry(
      async (attempt) => {
        attempts = attempt;
        if (attempt < 3) throw new Error('flaky');
        return `attempt-${attempt}`;
      },
      { attempts: 5, sleep: noSleep, onRetry },
    );
    expect(result).toBe('attempt-3');
    expect(attempts).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('gives up after the configured number of attempts', async () => {
    const fn = vi.fn(async () => {
      throw new Error('always fails');
    });
    await expect(retry(fn, { attempts: 3, sleep: noSleep })).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('honours shouldRetry to fail fast', async () => {
    const fn = vi.fn(async () => {
      throw new ProviderError('enrich', 'bad key', { retryable: false });
    });
    await expect(
      retry(fn, { attempts: 4, sleep: noSleep, shouldRetry: (error) => !(error instanceof ProviderError) || error.retryable }),
    ).rejects.toThrow('bad key');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('waits at least the Retry-After duration reported by a rate limit error', async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };
    await expect(
      retry(
        async (attempt) => {
          if (attempt === 1) throw new RateLimitError('slow down', 7000);
          return 'done';
        },
        { attempts: 3, sleep, baseDelayMs: 100, jitter: 0 },
      ),
    ).resolves.toBe('done');
    expect(delays[0]).toBeGreaterThanOrEqual(7000);
  });

  it('aborts immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => 'never');
    await expect(retry(fn, { attempts: 3, sleep: noSleep, signal: controller.signal })).resolves.toBe('never');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('mapLimit', () => {
  it('preserves input order and isolates failures', async () => {
    const results = await mapLimit([1, 2, 3, 4, 5], 2, async (value) => {
      if (value === 3) throw new Error('boom');
      return value * 10;
    });

    expect(results[0]).toEqual({ ok: true, value: 10 });
    expect(results[1]).toEqual({ ok: true, value: 20 });
    expect(results[2]?.ok).toBe(false);
    expect(results[3]).toEqual({ ok: true, value: 40 });
    expect(results[4]).toEqual({ ok: true, value: 50 });
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 20 }, (_, index) => index), 4, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return true;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe('fetchWithTimeout', () => {
  it('aborts a slow request', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;

    try {
      await expect(fetchWithTimeout('https://example.test', { timeoutMs: 20 })).rejects.toThrow('aborted');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
