/** Display formatting shared by the UI and the PDF/CSV renderers. */
import { roundTo } from '@/lib/normalize';

export function formatCurrency(value: number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatCurrencyDetailed(value: number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);
}

/**
 * Currency shortened to a compact axis label — `$1.2M` rather than `$1,200,000`.
 *
 * Exists for chart axes on narrow screens. A full amount is eleven characters
 * (`$60,000,000`), and an axis tick label is centred on its tick, so the last one on
 * the right spills past the plot edge by half its width. Compacting removes the
 * overflow at the source instead of padding the chart to hide it, and reads better
 * in the ~100px a phone has to offer.
 *
 * The abbreviation is computed here rather than delegated to `Intl`'s
 * `notation: 'compact'`, which is **not stable across ICU versions**: CI's Node and a
 * local Node disagree, rendering `0` as `$0.0` and `$0` respectively. A label whose
 * text depends on the runtime's ICU build cannot be pinned by a test, and the same
 * drift would silently change what production renders.
 *
 * Plain (non-compact) currency formatting is stable across ICU versions, so the scaled
 * number is formatted with that and the suffix appended.
 */
const COMPACT_UNITS = [
  { threshold: 1_000_000_000, suffix: 'B' },
  { threshold: 1_000_000, suffix: 'M' },
  { threshold: 1_000, suffix: 'K' },
] as const;

/**
 * How close to a unit a value must be before it is promoted to it.
 *
 * Choosing the unit from the raw magnitude is not enough: 999,999 is below a million,
 * so it would scale to 999.999 and round to `$1,000K` — a four-digit axis label. The
 * slack promotes anything that would round *up* into the next unit, so it renders as
 * `$1M` instead.
 */
const UNIT_PROMOTION_SLACK = 0.9995;

export function formatCurrencyCompact(value: number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';

  const magnitude = Math.abs(value);
  const unit = COMPACT_UNITS.find((candidate) => magnitude >= candidate.threshold * UNIT_PROMOTION_SLACK);
  const scaled = unit ? value / unit.threshold : value;

  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    // At most one decimal: `$1.5M` earns the character, `$1.50M` and `$1.0M` do not.
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(scaled);

  return unit ? `${formatted}${unit.suffix}` : formatted;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US').format(value);
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${roundTo(value, digits).toFixed(digits)}%`;
}

export function formatConfidence(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(2);
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelative(value: string | Date | null | undefined): string {
  if (!value) return 'never';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'never';
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

export function confidenceTone(confidence: number | null | undefined, threshold = 0.7): 'high' | 'medium' | 'low' | 'none' {
  if (confidence === null || confidence === undefined) return 'none';
  if (confidence >= 0.85) return 'high';
  if (confidence >= threshold) return 'medium';
  return 'low';
}

export function truncate(value: string | null | undefined, length = 80): string {
  if (!value) return '';
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}
