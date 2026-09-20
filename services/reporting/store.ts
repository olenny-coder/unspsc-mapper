/**
 * Report persistence.
 *
 * Generated reports are stored in Neon as `bytea` (the schema's `reports.blob`).
 * A weekly PDF is roughly 30-120 KB, so ~12 months of weekly reports fits
 * comfortably inside the 0.5 GB Neon free tier; the size is enforced here so a
 * large ad-hoc export cannot blow the quota.
 */
import { and, count, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { reports } from '@/db/schema';
import { getDb, type DbLike } from '@/db/client';
import { ValidationError } from '@/lib/errors';
import type { ReportFilters } from '@/lib/validation';
import { buildReportDataset, type ReportDataset } from '@/services/reporting/aggregate';
import { csvBytes, renderSupplierCsv, reportFilename } from '@/services/reporting/csv';
import { pdfFilename, renderSupplierPdf } from '@/services/reporting/pdf';
import { recordAudit } from '@/services/audit';

/** Refuse to store anything larger than this (protects the Neon free tier). */
export const MAX_STORED_REPORT_BYTES = 4 * 1024 * 1024; // 4 MB

export type GenerateReportOptions = {
  name?: string;
  format: 'csv' | 'pdf';
  filters?: ReportFilters | Record<string, string | string[] | undefined>;
  generatedBy?: string;
  /** Persist the bytes in `reports.blob`. */
  store?: boolean;
  schedule?: 'manual' | 'weekly' | 'monthly';
  db?: DbLike;
};

export type GeneratedReport = {
  name: string;
  format: 'csv' | 'pdf';
  filename: string;
  contentType: string;
  /** Node buffer, so it can be handed straight to a Response body. */
  bytes: Buffer;
  rowCount: number;
  dataset: ReportDataset;
  storedId: number | null;
  storedBytes: number;
};
const CONTENT_TYPES = {
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
} as const;

/**
 * Build a report, optionally persisting it. Returns the bytes plus the dataset
 * so the API can stream the file and the UI can preview the numbers.
 */
export async function generateReport(options: GenerateReportOptions): Promise<GeneratedReport> {
  const db = options.db ?? getDb();
  const generatedBy = options.generatedBy?.trim() || 'system';

  const dataset = await buildReportDataset({
    filters: options.filters,
    name: options.name,
    format: options.format,
    generatedBy,
    db: db as never,
  });

  const bytes: Buffer =
    options.format === 'pdf'
      ? Buffer.from(await renderSupplierPdf(dataset))
      : csvBytes(renderSupplierCsv(dataset, { includeMetadata: true, verbose: true }));

  const filename =
    options.format === 'pdf'
      ? pdfFilename(dataset.meta.name)
      : reportFilename(dataset.meta.name, 'csv', 'csv');

  let storedId: number | null = null;
  let storedBytes = 0;

  if (options.store) {
    if (bytes.byteLength > MAX_STORED_REPORT_BYTES) {
      throw new ValidationError(
        `Report is ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB, which exceeds the ${(
          MAX_STORED_REPORT_BYTES /
          1024 /
          1024
        ).toFixed(0)} MB storage limit. Re-run the export with narrower filters, or download it without storing.`,
        { bytes: bytes.byteLength, limit: MAX_STORED_REPORT_BYTES },
      );
    }

    const inserted = await db
      .insert(reports)
      .values({
        name: dataset.meta.name,
        format: options.format,
        filters: {
          ...(dataset.meta.filters as unknown as Record<string, unknown>),
          filterSummary: dataset.meta.filterSummary,
          schedule: options.schedule ?? 'manual',
        },
        rowCount: dataset.rows.length,
        sizeBytes: bytes.byteLength,
        generatedBy,
        blob: Buffer.from(bytes),
      })
      .returning({ id: reports.id });

    storedId = inserted[0]?.id ?? null;
    storedBytes = bytes.byteLength;

    await recordAudit(
      {
        entity: 'report',
        entityId: storedId,
        action: 'report_generated',
        details: {
          format: options.format,
          rows: dataset.rows.length,
          sizeBytes: bytes.byteLength,
          filters: dataset.meta.filterSummary,
          schedule: options.schedule ?? 'manual',
        },
        actor: generatedBy,
      },
      db,
    );
  }

  return {
    name: dataset.meta.name,
    format: options.format,
    filename,
    contentType: CONTENT_TYPES[options.format],
    bytes,
    rowCount: dataset.rows.length,
    dataset,
    storedId,
    storedBytes,
  };
}

export type ReportListRow = {
  id: number;
  name: string;
  format: string;
  filters: Record<string, unknown> | null;
  rowCount: number;
  sizeBytes: number;
  generatedBy: string;
  createdAt: string;
  hasBlob: boolean;
};

export type ReportListPage = {
  reports: ReportListRow[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  totalStoredBytes: number;
};

/** List stored reports for the `/reports` page (never selects the blob). */
export async function listReports(
  options: { page?: number; pageSize?: number; format?: 'csv' | 'pdf'; from?: string; to?: string; db?: DbLike } = {},
): Promise<ReportListPage> {
  const db = options.db ?? getDb();
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 25));

  const filters: SQL[] = [];
  if (options.format) filters.push(eq(reports.format, options.format));
  if (options.from) filters.push(gte(reports.createdAt, new Date(options.from)));
  if (options.to) filters.push(lte(reports.createdAt, new Date(options.to)));
  const where = filters.length ? and(...filters) : undefined;

  const [rows, totals, sizeTotal] = await Promise.all([
    db
      .select({
        id: reports.id,
        name: reports.name,
        format: reports.format,
        filters: reports.filters,
        rowCount: reports.rowCount,
        sizeBytes: reports.sizeBytes,
        generatedBy: reports.generatedBy,
        createdAt: reports.createdAt,
        blobSize: sql<number | null>`case when ${reports.blob} is null then null else octet_length(${reports.blob}) end`,
      })
      .from(reports)
      .where(where)
      .orderBy(desc(reports.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ value: count() }).from(reports).where(where),
    db.select({ value: sql<number>`coalesce(sum(${reports.sizeBytes}), 0)` }).from(reports).where(where),
  ]);

  const total = Number(totals[0]?.value ?? 0);
  return {
    reports: rows.map((row) => ({
      id: row.id,
      name: row.name,
      format: row.format,
      filters: (row.filters as Record<string, unknown> | null) ?? null,
      rowCount: row.rowCount,
      sizeBytes: row.sizeBytes,
      generatedBy: row.generatedBy,
      createdAt: row.createdAt.toISOString(),
      hasBlob: row.blobSize !== null,
    })),
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    totalStoredBytes: Number(sizeTotal[0]?.value ?? 0),
  };
}

/** Fetch a stored report's bytes for download. */
export async function getStoredReport(
  id: number,
  db: DbLike = getDb(),
): Promise<{ id: number; name: string; format: string; bytes: Uint8Array; createdAt: string } | null> {
  const rows = await db.select().from(reports).where(eq(reports.id, id)).limit(1);
  const row = rows[0];
  if (!row || !row.blob) return null;
  return {
    id: row.id,
    name: row.name,
    format: row.format,
    bytes: new Uint8Array(row.blob),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Delete a stored report (frees Neon storage). */
export async function deleteReport(id: number, options: { actor?: string; db?: DbLike } = {}): Promise<boolean> {
  const db = options.db ?? getDb();
  const deleted = await db.delete(reports).where(eq(reports.id, id)).returning({ id: reports.id });
  if (!deleted.length) return false;
  await recordAudit(
    {
      entity: 'report',
      entityId: id,
      action: 'updated',
      details: { deleted: true },
      actor: options.actor ?? 'dashboard',
    },
    db,
  );
  return true;
}

/**
 * Retention: keep the newest `keep` rows per format and drop the rest. Called by
 * the worker so stored blobs never grow without bound.
 */
export async function pruneOldReports(
  keep = 30,
  options: { db?: DbLike; actor?: string } = {},
): Promise<{ deleted: number; freedBytes: number }> {
  const db = options.db ?? getDb();

  let deleted = 0;
  let freedBytes = 0;

  for (const format of ['pdf', 'csv'] as const) {
    const stale = await db
      .select({ id: reports.id, sizeBytes: reports.sizeBytes })
      .from(reports)
      .where(eq(reports.format, format))
      .orderBy(desc(reports.createdAt))
      .offset(keep);

    if (!stale.length) continue;

    await db.delete(reports).where(
      sql`${reports.id} in (${sql.join(
        stale.map((row) => sql`${row.id}`),
        sql`, `,
      )})`,
    );

    const formatFreed = stale.reduce((sum, row) => sum + row.sizeBytes, 0);
    deleted += stale.length;
    freedBytes += formatFreed;

    await recordAudit(
      {
        entity: 'report',
        entityId: null,
        action: 'updated',
        details: { pruned: stale.length, format, kept: keep, freedBytes: formatFreed },
        actor: options.actor ?? 'worker',
      },
      db,
    );
  }

  return { deleted, freedBytes };
}

/** Convenience used by the worker's weekly job. */
export async function generateWeeklyReport(db: DbLike = getDb()): Promise<GeneratedReport> {
  const now = new Date();
  const name = `Weekly UNSPSC spend report ${now.toISOString().slice(0, 10)}`;
  return generateReport({
    name,
    format: 'pdf',
    filters: { rollup: 'parent' } as ReportFilters,
    generatedBy: 'worker',
    store: true,
    schedule: 'weekly',
    db,
  });
}
