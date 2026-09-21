'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Loader2, UploadCloud, X } from 'lucide-react';
import { useDemoMode } from '@/components/demo-mode';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { api, type UploadResultDto } from '@/lib/client';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

export default function UploadPage() {
  const { demo } = useDemoMode();
  const [dragging, setDragging] = React.useState(false);
  const [file, setFile] = React.useState<File | null>(null);
  const [enrich, setEnrich] = React.useState(true);
  const [classify, setClassify] = React.useState(true);
  const [uploading, setUploading] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [result, setResult] = React.useState<UploadResultDto | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const selectFile = (next: File | null) => {
    setResult(null);
    setError(null);
    setProgress(0);
    if (!next) {
      setFile(null);
      return;
    }
    if (!/\.csv$/i.test(next.name) && next.type !== 'text/csv') {
      setError('Please choose a .csv file. Excel workbooks must be exported to CSV first.');
      setFile(null);
      return;
    }
    if (next.size > 25 * 1024 * 1024) {
      setError(`That file is ${(next.size / 1024 / 1024).toFixed(1)} MB; the limit is 25 MB.`);
      setFile(null);
      return;
    }
    setFile(next);
  };

  const upload = async () => {
    if (!file) return;
    setUploading(true);
    setError(null);
    setProgress(10);
    // The request is a single POST, so the bar advances on a timer to show
    // liveness rather than claiming exact server-side progress.
    const ticker = setInterval(() => setProgress((value) => Math.min(90, value + 7)), 400);
    try {
      const data = await api.upload(file, { enrich, classify, actor: 'dashboard' });
      setResult(data);
      setProgress(100);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress(0);
    } finally {
      clearInterval(ticker);
      setUploading(false);
    }
  };

  const downloadTemplate = async () => {
    try {
      const data = await api.uploadTemplate();
      const blob = new Blob([data.template], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'supplier-upload-template.csv';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Upload suppliers</h1>
        <p className="text-sm text-muted-foreground">
          Drop a CSV of suppliers (and optional spend). Rows are deduplicated on the supplier name — legal suffixes such
          as Inc/LLC/Ltd are folded, so <code>ACME CO., LTD</code> and <code>Acme</code> become one supplier.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>CSV file</CardTitle>
            <CardDescription>Maximum 25 MB / 100,000 rows per upload.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                selectFile(event.dataTransfer.files?.[0] ?? null);
              }}
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-12 text-center transition-colors',
                dragging ? 'border-primary bg-primary/5' : 'border-input hover:border-primary/50 hover:bg-muted/40',
              )}
            >
              <UploadCloud className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm font-medium">Drag and drop a CSV here, or click to browse</p>
              <p className="text-xs text-muted-foreground">
                Required column: supplier name (name / supplier / vendor). Optional: amount, date, domain, industry,
                naics, parent.
              </p>
              <input
                ref={inputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                disabled={demo}
                onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
              />
            </div>

            {file ? (
              <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-4 py-3">
                <div className="flex items-center gap-3">
                  <FileSpreadsheet className="h-5 w-5 text-primary" />
                  <div>
                    <p className="text-sm font-medium">{file.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {(file.size / 1024).toFixed(1)} KB · {file.type || 'text/csv'}
                    </p>
                  </div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => selectFile(null)} aria-label="Remove file">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-6">
              <div className="flex items-center gap-2">
                <Checkbox id="opt-enrich" checked={enrich} onCheckedChange={(value) => setEnrich(value === true)} />
                <Label htmlFor="opt-enrich">Enrich via web API</Label>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox id="opt-classify" checked={classify} onCheckedChange={(value) => setClassify(value === true)} />
                <Label htmlFor="opt-classify">Classify with Groq</Label>
              </div>
            </div>

            {uploading ? <Progress value={progress} /> : null}

            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => void upload()}
                disabled={!file || uploading || demo}
                title={demo ? 'Unavailable in the read-only demo — sign in to make changes' : undefined}
              >
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                Upload and process
              </Button>
              <Button variant="outline" onClick={() => void downloadTemplate()}>
                <Download className="h-4 w-4" />
                Download template
              </Button>
              <Button variant="ghost" asChild>
                <Link href="/">Back to dashboard</Link>
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>How the pipeline works</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <Step number={1} title="Upsert">
              Rows are merged on the normalised supplier name. Amounts from repeated rows in the same file are summed.
            </Step>
            <Step number={2} title="Enrich">
              Cache first (free), then the configured provider for domain, industry, NAICS, SIC and parent company.
            </Step>
            <Step number={3} title="Link parents">
              A parent company row is created when needed so subsidiaries can point at it.
            </Step>
            <Step number={4} title="Classify">
              Parents are classified first; subsidiaries inherit the code with{' '}
              <code>inherited_from_parent = true</code>.
            </Step>
          </CardContent>
        </Card>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Upload failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {result ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              Upload complete
            </CardTitle>
            <CardDescription>
              {result.file.name} · {result.file.bytes.toLocaleString()} bytes · delimiter “{result.file.delimiter}”
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {result.warnings.length ? (
              <Alert variant="warning">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Heads up</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc pl-4">
                    {result.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Rows in file" value={formatNumber(result.upsert.rowsInFile)} />
              <Metric label="Created" value={formatNumber(result.upsert.created)} tone="good" />
              <Metric label="Updated" value={formatNumber(result.upsert.updated)} />
              <Metric label="Unchanged" value={formatNumber(result.upsert.unchanged)} />
              <Metric label="Duplicates folded" value={formatNumber(result.upsert.duplicateRowsInFile)} />
              <Metric label="Enriched" value={formatNumber(result.enrichment?.enriched ?? 0)} />
              <Metric label="From cache" value={formatNumber(result.enrichment?.cached ?? 0)} />
              <Metric label="Enrichment failures" value={formatNumber(result.enrichment?.failed ?? 0)} tone={(result.enrichment?.failed ?? 0) > 0 ? 'warn' : undefined} />
              <Metric label="Parent links" value={formatNumber(result.parentLinks?.linked ?? 0)} />
              <Metric label="Classified" value={formatNumber(result.classification?.classified ?? 0)} tone="good" />
              <Metric label="Inherited from parent" value={formatNumber(result.classification?.inherited ?? 0)} />
              <Metric label="Low confidence" value={formatNumber(result.classification?.lowConfidence ?? 0)} tone={(result.classification?.lowConfidence ?? 0) > 0 ? 'warn' : undefined} />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link href="/">View dashboard</Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link href="/review">Open review queue</Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link href="/hierarchy">Check hierarchy</Link>
              </Button>
            </div>

            {result.rowErrors.length ? (
              <div>
                <p className="mb-2 text-sm font-medium">Row warnings ({result.rowErrors.length})</p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-20">Row</TableHead>
                      <TableHead>Message</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.rowErrors.slice(0, 25).map((rowError) => (
                      <TableRow key={`${rowError.row}-${rowError.message}`}>
                        <TableCell className="font-mono text-xs">{rowError.row}</TableCell>
                        <TableCell className="text-sm">{rowError.message}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}

            {result.columns.length ? (
              <div>
                <p className="mb-2 text-sm font-medium">Detected columns</p>
                <div className="flex flex-wrap gap-1">
                  {result.columns.map((column) => (
                    <Badge key={column} variant="muted">
                      {column}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
        {number}
      </span>
      <span>
        <span className="font-medium text-foreground">{title}. </span>
        {children}
      </span>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          'text-lg font-semibold',
          tone === 'good' && 'text-emerald-700 dark:text-emerald-400',
          tone === 'warn' && 'text-amber-700 dark:text-amber-400',
        )}
      >
        {value}
      </p>
    </div>
  );
}
