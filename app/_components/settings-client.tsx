'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  CheckCircle2,
  Gauge,
  KeyRound,
  Loader2,
  RefreshCw,
  Save,
  Server,
  Sliders,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { api, type HealthDto, type SettingsDto } from '@/lib/client';
import { formatNumber, formatPercent } from '@/lib/format';

type Draft = {
  confidenceThreshold: string;
  modelStrategy: 'tiered' | 'accurate' | 'bulk';
  accurateModel: string;
  bulkModel: string;
  parentDetectionEnabled: boolean;
  enrichmentEnabled: boolean;
  syncEnabled: boolean;
  syncCron: string;
  staleAfterDays: string;
  batchSize: string;
  weeklyReportEnabled: boolean;
  weeklyReportCron: string;
  reportRecipients: string;
  groqApiKey: string;
  enrichApiKey: string;
};

export default function SettingsPage() {
  const [data, setData] = React.useState<SettingsDto | null>(null);
  const [health, setHealth] = React.useState<HealthDto | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [syncSecret, setSyncSecret] = React.useState('');
  const [syncBusy, setSyncBusy] = React.useState<string | null>(null);
  const [syncResult, setSyncResult] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [settings, healthData] = await Promise.all([api.settings(), api.health()]);
      setData(settings);
      setHealth(healthData);
      const effective = settings.settings.effective;
      setDraft({
        confidenceThreshold: effective.confidenceThreshold.toFixed(2),
        modelStrategy: (settings.settings.modelStrategy as Draft['modelStrategy']) ?? 'tiered',
        accurateModel: effective.accurateModel,
        bulkModel: effective.bulkModel,
        parentDetectionEnabled: effective.parentDetectionEnabled,
        enrichmentEnabled: effective.enrichmentEnabled,
        syncEnabled: effective.syncEnabled,
        syncCron: effective.syncCron,
        staleAfterDays: String(effective.staleAfterDays),
        batchSize: String(effective.batchSize),
        weeklyReportEnabled: effective.weeklyReportEnabled,
        weeklyReportCron: effective.weeklyReportCron,
        reportRecipients: settings.settings.reportRecipients ?? '',
        groqApiKey: '',
        enrichApiKey: '',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => (current ? { ...current, [key]: value } : current));

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.updateSettings({
        confidenceThreshold: Number(draft.confidenceThreshold),
        modelStrategy: draft.modelStrategy,
        accurateModel: draft.accurateModel,
        bulkModel: draft.bulkModel,
        parentDetectionEnabled: draft.parentDetectionEnabled,
        enrichmentEnabled: draft.enrichmentEnabled,
        syncEnabled: draft.syncEnabled,
        syncCron: draft.syncCron,
        staleAfterDays: Number(draft.staleAfterDays),
        batchSize: Number(draft.batchSize),
        weeklyReportEnabled: draft.weeklyReportEnabled,
        weeklyReportCron: draft.weeklyReportCron,
        reportRecipients: draft.reportRecipients || undefined,
        groqApiKey: draft.groqApiKey || undefined,
        enrichApiKey: draft.enrichApiKey || undefined,
        actor: 'dashboard',
      });
      setData((current) => (current ? { ...current, settings: result.settings } : current));
      setNotice(
        result.changes.length
          ? `Saved: ${result.changes.map((change) => `${change.key} ${String(change.from)} -> ${String(change.to)}`).join('; ')}`
          : 'Saved. No values changed.',
      );
      set('groqApiKey', '');
      set('enrichApiKey', '');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const runSync = async (mode: 'full' | 'report') => {
    if (!syncSecret) {
      setError('Enter the WORKER_SECRET to trigger a worker-only operation.');
      return;
    }
    setSyncBusy(mode);
    setError(null);
    setSyncResult(null);
    try {
      const result = await api.sync({ mode, actor: 'settings-page' }, syncSecret);
      setSyncResult(JSON.stringify(result, null, 2));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncBusy(null);
    }
  };

  const effective = data?.settings.effective;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Thresholds, models, parent detection and the sync schedule. Secrets stay in environment variables — they are
            never written to the database.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Reload
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={busy || !draft}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save settings
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
          <AlertTitle>Settings saved</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatusCard
          icon={<KeyRound className="h-4 w-4" />}
          title="Groq"
          ok={data?.settings.secrets.groqConfigured ?? false}
          detail={data?.settings.secrets.groqMasked ?? 'GROQ_API_KEY not set'}
          hint={effective ? `${effective.accurateModel} / ${effective.bulkModel}` : ''}
        />
        <StatusCard
          icon={<Server className="h-4 w-4" />}
          title="Enrichment"
          ok={data?.settings.secrets.enrichConfigured ?? false}
          detail={data?.settings.secrets.enrichMasked ?? 'ENRICH_API_KEY not set'}
          hint={effective?.enrichProvider ?? ''}
        />
        <StatusCard
          icon={<Gauge className="h-4 w-4" />}
          title="Worker secret"
          ok={data?.settings.secrets.workerSecretConfigured ?? false}
          detail={data?.settings.secrets.workerSecretConfigured ? 'WORKER_SECRET is set' : 'WORKER_SECRET missing'}
          hint="Protects /api/sync and report storage"
        />
        <StatusCard
          icon={<Sliders className="h-4 w-4" />}
          title="UNSPSC taxonomy"
          ok={(data?.taxonomyCodes ?? 0) > 1000}
          detail={`${formatNumber(data?.taxonomyCodes ?? 0)} codes seeded`}
          hint="Run `npm run db:seed` to load v26"
        />
      </div>

      {data?.usage ? (
        <Card>
          <CardHeader>
            <CardTitle>Free-tier budget today ({data.usage.day})</CardTitle>
            <CardDescription>
              {data.usage.reserve} requests/day are held back for interactive dashboard actions.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {data.usage.models.map((model) => {
              const used = model.requestCount;
              const pct = model.dailyLimit ? (used / model.dailyLimit) * 100 : 0;
              return (
                <div key={model.model} className="space-y-2 rounded-lg border p-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">{model.model}</span>
                    <span className="text-muted-foreground">
                      {formatNumber(used)} / {formatNumber(model.dailyLimit)} ({formatPercent(pct)})
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={pct > 85 ? 'h-full bg-destructive' : pct > 60 ? 'h-full bg-amber-500 dark:bg-amber-400' : 'h-full bg-primary'}
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">{formatNumber(model.remaining)} request(s) remaining</p>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      {draft ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Classification</CardTitle>
              <CardDescription>Confidence threshold and model routing.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="threshold">Confidence threshold (below this = review queue)</Label>
                <Input
                  id="threshold"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={draft.confidenceThreshold}
                  onChange={(event) => set('confidenceThreshold', event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Currently {data?.settings.effective.confidenceThreshold.toFixed(2)} in force. The env default is{' '}
                  {data?.limits ? `CLASSIFY_CONFIDENCE_THRESHOLD` : ''}.
                </p>
              </div>

              <div className="space-y-1">
                <Label>Model strategy</Label>
                <Select value={draft.modelStrategy} onValueChange={(value) => set('modelStrategy', value as Draft['modelStrategy'])}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tiered">Tiered — 70B for parents/high spend, 8B for the tail</SelectItem>
                    <SelectItem value="accurate">Always accurate (70B) — uses the 1k/day quota</SelectItem>
                    <SelectItem value="bulk">Always bulk (8B) — 14.4k/day quota</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>Accurate model</Label>
                  <Select value={draft.accurateModel} onValueChange={(value) => set('accurateModel', value)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(data?.modelChoices ?? []).map((choice) => (
                        <SelectItem key={choice.id} value={choice.id}>
                          {choice.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Bulk model</Label>
                  <Select value={draft.bulkModel} onValueChange={(value) => set('bulkModel', value)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(data?.modelChoices ?? []).map((choice) => (
                        <SelectItem key={choice.id} value={choice.id}>
                          {choice.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex items-start gap-3 rounded-lg border p-3">
                <Switch
                  id="parent-detection"
                  checked={draft.parentDetectionEnabled}
                  onCheckedChange={(value) => set('parentDetectionEnabled', value)}
                />
                <div>
                  <Label htmlFor="parent-detection">LLM parent detection</Label>
                  <p className="text-xs text-muted-foreground">
                    When the enrichment provider returns no ownership data, ask Llama 3.3 70B for the ultimate parent
                    company before classifying.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 rounded-lg border p-3">
                <Switch
                  id="enrichment-enabled"
                  checked={draft.enrichmentEnabled}
                  onCheckedChange={(value) => set('enrichmentEnabled', value)}
                />
                <div>
                  <Label htmlFor="enrichment-enabled">Enrichment enabled</Label>
                  <p className="text-xs text-muted-foreground">
                    Disable to run classification on supplier names alone (saves provider credits).
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Sync &amp; reports</CardTitle>
              <CardDescription>How often the worker refreshes and reports.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-start gap-3 rounded-lg border p-3">
                <Switch id="sync-enabled" checked={draft.syncEnabled} onCheckedChange={(value) => set('syncEnabled', value)} />
                <div className="flex-1">
                  <Label htmlFor="sync-enabled">Scheduled re-enrichment</Label>
                  <div className="mt-2 grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1">
                      <Label htmlFor="sync-cron" className="text-xs">
                        Cron (UTC)
                      </Label>
                      <Input
                        id="sync-cron"
                        className="font-mono text-xs"
                        value={draft.syncCron}
                        onChange={(event) => set('syncCron', event.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="stale-days" className="text-xs">
                        Stale after (days)
                      </Label>
                      <Input
                        id="stale-days"
                        type="number"
                        min={1}
                        value={draft.staleAfterDays}
                        onChange={(event) => set('staleAfterDays', event.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="batch-size" className="text-xs">
                        Batch size
                      </Label>
                      <Input
                        id="batch-size"
                        type="number"
                        min={1}
                        max={10}
                        value={draft.batchSize}
                        onChange={(event) => set('batchSize', event.target.value)}
                      />
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    The cron only fires while the worker is awake; cron-job.org pings <code>/health</code> every 5 minutes
                    to keep the Render free tier from spinning down.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 rounded-lg border p-3">
                <Switch
                  id="weekly-report"
                  checked={draft.weeklyReportEnabled}
                  onCheckedChange={(value) => set('weeklyReportEnabled', value)}
                />
                <div className="flex-1">
                  <Label htmlFor="weekly-report">Weekly PDF report</Label>
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label htmlFor="report-cron" className="text-xs">
                        Cron (UTC)
                      </Label>
                      <Input
                        id="report-cron"
                        className="font-mono text-xs"
                        value={draft.weeklyReportCron}
                        onChange={(event) => set('weeklyReportCron', event.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="report-recipients" className="text-xs">
                        Recipients (informational)
                      </Label>
                      <Input
                        id="report-recipients"
                        placeholder="procurement@example.com"
                        value={draft.reportRecipients}
                        onChange={(event) => set('reportRecipients', event.target.value)}
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-3 rounded-lg border p-3">
                <p className="text-sm font-medium">Manual worker runs</p>
                <div className="space-y-1">
                  <Label htmlFor="sync-secret" className="text-xs">
                    WORKER_SECRET
                  </Label>
                  <Input
                    id="sync-secret"
                    type="password"
                    value={syncSecret}
                    onChange={(event) => setSyncSecret(event.target.value)}
                    placeholder="Bearer secret"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => void runSync('full')} disabled={syncBusy !== null}>
                    {syncBusy === 'full' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    Run sync now
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void runSync('report')} disabled={syncBusy !== null}>
                    {syncBusy === 'report' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Generate weekly report now
                  </Button>
                </div>
                {syncResult ? (
                  <pre className="max-h-56 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">{syncResult}</pre>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>API keys</CardTitle>
              <CardDescription>
                Entering a key here stores only a masked fingerprint for display. The runtime always reads the real value
                from environment variables.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="groq-key">Groq API key</Label>
                <Input
                  id="groq-key"
                  type="password"
                  placeholder={data?.settings.secrets.groqMasked ?? 'gsk_…'}
                  value={draft.groqApiKey}
                  onChange={(event) => set('groqApiKey', event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="enrich-key">Enrichment API key</Label>
                <Input
                  id="enrich-key"
                  type="password"
                  placeholder={data?.settings.secrets.enrichMasked ?? 'provider key'}
                  value={draft.enrichApiKey}
                  onChange={(event) => set('enrichApiKey', event.target.value)}
                />
              </div>
              <Alert variant="info">
                <Server className="h-4 w-4" />
                <AlertTitle>Env-managed values</AlertTitle>
                <AlertDescription>
                  <p className="mb-1">These are read from the environment at runtime and cannot be changed here:</p>
                  <div className="flex flex-wrap gap-1">
                    {(data?.settings.envManaged ?? []).map((key) => (
                      <Badge key={key} variant="muted" className="font-mono text-[10px]">
                        {key}
                      </Badge>
                    ))}
                  </div>
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Dependency health</CardTitle>
              <CardDescription>
                Live status from <Link href="/api/health" className="underline">/api/health</Link>.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {health ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Dependency</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Detail</TableHead>
                      <TableHead className="text-right">Latency</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {health.checks.map((check) => (
                      <TableRow key={check.name}>
                        <TableCell className="font-medium">{check.name}</TableCell>
                        <TableCell>
                          <Badge variant={check.ok ? 'success' : 'warning'}>{check.ok ? 'ok' : 'degraded'}</Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{check.detail ?? '—'}</TableCell>
                        <TableCell className="text-right text-xs">
                          {check.latencyMs !== undefined ? `${check.latencyMs} ms` : '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="p-4">
                  <Skeleton className="h-24 w-full" />
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}

      {data?.usageHistory.length ? (
        <Card>
          <CardHeader>
            <CardTitle>Groq usage, last 7 days</CardTitle>
            <CardDescription>Requests per model per UTC day, from the durable `llm_usage` counter.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Day</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Prompt tokens</TableHead>
                  <TableHead className="text-right">Completion tokens</TableHead>
                  <TableHead className="text-right">Failures</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.usageHistory.map((row) => (
                  <TableRow key={`${row.day}-${row.model}`}>
                    <TableCell className="font-mono text-xs">{row.day}</TableCell>
                    <TableCell className="text-xs">{row.model}</TableCell>
                    <TableCell className="text-right">{formatNumber(row.requests)}</TableCell>
                    <TableCell className="text-right">{formatNumber(row.promptTokens)}</TableCell>
                    <TableCell className="text-right">{formatNumber(row.completionTokens)}</TableCell>
                    <TableCell className="text-right">{formatNumber(row.failures)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function StatusCard({
  icon,
  title,
  ok,
  detail,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  ok: boolean;
  detail: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription className="flex items-center gap-2">
          <span className={ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>{icon}</span>
          {title}
          <Badge variant={ok ? 'success' : 'warning'} className="ml-auto">
            {ok ? 'configured' : 'missing'}
          </Badge>
        </CardDescription>
        <CardTitle className="text-sm font-medium">{detail}</CardTitle>
      </CardHeader>
      {hint ? <CardContent className="pt-0 text-xs text-muted-foreground">{hint}</CardContent> : null}
    </Card>
  );
}
