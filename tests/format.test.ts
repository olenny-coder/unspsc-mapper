/**
 * Display formatting tests.
 *
 * `formatCurrencyCompact` exists to fix a layout defect rather than for tidiness:
 * axis tick labels are centred on their tick, so a full amount like `$60,000,000`
 * spills past the plot edge — and Recharts draws axis text as SVG, which cannot wrap.
 * The length assertions below are therefore the point of the test, not incidental.
 *
 * The most important assertion here is that the output does NOT depend on the
 * runtime's ICU build. CI caught that the hard way: `Intl`'s `notation: 'compact'`
 * renders `0` as `$0.0` under Node 20's ICU 78.2 and `$0` under Node 24's ICU 77.1,
 * so a test pinning that output passed locally and failed in CI. The abbreviation is
 * now computed in `lib/format.ts` and formatted with plain, stable currency formatting.
 */
import { describe, expect, it } from 'vitest';
import { formatCurrency, formatCurrencyCompact } from '@/lib/format';

describe('formatCurrencyCompact', () => {
  it('shortens amounts to an axis-sized label', () => {
    expect(formatCurrencyCompact(60_000_000)).toBe('$60M');
    expect(formatCurrencyCompact(15_000_000)).toBe('$15M');
    expect(formatCurrencyCompact(150_000)).toBe('$150K');
    expect(formatCurrencyCompact(0)).toBe('$0');
  });

  it('does not pad a whole number with a cosmetic fraction', () => {
    // The exact failure that reached CI: compact notation returned `$0.0` and
    // `$999.0` on Node 20. Nothing here may produce a trailing `.0`.
    for (const value of [0, 999, 1_000, 9_999, 10_000, 60_000_000]) {
      expect(formatCurrencyCompact(value), `value ${value}`).not.toMatch(/\.0(?=\D|$)/);
    }
  });

  it('pins the values that differ between ICU versions', () => {
    // Each of these rendered differently under CI's ICU 78.2 and the local ICU 77.1
    // while compact notation was in use. They must be stable now.
    expect(formatCurrencyCompact(0)).toBe('$0');
    expect(formatCurrencyCompact(999)).toBe('$999');
    expect(formatCurrencyCompact(9_999)).toBe('$10K');
    expect(formatCurrencyCompact(1_234_567_890)).toBe('$1.2B');
  });

  it('keeps one decimal where it carries information', () => {
    // Rounding 1.5M to `$2M` discards a quarter of the value; `$1.5M` is still short.
    expect(formatCurrencyCompact(1_500)).toBe('$1.5K');
    expect(formatCurrencyCompact(1_500_000)).toBe('$1.5M');
    expect(formatCurrencyCompact(1_234_567_890)).toBe('$1.2B');
  });

  it('never produces a label long enough to overflow an axis tick', () => {
    // The full form is 8–12 characters (`$60,000,000`, `$115,155,000`) and a tick label
    // is centred on its tick, so half of it hung past the plot edge. Compact must stay
    // comfortably shorter; 7 covers the worst case, `$999.5K`.
    for (const value of [999, 1_500, 999_999, 15_000_000, 60_000_000, 999_000_000, 1_234_567_890]) {
      expect(formatCurrencyCompact(value).length, `value ${value}`).toBeLessThanOrEqual(7);
    }
  });

  it('promotes a value that would otherwise round up into a four-digit label', () => {
    // Choosing the unit from the raw magnitude gave `$1,000K` for 999,999, because
    // 999.999 rounds up to 1000 in the K unit.
    expect(formatCurrencyCompact(999_999)).toBe('$1M');
    expect(formatCurrencyCompact(999_500)).toBe('$1M');
    expect(formatCurrencyCompact(999_499_999)).toBe('$999.5M');
    expect(formatCurrencyCompact(999_499)).toBe('$999.5K');
  });

  it('keeps sub-thousand amounts readable rather than rounding them away', () => {
    expect(formatCurrencyCompact(999)).toBe('$999');
    expect(formatCurrencyCompact(12.5)).toBe('$12.5');
  });

  it('handles negatives and the empty cases the rest of the app relies on', () => {
    expect(formatCurrencyCompact(-1_500_000)).toBe('-$1.5M');
    expect(formatCurrencyCompact(null)).toBe('—');
    expect(formatCurrencyCompact(undefined)).toBe('—');
    expect(formatCurrencyCompact(Number.NaN)).toBe('—');
    expect(formatCurrencyCompact(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('is shorter than the full form for every value it is used with', () => {
    for (const value of [15_000, 1_500_000, 60_000_000]) {
      expect(formatCurrencyCompact(value).length).toBeLessThan(formatCurrency(value).length);
    }
  });
});
