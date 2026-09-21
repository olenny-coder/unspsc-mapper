'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';import {
  AlertTriangle,
  CheckCircle2,
  History,
  Loader2,
  RefreshCw,
  Save,
  Search,
  Undo2,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfidenceBadge } from '@/components/confidence-badge';
import { useDemoMode } from '@/components/demo-mode';
import { ExportDialog } from '@/components/export-dialog';
import { api, type ReviewRowDto, type SupplierRowDto } from '@/lib/client';
import { formatCurrency, formatDateTime, formatNumber, formatRelative } from '@/lib/format';

export default function ReviewPage() {
  return (
    <React.Suspense fallback={<ReviewPageSkeleton />}>
      <ReviewPageInner />
    </React.Suspense>
  );
}

function ReviewPageSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function ReviewPageInner() {
  const { demo } = useDemoMode();
  const searchParams = useSearchParams();
  const initialSupplier = searchParams.get('supplier');

  const [rows, setRows] = React.useState<ReviewRowDto[]>([]);
  const [threshold, setThreshold] = React.useState(0.7);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [selected, setSelected] = React.useState<number | null>(initialSupplier ? Number(initialSupplier) : null);
  const [detail, setDetail] = React.useState<Awaited<ReturnType<typeof api.supplier>> | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  // Correction form
  const [code, setCode] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [applyToSubsidiaries, setApplyToSubsidiaries] = React.useState(true);
  const [suggestions, setSuggestions] = React.useState<
    Array<{ code: string; commodity: string; segment: string | null; className: string | null }>
  >([]);
  const [searching, setSearching] = React.useState(false);

  const loadQueue = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.reviewQueue();
      setRows(data.rows);
      setThreshold(data.threshold);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  const loadDetail = React.useCallback(async (supplierId: number) => {
    setDetailLoading(true);
    try {
      const data = await api.supplier(supplierId);
      setDetail(data);
      setCode(data.supplier.classification?.effectiveCode ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (selected !== null) void loadDetail(selected);
  }, [selected, loadDetail]);

  // Debounced taxonomy search for the correction form.
  React.useEffect(() => {
    if (code.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    const handle = setTimeout(() => {
      setSearching(true);
      api
        .searchCodes(code.trim(), 12)
        .then((data) => setSuggestions(data.results))
        .catch(() => setSuggestions([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(handle);
  }, [code]);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter(
      (row) =>
        row.name.toLowerCase().includes(term) ||
        (row.parentName ?? '').toLowerCase().includes(term) ||
        (row.code ?? '').includes(term),
    );
  }, [rows, search]);

  const saveCorrection = async (supplierId: number, supplierName: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.correctClassification(supplierId, {
        unspscCode: code.trim(),
        correctedBy: 'dashboard',
        reason: reason.trim() || undefined,
        applyToSubsidiaries,
      });
      setNotice(
        `Saved ${result.correctedCode} for ${supplierName}${
          result.appliedToSubsidiaries ? ` and propagated it to ${result.affectedSupplierIds.length - 1} subsidiary(ies)` : ''
        }. The correction is now a few-shot example for future classifications.`,
      );
      setReason('');
      await Promise.all([loadQueue(), loadDetail(supplierId)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const clearCorrection = async (supplierId: number) => {
    setBusy(true);
    setNotice(null);
    try {
      await api.clearCorrection(supplierId);
      setNotice('Correction cleared; the supplier is back in the review queue.');
      await Promise.all([loadQueue(), loadDetail(supplierId)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const refreshSelected = async (supplierId: number) => {
    setBusy(true);
    setNotice(null);
    try {
      await api.enrich({ supplierIds: [supplierId], force: true, detectParent: true, actor: 'dashboard' });
      setNotice('Re-enriched. Run classification again to apply the refreshed data.');
      await Promise.all([loadQueue(), loadDetail(supplierId)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const bulkReclassify = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.classify({ force: true, actor: 'dashboard', limit: 100 });
      setNotice(`Reclassified ${result.classified} supplier(s); ${result.lowConfidence} still below the threshold.`);
      await loadQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const detailSupplier: SupplierRowDto | null = detail?.supplier ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Review queue</h1>
          <p className="text-sm text-muted-foreground">
            {formatNumber(rows.length)} supplier(s) with confidence below {threshold.toFixed(2)}, missing
            classifications, or uncertain parent links. Corrections feed the few-shot prompt.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void loadQueue()} disabled={loading}>
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            Reload
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void bulkReclassify()}
            disabled={busy || demo}
            title={demo ? 'Unavailable in the read-only demo — sign in to make changes' : undefined}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Reclassify next 100
          </Button>
          <ExportDialog filters={{ confidenceState: 'low' }} label="Export review CSV" defaultFormat="csv" suggestedName="Low confidence review" />
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert variant="success">
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle>Saved</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="flex-col items-start gap-3 space-y-0 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle>Decisions needed</CardTitle>
            <CardDescription>Click a row to inspect the reasoning and correct the code.</CardDescription>
          </div>
          <div className="w-full sm:w-[260px]">
            <Input placeholder="Filter…" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Supplier</TableHead>
                <TableHead>Current code</TableHead>
                <TableHead className="text-right">Confidence</TableHead>
                <TableHead className="text-right">Spend</TableHead>
                <TableHead>Parent</TableHead>
                <TableHead>Why it needs review</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && !filtered.length
                ? Array.from({ length: 5 }).map((_, index) => (
                    <TableRow key={index}>
                      <TableCell colSpan={6}>
                        <Skeleton className="h-5 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                : filtered.map((row) => (
                    <TableRow
                      key={row.supplierId}
                      className="cursor-pointer"
                      onClick={() => setSelected(row.supplierId)}
                      data-state={selected === row.supplierId ? 'selected' : undefined}
                    >
                      <TableCell className="font-medium">
                        {row.name}
                        <span className="block text-xs text-muted-foreground">{row.domain ?? row.industry ?? '—'}</span>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{row.code ?? '—'}</TableCell>
                      <TableCell className="text-right">
                        <ConfidenceBadge confidence={row.confidence} threshold={threshold} inherited={row.inheritedFromParent} />
                      </TableCell>
                      <TableCell className="text-right">{formatCurrency(row.totalAmount)}</TableCell>
                      <TableCell className="text-xs">{row.parentName ?? '—'}</TableCell>
                      <TableCell>
                        <span className="flex flex-wrap gap-1">
                          {row.reasons.map((reason) => (
                            <Badge key={reason} variant="warning">
                              {reason}
                            </Badge>
                          ))}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
              {!loading && !filtered.length ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                    Nothing to review — every classification is above the confidence threshold and reviewed.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={selected !== null} onOpenChange={(open) => (open ? undefined : setSelected(null))}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{detailSupplier?.name ?? 'Supplier detail'}</DialogTitle>
            <DialogDescription>
              {detailLoading
                ? 'Loading…'
                : detailSupplier
                  ? `${detailSupplier.domain ?? 'no domain'} · ${detailSupplier.industry ?? 'no industry'} · ${detailSupplier.naics ? `NAICS ${detailSupplier.naics}` : 'no NAICS'}`
                  : ''}
            </DialogDescription>
          </DialogHeader>

          {detailLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : detailSupplier ? (
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Spend" value={formatCurrency(detailSupplier.totalAmount, detailSupplier.currency)} />
                <Field label="Enriched" value={formatRelative(detailSupplier.enrichedAt)} />
                <Field
                  label="Hierarchy"
                  value={
                    detailSupplier.parentName
                      ? `Subsidiary of ${detailSupplier.parentName}`
                      : detailSupplier.subsidiaryCount
                        ? `Parent of ${detailSupplier.subsidiaryCount}`
                        : 'Independent'
                  }
                />
              </div>

              <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                <p className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <History className="h-3.5 w-3.5" /> Model reasoning
                </p>
                <p className="text-muted-foreground">
                  {detailSupplier.classification?.reasoning ?? 'No reasoning recorded (supplier is unclassified).'}
                </p>
                {detailSupplier.classification ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Model: {detailSupplier.classification.llmModel ?? 'n/a'} · confidence{' '}
                    {detailSupplier.classification.confidence.toFixed(2)}
                    {detailSupplier.classification.inheritedFromParent ? ' · inherited from parent' : ''}
                    {detailSupplier.classification.correctedCode ? ' · human-corrected' : ''}
                  </p>
                ) : null}
              </div>

              <div className="space-y-3 rounded-lg border p-4">
                <p className="text-sm font-medium">Correct the classification</p>
                <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                  <div className="space-y-1">
                    <Label htmlFor="correction-code">8-digit UNSPSC code</Label>
                    <Input
                      id="correction-code"
                      placeholder="e.g. 43211500"
                      value={code}
                      onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
                      className="font-mono"
                      inputMode="numeric"
                    />
                  </div>
                  <div className="flex items-end">
                    <Button
                      variant="outline"
                      onClick={() => void refreshSelected(detailSupplier.id)}
                      disabled={busy || demo}
                      title={
                        demo
                          ? 'Unavailable in the read-only demo — sign in to make changes'
                          : 'Re-enrich this supplier from the provider before correcting'
                      }
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                      Re-enrich
                    </Button>
                  </div>
                </div>

                {searching ? (
                  <p className="text-xs text-muted-foreground">
                    <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                    Searching the UNSPSC taxonomy…
                  </p>
                ) : null}

                {suggestions.length ? (
                  <div className="max-h-40 overflow-y-auto rounded-md border">
                    {suggestions.map((suggestion) => (
                      <button
                        key={suggestion.code}
                        type="button"
                        className="flex w-full items-start gap-3 border-b px-3 py-2 text-left text-xs last:border-0 hover:bg-muted"
                        onClick={() => setCode(suggestion.code)}
                      >
                        <span className="font-mono font-medium">{suggestion.code}</span>
                        <span className="text-muted-foreground">
                          {suggestion.commodity}
                          <span className="block">
                            {suggestion.segment ?? ''} {suggestion.className ? `› ${suggestion.className}` : ''}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}

                <div className="space-y-1">
                  <Label htmlFor="correction-reason">Reason (stored for the audit trail and few-shot examples)</Label>
                  <Textarea
                    id="correction-reason"
                    placeholder="e.g. They supply IT hardware, not consulting services."
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </div>

                <div className="flex items-center gap-2">
                  <Checkbox
                    id="propagate"
                    checked={applyToSubsidiaries}
                    onCheckedChange={(value) => setApplyToSubsidiaries(value === true)}
                  />
                  <Label htmlFor="propagate">
                    Propagate to subsidiaries
                    {detail?.descendantCount ? ` (${detail.descendantCount} descendant(s))` : ''}
                  </Label>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => void saveCorrection(detailSupplier.id, detailSupplier.name)}
                    disabled={code.length !== 8 || busy || demo}
                    title={demo ? 'Unavailable in the read-only demo — sign in to make changes' : undefined}
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Save correction
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void clearCorrection(detailSupplier.id)}
                    disabled={busy || demo}
                    title={demo ? 'Unavailable in the read-only demo — sign in to make changes' : undefined}
                  >
                    <Undo2 className="h-4 w-4" />
                    Clear correction
                  </Button>
                </div>
              </div>

              {detail?.subsidiaries.length ? (
                <div>
                  <p className="mb-2 text-sm font-medium">Subsidiaries ({detail.subsidiaries.length})</p>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Domain</TableHead>
                        <TableHead className="text-right">Spend</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.subsidiaries.map((subsidiary) => (
                        <TableRow key={subsidiary.id}>
                          <TableCell>
                            <button type="button" className="hover:underline" onClick={() => setSelected(subsidiary.id)}>
                              {subsidiary.name}
                            </button>
                          </TableCell>
                          <TableCell className="text-xs">{subsidiary.domain ?? '—'}</TableCell>
                          <TableCell className="text-right">{formatCurrency(subsidiary.totalAmount)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : null}

              {detail?.history.length ? (
                <div>
                  <p className="mb-2 text-sm font-medium">Classification history</p>
                  <div className="space-y-1 text-xs">
                    {detail.history.slice(0, 8).map((entry) => (
                      <div key={entry.id} className="flex flex-wrap items-center gap-2 rounded border px-3 py-2">
                        <span className="font-mono font-medium">{entry.code}</span>
                        <Badge variant={entry.superseded ? 'muted' : 'success'}>
                          {entry.superseded ? 'superseded' : 'current'}
                        </Badge>
                        {entry.reviewed ? <Badge variant="outline">reviewed</Badge> : null}
                        {entry.inherited ? <Badge variant="secondary">inherited</Badge> : null}
                        <span className="text-muted-foreground">
                          {entry.confidence.toFixed(2)} · {entry.llmModel ?? 'human'} · {formatDateTime(entry.createdAt)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setSelected(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}
