/**
 * POST /api/upload
 *
 * Accepts a supplier CSV (`multipart/form-data` field `file`, or a raw
 * `text/csv` body), parses it, upserts suppliers on the normalised name, and
 * optionally chains enrichment + classification.
 *
 * The response reports exactly what happened per row so the `/upload` page can
 * show a meaningful confirmation instead of "done".
 */
import { NextResponse, type NextRequest } from 'next/server';
import Papa from 'papaparse';
import { z } from 'zod';
import { dynamic, jsonHandler } from '@/lib/api';
import { requireAuth } from '@/lib/auth';
import { getEnv } from '@/lib/env';
import { ValidationError } from '@/lib/errors';
import { parseSupplierCsv } from '@/lib/csv';
import { UPLOAD_ACCEPTED_COLUMNS, UPLOAD_TEMPLATE } from '@/lib/upload-template';
import { uploadOptionsSchema } from '@/lib/validation';
import {
  bulkUpsertSuppliers,
  csvRecordIsShifted,
  extractCsvDate,
  mapCsvRecordToSupplier,
  type SupplierUpsertInput,
} from '@/services/suppliers';
import { enrichSuppliers, resolveParentLinks } from '@/services/enrichment';
import { classifySuppliers } from '@/services/classification';
import { recordAudit } from '@/services/audit';

export { dynamic };

/** Hard cap: a 25 MB CSV is roughly 200k transaction rows. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_ROWS = 100_000;

const querySchema = z.object({
  enrich: z.string().optional(),
  classify: z.string().optional(),
  skipEnrichment: z.string().optional(),
  defaultDate: z.string().optional(),
  actor: z.string().optional(),
});

export { uploadOptionsSchema };

export const POST = jsonHandler(async (request: NextRequest) => {
  await requireAuth(request);

  const env = getEnv();
  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams.entries());
  const queryOptions = querySchema.parse(query);

  let csvText: string | null = null;
  let filename = 'upload.csv';

  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      throw new ValidationError('Multipart upload must include a `file` field containing the CSV.');
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new ValidationError(
        `File is ${(file.size / 1024 / 1024).toFixed(1)} MB, which exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit.`,
      );
    }
    csvText = await file.text();
    filename = file.name || filename;

    const formActor = form.get('actor');
    if (typeof formActor === 'string' && formActor.trim()) queryOptions.actor = formActor.trim();
    const formEnrich = form.get('enrich');
    if (typeof formEnrich === 'string') queryOptions.enrich = formEnrich;
    const formClassify = form.get('classify');
    if (typeof formClassify === 'string') queryOptions.classify = formClassify;
  } else if (contentType.includes('text/csv') || contentType.includes('text/plain')) {
    const body = await request.text();
    if (body.length > MAX_UPLOAD_BYTES) throw new ValidationError('CSV body exceeds the upload limit.');
    csvText = body;
  } else {
    // Fall back to JSON: { csv: "..." } or { suppliers: [...] }
    try {
      const body = (await request.json()) as { csv?: string; suppliers?: unknown[] };
      if (typeof body.csv === 'string') {
        csvText = body.csv;
      } else if (Array.isArray(body.suppliers)) {
        csvText = Papa.unparse(body.suppliers as Array<Record<string, unknown>>);
      }
    } catch {
      csvText = null;
    }
  }

  if (!csvText) {
    throw new ValidationError(
      'No CSV content found. POST multipart/form-data with a `file` field, or a text/csv body.',
    );
  }

  const options = {
    enrich: queryOptions.enrich === undefined ? true : ['1', 'true', 'yes', 'on'].includes(queryOptions.enrich.toLowerCase()),
    classify:
      queryOptions.classify === undefined ? true : ['1', 'true', 'yes', 'on'].includes(queryOptions.classify.toLowerCase()),
    skipEnrichment: queryOptions.skipEnrichment
      ? ['1', 'true', 'yes', 'on'].includes(queryOptions.skipEnrichment.toLowerCase())
      : false,
    actor: queryOptions.actor?.trim() || env.APP_ACTOR,
  };
  if (options.skipEnrichment) options.enrich = false;

  const parsed = parseSupplierCsv(csvText);
  if (!parsed.records.length) {
    throw new ValidationError('The CSV contains no data rows.', { headers: parsed.headers });
  }
  if (parsed.records.length > MAX_ROWS) {
    throw new ValidationError(`The CSV contains ${parsed.records.length} rows; the limit is ${MAX_ROWS}.`);
  }

  // Map + validate rows before touching the database.
  const inputs: SupplierUpsertInput[] = [];
  const rowErrors: Array<{ row: number; message: string }> = [...parsed.errors];
  let shiftedRows = 0;

  parsed.records.forEach((record, index) => {
    if (csvRecordIsShifted(record)) {
      // An unquoted comma inside a field shifts every later column; the row is
      // still imported, but the caller is warned so the source file can be fixed.
      shiftedRows += 1;
      if (rowErrors.length < 30) {
        rowErrors.push({
          row: index + 2,
          message:
            'Row has more fields than the header: a value containing a comma is probably not quoted (for example an amount like $1,250.00). Columns after the comma were ignored.',
        });
      }
    }

    const mapped = mapCsvRecordToSupplier(record);
    if (!mapped) {
      rowErrors.push({ row: index + 2, message: 'Missing or empty supplier name column' });
      return;
    }
    // The transaction date is validated for feedback only: spend is aggregated per
    // supplier, and the date range is applied to `suppliers.created_at`.
    const date = extractCsvDate(record) ?? queryOptions.defaultDate ?? null;
    if (date) mapped.description = mapped.description ?? `Latest transaction date: ${date}`;
    inputs.push(mapped);
  });

  if (!inputs.length) {
    throw new ValidationError(
      'No usable rows found. The CSV needs a supplier name column (name / supplier / vendor).',
      { headers: parsed.headers, errors: rowErrors.slice(0, 25) },
    );
  }

  const summary = await bulkUpsertSuppliers(inputs, { actor: options.actor });

  let enrichmentSummary: Awaited<ReturnType<typeof enrichSuppliers>> | null = null;
  let parentLinks: Awaited<ReturnType<typeof resolveParentLinks>> | null = null;
  let classificationSummary: Awaited<ReturnType<typeof classifySuppliers>> | null = null;

  if (options.enrich && env.ENRICH_PROVIDER !== 'none' && env.ENRICH_API_KEY) {
    enrichmentSummary = await enrichSuppliers(summary.supplierIds, {
      actor: options.actor,
      detectParent: true,
    });
    parentLinks = await resolveParentLinks({ supplierIds: summary.supplierIds, actor: options.actor });
  } else {
    // Even without an enrichment provider we can still resolve parents that were
    // supplied explicitly in the CSV.
    parentLinks = await resolveParentLinks({ supplierIds: summary.supplierIds, actor: options.actor });
  }

  if (options.classify && env.GROQ_API_KEY) {
    classificationSummary = await classifySuppliers({
      supplierIds: summary.supplierIds.length <= 50 ? summary.supplierIds : undefined,
      actor: options.actor,
      limit: 500,
    });
  }

  await recordAudit(
    {
      entity: 'supplier',
      entityId: null,
      action: 'synced',
      details: {
        source: filename,
        rowsInFile: parsed.records.length,
        created: summary.created,
        updated: summary.updated,
        unchanged: summary.unchanged,
        duplicateRowsInFile: summary.duplicateRowsInFile,
        rowErrors: rowErrors.length,
        shiftedRows,
        enriched: enrichmentSummary?.enriched ?? 0,
        classified: classificationSummary?.classified ?? 0,
      },
      actor: options.actor,
    },
  );

  return NextResponse.json({
    ok: true,
    data: {
      file: { name: filename, bytes: csvText.length, delimiter: parsed.detectedDelimiter },
      columns: parsed.headers,
      upsert: {
        rowsInFile: parsed.records.length,
        created: summary.created,
        updated: summary.updated,
        unchanged: summary.unchanged,
        duplicateRowsInFile: summary.duplicateRowsInFile,
        supplierIds: summary.supplierIds,
      },
      enrichment: enrichmentSummary
        ? {
            processed: enrichmentSummary.processed,
            enriched: enrichmentSummary.enriched,
            cached: enrichmentSummary.cached,
            failed: enrichmentSummary.failed,
            creditsUsed: enrichmentSummary.creditsUsed,
            llmParentCalls: enrichmentSummary.llmParentCalls,
          }
        : null,
      parentLinks,
      classification: classificationSummary
        ? {
            classified: classificationSummary.classified,
            inherited: classificationSummary.inherited,
            failed: classificationSummary.failed,
            lowConfidence: classificationSummary.lowConfidence,
            llmRequests: classificationSummary.llmRequests,
          }
        : null,
      rowErrors: rowErrors.slice(0, 50),
      shiftedRows,
      warnings: [
        ...(shiftedRows
          ? [
              `${shiftedRows} row(s) had more fields than the header - a value containing a comma is probably unquoted. Columns after the extra comma were ignored.`,
            ]
          : []),
        ...(env.GROQ_API_KEY ? [] : ['GROQ_API_KEY is not set: classification was skipped.']),
        ...(env.ENRICH_PROVIDER === 'none' || !env.ENRICH_API_KEY
          ? ['No enrichment provider configured: suppliers were stored without web enrichment.']
          : []),
      ],
    },
  });
});

/** GET /api/upload returns the accepted template so the UI can offer a download. */
export const GET = jsonHandler(async () => {
  return NextResponse.json({
    ok: true,
    data: {
      template: UPLOAD_TEMPLATE,
      acceptedColumns: UPLOAD_ACCEPTED_COLUMNS,
    },
  });
});
