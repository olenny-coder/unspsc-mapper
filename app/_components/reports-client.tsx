'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Database,
  Download,
  FileSpreadsheet,
  FileText,
  HardDriveDownload,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { api, exportUrl, type MetricsDto, type ReportListDto } from '@/lib/client';
import { formatBytes, formatCurrency, formatDateTime, formatNumber, formatPercent } from '@/lib/format';

export default function ReportsPage() {
  const [data, setData] = React.useState<ReportListDto | null>(null);
  const [metrics, setMetrics] = React.useState<MetricsDto | null>(null);
  const [budget, setBudget] = React.useState<Awaited<ReturnType<typeof api.reportBudget>> | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [workerSecret, setWorkerSecret] = React.useState('');
  const [reportName, setReportName] = React.useState('');
  const [format, setFormat] = React.useState<'csv' | 'pdf'>('pdf');
  const [rollup, setRollup] = React.useState(true);
  const [minConfidence, setMinConfidence] = React.useState('');

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [reports, budgetData, metricsData] = await Promise.all([
        api.reports({ pageSize: 50 }),
        api.reportBudget(),
        api.metrics({ usage: 'false' }),
      ]);
      setData(reports);
      setBudget(budgetData);
      setMetrics(metricsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const generate = async (store: boolean) => {
    setBusy(store ? 'store' : 'generate');
    setError(null);
    setNotice(null);
    try {
      const result = await api.generateReport({
        name: reportName || undefined,
        format,
        filters: {
          ...(rollup ? { rollup: 'parent' } : {}),
          ...(minConfidence ? { minConfidence: Number(minConfidence) } : {}),
        },
        store,
        generatedBy: 'dashboard',
        secret: store ? workerSecret : undefined,
      });
      setNotice(
        `${result.filename} generated with ${formatNumber(result.rows)} supplier row(s) (${formatBytes(result.bytes)})${
          result.storedId ? ` and stored as report #${result.storedId}` : ''
        }.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: number) => {
    if (!workerSecret) {
      setError('Enter the WORKER_SECRET above to delete stored reports.');
      return;
    }
    setBusy(`delete-${id}`);
    setNotice(null);
    try {
      await api.deleteReport(id, workerSecret);
      setNotice(`Report #${id} deleted and its Neon storage reclaimed.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const summary = metrics?.summary;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
          <p className="text-sm text-muted-foreground">
            Generate CSV or PDF reports on demand, and review the weekly PDFs produced by the Render worker.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            Reload
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={exportUrl('csv', { rollup: 'parent' })} download>
              <FileSpreadsheet className="h-4 w-4" />
              Quick CSV
            </a>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <a href={exportUrl('pdf', { rollup: 'parent' })} download>
              <FileText className="h-4 w-4" />
              Quick PDF
            </a>
          </Button>
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
          <AlertTitle>Report ready</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Generate a report</CardTitle>
            <CardDescription>
              The streamed endpoint is <code>GET /api/export?format=csv|pdf</code>; storing a copy also writes a row to
              the <code>reports</code> table in Neon.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="report-name">Report name</Label>
                <Input
                  id="report-name"
                  placeholder={`UNSPSC spend report ${new Date().toISOString().slice(0, 10)}`}
                  value={reportName}
                  onChange={(event) => setReportName(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="report-format">Format</Label>
                <div className="flex gap-2">
                  <Button
                    variant={format === 'pdf' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setFormat('pdf')}
                    className="flex-1"
                  >
                    <FileText className="h-4 w-4" />
                    PDF
                  </Button>
                  <Button
                    variant={format === 'csv' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setFormat('csv')}
                    className="flex-1"
                  >
                    <FileSpreadsheet className="h-4 w-4" />
                    CSV
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="report-min-confidence">Minimum confidence</Label>
                <Input
                  id="report-min-confidence"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  placeholder="no filter"
                  value={minConfidence}
                  onChange={(event) => setMinConfidence(event.target.value)}
                />
              </div>
              <div className="flex items-end gap-2">
                <input
                  id="report-rollup"
                  type="checkbox"
                  className="mb-2.5 h-4 w-4 rounded border-input"
                  checked={rollup}
                  onChange={(event) => setRollup(event.target.checked)}
                />
                <Label htmlFor="report-rollup" className="mb-1.5">
                  Roll up by parent company
                </Label>
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="worker-secret">WORKER_SECRET (required only to store or delete reports)</Label>
              <Input
                id="worker-secret"
                type="password"
                placeholder="Bearer secret from your environment"
                value={workerSecret}
                onChange={(event) => setWorkerSecret(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Stored blobs live in Neon, so writing and deleting them is a privileged operation. Downloads never
                require the secret.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <a href={exportUrl(format, { ...(rollup ? { rollup: 'parent' } : {}), ...(minConfidence ? { minConfidence: Number(minConfidence) } : {}) }, { name: reportName || undefined })} download>
                  <Download className="h-4 w-4" />
                  Download {format.toUpperCase()}
                </a>
              </Button>
              <Button variant="outline" onClick={() => void generate(false)} disabled={busy !== null}>
                {busy === 'generate' ? <Loader2 className="h-4 w-4 animate-spin" /> : <HardDriveDownload className="h-4 w-4" />}
                Generate and log (no store)
              </Button>
              <Button variant="outline" onClick={() => void generate(true)} disabled={busy !== null || !workerSecret}>
                {busy === 'store' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
                Generate and store in Neon
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Current dataset</CardTitle>
            <CardDescription>What any report generated right now would contain.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {summary ? (
              <>
                <Row label="Suppliers" value={formatNumber(summary.totalSuppliers)} />
                <Row label="Total spend" value={formatCurrency(summary.totalSpend, summary.currency)} />
                <Row label="Classified" value={formatPercent(summary.percentClassified)} />
                <Row label="Low confidence" value={formatPercent(summary.percentLowConfidence)} />
                <Row label="Parents / subsidiaries" value={`${summary.parents} / ${summary.subsidiaries}`} />
                <Row label="Inherited codes" value={formatNumber(summary.inherited)} />
                <Row label="Stale" value={formatNumber(summary.stale)} />
                <Row
                  label="Stored reports"
                  value={budget ? `${budget.reportCount} (${formatBytes(budget.storedBytes)})` : '—'}
                />
                {budget ? (
                  <p className="pt-2 text-xs text-muted-foreground">
                    {formatPercent(budget.shareOfNeonFreeTier * 100, 2)} of the 0.5 GB Neon free tier is used by stored
                    reports. Anything over {formatBytes(budget.maxStoredReportBytes)} is refused.
                  </p>
                ) : null}
              </>
            ) : (
              <Skeleton className="h-32 w-full" />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Stored reports</CardTitle>
          <CardDescription>
            The worker generates a weekly PDF every Monday at 06:00 (configurable via <code>CRON_REPORT</code>) while it
            is awake.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Format</TableHead>
                <TableHead className="text-right">Rows</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead>Generated by</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && !data
                ? Array.from({ length: 4 }).map((_, index) => (
                    <TableRow key={index}>
                      <TableCell colSpan={8}>
                        <Skeleton className="h-5 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                : (data?.reports ?? []).map((report) => (
                    <TableRow key={report.id}>
                      <TableCell className="font-medium">{report.name}</TableCell>
                      <TableCell>
                        <Badge variant={report.format === 'pdf' ? 'info' : 'secondary'}>{report.format.toUpperCase()}</Badge>
                      </TableCell>
                      <TableCell className="text-right">{formatNumber(report.rowCount)}</TableCell>
                      <TableCell className="text-right">{formatBytes(report.sizeBytes)}</TableCell>
                      <TableCell className="text-xs">{report.generatedBy}</TableCell>
                      <TableCell className="text-xs">{formatDateTime(report.createdAt)}</TableCell>
                      <TableCell className="text-xs">
                        {typeof report.filters?.schedule === 'string' ? (
                          <span className="inline-flex items-center gap-1">
                            <CalendarClock className="h-3.5 w-3.5" />
                            {report.filters.schedule}
                          </span>
                        ) : (
                          'manual'
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button variant="outline" size="sm" asChild>
                            <a href={`/api/reports/${report.id}/download`} download>
                              <Download className="h-3.5 w-3.5" />
                              Download
                            </a>
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => void remove(report.id)}
                            disabled={busy === `delete-${report.id}`}
                            aria-label={`Delete report ${report.id}`}
                          >
                            {busy === `delete-${report.id}` ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
              {!loading && !data?.reports.length ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                    No stored reports yet. Generate one above, or let the worker&apos;s weekly job create the first one.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Report contents</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="rounded-lg border p-3">
            <p className="font-medium">PDF</p>
            <ul className="mt-1 list-disc pl-4 text-muted-foreground">
              <li>Title page: name, date range, generated by, active filters</li>
              <li>Summary: totals, % classified, % low-confidence, top 10 parents by spend</li>
              <li>UNSPSC segment breakdown as a table and a bar chart</li>
              <li>Parent/subsidiary hierarchy table</li>
              <li>Low-confidence review appendix</li>
            </ul>
          </div>
          <div className="rounded-lg border p-3">
            <p className="font-medium">CSV</p>
            <ul className="mt-1 list-disc pl-4 text-muted-foreground">
              <li>Metadata preamble with the exact filters used</li>
              <li>One row per supplier: code, segment, confidence, parent, spend, stale flag</li>
              <li>Segment breakdown section</li>
              <li>Parent roll-up section when roll-up is enabled</li>
              <li>Low-confidence appendix</li>
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              Additional variants: <code>format=rollup</code> and <code>format=hierarchy</code>. See the{' '}
              <Link href="/api/health" className="underline">
                health endpoint
              </Link>{' '}
              for budget status.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b pb-1 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
