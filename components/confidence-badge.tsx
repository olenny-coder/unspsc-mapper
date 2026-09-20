import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { confidenceTone } from '@/lib/format';

export function ConfidenceBadge({
  confidence,
  threshold = 0.7,
  inherited = false,
  reviewed = false,
  className,
}: {
  confidence: number | null | undefined;
  threshold?: number;
  inherited?: boolean;
  reviewed?: boolean;
  className?: string;
}) {
  const tone = confidenceTone(confidence, threshold);
  const variant = tone === 'high' ? 'success' : tone === 'medium' ? 'info' : tone === 'low' ? 'warning' : 'muted';
  const label = confidence === null || confidence === undefined ? 'unclassified' : confidence.toFixed(2);

  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      <Badge variant={variant} title={`Confidence ${label} (review threshold ${threshold.toFixed(2)})`}>
        {label}
      </Badge>
      {inherited ? (
        <Badge variant="secondary" title="Inherited from the parent company classification">
          inherited
        </Badge>
      ) : null}
      {reviewed ? (
        <Badge variant="outline" title="Human-reviewed classification">
          reviewed
        </Badge>
      ) : null}
    </span>
  );
}

export function StaleBadge({ stale, reason, ageDays }: { stale: boolean; reason?: string | null; ageDays?: number | null }) {
  if (!stale) return null;
  return (
    <Badge
      variant="warning"
      title={`Stale: ${reason ?? 'enrichment is out of date'}${ageDays !== null && ageDays !== undefined ? ` (${ageDays} days old)` : ''}`}
    >
      stale
    </Badge>
  );
}
