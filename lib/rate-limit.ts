/**
 * In-process token-bucket rate limiter plus free-tier daily budget accounting.
 *
 * Two limits are enforced:
 *   1. per-minute request rate (protects against Groq 429s), and
 *   2. per-day request budget per model (protects the free tier quota).
 *
 * The limiter is process-local. On Vercel that means each serverless instance
 * has its own bucket; the durable daily counters live in the `llm_usage` table
 * (see `services/llm-usage.ts`) and are consulted by the worker, which is the
 * only long-lived process that can exhaust a daily quota.
 */
import { RateLimitError } from '@/lib/errors';

export type RateLimiterOptions = {
  /** Maximum requests per rolling minute. */
  perMinute: number;
  /** Injectable clock (ms epoch). */
  now?: () => number;
  /** Injectable sleep. */
  sleep?: (ms: number) => Promise<void>;
  label?: string;
};

export type RateLimiterSnapshot = {
  perMinute: number;
  inWindow: number;
  nextSlotInMs: number;
};

/**
 * Sliding-window limiter. Call `acquire()` before every upstream request; it
 * resolves when a slot is available and throws `RateLimitError` when
 * `maxWaitMs` would be exceeded.
 */
export class RateLimiter {
  private readonly perMinute: number;
  private readonly now: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly label: string;
  private readonly timestamps: number[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions) {
    this.perMinute = Math.max(1, Math.floor(options.perMinute));
    this.now = options.now ?? Date.now;
    this.sleepFn = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.label = options.label ?? 'rate-limiter';
  }

  /** Remove timestamps outside the 60s window. */
  private prune(now: number): void {
    const cutoff = now - 60_000;
    while (this.timestamps.length && (this.timestamps[0] as number) <= cutoff) {
      this.timestamps.shift();
    }
  }

  /** Milliseconds until the next slot frees up (0 when a slot is available now). */
  nextSlotInMs(): number {
    const now = this.now();
    this.prune(now);
    if (this.timestamps.length < this.perMinute) return 0;
    const oldest = this.timestamps[0] as number;
    return Math.max(0, oldest + 60_000 - now);
  }

  snapshot(): RateLimiterSnapshot {
    const now = this.now();
    this.prune(now);
    return { perMinute: this.perMinute, inWindow: this.timestamps.length, nextSlotInMs: this.nextSlotInMs() };
  }

  /**
   * Serialise acquisitions so concurrent callers queue instead of stampeding.
   */
  async acquire(maxWaitMs = 60_000): Promise<void> {
    const run = async (): Promise<void> => {
      let waited = 0;
      for (;;) {
        const wait = this.nextSlotInMs();
        if (wait === 0) {
          this.timestamps.push(this.now());
          return;
        }
        if (waited + wait > maxWaitMs) {
          throw new RateLimitError(
            `${this.label}: per-minute limit of ${this.perMinute} requests reached`,
            wait,
            { perMinute: this.perMinute, waitedMs: waited },
          );
        }
        await this.sleepFn(wait);
        waited += wait;
      }
    };

    const previous = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await run();
    } finally {
      release();
    }
  }

  /** Record a request that was issued outside `acquire` (e.g. after a retry). */
  record(count = 1): void {
    const now = this.now();
    this.prune(now);
    for (let i = 0; i < count; i += 1) this.timestamps.push(now);
  }

  reset(): void {
    this.timestamps.length = 0;
  }
}

export type DailyBudgetOptions = {
  /** Hard cap of requests per UTC day. */
  dailyLimit: number;
  /** Requests kept in reserve for interactive dashboard actions. */
  reserve?: number;
  now?: () => number;
  label?: string;
};

/** UTC day bucket, `YYYY-MM-DD`. */
export function usageDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Daily free-tier budget guard. `spent` is injected from the durable counter
 * (`llm_usage`) so the value survives worker restarts.
 */
export class DailyBudget {
  private readonly dailyLimit: number;
  private readonly reserve: number;
  private readonly label: string;
  private used: number;

  constructor(options: DailyBudgetOptions & { used?: number }) {
    this.dailyLimit = Math.max(1, Math.floor(options.dailyLimit));
    this.reserve = Math.max(0, Math.floor(options.reserve ?? 0));
    this.label = options.label ?? 'daily-budget';
    this.used = Math.max(0, Math.floor(options.used ?? 0));
  }

  /** Usable requests today, excluding the reserve. */
  get capacity(): number {
    return Math.max(0, this.dailyLimit - this.reserve);
  }

  get remaining(): number {
    return Math.max(0, this.capacity - this.used);
  }

  get spent(): number {
    return this.used;
  }

  setSpent(value: number): void {
    this.used = Math.max(0, Math.floor(value));
  }

  hasCapacity(count = 1): boolean {
    return this.remaining >= count;
  }

  /**
   * Consume `count` units, throwing `RateLimitError` when the daily free-tier
   * budget (minus the reserve) is exhausted.
   */
  consume(count = 1): void {
    if (this.remaining < count) {
      const nextUtcMidnight = Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        new Date().getUTCDate() + 1,
      );
      throw new RateLimitError(
        `${this.label}: daily budget exhausted (${this.used}/${this.capacity} used, ${this.reserve} reserved)`,
        Math.max(1000, nextUtcMidnight - Date.now()),
        { dailyLimit: this.dailyLimit, used: this.used, reserve: this.reserve },
      );
    }
    this.used += count;
  }
}
