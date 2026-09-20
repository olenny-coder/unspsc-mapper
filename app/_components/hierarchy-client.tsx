'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Building2,
  ChevronDown,
  ChevronRight,
  Link2,
  Link2Off,
  Loader2,
  RefreshCw,
  Users,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ExportDialog } from '@/components/export-dialog';
import { api, type HierarchyClusterDto, type SupplierRowDto } from '@/lib/client';
import { formatCurrency, formatNumber } from '@/lib/format';

export default function HierarchyPage() {
  const [clusters, setClusters] = React.useState<HierarchyClusterDto[]>([]);
  const [totals, setTotals] = React.useState({ clusters: 0, parents: 0, suppliers: 0, orphans: 0 });
  const [orphans, setOrphans] = React.useState<Array<{ id: number; name: string; parentName: string | null }>>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({});
  const [search, setSearch] = React.useState('');
  const [allSuppliers, setAllSuppliers] = React.useState<SupplierRowDto[]>([]);

  const [linkTarget, setLinkTarget] = React.useState<{ id: number; name: string } | null>(null);
  const [parentMode, setParentMode] = React.useState<'existing' | 'new'>('existing');
  const [parentId, setParentId] = React.useState<string>('');
  const [parentName, setParentName] = React.useState('');
  const [parentDomain, setParentDomain] = React.useState('');

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [hierarchy, suppliers] = await Promise.all([api.hierarchy(true), api.suppliers({ pageSize: 200 })]);
      setClusters(hierarchy.clusters);
      setTotals(hierarchy.totals);
      setOrphans(hierarchy.orphans);
      setAllSuppliers(suppliers.rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return clusters;
    return clusters
      .map((cluster) => ({
        ...cluster,
        members: cluster.members.filter((member) => member.name.toLowerCase().includes(term)),
      }))
      .filter((cluster) => cluster.rootName.toLowerCase().includes(term) || cluster.members.length > 0);
  }, [clusters, search]);

  const submitLink = async () => {
    if (!linkTarget) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.linkParent({
        supplierId: linkTarget.id,
        ...(parentMode === 'existing'
          ? { parentId: Number(parentId) }
          : { parentName, parentDomain: parentDomain || undefined }),
      });
      setNotice(`${linkTarget.name} is now linked to ${result.parentName ?? `supplier #${result.parentId}`}.`);
      setLinkTarget(null);
      setParentId('');
      setParentName('');
      setParentDomain('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (supplierId: number, name: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.unlinkParent(supplierId);
      setNotice(`${name} was unlinked and is now independent. Its inherited classification is kept until you reclassify it.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const reclassifyFamily = async (cluster: HierarchyClusterDto) => {
    setBusy(true);
    setNotice(null);
    try {
      const ids = cluster.members.map((member) => member.id);
      const result = await api.classify({ supplierIds: ids, force: true, actor: 'dashboard' });
      setNotice(
        `Reclassified ${result.classified} supplier(s) in ${cluster.rootName}, ${result.inherited} inherited from the parent.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const parentOptions = allSuppliers.filter((supplier) => supplier.id !== linkTarget?.id);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Parent / subsidiary hierarchy</h1>
          <p className="text-sm text-muted-foreground">
            {formatNumber(totals.parents)} parent companies covering {formatNumber(totals.suppliers)} suppliers.
            Classification runs parent-first, and subsidiaries inherit the parent&apos;s UNSPSC code.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            Reload
          </Button>
          <ExportDialog filters={{ rollup: 'parent' }} label="Export roll-up CSV" defaultFormat="csv" />
          <ExportDialog filters={{}} label="Export hierarchy CSV" defaultFormat="csv" suggestedName="Hierarchy" />
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{busy ? 'Operation failed' : 'Load failed'}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <Alert variant="success">
          <Users className="h-4 w-4" />
          <AlertTitle>Hierarchy updated</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="flex-col items-start gap-3 space-y-0 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <CardTitle>Corporate families</CardTitle>
            <CardDescription>Link or unlink subsidiaries manually. Cycles are rejected automatically.</CardDescription>
          </div>
          <div className="w-full sm:w-[260px]">
            <Input placeholder="Filter companies…" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading && !filtered.length
            ? Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-16 w-full" />)
            : null}

          {!loading && !filtered.length ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No parent/subsidiary relationships yet. Upload suppliers with a <code>parent</code> column, or use the
              &ldquo;Link to parent&rdquo; action below.
            </p>
          ) : null}

          {filtered.map((cluster) => {
            const isCollapsed = collapsed[cluster.key] ?? false;
            return (
              <div key={cluster.key} className="rounded-lg border">
                <div className="flex flex-wrap items-center justify-between gap-3 bg-muted/40 px-4 py-3">
                  <button
                    type="button"
                    className="flex items-center gap-2 text-left"
                    onClick={() => setCollapsed((current) => ({ ...current, [cluster.key]: !isCollapsed }))}
                  >
                    {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    <Building2 className="h-4 w-4 text-primary" />
                    <span>
                      <span className="font-medium">{cluster.rootName}</span>
                      <span className="block text-xs text-muted-foreground">
                        {cluster.rootDomain ?? 'no domain'} · {cluster.subsidiaryCount} subsidiar
                        {cluster.subsidiaryCount === 1 ? 'y' : 'ies'} · {formatCurrency(cluster.totalAmount)}
                      </span>
                    </span>
                    {cluster.isVirtualRoot ? <Badge variant="outline">external parent</Badge> : null}
                    {cluster.rootId === null ? <Badge variant="muted">not in registry</Badge> : null}
                  </button>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void reclassifyFamily(cluster)}
                      title="Re-run classification for the parent and all of its subsidiaries"
                    >
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                      Reclassify family
                    </Button>
                  </div>
                </div>

                {!isCollapsed ? (
                  <div className="divide-y">
                    {cluster.members.map((member) => (
                      <div key={member.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                        <div className={member.isRoot ? 'font-medium' : 'pl-6 text-sm'}>
                          <span>{member.name}</span>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {member.isRoot ? 'parent company' : `subsidiary via ${member.parentSource ?? 'link'}`}
                          </span>
                          {member.stale ? (
                            <Badge variant="warning" className="ml-2">
                              stale
                            </Badge>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-sm text-muted-foreground">{formatCurrency(member.totalAmount)}</span>
                          <Button variant="ghost" size="sm" asChild>
                            <Link href={`/review?supplier=${member.id}`}>Open</Link>
                          </Button>
                          {member.isRoot ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setLinkTarget({ id: member.id, name: member.name })}
                            >
                              <Link2 className="h-3.5 w-3.5" />
                              Add subsidiary
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => void unlink(member.id, member.name)}
                            >
                              <Link2Off className="h-3.5 w-3.5" />
                              Unlink
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {orphans.length ? (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{orphans.length} supplier(s) have an unresolved parent link</AlertTitle>
          <AlertDescription>
            Their <code>parent_id</code> points at a row that no longer exists. They are treated as independent
            suppliers until re-linked.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Link any supplier to a parent</CardTitle>
          <CardDescription>
            Choose an existing supplier as the parent, or name an external parent company — a placeholder supplier row
            is created so subsidiaries can inherit its classification.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="w-full space-y-1 sm:w-[300px]">
            <Label>Subsidiary</Label>
            <Select
              value={linkTarget ? String(linkTarget.id) : ''}
              onValueChange={(value) => {
                const found = allSuppliers.find((supplier) => supplier.id === Number(value));
                setLinkTarget(found ? { id: found.id, name: found.name } : null);
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a supplier…" />
              </SelectTrigger>
              <SelectContent>
                {parentOptions.slice(0, 200).map((supplier) => (
                  <SelectItem key={supplier.id} value={String(supplier.id)}>
                    {supplier.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button disabled={!linkTarget} onClick={() => setLinkTarget(linkTarget ?? null)}>
            Configure link
          </Button>
          <span className="text-sm text-muted-foreground">
            {linkTarget ? `Selected: ${linkTarget.name}` : 'Select a supplier to enable linking.'}
          </span>
        </CardContent>
      </Card>

      <Dialog open={linkTarget !== null} onOpenChange={(open) => (open ? undefined : setLinkTarget(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link {linkTarget?.name} to a parent company</DialogTitle>
            <DialogDescription>
              The subsidiary will inherit the parent&apos;s UNSPSC classification on the next classification run.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex gap-2">
              <Button
                variant={parentMode === 'existing' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setParentMode('existing')}
              >
                Existing supplier
              </Button>
              <Button variant={parentMode === 'new' ? 'default' : 'outline'} size="sm" onClick={() => setParentMode('new')}>
                External parent
              </Button>
            </div>

            {parentMode === 'existing' ? (
              <div className="space-y-1">
                <Label>Parent supplier</Label>
                <Select value={parentId} onValueChange={setParentId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select the parent company…" />
                  </SelectTrigger>
                  <SelectContent>
                    {parentOptions.slice(0, 200).map((supplier) => (
                      <SelectItem key={supplier.id} value={String(supplier.id)}>
                        {supplier.name}
                        {supplier.subsidiaryCount ? ` (${supplier.subsidiaryCount} subs)` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="parent-name">Parent company name</Label>
                  <Input
                    id="parent-name"
                    placeholder="e.g. Siemens AG"
                    value={parentName}
                    onChange={(event) => setParentName(event.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="parent-domain">Parent domain (optional)</Label>
                  <Input
                    id="parent-domain"
                    placeholder="siemens.com"
                    value={parentDomain}
                    onChange={(event) => setParentDomain(event.target.value)}
                  />
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setLinkTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => void submitLink()}
              disabled={busy || (parentMode === 'existing' ? !parentId : parentName.trim().length < 2)}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              Link parent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
