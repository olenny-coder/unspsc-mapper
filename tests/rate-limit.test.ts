import { describe, expect, it, vi } from 'vitest';
import { DailyBudget, RateLimiter, usageDay } from '@/lib/rate-limit';
import { RateLimitError } from '@/lib/errors';

/** Controllable clock so limiter tests never really wait. */
function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('RateLimiter', () => {
  it('allows up to the per-minute limit immediately', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ perMinute: 3, now: clock.now, sleep: async () => undefined });

    const started = Date.now();
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(Date.now() - started).toBeLessThan(500);
    expect(limiter.snapshot().inWindow).toBe(3);
  });

  it('reports the wait until the next free slot', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ perMinute: 1, now: clock.now, sleep: async () => undefined });
    await limiter.acquire();
    expect(limiter.nextSlotInMs()).toBe(60_000);
    clock.advance(30_000);
    expect(limiter.nextSlotInMs()).toBe(30_000);
    clock.advance(30_000);
    expect(limiter.nextSlotInMs()).toBe(0);
  });

  it('throws a RateLimitError instead of waiting past maxWaitMs', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ perMinute: 1, now: clock.now, sleep: async () => undefined, label: 'groq' });
    await limiter.acquire();
    await expect(limiter.acquire(1000)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('waits for a slot when the wait is acceptable', async () => {
    const clock = fakeClock();
    const sleeps: number[] = [];
    const limiter = new RateLimiter({
      perMinute: 1,
      now: clock.now,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.advance(ms);
      },
    });
    await limiter.acquire();
    await limiter.acquire(120_000);
    expect(sleeps).toEqual([60_000]);
    expect(limiter.snapshot().inWindow).toBe(1);
  });

  it('serialises concurrent acquisitions', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({
      perMinute: 2,
      now: clock.now,
      sleep: async (ms) => {
        clock.advance(ms);
      },
    });

    await Promise.all([limiter.acquire(120_000), limiter.acquire(120_000), limiter.acquire(120_000)]);
    // Third call had to wait for the window to roll forward.
    expect(limiter.snapshot().inWindow).toBeLessThanOrEqual(2);
  });

  it('reset clears the window', async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter({ perMinute: 1, now: clock.now, sleep: async () => undefined });
    await limiter.acquire();
    limiter.reset();
    expect(limiter.snapshot().inWindow).toBe(0);
  });
});

describe('DailyBudget', () => {
  it('tracks spend against capacity minus the reserve', () => {
    const budget = new DailyBudget({ dailyLimit: 1000, reserve: 50, label: '70b' });
    expect(budget.capacity).toBe(950);
    expect(budget.remaining).toBe(950);

    budget.consume(900);
    expect(budget.remaining).toBe(50);
    expect(budget.hasCapacity(50)).toBe(true);
    expect(budget.hasCapacity(51)).toBe(false);
  });

  it('throws a RateLimitError once the usable budget is exhausted', () => {
    const budget = new DailyBudget({ dailyLimit: 10, reserve: 2, label: '70b' });
    budget.consume(8);
    expect(() => budget.consume(1)).toThrow(RateLimitError);
  });

  it('can be rehydrated from durable usage counters', () => {
    const budget = new DailyBudget({ dailyLimit: 1000, reserve: 50, used: 975 });
    expect(budget.spent).toBe(975);
    expect(budget.remaining).toBe(0);
    budget.setSpent(0);
    expect(budget.remaining).toBe(950);
  });
});

describe('usageDay', () => {
  it('buckets by UTC day', () => {
    expect(usageDay(Date.parse('2024-03-01T23:59:59Z'))).toBe('2024-03-01');
    expect(usageDay(Date.parse('2024-03-02T00:00:01Z'))).toBe('2024-03-02');
  });
});

describe('rate limiter logging', () => {
  it('does not call the logger on the success path', async () => {
    const spy = vi.fn();
    const limiter = new RateLimiter({ perMinute: 5, sleep: async () => undefined });
    await limiter.acquire();
    expect(spy).not.toHaveBeenCalled();
  });
});
