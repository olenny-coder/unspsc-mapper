/**
 * GET /api/health
 *
 * Used by:
 *   - cron-job.org / UptimeRobot to keep the Render worker awake (15 min idle
 *     spin-down on the free tier);
 *   - the CI smoke test and the `/settings` page;
 *   - Render's own health check.
 *
 * Returns 200 whenever the process is up, and includes per-dependency status so
 * a degraded database does not look like a dead worker. `?strict=true` returns
 * 503 when a dependency is down.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { dynamic } from '@/lib/api';
import { resolveRequestRole } from '@/lib/auth';
import { getEnv, getEnvIssues, isEnrichmentConfigured, isGroqConfigured } from '@/lib/env';
import { getDb } from '@/db/client';
import { suppliers, unspscCodes } from '@/db/schema';
import { sql } from 'drizzle-orm';
import { getLlmUsageOverview } from '@/services/llm-usage';
import { enrichmentCreditsUsedThisMonth } from '@/services/enrichment';

export { dynamic };

type DependencyStatus = {
  name: string;
  ok: boolean;
  detail?: string;
  latencyMs?: number;
};

async function timed(name: string, fn: () => Promise<string | undefined>): Promise<DependencyStatus> {
  const started = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, detail, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - started,
    };
  }
}

export async function GET(request: NextRequest) {
  const env = getEnv();
  const strict = ['1', 'true', 'yes', 'on'].includes((request.nextUrl.searchParams.get('strict') ?? '').toLowerCase());
  const started = Date.now();

  const checks: DependencyStatus[] = [];

  // Unusable environment values are replaced by defaults rather than failing the
  // request, which keeps the app up but would otherwise hide the problem away in
  // a log. Reporting them here makes a misconfiguration visible from outside the
  // process — and `?strict=true` turns it into a 503 so a monitor notices.
  /*
   * Health is a public path, so an anonymous visitor on a demo deployment reaches
   * this route directly — it is the one handler that does not pass through
   * `jsonHandler`. Row counts are real data and are therefore reduced to plain
   * reachability for anyone who is not signed in; the operational signal (up or
   * down, plus latency) survives for uptime monitors.
   */
  const role = await resolveRequestRole(request);

  const envIssues = getEnvIssues();
  checks.push({
    name: 'configuration',
    ok: envIssues.length === 0,
    detail: envIssues.length
      ? `${envIssues.length} unusable environment ${envIssues.length === 1 ? 'variable' : 'variables'} ignored: ${envIssues
          .map((issue) => `${issue.variable} (${issue.problem})`)
          .join('; ')}`
      : 'all configured values are valid',
  });

  const database = await timed('database', async () => {
    const db = getDb();
    const result = await db.execute<{ suppliers: number; codes: number }>(sql`
      select
        (select count(*) from ${suppliers}) as suppliers,
        (select count(*) from ${unspscCodes}) as codes
    `);
    const row = (result as unknown as Array<{ suppliers: number; codes: number }>)[0];
    return row ? `${row.suppliers} suppliers, ${row.codes} UNSPSC codes` : undefined;
  });
  checks.push(
    role === 'demo'
      ? {
          name: 'database',
          ok: database.ok,
          detail: database.ok ? 'reachable' : database.detail,
          latencyMs: database.latencyMs,
        }
      : database,
  );

  checks.push({
    name: 'groq',
    ok: isGroqConfigured(),
    detail: isGroqConfigured()
      ? `configured (${env.GROQ_MODEL_ACCURATE} / ${env.GROQ_MODEL_BULK})`
      : 'GROQ_API_KEY is not set',
  });

  checks.push({
    name: 'enrichment',
    ok: env.ENRICH_PROVIDER === 'none' || isEnrichmentConfigured(),
    detail:
      env.ENRICH_PROVIDER === 'none'
        ? 'disabled (ENRICH_PROVIDER=none)'
        : isEnrichmentConfigured()
          ? `${env.ENRICH_PROVIDER} configured`
          : `ENRICH_PROVIDER=${env.ENRICH_PROVIDER} but ENRICH_API_KEY is not set`,
  });

  let llmUsage: Awaited<ReturnType<typeof getLlmUsageOverview>> | null = null;
  let enrichCredits: number | null = null;
  if (database.ok) {
    try {
      llmUsage = await getLlmUsageOverview();
    } catch (error) {
      checks.push({
        name: 'llm-usage',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      enrichCredits = await enrichmentCreditsUsedThisMonth();
    } catch (error) {
      checks.push({
        name: 'enrichment-usage',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Only a hard dependency can make the deployment unhealthy. Groq and the
  // enrichment provider are optional: without them the app still stores and
  // reports suppliers, so their absence is reported as `configured: false`
  // rather than as an outage (which would raise false alarms on uptime monitors).
  const HARD_DEPENDENCIES = new Set(['database']);
  const failedHardChecks = checks.filter((check) => HARD_DEPENDENCIES.has(check.name) && !check.ok);
  const ok = failedHardChecks.length === 0;

  const body = {
    ok,
    service: 'unspsc-spend-categorizer',
    version: process.env.npm_package_version ?? '1.0.0',
    environment: env.NODE_ENV,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    responseTimeMs: Date.now() - started,
    checks,
    degraded: checks.some((check) => !check.ok) || !isGroqConfigured(),
    freeTierBudget: llmUsage
      ? {
          day: llmUsage.day,
          reserve: llmUsage.reserve,
          models: llmUsage.models.map((model) => ({
            model: model.model,
            used: model.requestCount,
            limit: model.dailyLimit,
            remaining: model.remaining,
          })),
          enrichmentCreditsUsedThisMonth: enrichCredits,
          enrichmentMonthlyLimit: env.ENRICH_MONTHLY_CREDIT_LIMIT,
        }
      : null,
  };

  return NextResponse.json(body, { status: strict && !ok ? 503 : 200 });
}

/** HEAD is used by some uptime monitors; keep it cheap. */
export async function HEAD() {
  return new NextResponse(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}
