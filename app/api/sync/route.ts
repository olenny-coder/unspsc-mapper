/**
 * POST /api/sync — worker-only endpoint.
 *
 * Re-enriches stale suppliers, re-links parents, reclassifies, and (mode=report)
 * generates the weekly PDF. Protected by `WORKER_SECRET`.
 *
 * Triggered by:
 *   - the Render worker's internal scheduler (`runSync` directly, not over HTTP);
 *   - cron-job.org / GitHub Actions / any external cron with the secret;
 *   - manual ops calls.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { dynamic, jsonHandler, readJsonBody, readQuery, requireWorkerAuth } from '@/lib/api';
import { syncRequestSchema } from '@/lib/validation';
import { runSync } from '@/services/sync';
import { getSyncHealth } from '@/services/sync';
import { generateWeeklyReport, pruneOldReports } from '@/services/reporting/store';

export { dynamic };

export const POST = jsonHandler(async (request: NextRequest) => {
  requireWorkerAuth(request);

  const hasBody = (request.headers.get('content-length') ?? '0') !== '0' || Boolean(request.headers.get('transfer-encoding'));
  const params = hasBody
    ? await readJsonBody(request, syncRequestSchema)
    : readQuery(request, syncRequestSchema);

  const actor = params.actor ?? 'worker';

  // `mode=report` is the weekly PDF job; it never runs enrichment.
  if (params.mode === 'report') {
    const report = await generateWeeklyReport();
    const pruned = await pruneOldReports(30, { actor });
    return NextResponse.json({
      ok: true,
      data: {
        mode: 'report',
        report: {
          id: report.storedId,
          name: report.name,
          format: report.format,
          filename: report.filename,
          rows: report.rowCount,
          bytes: report.bytes.byteLength,
        },
        pruned,
      },
    });
  }

  const summary = await runSync({
    mode: params.mode ?? 'full',
    limit: params.limit,
    staleAfterDays: params.staleAfterDays,
    actor,
  });

  return NextResponse.json({ ok: true, data: summary }, { status: summary.stoppedReason === 'error' ? 500 : 200 });
});

/** GET /api/sync — health + last sync summary (also worker-only). */
export const GET = jsonHandler(async (request: NextRequest) => {
  requireWorkerAuth(request);
  const health = await getSyncHealth();
  return NextResponse.json({ ok: true, data: health });
});
