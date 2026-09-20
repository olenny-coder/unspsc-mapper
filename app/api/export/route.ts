/**
 * GET /api/export?format=csv|pdf&<filters...>
 *
 * Streams a generated report. Filters are the same ones the dashboard uses, so
 * "what you see is what you export":
 *   minConfidence, maxConfidence, confidenceState, segment, parent, parentId,
 *   onlyParents, onlySubsidiaries, onlyStale, from, to, search, rollup=parent
 *
 * `store=true` also persists the bytes in `reports` (subject to the 4 MB cap).
 * `format=rollup|hierarchy` returns the parent roll-up / hierarchy CSV variants.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { binaryBody, dynamic, jsonHandler, readFilters } from '@/lib/api';
import { requireAuth } from '@/lib/auth';
import { generateReport } from '@/services/reporting/store';
import { buildReportDataset } from '@/services/reporting/aggregate';
import { csvBytes, renderHierarchyCsv, renderParentRollupCsv, reportFilename } from '@/services/reporting/csv';

export { dynamic };
/** Streamed file downloads must not be statically optimised. */
export const fetchCache = 'force-no-store';

export const GET = jsonHandler(async (request: NextRequest) => {
  await requireAuth(request);

  const searchParams = request.nextUrl.searchParams;
  const format = (searchParams.get('format') ?? 'csv').toLowerCase();
  const store = ['1', 'true', 'yes', 'on'].includes((searchParams.get('store') ?? '').toLowerCase());
  const name = searchParams.get('name') ?? undefined;
  const generatedBy = searchParams.get('generatedBy') ?? undefined;
  const filters = readFilters(request);

  // Variant CSVs don't need the full dataset pipeline twice.
  if (format === 'rollup' || format === 'hierarchy' || format === 'parent-rollup') {
    const dataset = await buildReportDataset({ filters, name, format: 'csv', generatedBy });
    const csv = format === 'hierarchy' ? renderHierarchyCsv(dataset) : renderParentRollupCsv(dataset);
    const filename =
      format === 'hierarchy'
        ? reportFilename(`${dataset.meta.name} hierarchy`, 'csv')
        : reportFilename(`${dataset.meta.name} parent rollup`, 'csv');

    return new NextResponse(binaryBody(csvBytes(csv)), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  if (format !== 'csv' && format !== 'pdf') {
    return NextResponse.json(
      { ok: false, error: { code: 'validation_error', message: 'format must be csv, pdf, rollup or hierarchy' } },
      { status: 400 },
    );
  }

  const report = await generateReport({
    name,
    format,
    filters,
    generatedBy,
    store,
    schedule: 'manual',
  });

  return new NextResponse(binaryBody(report.bytes), {
    status: 200,
    headers: {
      'Content-Type': report.contentType,
      'Content-Disposition': `attachment; filename="${report.filename}"`,
      'Content-Length': String(report.bytes.byteLength),
      'Cache-Control': 'no-store',
      'X-Report-Rows': String(report.rowCount),
      ...(report.storedId ? { 'X-Report-Id': String(report.storedId) } : {}),
    },
  });
});

/**
 * POST /api/export with `{ preview: true }` returns the summary numbers only, so
 * the export dialog can show what will be in the file before downloading it.
 */
export const POST = jsonHandler(async (request: NextRequest) => {
  await requireAuth(request);

  const body = (await request.json().catch(() => ({}))) as { filters?: Record<string, unknown>; preview?: boolean };
  const filters = readFilters(request);
  const dataset = await buildReportDataset({
    filters: { ...filters, ...(body.filters ?? {}) } as typeof filters,
    generatedBy: 'preview',
  });

  return NextResponse.json({
    ok: true,
    data: {
      summary: dataset.summary,
      segments: dataset.segments.slice(0, 25),
      topParents: dataset.topParents,
      lowConfidenceCount: dataset.lowConfidence.length,
      rowCount: dataset.rows.length,
      filterSummary: dataset.meta.filterSummary,
    },
  });
});
