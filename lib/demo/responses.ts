/**
 * The demo read surface.
 *
 * This module is the *only* thing that answers an anonymous visitor when
 * `DEMO_MODE=true`. It reads `lib/demo/dataset.ts` — a bundled, illustrative
 * snapshot — and never touches the database, a service, or a provider.
 *
 * The isolation is structural rather than a matter of remembering to add a check:
 * `jsonHandler` (see `lib/api.ts`) diverts a demo request here *before* the route's
 * own handler runs, so a real handler and its queries are unreachable on this path.
 * A path this module does not recognise is refused rather than falling through, so
 * a newly added endpoint is private until it is deliberately exposed.
 *
 * Derived figures (segment totals, rollups, the review queue) are computed from the
 * fixture rows rather than hand-written, so the numbers on screen agree with each
 * other instead of merely looking plausible.
 */
import { NextResponse, type NextRequest } from 'next/server';
import type {
  AuditEntryDto,
  AuditPageDto,
  HierarchyClusterDto,
  MetricsDto,
  ParentRollupDto,
  ReportListDto,
  ReviewRowDto,
  SegmentDto,
  SettingsDto,
  SupplierRowDto,
  SummaryDto,
} from '@/lib/client';
import { DEMO_AUDIT_ENTRIES, DEMO_CODE_SEARCH, DEMO_CURRENCY, DEMO_REPORTS, DEMO_SUPPLIER_ROWS } from '@/lib/demo/dataset';
import { DemoReadOnlyError, NotFoundError, serializeError } from '@/lib/errors';
import { UPLOAD_ACCEPTED_COLUMNS, UPLOAD_TEMPLATE } from '@/lib/upload-template';

/** Mirrors the seeded setting; a demo visitor cannot change it. */
const CONFIDENCE_THRESHOLD = 0.7;

/**
 * Mirrors `GROQ_MODEL_CHOICES` in `services/groq.ts`.
 *
 * Duplicated deliberately: importing that module would pull the provider client
 * into the demo's dependency graph for the sake of a dropdown.
 */
const MODEL_CHOICES = [
  { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile (accurate, 1k req/day)' },
  { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant (bulk, 14.4k req/day)' },
];

const ACCURATE_MODEL = 'llama-3.3-70b-versatile';
const BULK_MODEL = 'llama-3.1-8b-instant';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ClassifiedRow = SupplierRowDto & {
  classification: NonNullable<SupplierRowDto['classification']>;
};

function classifiedRows(rows: readonly SupplierRowDto[]): ClassifiedRow[] {
  return rows.filter((row): row is ClassifiedRow => row.classification !== null);
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function share(part: number, whole: number): number {
  return whole > 0 ? round(part / whole, 4) : 0;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Today's UTC date, so the demo does not look frozen in time. */
function demoDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function firstParam(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)?.trim();
  return value ? value : undefined;
}

function boolParam(params: URLSearchParams, key: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes((params.get(key) ?? '').toLowerCase());
}

function numberParam(params: URLSearchParams, key: string): number | undefined {
  const raw = firstParam(params, key);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// ---------------------------------------------------------------------------
// Derived figures
// ---------------------------------------------------------------------------

function summaryOf(rows: readonly SupplierRowDto[]): SummaryDto {
  const scored = classifiedRows(rows);
  const totalSpend = sum(rows.map((row) => row.totalAmount));
  const lowConfidence = scored.filter((row) => row.classification.confidence < CONFIDENCE_THRESHOLD);
  const confidences = scored.map((row) => row.classification.confidence);

  return {
    totalSuppliers: rows.length,
    totalSpend: round(totalSpend, 2),
    classified: scored.length,
    unclassified: rows.length - scored.length,
    percentClassified: share(scored.length, rows.length),
    lowConfidence: lowConfidence.length,
    percentLowConfidence: share(lowConfidence.length, Math.max(scored.length, 1)),
    reviewed: scored.filter((row) => row.classification.reviewed).length,
    inherited: scored.filter((row) => row.classification.inheritedFromParent).length,
    stale: rows.filter((row) => row.stale).length,
    parents: rows.filter((row) => row.isParent).length,
    subsidiaries: rows.filter((row) => row.parentId !== null).length,
    averageConfidence: confidences.length ? round(sum(confidences) / confidences.length) : null,
    confidenceThreshold: CONFIDENCE_THRESHOLD,
    currency: DEMO_CURRENCY,
  };
}

function segmentsOf(rows: readonly SupplierRowDto[]): SegmentDto[] {
  const buckets = new Map<string, { segment: string; spend: number; suppliers: number; scores: number[] }>();

  for (const row of classifiedRows(rows)) {
    // Grouped on `effectiveCode`, matching production
    // (`coalesce(correctedCode, unspscCode)` in services/suppliers.ts). Using the
    // original code instead would file a human-corrected row under its old
    // segment, so a bar would carry the wrong segment's name.
    const code = row.classification.effectiveCode.slice(0, 2);
    const bucket = buckets.get(code) ?? {
      segment: row.classification.segment ?? `Segment ${code}`,
      spend: 0,
      suppliers: 0,
      scores: [],
    };
    bucket.spend += row.totalAmount;
    bucket.suppliers += 1;
    bucket.scores.push(row.classification.confidence);
    buckets.set(code, bucket);
  }

  const totalSpend = sum([...buckets.values()].map((bucket) => bucket.spend));

  return [...buckets.entries()]
    .map(([segmentCode, bucket]) => ({
      segmentCode,
      segment: bucket.segment,
      suppliers: bucket.suppliers,
      spend: round(bucket.spend, 2),
      spendShare: share(bucket.spend, totalSpend),
      avgConfidence: bucket.scores.length ? round(sum(bucket.scores) / bucket.scores.length) : null,
    }))
    .sort((a, b) => b.spend - a.spend);
}

/**
 * One entry per corporate family.
 *
 * A row with subsidiaries becomes a real parent cluster; a standalone supplier
 * becomes a single-member cluster flagged `isVirtualRoot`, matching how the real
 * roll-up represents a company with no declared group.
 */
function rollupOf(rows: readonly SupplierRowDto[]): ParentRollupDto[] {
  const children = new Map<number, SupplierRowDto[]>();
  for (const row of rows) {
    if (row.parentId === null) continue;
    const bucket = children.get(row.parentId) ?? [];
    bucket.push(row);
    children.set(row.parentId, bucket);
  }

  const clusters: ParentRollupDto[] = [];

  for (const row of rows) {
    if (row.parentId !== null) continue;

    const members = [row, ...(children.get(row.id) ?? [])];
    const classified = classifiedRows(members);
    const scored = classified.map((member) => member.classification);
    const codes = new Set(scored.map((classification) => classification.effectiveCode));

    clusters.push({
      clusterKey: `demo-${row.id}`,
      parentId: row.isParent ? row.id : null,
      parentName: row.name,
      parentDomain: row.domain,
      isVirtualRoot: !row.isParent,
      supplierCount: members.length,
      subsidiaryCount: members.length - 1,
      totalAmount: round(sum(members.map((member) => member.totalAmount)), 2),
      unspscCode: codes.size === 1 ? [...codes][0] ?? null : null,
      confidence: scored.length
        ? round(sum(scored.map((classification) => classification.confidence)) / scored.length)
        : null,
      staleCount: members.filter((member) => member.stale).length,
      lowConfidenceCount: scored.filter((classification) => classification.confidence < CONFIDENCE_THRESHOLD).length,
    });
  }

  return clusters.sort((a, b) => b.totalAmount - a.totalAmount);
}

function reviewReasons(row: SupplierRowDto): string[] {
  const reasons: string[] = [];
  if (!row.classification) {
    reasons.push('Never classified');
    return reasons;
  }
  if (row.classification.confidence < CONFIDENCE_THRESHOLD) reasons.push('Below the confidence threshold');
  if (row.classification.inheritedFromParent) reasons.push('Inherited from its parent company, not classified directly');
  if (row.stale) reasons.push(row.staleReason ?? 'Data is stale');
  if (!row.classification.reviewed) reasons.push('Not yet reviewed by a human');
  return reasons;
}

function reviewRows(rows: readonly SupplierRowDto[]): ReviewRowDto[] {
  return rows
    .map((row) => ({ row, reasons: reviewReasons(row) }))
    .filter(({ row }) => row.classification === null || row.classification.confidence < CONFIDENCE_THRESHOLD)
    .map(({ row, reasons }) => ({
      supplierId: row.id,
      name: row.name,
      domain: row.domain,
      industry: row.industry,
      totalAmount: row.totalAmount,
      parentName: row.parentName,
      confidence: row.classification?.confidence ?? null,
      code: row.classification?.effectiveCode ?? null,
      commodity: row.classification?.commodity ?? null,
      reasoning: row.classification?.reasoning ?? null,
      llmModel: row.classification?.llmModel ?? null,
      inheritedFromParent: row.classification?.inheritedFromParent ?? false,
      reasons,
    }))
    .sort((a, b) => (a.confidence ?? 0) - (b.confidence ?? 0));
}

// ---------------------------------------------------------------------------
// Filtering and paging
// ---------------------------------------------------------------------------

function applyFilters(rows: readonly SupplierRowDto[], params: URLSearchParams): SupplierRowDto[] {
  const search = firstParam(params, 'search')?.toLowerCase();
  const segment = firstParam(params, 'segment');
  const prefix = firstParam(params, 'unspscPrefix');
  const industry = firstParam(params, 'industry')?.toLowerCase();
  const country = firstParam(params, 'country')?.toLowerCase();
  const parent = firstParam(params, 'parent')?.toLowerCase();
  const parentId = numberParam(params, 'parentId');
  const minConfidence = numberParam(params, 'minConfidence');
  const maxConfidence = numberParam(params, 'maxConfidence');
  const confidenceState = firstParam(params, 'confidenceState') ?? 'all';
  const supplierIds = firstParam(params, 'supplierIds')
    ?.split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value));

  return rows.filter((row) => {
    if (search && !`${row.name} ${row.domain ?? ''} ${row.industry ?? ''}`.toLowerCase().includes(search)) return false;
    if (industry && !(row.industry ?? '').toLowerCase().includes(industry)) return false;
    if (country && !(row.country ?? '').toLowerCase().includes(country)) return false;
    if (parent && !(row.parentName ?? row.name).toLowerCase().includes(parent)) return false;
    if (parentId !== undefined && row.parentId !== parentId && row.id !== parentId) return false;
    if (supplierIds?.length && !supplierIds.includes(row.id)) return false;

    const code = row.classification?.effectiveCode ?? '';
    if (segment && !(row.classification?.segment ?? '').toLowerCase().includes(segment.toLowerCase())) return false;
    if (prefix && !code.startsWith(prefix)) return false;

    if (boolParam(params, 'onlyParents') && !row.isParent) return false;
    if (boolParam(params, 'onlySubsidiaries') && row.parentId === null) return false;
    if (boolParam(params, 'onlyStale') && !row.stale) return false;

    const confidence = row.classification?.confidence ?? null;
    if (minConfidence !== undefined && (confidence ?? 0) < minConfidence) return false;
    if (maxConfidence !== undefined && (confidence ?? 1) > maxConfidence) return false;

    if (confidenceState === 'unclassified') return row.classification === null;
    if (confidenceState === 'low') {
      return row.classification !== null && row.classification.confidence < CONFIDENCE_THRESHOLD;
    }
    if (confidenceState === 'reviewed') return row.classification?.reviewed === true;
    if (confidenceState === 'unreviewed') {
      return row.classification !== null && row.classification.reviewed === false;
    }
    return true;
  });
}

function sortRows(rows: SupplierRowDto[], params: URLSearchParams): SupplierRowDto[] {
  const key = firstParam(params, 'sort') ?? 'name';
  const direction = firstParam(params, 'dir') === 'desc' ? -1 : 1;

  const value = (row: SupplierRowDto): string | number => {
    switch (key) {
      case 'amount':
      case 'totalAmount':
      case 'spend':
        return row.totalAmount;
      case 'confidence':
        return row.classification?.confidence ?? -1;
      case 'updated':
      case 'updatedAt':
        return row.updatedAt;
      case 'segment':
        return row.classification?.segment ?? '';
      default:
        return row.name.toLowerCase();
    }
  };

  return [...rows].sort((a, b) => {
    const left = value(a);
    const right = value(b);
    if (typeof left === 'number' && typeof right === 'number') return (left - right) * direction;
    return String(left).localeCompare(String(right)) * direction;
  });
}

// ---------------------------------------------------------------------------
// Endpoint payloads
// ---------------------------------------------------------------------------

function metricsPayload(params: URLSearchParams): MetricsDto {
  const rows = applyFilters(DEMO_SUPPLIER_ROWS, params);
  const includeUsage = firstParam(params, 'usage') !== 'false';
  const rollup = rollupOf(rows);
  const queue = reviewRows(rows);

  return {
    threshold: CONFIDENCE_THRESHOLD,
    summary: summaryOf(rows),
    segments: segmentsOf(rows),
    topParents: rollup.slice(0, 8),
    rollup,
    reviewQueueSize: queue.length,
    reviewPreview: queue.slice(0, 5),
    recentSuppliers: [...rows]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 8)
      .map((row) => ({
        id: row.id,
        name: row.name,
        code: row.classification?.effectiveCode ?? null,
        confidence: row.classification?.confidence ?? null,
        stale: row.stale,
        updatedAt: row.updatedAt,
      })),
    usage: includeUsage
      ? {
          day: demoDay(),
          reserve: 50,
          models: [
            { model: ACCURATE_MODEL, requestCount: 128, dailyLimit: 1000, remaining: 872 },
            { model: BULK_MODEL, requestCount: 940, dailyLimit: 14400, remaining: 13460 },
          ],
        }
      : null,
    enrichmentCreditsUsedThisMonth: 0,
    lastSync: { at: daysAgo(1), summary: { mode: 'incremental', checked: rows.length, stale: rows.filter((r) => r.stale).length } },
    settings: {
      confidenceThreshold: CONFIDENCE_THRESHOLD,
      modelStrategy: 'tiered',
      accurateModel: ACCURATE_MODEL,
      bulkModel: BULK_MODEL,
      parentDetectionEnabled: true,
      syncEnabled: true,
      staleAfterDays: 30,
      batchSize: 25,
      weeklyReportEnabled: true,
      syncCron: '0 3 * * *',
      weeklyReportCron: '0 6 * * 1',
    },
    secrets: {
      groqConfigured: true,
      enrichConfigured: false,
      workerSecretConfigured: true,
      groqMasked: 'gsk_demo••••••••••••',
      enrichMasked: null,
    },
  };
}

function suppliersPayload(params: URLSearchParams): unknown {
  const rows = sortRows(applyFilters(DEMO_SUPPLIER_ROWS, params), params);
  const stats = summaryOf(rows);

  if (boolParam(params, 'meta')) {
    const seen = new Map<string, { segmentCode: string; segment: string; codes: Set<string> }>();
    for (const row of classifiedRows(rows)) {
      const code = row.classification.effectiveCode;
      const key = code.slice(0, 2);
      const bucket = seen.get(key) ?? {
        segmentCode: key,
        segment: row.classification.segment ?? `Segment ${key}`,
        codes: new Set<string>(),
      };
      bucket.codes.add(code);
      seen.set(key, bucket);
    }

    return {
      segments: [...seen.values()]
        .map((bucket) => ({ segmentCode: bucket.segmentCode, segment: bucket.segment, codes: bucket.codes.size }))
        .sort((a, b) => a.segment.localeCompare(b.segment)),
      parents: rows
        .filter((row) => row.isParent)
        .map((row) => ({
          id: row.id,
          name: row.name,
          subsidiaries: row.subsidiaryCount,
          totalAmount: row.totalAmount,
        }))
        .sort((a, b) => b.totalAmount - a.totalAmount),
      currency: DEMO_CURRENCY,
    };
  }

  const pageSize = Math.min(Math.max(numberParam(params, 'pageSize') ?? 25, 1), 500);
  const pages = Math.max(Math.ceil(rows.length / pageSize), 1);
  const page = Math.min(Math.max(numberParam(params, 'page') ?? 1, 1), pages);
  const start = (page - 1) * pageSize;

  return {
    rows: rows.slice(start, start + pageSize),
    total: rows.length,
    page,
    pageSize,
    pages,
    stats,
    rollup: rollupOf(rows),
  };
}

function supplierDetailPayload(id: number): unknown {
  const supplier = DEMO_SUPPLIER_ROWS.find((row) => row.id === id);
  if (!supplier) throw new NotFoundError(`No demo supplier with id ${id}.`);

  const parent = supplier.parentId === null
    ? null
    : DEMO_SUPPLIER_ROWS.find((row) => row.id === supplier.parentId) ?? null;
  const subsidiaries = DEMO_SUPPLIER_ROWS.filter((row) => row.parentId === supplier.id);

  const history = supplier.classification
    ? [
        {
          id: supplier.classification.id,
          code: supplier.classification.unspscCode,
          confidence: supplier.classification.confidence,
          reasoning: supplier.classification.reasoning,
          llmModel: supplier.classification.llmModel,
          inherited: supplier.classification.inheritedFromParent,
          reviewed: supplier.classification.reviewed,
          superseded: false,
          createdAt: supplier.updatedAt,
        },
      ]
    : [];

  const corrections =
    supplier.classification?.correctedCode
      ? [
          {
            id: supplier.classification.id + 900_000,
            originalCode: supplier.classification.unspscCode,
            correctedCode: supplier.classification.correctedCode,
            correctedBy: 'demo-seed',
            reason: 'Illustrative correction demonstrating the review loop.',
            appliedToSubsidiaries: false,
            createdAt: supplier.updatedAt,
          },
        ]
      : [];

  return {
    supplier,
    parent: parent ? { id: parent.id, name: parent.name, domain: parent.domain } : null,
    subsidiaries: subsidiaries.map((row) => ({
      id: row.id,
      name: row.name,
      domain: row.domain,
      totalAmount: row.totalAmount,
    })),
    descendantCount: subsidiaries.length,
    history,
    corrections,
    audits: DEMO_AUDIT_ENTRIES.filter((entry) => entry.entity === 'supplier' && entry.entityId === supplier.id),
  };
}

function classificationsPayload(params: URLSearchParams): unknown {
  const rows = applyFilters(DEMO_SUPPLIER_ROWS, params);
  const view = firstParam(params, 'view') ?? 'segments';

  if (view === 'queue') {
    const threshold = numberParam(params, 'threshold') ?? CONFIDENCE_THRESHOLD;
    const limit = Math.min(Math.max(numberParam(params, 'limit') ?? 500, 1), 500);
    const all = reviewRows(rows);
    const queue = threshold === CONFIDENCE_THRESHOLD ? all : all.filter((row) => (row.confidence ?? 0) < threshold);
    return { threshold, count: queue.length, rows: queue.slice(0, limit) };
  }

  return { segments: segmentsOf(rows) };
}

function hierarchyPayload(params: URLSearchParams): unknown {
  const rows = applyFilters(DEMO_SUPPLIER_ROWS, params);
  const children = new Map<number, SupplierRowDto[]>();
  for (const row of rows) {
    if (row.parentId === null) continue;
    const bucket = children.get(row.parentId) ?? [];
    bucket.push(row);
    children.set(row.parentId, bucket);
  }

  const clusters: HierarchyClusterDto[] = [];
  for (const root of rows) {
    if (root.parentId !== null) continue;
    const kids = children.get(root.id) ?? [];

    clusters.push({
      key: `demo-${root.id}`,
      rootId: root.isParent ? root.id : null,
      rootName: root.name,
      rootDomain: root.domain,
      isVirtualRoot: !root.isParent,
      subsidiaryCount: kids.length,
      totalAmount: round(root.totalAmount + sum(kids.map((kid) => kid.totalAmount)), 2),
      members: [
        {
          id: root.id,
          name: root.name,
          domain: root.domain,
          industry: root.industry,
          isRoot: true,
          depth: 0,
          totalAmount: root.totalAmount,
          parentSource: root.parentSource,
          stale: root.stale,
        },
        ...kids.map((kid) => ({
          id: kid.id,
          name: kid.name,
          domain: kid.domain,
          industry: kid.industry,
          isRoot: false,
          depth: 1,
          totalAmount: kid.totalAmount,
          parentSource: kid.parentSource,
          stale: kid.stale,
        })),
      ],
    });
  }

  return {
    clusters: clusters.sort((a, b) => b.totalAmount - a.totalAmount),
    totals: {
      clusters: clusters.length,
      parents: rows.filter((row) => row.isParent).length,
      suppliers: rows.length,
      orphans: 0,
    },
    hadCycle: false,
    orphans: [] as Array<{ id: number; name: string; parentName: string | null }>,
  };
}

/** Count entries by one of two keys, most frequent first. */
function tally(entries: readonly AuditEntryDto[], key: 'action' | 'entity'): Array<{ name: string; count: number }> {
  const buckets = new Map<string, number>();
  for (const entry of entries) {
    const value = key === 'action' ? entry.action : entry.entity;
    buckets.set(value, (buckets.get(value) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function auditPayload(params: URLSearchParams): unknown {
  const entries = [...DEMO_AUDIT_ENTRIES].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (firstParam(params, 'view') === 'summary') {
    return {
      byAction: tally(entries, 'action').map(({ name, count }) => ({ action: name, count })),
      byEntity: tally(entries, 'entity').map(({ name, count }) => ({ entity: name, count })),
      recent: entries.slice(0, 10),
    };
  }

  const action = firstParam(params, 'action');
  const entity = firstParam(params, 'entity');
  const search = firstParam(params, 'search')?.toLowerCase();

  const filtered = entries.filter((entry) => {
    if (action && entry.action !== action) return false;
    if (entity && entry.entity !== entity) return false;
    if (search && !`${entry.actor} ${entry.action} ${JSON.stringify(entry.details ?? {})}`.toLowerCase().includes(search)) {
      return false;
    }
    return true;
  });

  const pageSize = Math.min(Math.max(numberParam(params, 'pageSize') ?? 25, 1), 200);
  const pages = Math.max(Math.ceil(filtered.length / pageSize), 1);
  const page = Math.min(Math.max(numberParam(params, 'page') ?? 1, 1), pages);
  const start = (page - 1) * pageSize;

  const body: AuditPageDto = {
    entries: filtered.slice(start, start + pageSize),
    total: filtered.length,
    page,
    pageSize,
    pages,
  };
  return body;
}

function reportsPayload(params: URLSearchParams): unknown {
  const totalStoredBytes = sum(DEMO_REPORTS.map((report) => report.sizeBytes));

  if (firstParam(params, 'view') === 'budget') {
    return {
      storedBytes: totalStoredBytes,
      reportCount: DEMO_REPORTS.length,
      largestReportBytes: Math.max(...DEMO_REPORTS.map((report) => report.sizeBytes), 0),
      maxStoredReportBytes: 4 * 1024 * 1024,
      shareOfNeonFreeTier: round(totalStoredBytes / (500 * 1024 * 1024), 4),
    };
  }

  const pageSize = Math.min(Math.max(numberParam(params, 'pageSize') ?? 25, 1), 100);
  const pages = Math.max(Math.ceil(DEMO_REPORTS.length / pageSize), 1);
  const page = Math.min(Math.max(numberParam(params, 'page') ?? 1, 1), pages);
  const start = (page - 1) * pageSize;

  const body: ReportListDto = {
    reports: DEMO_REPORTS.slice(start, start + pageSize),
    total: DEMO_REPORTS.length,
    page,
    pageSize,
    pages,
    totalStoredBytes,
  };
  return body;
}

function settingsPayload(): SettingsDto {
  return {
    settings: {
      id: 1,
      confidenceThreshold: String(CONFIDENCE_THRESHOLD),
      modelStrategy: 'tiered',
      accurateModel: ACCURATE_MODEL,
      bulkModel: BULK_MODEL,
      parentDetectionEnabled: true,
      enrichmentEnabled: false,
      syncEnabled: true,
      syncCron: '0 3 * * *',
      staleAfterDays: 30,
      batchSize: 25,
      weeklyReportEnabled: true,
      weeklyReportCron: '0 6 * * 1',
      reportRecipients: null,
      updatedAt: daysAgo(2),
      updatedBy: 'demo-seed',
      effective: {
        confidenceThreshold: CONFIDENCE_THRESHOLD,
        accurateModel: ACCURATE_MODEL,
        bulkModel: BULK_MODEL,
        modelStrategy: 'tiered',
        staleAfterDays: 30,
        batchSize: 25,
        syncCron: '0 3 * * *',
        weeklyReportCron: '0 6 * * 1',
        parentDetectionEnabled: true,
        enrichmentEnabled: false,
        enrichProvider: 'none',
        syncEnabled: true,
        weeklyReportEnabled: true,
      },
      secrets: {
        groqConfigured: true,
        groqMasked: 'gsk_demo••••••••••••',
        enrichConfigured: false,
        enrichMasked: null,
        workerSecretConfigured: true,
      },
      envManaged: ['DEMO_MODE', 'DATABASE_URL'],
    },
    usage: {
      day: demoDay(),
      reserve: 50,
      models: [
        { model: ACCURATE_MODEL, requestCount: 128, dailyLimit: 1000, remaining: 872 },
        { model: BULK_MODEL, requestCount: 940, dailyLimit: 14400, remaining: 13460 },
      ],
    },
    // A fixed, illustrative series: identical for every visitor, so the chart
    // cannot be mistaken for live quota telemetry.
    usageHistory: [6, 5, 4, 3, 2, 1, 0].flatMap((offset) => [
      { day: daysAgo(offset).slice(0, 10), model: ACCURATE_MODEL, requests: 96 + offset * 7, promptTokens: 41_000 + offset * 900, completionTokens: 9_400 + offset * 210, failures: offset % 3 },
      { day: daysAgo(offset).slice(0, 10), model: BULK_MODEL, requests: 810 + offset * 23, promptTokens: 128_000 + offset * 3_100, completionTokens: 21_000 + offset * 480, failures: 0 },
    ]),
    modelChoices: [...MODEL_CHOICES],
    taxonomyCodes: 149_849,
    limits: {
      llmRequestsPerDayAccurate: 1000,
      llmRequestsPerDayBulk: 14400,
      llmRequestsPerMinute: 25,
      llmBatchSize: 10,
      enrichmentCreditsPerMonth: 500,
    },
  };
}

function classifyPayload(params: URLSearchParams): unknown {
  const query = firstParam(params, 'q');

  if (query) {
    const needle = query.toLowerCase();
    const limit = Math.min(Math.max(numberParam(params, 'limit') ?? 25, 1), 100);
    const results = DEMO_CODE_SEARCH.filter((entry) =>
      `${entry.code} ${entry.commodity} ${entry.segment ?? ''} ${entry.className ?? ''}`.toLowerCase().includes(needle),
    ).slice(0, limit);
    return { results };
  }

  const rows = applyFilters(DEMO_SUPPLIER_ROWS, params);
  const parents = rows.filter((row) => row.isParent);
  const standalone = rows.filter((row) => row.parentId === null && !row.isParent);

  return {
    clusters: parents.length + standalone.length,
    parentItems: parents.map((row) => ({
      representativeName: row.name,
      rootName: row.name,
      subsidiaries: row.subsidiaryCount,
      model: ACCURATE_MODEL,
    })),
    standalone: standalone.map((row) => ({ id: row.id, name: row.name, model: BULK_MODEL })),
    totalSuppliers: rows.length,
    estimatedRequests: parents.length + standalone.length,
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Answer a demo read request, or `null` if this module has nothing to say.
 *
 * Returning `null` rather than falling through to the real handler is the whole
 * point: an endpoint that is not listed here stays private.
 */
function readDemoEndpoint(pathname: string, params: URLSearchParams): unknown | null {
  switch (pathname) {
    case '/api/metrics':
      return metricsPayload(params);

    case '/api/suppliers':
      return suppliersPayload(params);

    case '/api/classifications':
      return classificationsPayload(params);

    case '/api/hierarchy':
      return hierarchyPayload(params);

    case '/api/audit':
      return auditPayload(params);

    case '/api/reports':
      return reportsPayload(params);

    case '/api/settings':
      return settingsPayload();

    case '/api/classify':
      return classifyPayload(params);

    case '/api/upload':
      return { template: UPLOAD_TEMPLATE, acceptedColumns: UPLOAD_ACCEPTED_COLUMNS };

    case '/api/auth/session':
      return {
        authenticated: false,
        via: null,
        authConfigured: true,
        authDisabled: false,
        demo: true,
        hint: 'You are browsing the read-only demo. Sign in with the dashboard secret to use the real data.',
      };

    default:
      break;
  }

  const supplierMatch = /^\/api\/suppliers\/(\d+)$/.exec(pathname);
  if (supplierMatch?.[1]) return supplierDetailPayload(Number(supplierMatch[1]));

  return null;
}

/** A JSON envelope shaped exactly like `errorResponse` in `lib/api.ts`. */
function envelopeError(error: unknown): NextResponse {
  const serialized = serializeError(error);
  return NextResponse.json({ ok: false, error: serialized }, { status: serialized.status });
}

/** Endpoints the demo deliberately refuses even though they only read. */
const DEMO_BLOCKED_READS = new Set(['/api/export']);

/**
 * The single entry point for an anonymous request in demo mode.
 *
 * Reached from `jsonHandler` before the route's handler, so nothing here can fall
 * through to real data. Non-GET verbs are refused outright, which is what makes the
 * demo read-only regardless of what any individual route decides.
 */
export function demoRespond(request: NextRequest): NextResponse {
  const method = request.method.toUpperCase();
  const pathname = request.nextUrl.pathname.replace(/\/+$/, '') || '/';

  if (method !== 'GET' && method !== 'HEAD') {
    return envelopeError(
      new DemoReadOnlyError(
        'This is a read-only demo, so nothing can be changed here. Sign in with the dashboard secret to upload suppliers, classify, sync or change settings.',
        { method, pathname },
      ),
    );
  }

  if (DEMO_BLOCKED_READS.has(pathname)) {
    return envelopeError(
      new DemoReadOnlyError(
        'Downloads and stored report exports are disabled in the demo. Sign in to generate exports from the real data.',
        { pathname },
      ),
    );
  }

  try {
    const data = readDemoEndpoint(pathname, request.nextUrl.searchParams);
    if (data === null) {
      return envelopeError(
        new NotFoundError(`The demo does not provide ${pathname}. Sign in to use this part of the application.`, {
          pathname,
        }),
      );
    }
    return NextResponse.json({ ok: true, data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return envelopeError(error);
  }
}
