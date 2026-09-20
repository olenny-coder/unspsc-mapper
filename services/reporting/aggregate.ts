/**
 * Report aggregation: turns filtered supplier rows into the numbers that appear
 * in both the CSV and the PDF.
 *
 * Everything is computed in-process from a single `listSuppliers({ all: true })`
 * read so the CSV and PDF can never disagree, and so Neon compute time stays
 * low (an important free-tier consideration).
 */
import { getEnv } from '@/lib/env';
import { roundTo } from '@/lib/normalize';
import { describeFilters, parseReportFilters, type ReportFilters } from '@/lib/validation';
import type { DbLike } from '@/db/client';
import {
  buildHierarchy,
  rollupByParent,
  toAmount,
  type ParentRollup,
  type RollupSupplierInput,
} from '@/services/hierarchy';
import { listSuppliers, toNode, type SupplierListRow } from '@/services/suppliers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReportSummary = {
  totalSuppliers: number;
  totalSpend: number;
  classified: number;
  unclassified: number;
  percentClassified: number;
  lowConfidence: number;
  percentLowConfidence: number;
  reviewed: number;
  inherited: number;
  stale: number;
  parents: number;
  subsidiaries: number;
  averageConfidence: number | null;
  confidenceThreshold: number;
  currency: string;
};

export type SegmentBreakdownRow = {
  segmentCode: string;
  segment: string;
  suppliers: number;
  spend: number;
  spendShare: number;
  avgConfidence: number | null;
};

export type LowConfidenceRow = {
  supplierId: number;
  name: string;
  code: string | null;
  commodity: string | null;
  confidence: number | null;
  reasoning: string | null
  model: string | null;
  parentName: string | null;
  spend: number;
};

export type SupplierReportRow = {
  supplier: SupplierListRow;
  effectiveCode: string | null;
  commodity: string | null;
  parentLabel: string;
  confidence: number | null;
};

export type ReportDataset = {
  meta: {
    name: string;
    format: 'csv' | 'pdf';
    generatedAt: string;
    generatedBy: string;
    filters: ReportFilters;
    filterSummary: string[];
    dateRange: { from: string | null; to: string | null };
    rollup: 'supplier' | 'parent';
    taxonomyVersion: string;
    appUrl: string;
  };
  summary: ReportSummary;
  segments: SegmentBreakdownRow[];
  parents: ParentRollup[];
  topParents: ParentRollup[];
  lowConfidence: LowConfidenceRow[];
  rows: SupplierReportRow[];
};

export type BuildReportOptions = {
  filters?: ReportFilters | Record<string, string | string[] | undefined>;
  name?: string;
  format?: 'csv' | 'pdf';
  generatedBy?: string;
  /** Reuse rows already loaded by the caller (avoids a second DB read). */
  rows?: SupplierListRow[];
  db?: DbLike;
};

// ---------------------------------------------------------------------------
// Pure computation (unit-tested directly)
// ---------------------------------------------------------------------------

/**
 * Headline metrics for a set of supplier rows.
 *
 * `% classified` counts suppliers whose current classification exists and was
 * not superseded; `% low-confidence` counts unreviewed classifications below the
 * configured threshold, expressed over ALL suppliers (so the two percentages
 * describe the same denominator and can be read on one slide).
 */
export function summarize(
  rows: readonly SupplierListRow[],
  options: { confidenceThreshold: number; currency?: string } = { confidenceThreshold: 0.7 },
): ReportSummary {
  const threshold = options.confidenceThreshold;
  let totalSpend = 0;
  let classified = 0;
  let lowConfidence = 0;
  let reviewed = 0;
  let inherited = 0;
  let stale = 0;
  let parents = 0;
  let subsidiaries = 0;
  let confidenceSum = 0;
  let confidenceCount = 0;

  for (const row of rows) {
    totalSpend += toAmount(row.totalAmount);
    if (row.isParent) parents += 1;
    if (row.parentId !== null) subsidiaries += 1;
    if (row.stale || !row.enrichedAt) stale += 1;

    const classification = row.classification;
    if (!classification) continue;
    classified += 1;
    if (classification.reviewed) reviewed += 1;
    if (classification.inheritedFromParent) inherited += 1;
    confidenceSum += classification.confidence;
    confidenceCount += 1;
    if (classification.confidence < threshold && !classification.reviewed) lowConfidence += 1;
  }

  const total = rows.length;
  return {
    totalSuppliers: total,
    totalSpend: roundTo(totalSpend, 2),
    classified,
    unclassified: total - classified,
    percentClassified: total ? roundTo((classified / total) * 100, 1) : 0,
    lowConfidence,
    percentLowConfidence: total ? roundTo((lowConfidence / total) * 100, 1) : 0,
    reviewed,
    inherited,
    stale,
    parents,
    subsidiaries,
    averageConfidence: confidenceCount ? roundTo(confidenceSum / confidenceCount, 3) : null,
    confidenceThreshold: threshold,
    currency: options.currency ?? 'USD',
  };
}

/** UNSPSC segment breakdown with spend share, sorted by spend desc. */
export function breakdownBySegment(rows: readonly SupplierListRow[]): SegmentBreakdownRow[] {
  const buckets = new Map<
    string,
    { segmentCode: string; segment: string; suppliers: number; spend: number; confidenceSum: number; confidenceCount: number }
  >();

  let totalSpend = 0;
  for (const row of rows) {
    const classification = row.classification;
    const code = classification?.effectiveCode ?? null;
    const segmentCode = code ? code.slice(0, 2) : '--';
    const segment = classification?.segment ?? (code ? 'Unmapped segment' : 'Not classified');

    const bucket = buckets.get(segmentCode) ?? {
      segmentCode,
      segment,
      suppliers: 0,
      spend: 0,
      confidenceSum: 0,
      confidenceCount: 0,
    };
    bucket.suppliers += 1;
    const spend = toAmount(row.totalAmount);
    bucket.spend += spend;
    totalSpend += spend;
    if (classification) {
      bucket.confidenceSum += classification.confidence;
      bucket.confidenceCount += 1;
    }
    buckets.set(segmentCode, bucket);
  }

  return [...buckets.values()]
    .map((bucket) => ({
      segmentCode: bucket.segmentCode,
      segment: bucket.segment,
      suppliers: bucket.suppliers,
      spend: roundTo(bucket.spend, 2),
      spendShare: totalSpend ? roundTo((bucket.spend / totalSpend) * 100, 1) : 0,
      avgConfidence: bucket.confidenceCount ? roundTo(bucket.confidenceSum / bucket.confidenceCount, 3) : null,
    }))
    .sort((a, b) => b.spend - a.spend || a.segmentCode.localeCompare(b.segmentCode));
}

/** Rows that still need a human decision. */
export function collectLowConfidence(
  rows: readonly SupplierListRow[],
  options: { confidenceThreshold: number; limit?: number } = { confidenceThreshold: 0.7 },
): LowConfidenceRow[] {
  const limit = options.limit ?? 100;
  return rows
    .filter((row) => {
      if (!row.classification) return true;
      if (row.classification.reviewed) return false;
      return row.classification.confidence < options.confidenceThreshold;
    })
    .sort((a, b) => {
      const confidenceA = a.classification?.confidence ?? -1;
      const confidenceB = b.classification?.confidence ?? -1;
      if (confidenceA !== confidenceB) return confidenceA - confidenceB;
      return toAmount(b.totalAmount) - toAmount(a.totalAmount);
    })
    .slice(0, limit)
    .map((row) => ({
      supplierId: row.id,
      name: row.name,
      code: row.classification?.effectiveCode ?? null,
      commodity: row.classification?.commodity ?? null,
      confidence: row.classification?.confidence ?? null,
      reasoning: row.classification?.reasoning ?? null,
      model: row.classification?.llmModel ?? null,
      parentName: row.parentName,
      spend: toAmount(row.totalAmount),
    }));
}

/** Top N parents by rolled-up spend. */
export function topParentsBySpend(parents: readonly ParentRollup[], limit = 10): ParentRollup[] {
  return [...parents].sort((a, b) => b.totalAmount - a.totalAmount).slice(0, limit);
}

/** A supplier row's display parent label. */
export function parentLabelFor(row: SupplierListRow, parentNamesById: Map<number, string>): string {
  if (row.parentId !== null) {
    const linked = parentNamesById.get(row.parentId);
    if (linked) return linked;
  }
  if (row.parentName) return row.parentName;
  if (row.isParent || row.subsidiaryCount > 0) return `${row.name} (parent)`;
  return 'Independent';
}

// ---------------------------------------------------------------------------
// Dataset assembly
// ---------------------------------------------------------------------------

export async function buildReportDataset(options: BuildReportOptions = {}): Promise<ReportDataset> {
  const env = getEnv();
  const filters = (
    options.filters && 'rollup' in (options.filters as ReportFilters)
      ? (options.filters as ReportFilters)
      : parseReportFilters((options.filters ?? {}) as Record<string, string | string[] | undefined>)
  ) as ReportFilters;

  const rows =
    options.rows ??
    (
      await listSuppliers({
        all: true,
        filters,
        sort: 'name',
        dir: 'asc',
        db: options.db,
      })
    ).rows;

  const threshold = env.CLASSIFY_CONFIDENCE_THRESHOLD;
  const summary = summarize(rows, { confidenceThreshold: threshold, currency: rows[0]?.currency ?? 'USD' });
  const segments = breakdownBySegment(rows);

  const rollupInputs: RollupSupplierInput[] = rows.map((row) => {
    const node = toNode(row);
    return { ...node } satisfies RollupSupplierInput;
  });
  const parents = rollupByParent(rollupInputs, threshold);

  const parentNamesById = new Map(rows.map((row) => [row.id, row.name]));
  const reportRows: SupplierReportRow[] = rows.map((row) => ({
    supplier: row,
    effectiveCode: row.classification?.effectiveCode ?? null,
    commodity: row.classification?.commodity ?? null,
    parentLabel: parentLabelFor(row, parentNamesById),
    confidence: row.classification?.confidence ?? null,
  }));

  const now = new Date();
  return {
    meta: {
      name: options.name?.trim() || `UNSPSC spend report ${now.toISOString().slice(0, 10)}`,
      format: options.format ?? 'csv',
      generatedAt: now.toISOString(),
      generatedBy: options.generatedBy ?? env.APP_ACTOR,
      filters,
      filterSummary: describeFilters(filters),
      dateRange: { from: filters.from ?? null, to: filters.to ?? null },
      rollup: filters.rollup ?? 'supplier',
      taxonomyVersion: env.UNSPSC_VERSION,
      appUrl: env.NEXT_PUBLIC_APP_URL,
    },
    summary,
    segments,
    parents,
    topParents: topParentsBySpend(parents, 10),
    lowConfidence: collectLowConfidence(rows, { confidenceThreshold: threshold, limit: 100 }),
    rows: reportRows,
  };
}

/** Hierarchy table for the PDF/appendix: parent -> subsidiaries. */
export function hierarchyRows(dataset: ReportDataset): Array<{
  parentName: string;
  parentCode: string | null;
  supplierCount: number;
  subsidiaryCount: number;
  totalAmount: number;
  staleCount: number;
  lowConfidenceCount: number;
  subsidiaries: Array<{ name: string; code: string | null; confidence: number | null; amount: number }>;
}> {
  const byId = new Map(dataset.rows.map((row) => [row.supplier.id, row]));
  const nodes = dataset.rows.map((row) => toNode(row.supplier));
  const tree = buildHierarchy(nodes);

  return tree.clusters.map((cluster) => {
    const rollup = dataset.parents.find((parent) => parent.clusterKey === cluster.key);
    const subsidiaries = cluster.members
      .filter((member) => !member.isRoot)
      .map((member) => {
        const row = byId.get(member.supplier.id);
        return {
          name: member.supplier.name,
          code: row?.effectiveCode ?? null,
          confidence: row?.confidence ?? null,
          amount: toAmount(member.supplier.totalAmount),
        };
      });

    const rootRow = cluster.rootId !== null ? byId.get(cluster.rootId) : undefined;

    return {
      parentName: cluster.rootName,
      parentCode: rootRow?.effectiveCode ?? null,
      supplierCount: cluster.members.length,
      subsidiaryCount: cluster.subsidiaryCount,
      totalAmount: roundTo(cluster.totalAmount, 2),
      staleCount: rollup?.staleCount ?? 0,
      lowConfidenceCount: rollup?.lowConfidenceCount ?? 0,
      subsidiaries,
    };
  });
}
