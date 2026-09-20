/**
 * /api/reports
 *
 *  GET    ?view=list|budget            — stored reports (metadata only) / storage budget
 *  POST   { format, filters, name, store, schedule } — generate + optionally store
 *  DELETE ?id=<n>                      — remove a stored report and free Neon storage
 *
 * Weekly PDF generation is worker-only; it goes through POST /api/sync with
 * `mode=report` so scheduled runs cannot be triggered from a browser session
 * without the worker secret.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { dynamic, jsonHandler, readJsonBody, requireWorkerAuth } from '@/lib/api';
import { requireAuth } from '@/lib/auth';
import { ValidationError } from '@/lib/errors';
import { generateReportRequestSchema, parseReportFilters } from '@/lib/validation';
import { deleteReport, listReports, generateReport, MAX_STORED_REPORT_BYTES } from '@/services/reporting/store';
import { getDb } from '@/db/client';
import { reports } from '@/db/schema';
import { sql } from 'drizzle-orm';

export { dynamic };

const listQuerySchema = z.object({
  view: z.enum(['list', 'budget']).default('list'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  format: z.enum(['csv', 'pdf']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const GET = jsonHandler(async (request: NextRequest) => {
  await requireAuth(request);

  const parsed = listQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));
  const query = parsed.success ? parsed.data : listQuerySchema.parse({});

  if (query.view === 'budget') {
    const db = getDb();
    const totals = await db
      .select({
        storedBytes: sql<number>`coalesce(sum(${reports.sizeBytes}), 0)`,
        count: sql<number>`count(*)`,
        largest: sql<number>`coalesce(max(${reports.sizeBytes}), 0)`,
      })
      .from(reports);
    const row = totals[0];
    return NextResponse.json({
      ok: true,
      data: {
        storedBytes: Number(row?.storedBytes ?? 0),
        reportCount: Number(row?.count ?? 0),
        largestReportBytes: Number(row?.largest ?? 0),
        maxStoredReportBytes: MAX_STORED_REPORT_BYTES,
        // Neon free tier is 0.5 GB; reports are a small slice of that.
        shareOfNeonFreeTier: Number(row?.storedBytes ?? 0) / (0.5 * 1024 * 1024 * 1024),
      },
    });
  }

  const page = await listReports({
    page: query.page,
    pageSize: query.pageSize,
    format: query.format,
    from: query.from,
    to: query.to,
  });
  return NextResponse.json({ ok: true, data: page });
});

export const POST = jsonHandler(async (request: NextRequest) => {
  await requireAuth(request);

  const body = await readJsonBody(request, generateReportRequestSchema);

  // Storing a report consumes Neon storage, so it is a privileged operation.
  if (body.store) requireWorkerAuth(request);

  const filters = parseReportFilters((body.filters ?? {}) as Record<string, string | undefined>);

  const report = await generateReport({
    name: body.name,
    format: body.format ?? 'pdf',
    filters,
    generatedBy: body.generatedBy ?? 'dashboard',
    store: body.store ?? false,
    schedule: body.schedule ?? 'manual',
  });

  return NextResponse.json({
    ok: true,
    data: {
      name: report.name,
      format: report.format,
      filename: report.filename,
      rows: report.rowCount,
      bytes: report.bytes.byteLength,
      storedId: report.storedId,
      summary: report.dataset.summary,
      filterSummary: report.dataset.meta.filterSummary,
      // The bytes are streamed by GET /api/export and GET /api/reports/[id]/download.
    },
  });
});

export const DELETE = jsonHandler(async (request: NextRequest) => {
  requireWorkerAuth(request);
  const id = Number(request.nextUrl.searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('Query parameter `id` must be a positive integer.');
  const deleted = await deleteReport(id, { actor: 'worker' });
  return NextResponse.json({ ok: true, data: { id, deleted } });
});
