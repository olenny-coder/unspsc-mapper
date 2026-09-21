/**
 * Display formatting tests.
 *
 * The compact currency formatter exists to fix a layout defect rather than for
 * tidiness: axis tick labels are centred on their tick, so a full amount like
 * `$60,000,000` spills past the plot edge — and Recharts draws axis text as SVG,
 * which cannot wrap. The length assertions below are therefore the point of the
 * test, not incidental.
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

  it('keeps a decimal only where the magnitude needs one to stay meaningful', () => {
    // Without this, $1,500 would render as "$2K" and lose the distinction entirely.
    expect(formatCurrencyCompact(1_500)).toBe('$1.5K');
    expect(formatCurrencyCompact(1_500_000)).toBe('$2M');
  });

  it('never produces a label long enough to overflow an axis tick', () => {
    for (const value of [999, 1_500, 999_999, 15_000_000, 60_000_000, 999_000_000, 1_234_567_890]) {
      // Eleven characters is the width of the full form, which is what overflowed.
      expect(formatCurrencyCompact(value).length).toBeLessThanOrEqual(6);
    }
  });

  it('handles the empty cases the rest of the app relies on', () => {
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
