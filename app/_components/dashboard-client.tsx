'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowUpDown,
  Building2,
  CheckCircle2,
  Coins,
  Loader2,
  Percent,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfidenceBadge, StaleBadge } from '@/components/confidence-badge';
import { useDemoMode } from '@/components/demo-mode';
import { ExportDialog } from '@/components/export-dialog';
import {
  EMPTY_FILTERS,
  FilterBar,
  toApiFilters,
  type DashboardFilterState,
} from '@/components/filter-bar';
import { api, type MetricsDto, type ParentRollupDto, type SupplierRowDto } from '@/lib/client';
import { formatCurrency, formatCurrencyCompact, formatDateTime, formatNumber, formatPercent, formatRelative, truncate } from '@/lib/format';
import { cn } from '@/lib/utils';

const CHART_FALLBACK = {
  grid: 'hsl(214 32% 91%)',
  series: ['#2563eb', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444'],
};

/**
 * Chart palette resolved from the CSS design tokens.
 *
 * Using the tokens (rather than fixed hex values) means the bar chart follows the
 * active theme, including when the user switches theme at runtime: the
 * MutationObserver on `<html>` re-reads the variables and React re-renders.
 */
function useChartColors(): { grid: string; series: string[] } {
  const [colors, setColors] = React.useState(CHART_FALLBACK);

  React.useEffect(() => {
    const read = () => {
      const styles = getComputedStyle(document.documentElement);
      const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
      setColors({
        grid: `hsl(${token('--chart-grid', '214 32% 91%')})`,
        series: [1, 2, 3, 4, 5].map((index) => `hsl(${token(`--chart-${index}`, CHART_FALLBACK.series[index - 1]!)})`),
      });
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => observer.disconnect();
  }, []);

  return colors;
}

type SortKey = 'name' | 'spend' | 'confidence' | 'updatedAt';

/** True below the `sm` breakpoint, where the chart has far less horizontal room. */
function useIsNarrow(): boolean {
  const [narrow, setNarrow] = React.useState(false);
  React.useEffect(() => {
    const media = window.matchMedia('(max-width: 639px)');
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return narrow;
}

export default function DashboardPage() {
  const { demo } = useDemoMode();
  const chartColors = useChartColors();
  const isNarrow = useIsNarrow();
  const [filters, setFilters] = React.useState<DashboardFilterState>(EMPTY_FILTERS);
  const [metrics, setMetrics] = React.useState<MetricsDto | null>(null);
  const [rows, setRows] = React.useState<SupplierRowDto[]>([]);
  const [rollup, setRollup] = React.useState<ParentRollupDto[]>([]);
  const [page, setPage] = React.useState(1);
  const [pages, setPages] = React.useState(1);
  const [total, setTotal] = React.useState(0);
  const [sort, setSort] = React.useState<SortKey>('name');
  const [dir, setDir] = React.useState<'asc' | 'desc'>('asc');
  const [selected, setSelected] = React.useState<number[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [meta, setMeta] = React.useState<{
    segments: Array<{ segmentCode: string; segment: string; codes: number }>;
    parents: Array<{ id: number | null; name: string; subsidiaries: number; totalAmount: number }>;
  }>({ segments: [], parents: [] });

  const apiFilters = React.useMemo(() => toApiFilters(filters), [filters]);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [metricsData, suppliersData] = await Promise.all([
        api.metrics(apiFilters),
        api.suppliers({ ...apiFilters, page, pageSize: 25, sort, dir }),
      ]);
      setMetrics(metricsData);
      setRows(suppliersData.rows);
      setRollup(suppliersData.rollup);
      setTotal(suppliersData.total);
      setPages(suppliersData.pages);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [apiFilters, page, sort, dir]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    api
      .supplierMeta()
      .then((data) => setMeta({ segments: data.segments, parents: data.parents }))
      .catch(() => undefined);
  }, []);

  const refreshSelected = async () => {
    if (!selected.length) return;
    setBusy('enrich');
    setNotice(null);
    try {
      const result = await api.enrich({ supplierIds: selected, force: true, detectParent: true, actor: 'dashboard' });
      setNotice(
        `Refreshed ${result.processed} supplier(s): ${result.enriched} enriched, ${result.cached} from cache, ${result.failed} failed, ${result.parentLinks.linked} parent link(s) updated.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const classifySelected = async () => {
    setBusy('classify');
    setNotice(null);
    try {
      const result = await api.classify({
        supplierIds: selected.length ? selected : undefined,
        actor: 'dashboard',
        preserveReviewed: true,
      });
      setNotice(
        `Classified ${result.classified} supplier(s), ${result.inherited} inherited from a parent, ${result.failed} failed. ${result.llmRequests} Groq request(s).`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const runSync = async () => {
    setBusy('sync');
    setNotice(null);
    try {
      const result = await api.enrich({ pending: true, actor: 'dashboard' });
      setNotice(`Sync pass: ${result.processed} processed, ${result.enriched} enriched, ${result.creditsUsed} credits.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const toggleSort = (key: SortKey) => {
    if (sort === key) setDir(dir === 'asc' ? 'desc' : 'asc');
    else {
      setSort(key);
      setDir(key === 'name' ? 'asc' : 'desc');
    }
    setPage(1);
  };

  const summary = metrics?.summary;

  /*
   * Category labels are budgeted to the axis width, not to a fixed length.
   *
   * Recharts renders axis text as SVG, which cannot wrap, so a label longer than the
   * axis is simply clipped. A 22-character budget plus the 3-character segment-code
   * prefix needs about 128px, but a phone only gives the axis 108px — which is what
   * pushed the chart's content past its own container and clipped the labels. The
   * budget is therefore derived from the axis width and font size it is drawn at.
   */
  const yAxisWidth = isNarrow ? 108 : 170;
  const yAxisFontSize = isNarrow ? 10 : 11;
  // 0.55em per character is a deliberately pessimistic estimate of average glyph
  // width: font metrics differ per device and per platform font stack, and the cost
  // of guessing low is a clipped label, whereas guessing high only costs a character.
  const labelBudget = Math.max(8, Math.floor((yAxisWidth - 8) / (yAxisFontSize * 0.55)) - 3);

  const chartData = (metrics?.segments ?? []).slice(0, 10).map((segment) => ({
    name: `${segment.segmentCode} ${truncate(segment.segment, labelBudget)}`,
    // Kept in full so the tooltip can show what the axis had to shorten.
    fullName: `${segment.segmentCode} ${segment.segment}`,
    spend: segment.spend,
    suppliers: segment.suppliers,
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Spend dashboard</h1>
          <p className="text-sm text-muted-foreground">
            {summary
              ? `${formatNumber(summary.totalSuppliers)} suppliers · ${formatCurrency(summary.totalSpend, summary.currency)} tracked spend · review threshold ${summary.confidenceThreshold.toFixed(2)}`
              : 'Loading supplier portfolio…'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Reload
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void runSync()}
            disabled={busy !== null || demo}
            title={
              demo
                ? 'Unavailable in the read-only demo — sign in to make changes'
                : 'Re-enrich suppliers that are stale or never enriched'
            }
          >
            {busy === 'sync' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Sync stale
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refreshSelected()}
            disabled={!selected.length || busy !== null || demo}
            title={demo ? 'Unavailable in the read-only demo — sign in to make changes' : undefined}
          >
            {busy === 'enrich' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span className="hidden sm:inline">Refresh selected</span>
            <span className="sm:hidden">Refresh</span>
            {selected.length ? ` (${selected.length})` : ''}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void classifySelected()}
            disabled={busy !== null || demo}
            title={demo ? 'Unavailable in the read-only demo — sign in to make changes' : undefined}
          >
            {busy === 'classify' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {/* The long label would push the toolbar onto three rows on a phone. */}
            <span className="hidden sm:inline">
              {selected.length ? `Classify selected (${selected.length})` : 'Classify pending'}
            </span>
            <span className="sm:hidden">{selected.length ? `Classify (${selected.length})` : 'Classify'}</span>
          </Button>
          <ExportDialog filters={apiFilters} label="Export CSV" defaultFormat="csv" />
          <ExportDialog filters={apiFilters} label="Export PDF" defaultFormat="pdf" />
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Request failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {notice ? (
        <Alert variant="success">
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle>Done</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {metrics && (!metrics.secrets.groqConfigured || !metrics.secrets.enrichConfigured) ? (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Configuration incomplete</AlertTitle>
          {/*
            One short sentence per problem rather than a single run-on line.

            The previous wording embedded `ENRICH_PROVIDER/ENRICH_API_KEY` as one
            31-character unbroken token, which cannot wrap, so on a narrow phone it
            overflowed the alert's padding and ran into the border. Naming each
            variable on its own keeps every token short enough to wrap, and reads far
            better on a phone than one long sentence.
          */}
          <AlertDescription className="space-y-1.5">
            {metrics.secrets.groqConfigured ? null : (
              <p>
                <code>GROQ_API_KEY</code> is missing, so classification is disabled.
              </p>
            )}
            {metrics.secrets.enrichConfigured ? null : (
              <p>No enrichment provider is configured, so suppliers are stored without web enrichment.</p>
            )}
            <p className="text-xs opacity-80">
              Set these in your Vercel or Render environment variables, or in <code>.env.local</code> for local
              development.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          icon={<Coins className="h-4 w-4" />}
          label="Total spend"
          value={summary ? formatCurrency(summary.totalSpend, summary.currency) : '—'}
          caption={summary ? `${formatNumber(summary.totalSuppliers)} suppliers` : ''}
          loading={loading && !summary}
        />
        <KpiCard
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Classified"
          value={summary ? formatPercent(summary.percentClassified) : '—'}
          caption={summary ? `${formatNumber(summary.classified)} of ${formatNumber(summary.totalSuppliers)} suppliers` : ''}
          loading={loading && !summary}
        />
        <KpiCard
          icon={<AlertTriangle className="h-4 w-4" />}
          label="Low confidence"
          value={summary ? formatPercent(summary.percentLowConfidence) : '—'}
          caption={summary ? `${formatNumber(summary.lowConfidence)} awaiting review` : ''}
          loading={loading && !summary}
          tone="warn"
        />
        <KpiCard
          icon={<Building2 className="h-4 w-4" />}
          label="Corporate families"
          value={summary ? formatNumber(summary.parents) : '—'}
          caption={summary ? `${formatNumber(summary.subsidiaries)} subsidiaries · ${formatNumber(summary.inherited)} inherited codes` : ''}
          loading={loading && !summary}
        />
      </div>

      <FilterBar
        state={filters}
        onChange={(next) => {
          setFilters(next);
          setPage(1);
        }}
        segments={meta.segments}
        parents={meta.parents}
        right={
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <Percent className="h-3.5 w-3.5" />
            {metrics?.usage
              ? `Groq today: ${formatNumber(metrics.usage.models.reduce((sum, model) => sum + model.requestCount, 0))} request(s)`
              : 'Groq usage unavailable'}
            {metrics?.lastSync ? ` · last sync ${formatRelative(metrics.lastSync.at)}` : ''}
          </span>
        }
      />

      <div className="grid min-w-0 gap-4 lg:grid-cols-5">
        <Card className="min-w-0 lg:col-span-3">
          <CardHeader>
            <CardTitle>Spend by UNSPSC segment</CardTitle>
            <CardDescription>Top 10 segments by spend for the current filter selection.</CardDescription>
          </CardHeader>
          {/* Taller on mobile: vertical bars need room when the labels are long. */}
          <CardContent className="h-[300px] min-w-0 overflow-hidden sm:h-[340px] lg:h-[320px]">
            {loading && !chartData.length ? (
              <Skeleton className="h-full w-full" />
            ) : chartData.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  layout="vertical"
                  /* The category axis is much narrower on a phone, so the bars
                     keep a usable length by reclaiming label space. */
                  margin={{ left: 0, right: 16, top: 4, bottom: 4 }}
                >
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke={chartColors.grid} />
                  <XAxis
                    type="number"
                    tickFormatter={(value: number) => formatCurrencyCompact(value)}
                    fontSize={11}
                    stroke={chartColors.grid}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={yAxisWidth}
                    fontSize={yAxisFontSize}
                    stroke={chartColors.grid}
                  />
                  <RechartsTooltip
                    formatter={(value: number) => formatCurrency(value)}
                    // The axis shortens the segment name to fit; the tooltip shows it
                    // in full, so truncation costs nothing.
                    labelFormatter={(label: string, payload: Array<{ payload?: { fullName?: string } }>) =>
                      payload?.[0]?.payload?.fullName ?? label
                    }
                    labelStyle={{ fontSize: 12, color: 'hsl(var(--foreground))' }}
                    contentStyle={{
                      fontSize: 12,
                      borderRadius: 8,
                      background: 'hsl(var(--popover))',
                      border: '1px solid hsl(var(--border))',
                      color: 'hsl(var(--popover-foreground))',
                    }}
                  />
                  {/*
                    Fully rounded bar caps. Recharts clamps each corner radius to
                    half the bar thickness, so a radius of 6 produces a stadium
                    (pill) shape on the ~14px bars while also rounding the baseline
                    end — matching the rounded language of the rest of the UI.
                  */}
                  <Bar dataKey="spend" radius={[6, 6, 6, 6]}>
                    {chartData.map((entry, index) => (
                      <Cell
                        key={entry.name}
                        fill={chartColors.series[index % chartColors.series.length]}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
                No segment data yet — upload a supplier CSV to get started.
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0 lg:col-span-2">
          <CardHeader>
            <CardTitle>Top parent companies</CardTitle>
            <CardDescription>Rolled-up spend across each corporate family.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Parent</TableHead>
                  <TableHead className="text-right">Subs.</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(metrics?.topParents ?? []).slice(0, 8).map((parent) => (
                  <TableRow key={parent.clusterKey}>
                    <TableCell className="max-w-[220px]">
                      <span className="font-medium">{truncate(parent.parentName, 32)}</span>
                      <span className="block text-xs text-muted-foreground">
                        {parent.unspscCode ?? 'unclassified'}
                        {parent.isVirtualRoot ? ' · virtual parent' : ''}
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-sm">{parent.subsidiaryCount}</TableCell>
                    <TableCell className="text-right text-sm font-medium">
                      {formatCurrency(parent.totalAmount)}
                    </TableCell>
                  </TableRow>
                ))}
                {!metrics?.topParents?.length ? (
                  <TableRow>
                    <TableCell colSpan={3} className="py-6 text-center text-sm text-muted-foreground">
                      No parent companies detected yet.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      {(metrics?.reviewQueueSize ?? 0) > 0 ? (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{metrics?.reviewQueueSize} supplier(s) need a human decision</AlertTitle>
          <AlertDescription>
            Low-confidence classifications and uncertain parent links.{' '}
            <Link href="/review" className="font-medium underline">
              Open the review queue
            </Link>
            .
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="flex-col items-start gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>
              {filters.rollup === 'parent' ? 'Parent roll-up' : 'Suppliers'} ({formatNumber(total)})
            </CardTitle>
            <CardDescription>
              {selected.length ? `${selected.length} selected · ` : ''}
              {filters.rollup === 'parent'
                ? 'Spend and classification aggregated per parent company.'
                : 'Current classification per supplier, with inheritance and review state.'}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {selected.length ? (
              <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
                Clear selection
              </Button>
            ) : null}
            <ExportDialog
              filters={{ ...apiFilters, rollup: 'parent' }}
              label="Roll-up CSV"
              defaultFormat="csv"
              suggestedName="Parent roll-up"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {filters.rollup === 'parent' ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Parent company</TableHead>
                  <TableHead>UNSPSC</TableHead>
                  <TableHead className="text-right">Suppliers</TableHead>
                  <TableHead className="text-right">Subsidiaries</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="text-right">Confidence</TableHead>
                  <TableHead className="text-right">Low conf.</TableHead>
                  <TableHead className="text-right">Stale</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rollup.map((parent) => (
                  <TableRow key={parent.clusterKey}>
                    <TableCell className="font-medium">
                      {parent.parentName}
                      {parent.isVirtualRoot ? (
                        <Badge variant="outline" className="ml-2">
                          external
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{parent.unspscCode ?? '—'}</TableCell>
                    <TableCell className="text-right">{parent.supplierCount}</TableCell>
                    <TableCell className="text-right">{parent.subsidiaryCount}</TableCell>
                    <TableCell className="text-right font-medium">{formatCurrency(parent.totalAmount)}</TableCell>
                    <TableCell className="text-right">
                      <ConfidenceBadge confidence={parent.confidence} threshold={metrics?.threshold ?? 0.7} />
                    </TableCell>
                    <TableCell className="text-right">{parent.lowConfidenceCount}</TableCell>
                    <TableCell className="text-right">{parent.staleCount}</TableCell>
                  </TableRow>
                ))}
                {!rollup.length ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                      No parent companies match the filters.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">
                      {/* The label supplies a real 32x32 hit area around the 16px box. */}
                      <label className="flex h-8 w-8 cursor-pointer items-center justify-center">
                        <input
                          type="checkbox"
                          aria-label="Select all rows"
                          className="h-4 w-4 rounded border-input"
                          checked={rows.length > 0 && selected.length === rows.length}
                          onChange={(event) => setSelected(event.target.checked ? rows.map((row) => row.id) : [])}
                        />
                      </label>
                    </TableHead>
                    <SortableHead label="Supplier" active={sort === 'name'} dir={dir} onClick={() => toggleSort('name')} />
                    <TableHead>UNSPSC</TableHead>
                    <TableHead>Commodity</TableHead>
                    <SortableHead
                      label="Confidence"
                      active={sort === 'confidence'}
                      dir={dir}
                      onClick={() => toggleSort('confidence')}
                      align="right"
                    />
                    <TableHead>Parent</TableHead>
                    <SortableHead label="Spend" active={sort === 'spend'} dir={dir} onClick={() => toggleSort('spend')} align="right" />
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading && !rows.length
                    ? Array.from({ length: 6 }).map((_, index) => (
                        <TableRow key={index}>
                          <TableCell colSpan={8}>
                            <Skeleton className="h-5 w-full" />
                          </TableCell>
                        </TableRow>
                      ))
                    : rows.map((row) => (
                        <TableRow key={row.id} data-state={selected.includes(row.id) ? 'selected' : undefined}>
                          <TableCell>
                            {/* Real 32x32 hit area around a 16px box. */}
                            <label className="flex h-8 w-8 cursor-pointer items-center justify-center">
                              <input
                                type="checkbox"
                                aria-label={`Select ${row.name}`}
                                className="h-4 w-4 rounded border-input"
                                checked={selected.includes(row.id)}
                                onChange={(event) =>
                                  setSelected((current) =>
                                    event.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id),
                                  )
                                }
                              />
                            </label>
                          </TableCell>
                          <TableCell className="max-w-[240px]">
                            <Link href={`/review?supplier=${row.id}`} className="font-medium hover:underline">
                              {row.name}
                            </Link>
                            <span className="block text-xs text-muted-foreground">
                              {row.domain ?? 'no domain'} · {truncate(row.industry ?? 'no industry', 40)}
                            </span>
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {row.classification?.effectiveCode ?? '—'}
                            {row.classification?.correctedCode ? (
                              <Badge variant="info" className="ml-1">
                                corrected
                              </Badge>
                            ) : null}
                          </TableCell>
                          <TableCell className="max-w-[200px] text-xs">{truncate(row.classification?.commodity ?? '—', 38)}</TableCell>
                          <TableCell className="text-right">
                            <ConfidenceBadge
                              confidence={row.classification?.confidence ?? null}
                              threshold={metrics?.threshold ?? 0.7}
                              inherited={row.classification?.inheritedFromParent}
                              reviewed={row.classification?.reviewed}
                            />
                          </TableCell>
                          <TableCell className="max-w-[180px] text-xs">
                            {row.parentName ?? (row.parentId ? `#${row.parentId}` : '—')}
                            {row.parentSource ? (
                              <span className="block text-[11px] text-muted-foreground">via {row.parentSource}</span>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-right font-medium">{formatCurrency(row.totalAmount, row.currency)}</TableCell>
                          <TableCell>
                            <span className="flex flex-wrap items-center gap-1">
                              <StaleBadge stale={row.stale} reason={row.staleReason} ageDays={row.enrichedAtAgeDays} />
                              {row.subsidiaryCount > 0 ? (
                                <Badge variant="secondary" title={`${row.subsidiaryCount} subsidiaries`}>
                                  {row.subsidiaryCount} subs
                                </Badge>
                              ) : null}
                              {!row.enrichedAt ? <Badge variant="muted">not enriched</Badge> : null}
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                  {!loading && !rows.length ? (
                    <TableRow>
                      <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                        No suppliers match the current filters.{' '}
                        <Link href="/upload" className="font-medium underline">
                          Upload a CSV
                        </Link>{' '}
                        to get started.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>

              <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
                <span className="text-muted-foreground">
                  Page {page} of {pages} · {formatNumber(total)} suppliers
                </span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
                    Previous
                  </Button>
                  <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {metrics?.lastSync ? (
        <Card>
          <CardHeader>
            <CardTitle>Last sync run</CardTitle>
            <CardDescription>{formatDateTime(metrics.lastSync.at)} (worker)</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            {Object.entries(metrics.lastSync.summary)
              .filter(([key]) => ['candidatesFound', 'enriched', 'classified', 'inherited', 'staleMarked', 'llmRequests', 'batches', 'stoppedReason'].includes(key))
              .map(([key, value]) => (
                <div key={key} className="rounded-md border bg-muted/30 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{key}</p>
                  <p className="font-medium">{String(value)}</p>
                </div>
              ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function KpiCard({
  icon,
  label,
  value,
  caption,
  loading,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  caption?: string;
  loading?: boolean;
  tone?: 'warn';
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="flex items-center gap-2">
          <span className={tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-primary'}>{icon}</span>
          {label}
        </CardDescription>
        <CardTitle className="text-2xl">
          {loading ? <Skeleton className="h-7 w-24" /> : value}
        </CardTitle>
      </CardHeader>
      {caption ? <CardContent className="pt-0 text-xs text-muted-foreground">{caption}</CardContent> : null}
    </Card>
  );
}

function SortableHead({
  label,
  active,
  dir,
  onClick,
  align = 'left',
}: {
  label: string;
  active: boolean;
  dir: 'asc' | 'desc';
  onClick: () => void;
  align?: 'left' | 'right';
}) {
  return (
    <TableHead className={align === 'right' ? 'text-right' : undefined}>
      {/* The button fills the header cell, so the whole cell is a tap target. */}
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'inline-flex h-full w-full items-center gap-1 hover:text-foreground',
          align === 'right' && 'justify-end',
        )}
      >
        {label}
        <ArrowUpDown className={active ? 'h-3 w-3 text-primary' : 'h-3 w-3 opacity-40'} />
        {active ? <span className="sr-only">{dir === 'asc' ? 'ascending' : 'descending'}</span> : null}
      </button>
    </TableHead>
  );
}
