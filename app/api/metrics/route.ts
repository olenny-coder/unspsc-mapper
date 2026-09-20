/**
 * GET /api/metrics
 *
 * One call that gives the dashboard everything it renders: headline stats,
 * segment breakdown, top parents, roll-up, review-queue size, stale count, LLM
 * budget and the last sync summary. Consolidating this keeps the free-tier
 * compute bill down (one read pass per page load instead of six).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { dynamic, jsonHandler, readFilters } from '@/lib/api';
import { requireAuth } from '@/lib/auth';
import { buildReportDataset } from '@/services/reporting/aggregate';
import { getSupplierStats, listSuppliers, toNode } from '@/services/suppliers';
import { rollupByParent } from '@/services/hierarchy';
import { getReviewQueue } from '@/services/classification';
import { getLlmUsageOverview } from '@/services/llm-usage';
import { getSyncHealth } from '@/services/sync';
import { getEffectiveSettings } from '@/services/settings';
import { enrichmentCreditsUsedThisMonth } from '@/services/enrichment';
import { getEnv } from '@/lib/env';

export { dynamic };

export const GET = jsonHandler(async (request: NextRequest) => {
  await requireAuth(request);

  const env = getEnv();
  const filters = readFilters(request);
  const includeUsage = request.nextUrl.searchParams.get('usage') !== 'false';

  const dataset = await buildReportDataset({ filters, format: 'csv', generatedBy: 'dashboard' });
  const stats = await getSupplierStats({ filters });

  const rollup = rollupByParent(dataset.rows.map((row) => toNode(row.supplier)), env.CLASSIFY_CONFIDENCE_THRESHOLD);

  const [review, usage, health, settings] = await Promise.all([
    getReviewQueue({ limit: 200 }),
    includeUsage ? getLlmUsageOverview() : Promise.resolve(null),
    getSyncHealth(),
    getEffectiveSettings(),
  ]);

  // Recently updated suppliers for the dashboard "activity" strip.
  const recent = await listSuppliers({
    filters,
    page: 1,
    pageSize: 8,
    sort: 'updatedAt',
    dir: 'desc',
  });

  return NextResponse.json({
    ok: true,
    data: {
      threshold: env.CLASSIFY_CONFIDENCE_THRESHOLD,
      filters,
      summary: dataset.summary,
      stats,
      segments: dataset.segments,
      topParents: dataset.topParents,
      rollup,
      reviewQueueSize: review.length,
      reviewPreview: review.slice(0, 10),
      recentSuppliers: recent.rows.map((row) => ({
        id: row.id,
        name: row.name,
        code: row.classification?.effectiveCode ?? null,
        confidence: row.classification?.confidence ?? null,
        stale: row.stale,
        updatedAt: row.updatedAt,
      })),
      usage,
      enrichmentCreditsUsedThisMonth: includeUsage ? await enrichmentCreditsUsedThisMonth() : null,
      lastSync: health.lastSync,
      settings: {
        confidenceThreshold: settings.effective.confidenceThreshold,
        modelStrategy: settings.effective.modelStrategy,
        accurateModel: settings.effective.accurateModel,
        bulkModel: settings.effective.bulkModel,
        parentDetectionEnabled: settings.effective.parentDetectionEnabled,
        syncEnabled: settings.effective.syncEnabled,
        staleAfterDays: settings.effective.staleAfterDays,
        batchSize: settings.effective.batchSize,
        weeklyReportEnabled: settings.effective.weeklyReportEnabled,
        syncCron: settings.effective.syncCron,
        weeklyReportCron: settings.effective.weeklyReportCron,
      },
      secrets: settings.secrets,
    },
  });
});
