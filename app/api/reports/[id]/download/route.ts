/**
 * GET /api/reports/[id]/download
 *
 * Streams a previously stored report (the weekly PDF job stores one every
 * Monday). Falls back to regenerating the report when the blob was pruned, so a
 * bookmark never 404s.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { binaryBody, dynamic, jsonHandler, parseIdParam } from '@/lib/api';
import { requireAuth } from '@/lib/auth';
import { NotFoundError } from '@/lib/errors';
import { generateReport, getStoredReport } from '@/services/reporting/store';
import { reportFilename } from '@/services/reporting/csv';
import type { ReportFilters } from '@/lib/validation';

export { dynamic };

export const GET = jsonHandler(async (request: NextRequest, context: { params: { id: string } }) => {
  await requireAuth(request);

  const id = parseIdParam(context.params.id, 'report id');
  const stored = await getStoredReport(id);

  if (stored && stored.bytes.byteLength) {
    const filename =
      stored.format === 'pdf' ? reportFilename(stored.name, 'pdf') : reportFilename(stored.name, 'csv');
    return new NextResponse(binaryBody(stored.bytes), {
      status: 200,
      headers: {
        'Content-Type': stored.format === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(stored.bytes.byteLength),
        'Cache-Control': 'no-store',
      },
    });
  }

  // The row exists but the blob was pruned (or is empty): regenerate on demand.
  const { listReports } = await import('@/services/reporting/store');
  const { reports: rows } = await listReports({ pageSize: 100 });
  const meta = rows.find((row) => row.id === id);
  if (!meta) throw new NotFoundError(`Report ${id} not found.`);

  const format = meta.format === 'pdf' ? 'pdf' : 'csv';
  const regenerated = await generateReport({
    name: meta.name,
    format,
    filters: { rollup: 'parent' } as ReportFilters,
    generatedBy: 'dashboard',
    store: false,
  });

  return new NextResponse(binaryBody(regenerated.bytes), {
    status: 200,
    headers: {
      'Content-Type': regenerated.contentType,
      'Content-Disposition': `attachment; filename="${regenerated.filename}"`,
      'Cache-Control': 'no-store',
      'X-Regenerated': 'true',
    },
  });
});
