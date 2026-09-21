'use client';

import * as React from 'react';
import { Download, FileSpreadsheet, FileText, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDemoMode } from '@/components/demo-mode';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, exportUrl, type SummaryDto } from '@/lib/client';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/format';

export type ExportFilters = Record<string, unknown>;

/**
 * Export dialog: shows a live preview of what the file will contain (row count,
 * summary numbers, active filters) before triggering the download, with a
 * CSV/PDF toggle as required by the spec.
 */
export function ExportDialog({
  filters,
  label = 'Export',
  variant = 'outline',
  defaultFormat = 'csv',
  suggestedName,
}: {
  filters: ExportFilters;
  label?: string;
  variant?: 'default' | 'outline' | 'secondary' | 'ghost';
  defaultFormat?: 'csv' | 'pdf';
  suggestedName?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [format, setFormat] = React.useState<'csv' | 'pdf'>(defaultFormat);
  const [rollup, setRollup] = React.useState(false);
  const [preview, setPreview] = React.useState<Awaited<ReturnType<typeof api.previewExport>> | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [name, setName] = React.useState(suggestedName ?? '');
  const { demo } = useDemoMode();
  // Stabilise the effect dependency: callers often pass an inline object.
  const filtersKey = JSON.stringify(filters);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .previewExport(filters)
      .then((data) => {
        if (!cancelled) setPreview(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filtersKey]);

  const activeFilters = React.useMemo(
    () =>
      Object.entries(filters).filter(([, value]) => value !== undefined && value !== null && value !== '' && value !== false),
    [filters],
  );

  const downloadUrl = exportUrl(
    format,
    { ...filters, ...(rollup ? { rollup: 'parent' } : {}) },
    { name: name || undefined, store: false },
  );

  const summary: SummaryDto | undefined = preview?.summary;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/*
          Disabled in the demo rather than opening a dialog whose preview and
          download both answer 403. Exports are the one read the demo refuses,
          because they would hand out a file built from the sample set.
        */}
        <Button
          variant={variant}
          size="sm"
          disabled={demo}
          title={demo ? 'Downloads are disabled in the read-only demo' : undefined}
        >
          <Download className="h-4 w-4" />
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Export report</DialogTitle>
          <DialogDescription>
            The file contains exactly the rows matching the current filters, with a metadata preamble recording the
            filters that produced it.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={format} onValueChange={(value) => setFormat(value as 'csv' | 'pdf')}>
          <TabsList>
            <TabsTrigger value="csv">
              <FileSpreadsheet className="mr-1.5 h-3.5 w-3.5" />
              CSV
            </TabsTrigger>
            <TabsTrigger value="pdf">
              <FileText className="mr-1.5 h-3.5 w-3.5" />
              PDF
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="font-medium">Report name</span>
            <input
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={name}
              placeholder={suggestedName ?? 'UNSPSC spend report'}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="flex items-end gap-2 text-sm">
            <input
              id="rollup-toggle"
              type="checkbox"
              className="mb-2.5 h-4 w-4 rounded border-input"
              checked={rollup}
              onChange={(event) => setRollup(event.target.checked)}
            />
            <span className="mb-1.5">
              Roll up by parent company
              <span className="block text-xs text-muted-foreground">Aggregates spend and codes per parent.</span>
            </span>
          </label>
        </div>

        <div className="rounded-lg border bg-muted/40 p-4 text-sm">
          {loading ? (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Computing preview…
            </p>
          ) : error ? (
            <p className="text-destructive">{error}</p>
          ) : preview && summary ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Suppliers" value={formatNumber(summary.totalSuppliers)} />
                <Stat label="Spend" value={formatCurrency(summary.totalSpend, summary.currency)} />
                <Stat label="Classified" value={formatPercent(summary.percentClassified)} />
                <Stat label="Low confidence" value={formatPercent(summary.percentLowConfidence)} />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Filters applied</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {preview.filterSummary.length ? preview.filterSummary.join(' · ') : 'No filters (all suppliers)'}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                {preview.rowCount} supplier row(s), {preview.segments.length} segment(s),{' '}
                {preview.lowConfidenceCount} low-confidence row(s) in the appendix.
              </p>
            </div>
          ) : (
            <p className="text-muted-foreground">Nothing to preview yet.</p>
          )}
        </div>

        {activeFilters.length ? (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium">Raw filter parameters ({activeFilters.length})</summary>
            <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">
              {JSON.stringify(Object.fromEntries(activeFilters), null, 2)}
            </pre>
          </details>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button asChild size="sm">
            <a href={downloadUrl} download>
              <Download className="h-4 w-4" />
              Download {format.toUpperCase()}
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold">{value}</p>
    </div>
  );
}
