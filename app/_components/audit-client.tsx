'use client';

import * as React from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, RefreshCw, ScrollText } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { api, type AuditPageDto } from '@/lib/client';
import { formatDateTime, formatNumber } from '@/lib/format';

const ENTITIES = ['supplier', 'classification', 'correction', 'report', 'settings', 'sync'] as const;
const ACTIONS = [
  'created',
  'updated',
  'enriched',
  'enrich_failed',
  'classified',
  'inherited',
  'corrected',
  'propagated',
  'linked',
  'unlinked',
  'synced',
  'stale_marked',
  'report_generated',
  'settings_updated',
] as const;

export default function AuditPage() {
  const [data, setData] = React.useState<AuditPageDto | null>(null);
  const [summary, setSummary] = React.useState<Awaited<ReturnType<typeof api.auditSummary>> | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [page, setPage] = React.useState(1);
  const [entity, setEntity] = React.useState('all');
  const [action, setAction] = React.useState('all');
  const [actor, setActor] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [entries, sum] = await Promise.all([
        api.audit({
          page,
          pageSize: 50,
          entity: entity === 'all' ? undefined : entity,
          action: action === 'all' ? undefined : action,
          actor: actor || undefined,
          search: search || undefined,
          from: from || undefined,
          to: to || undefined,
        }),
        api.auditSummary(),
      ]);
      setData(entries);
      setSummary(sum);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [page, entity, action, actor, search, from, to]);

  React.useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
          <p className="text-sm text-muted-foreground">
            Every enrichment, classification, correction, sync and report event, with the actor and the details needed to
            reconstruct it.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Reload
        </Button>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Could not load the audit log</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-4">
        <Card className="lg:col-span-3">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Filters</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <div className="space-y-1">
              <Label>Entity</Label>
              <Select
                value={entity}
                onValueChange={(value) => {
                  setEntity(value);
                  setPage(1);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {ENTITIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Action</Label>
              <Select
                value={action}
                onValueChange={(value) => {
                  setAction(value);
                  setPage(1);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {ACTIONS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-actor">Actor</Label>
              <Input id="audit-actor" placeholder="system, worker, email…" value={actor} onChange={(event) => setActor(event.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-search">Details contain</Label>
              <Input id="audit-search" placeholder="code, supplier…" value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-from">From</Label>
              <Input id="audit-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-to">To</Label>
              <Input id="audit-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Activity by action</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            {(summary?.byAction ?? []).slice(0, 6).map((entry) => (
              <div key={entry.action} className="flex items-center justify-between">
                <span className="text-muted-foreground">{entry.action}</span>
                <span className="font-medium">{formatNumber(entry.count)}</span>
              </div>
            ))}
            {!summary?.byAction.length ? <p className="text-muted-foreground">No activity recorded yet.</p> : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ScrollText className="h-4 w-4" />
            Entries ({formatNumber(data?.total ?? 0)})
          </CardTitle>
          <CardDescription>
            Page {data?.page ?? 1} of {data?.pages ?? 1}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[170px]">When</TableHead>
                <TableHead className="w-[120px]">Entity</TableHead>
                <TableHead className="w-[140px]">Action</TableHead>
                <TableHead className="w-[130px]">Actor</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && !data
                ? Array.from({ length: 8 }).map((_, index) => (
                    <TableRow key={index}>
                      <TableCell colSpan={5}>
                        <Skeleton className="h-5 w-full" />
                      </TableCell>
                    </TableRow>
                  ))
                : (data?.entries ?? []).map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDateTime(entry.createdAt)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="muted">{entry.entity}</Badge>
                        {entry.entityId !== null ? (
                          <span className="ml-1 text-xs text-muted-foreground">#{entry.entityId}</span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            entry.action === 'corrected' || entry.action === 'propagated'
                              ? 'info'
                              : entry.action === 'enrich_failed' || entry.action === 'stale_marked'
                                ? 'warning'
                                : 'secondary'
                          }
                        >
                          {entry.action}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">{entry.actor}</TableCell>
                      <TableCell className="max-w-[520px]">
                        <code className="block break-words font-mono text-[11px] text-muted-foreground">
                          {entry.details ? JSON.stringify(entry.details) : '—'}
                        </code>
                      </TableCell>
                    </TableRow>
                  ))}
              {!loading && !data?.entries.length ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                    No audit entries match the filters.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>

          <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
            <span className="text-muted-foreground">
              {formatNumber(data?.total ?? 0)} entries · page size {data?.pageSize ?? 50}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={(data?.page ?? 1) <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
                <ChevronLeft className="h-4 w-4" />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={(data?.page ?? 1) >= (data?.pages ?? 1)}
                onClick={() => setPage((value) => value + 1)}
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {summary?.recent.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Latest events</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 text-xs">
            {summary.recent.map((entry) => (
              <div key={entry.id} className="flex flex-wrap items-center gap-2 rounded border px-3 py-2">
                <Badge variant="muted">{entry.entity}</Badge>
                <Badge variant="secondary">{entry.action}</Badge>
                <span className="text-muted-foreground">{entry.actor}</span>
                <span className="text-muted-foreground">{formatDateTime(entry.createdAt)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
