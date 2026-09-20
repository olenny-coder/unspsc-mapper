/**
 * Supplier data access + the incremental upsert/sync logic.
 *
 * The upsert is the heart of "the supplier database stays up to date":
 *  - dedupe on `normalized_name` (unique), which folds legal suffixes so
 *    "ACME CO., LTD" and "Acme Co" collapse into one supplier;
 *  - never overwrite good enriched data with empty data (non-destructive merge);
 *  - record a fingerprint of the enriched payload so the sync job can tell when
 *    enrichment changed materially and reclassification is required.
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { classifications, suppliers, unspscCodes, type Supplier } from '@/db/schema';
import { getDb, type DbLike } from '@/db/client';
import type { ReportFilters } from '@/lib/validation';
import {
  canonicalizeEntityName,
  extractDomain,
  fnv1a,
  normalizeSupplierName,
  smartTitleCase,
  toIsoDate,
} from '@/lib/normalize';
import { getEnv } from '@/lib/env';
import { buildHierarchy, readAmount, type SupplierNode } from '@/services/hierarchy';
import { recordAudit } from '@/services/audit';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export type CurrentClassification = {
  id: number;
  unspscCode: string;
  effectiveCode: string;
  confidence: number;
  reasoning: string | null;
  llmModel: string | null;
  inheritedFromParent: boolean;
  reviewed: boolean;
  correctedCode: string | null;
  correctedBy: string | null;
  segment: string | null;
  segmentCode: string | null;
  family: string | null;
  className: string | null;
  commodity: string | null;
  codeDescription: string | null;
};

export type SupplierListRow = {
  id: number;
  name: string;
  normalizedName: string;
  domain: string | null;
  industry: string | null;
  naics: string | null;
  sic: string | null;
  description: string | null;
  country: string | null;
  totalAmount: number;
  transactionCount: number;
  currency: string;
  parentId: number | null;
  parentName: string | null;
  parentDomain: string | null;
  isParent: boolean;
  parentSource: string | null;
  parentConfidence: number | null;
  enrichedAt: string | null;
  enrichedAtAgeDays: number | null;
  lastEnrichError: string | null;
  stale: boolean;
  staleReason: string | null;
  createdAt: string;
  updatedAt: string;
  subsidiaryCount: number;
  classification: CurrentClassification | null;
};

export type SupplierPage = {
  rows: SupplierListRow[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
};

export type SupplierStats = {
  totalSuppliers: number;
  totalSpend: number;
  enriched: number;
  stale: number;
  parents: number;
  subsidiaries: number;
  classified: number;
  reviewed: number;
  lowConfidence: number;
  inherited: number;
  unclassified: number;
  percentClassified: number;
  percentLowConfidence: number;
  avgConfidence: number | null;
};

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

type RawJoinedRow = {
  supplier: Supplier;
  classification: typeof classifications.$inferSelect | null;
  code: typeof unspscCodes.$inferSelect | null;
};

function mapClassification(
  classification: typeof classifications.$inferSelect | null,
  code: typeof unspscCodes.$inferSelect | null,
): CurrentClassification | null {
  if (!classification) return null;
  const effective = classification.correctedCode ?? classification.unspscCode;
  return {
    id: classification.id,
    unspscCode: classification.unspscCode,
    effectiveCode: effective,
    confidence: Number(classification.confidence ?? 0),
    reasoning: classification.reasoning,
    llmModel: classification.llmModel,
    inheritedFromParent: classification.inheritedFromParent,
    reviewed: classification.reviewed,
    correctedCode: classification.correctedCode,
    correctedBy: classification.correctedBy,
    segment: code?.segment ?? null,
    segmentCode: code?.segmentCode ?? null,
    family: code?.family ?? null,
    className: code?.class ?? null,
    commodity: code?.commodity ?? null,
    codeDescription: code?.description ?? null,
  };
}

function daysSince(value: Date | string | null): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
}

function mapSupplierRow(raw: RawJoinedRow, subsidiaryCount: number): SupplierListRow {
  const { supplier, classification, code } = raw;
  return {
    id: supplier.id,
    name: supplier.name,
    normalizedName: supplier.normalizedName,
    domain: supplier.domain,
    industry: supplier.industry,
    naics: supplier.naics,
    sic: supplier.sic,
    description: supplier.description,
    country: supplier.country,
    totalAmount: readAmount(supplier as unknown as Record<string, unknown>),
    transactionCount: supplier.transactionCount,
    currency: supplier.currency,
    parentId: supplier.parentId,
    parentName: supplier.parentName,
    parentDomain: supplier.parentDomain,
    isParent: supplier.isParent,
    parentSource: supplier.parentSource,
    parentConfidence: supplier.parentConfidence === null ? null : Number(supplier.parentConfidence),
    enrichedAt: supplier.enrichedAt ? supplier.enrichedAt.toISOString() : null,
    enrichedAtAgeDays: daysSince(supplier.enrichedAt),
    lastEnrichError: supplier.lastEnrichError,
    stale: supplier.stale,
    staleReason: supplier.staleReason,
    createdAt: supplier.createdAt.toISOString(),
    updatedAt: supplier.updatedAt.toISOString(),
    subsidiaryCount,
    classification: mapClassification(classification, code),
  };
}

/** Convert a list row into the pure hierarchy node shape. */
export function toNode(row: SupplierListRow): SupplierNode & {
  classification: { unspscCode: string; confidence: number; inheritedFromParent: boolean; reviewed: boolean } | null;
  effectiveCode: string | null;
} {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parentId,
    parentName: row.parentName,
    parentDomain: row.parentDomain,
    isParent: row.isParent,
    domain: row.domain,
    industry: row.industry,
    naics: row.naics,
    sic: row.sic,
    description: row.description,
    country: row.country,
    totalAmount: row.totalAmount,
    enrichedAt: row.enrichedAt,
    stale: row.stale,
    classification: row.classification
      ? {
          unspscCode: row.classification.effectiveCode,
          confidence: row.classification.confidence,
          inheritedFromParent: row.classification.inheritedFromParent,
          reviewed: row.classification.reviewed,
        }
      : null,
    effectiveCode: row.classification?.effectiveCode ?? null,
  };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/** Turn `43` / `4321` / `43211500` into a LIKE prefix (`43%`). */
export function segmentLikePattern(segment: string | undefined): string | null {
  if (!segment) return null;
  const digits = segment.replace(/\D/g, '');
  if (!digits) return null;
  return `${digits.slice(0, 8)}%`;
}

/**
 * Build the SQL WHERE for a filter set. `staleAfterDays` is supplied by the
 * caller so this stays a pure function of its inputs.
 */
export function buildSupplierFilters(
  filters: ReportFilters,
  options: { staleAfterDays: number; confidenceThreshold: number },
): SQL | undefined {
  const conditions: SQL[] = [];

  if (filters.search) {
    const term = `%${filters.search}%`;
    const searchCondition = or(
      ilike(suppliers.name, term),
      ilike(suppliers.domain, term),
      ilike(suppliers.industry, term),
      ilike(suppliers.parentName, term),
    );
    if (searchCondition) conditions.push(searchCondition);
  }

  if (filters.onlyParents) conditions.push(eq(suppliers.isParent, true));
  if (filters.onlySubsidiaries) conditions.push(isNotNull(suppliers.parentId));
  if (filters.parentId) conditions.push(eq(suppliers.parentId, filters.parentId));
  if (filters.parent) {
    // Match either the linked parent row's name or the stored parent name.
    const parentMatch = or(
      eq(suppliers.parentName, filters.parent),
      sql`${suppliers.parentId} in (select ${suppliers.id} from ${suppliers} where ${suppliers.name} = ${filters.parent})`,
    );
    if (parentMatch) conditions.push(parentMatch);
  }
  if (filters.industry) conditions.push(ilike(suppliers.industry, `%${filters.industry}%`));
  if (filters.country) conditions.push(ilike(suppliers.country, `%${filters.country}%`));

  if (filters.onlyStale) {
    conditions.push(
      or(
        eq(suppliers.stale, true),
        isNull(suppliers.enrichedAt),
        lt(suppliers.enrichedAt, new Date(Date.now() - options.staleAfterDays * 86_400_000)),
      )!,
    );
  }

  if (filters.supplierIds?.length) conditions.push(inArray(suppliers.id, filters.supplierIds));

  if (filters.segment || filters.unspscPrefix) {
    const pattern = segmentLikePattern(filters.segment ?? filters.unspscPrefix);
    if (pattern) {
      conditions.push(
        or(
          sql`coalesce(${classifications.correctedCode}, ${classifications.unspscCode}) like ${pattern}`,
          sql`${unspscCodes.code} like ${pattern}`,
        )!,
      );
    }
  }

  if (filters.minConfidence !== undefined) {
    conditions.push(gte(classifications.confidence, String(filters.minConfidence)));
  }
  if (filters.maxConfidence !== undefined) {
    conditions.push(
      or(isNull(classifications.id), lt(classifications.confidence, String(filters.maxConfidence + 0.0001)))!,
    );
  }

  switch (filters.confidenceState) {
    case 'low':
      conditions.push(
        and(
          isNotNull(classifications.id),
          lt(classifications.confidence, String(options.confidenceThreshold)),
          eq(classifications.reviewed, false),
        )!,
      );
      break;
    case 'reviewed':
      conditions.push(eq(classifications.reviewed, true));
      break;
    case 'unreviewed':
      conditions.push(and(isNotNull(classifications.id), eq(classifications.reviewed, false))!);
      break;
    case 'unclassified':
      conditions.push(isNull(classifications.id));
      break;
    default:
      break;
  }

  if (filters.from) {
    conditions.push(gte(suppliers.createdAt, new Date(filters.from)) as SQL);
  }
  if (filters.to) {
    const to = new Date(filters.to);
    if (/^\d{4}-\d{2}-\d{2}$/.test(filters.to)) to.setUTCHours(23, 59, 59, 999);
    conditions.push(lt(suppliers.createdAt, new Date(to.getTime() + 1)) as SQL);
  }

  if (!conditions.length) return undefined;
  return and(...conditions);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

type ListOptions = {
  filters?: ReportFilters;
  page?: number;
  pageSize?: number;
  sort?: 'name' | 'spend' | 'confidence' | 'updatedAt' | 'createdAt';
  dir?: 'asc' | 'desc';
  /** Skip pagination (used by exports). */
  all?: boolean;
  db?: DbLike;
};

/** Current classification sub-select (newest non-superseded row per supplier). */
function currentClassificationQuery(db: DbLike) {
  return db
    .select({
      supplierId: classifications.supplierId,
      idCol: sql<number>`max(${classifications.id})`.as('classification_id'),
    })
    .from(classifications)
    .where(eq(classifications.superseded, false))
    .groupBy(classifications.supplierId)
    .as('cc');
}

/**
 * List suppliers joined to their current classification. Filtering and
 * pagination happen in SQL; the parent roll-up is applied afterwards because it
 * needs whole-cluster context.
 */
export async function listSuppliers(options: ListOptions = {}): Promise<SupplierPage> {
  const db = options.db ?? getDb();
  const env = getEnv();
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, options.pageSize ?? 25));
  const filters = options.filters ?? ({} as ReportFilters);

  const cc = currentClassificationQuery(db);

  const where = buildSupplierFilters(filters, {
    staleAfterDays: env.SYNC_STALE_DAYS,
    confidenceThreshold: env.CLASSIFY_CONFIDENCE_THRESHOLD,
  });

  const subsidiaryCounts = db
    .select({
      parentId: suppliers.parentId,
      childCount: sql<number>`count(*)`.as('child_count'),
    })
    .from(suppliers)
    .where(isNotNull(suppliers.parentId))
    .groupBy(suppliers.parentId)
    .as('sc');

  const baseQuery = db
    .select({
      supplier: suppliers,
      classification: classifications,
      code: unspscCodes,
      childCount: subsidiaryCounts.childCount,
    })
    .from(suppliers)
    .leftJoin(cc, eq(cc.supplierId, suppliers.id))
    .leftJoin(classifications, eq(classifications.id, cc.idCol))
    .leftJoin(unspscCodes, eq(unspscCodes.code, sql`coalesce(${classifications.correctedCode}, ${classifications.unspscCode})`))
    .leftJoin(subsidiaryCounts, eq(subsidiaryCounts.parentId, suppliers.id))
    .where(where);

  const sortColumn =
    options.sort === 'spend'
      ? suppliers.totalAmount
      : options.sort === 'confidence'
        ? classifications.confidence
        : options.sort === 'updatedAt'
          ? suppliers.updatedAt
          : options.sort === 'createdAt'
            ? suppliers.createdAt
            : suppliers.name;

  const direction = options.dir === 'desc' ? desc : asc;

  const rows = await (options.all
    ? baseQuery.orderBy(direction(sortColumn))
    : baseQuery
        .orderBy(direction(sortColumn))
        .limit(pageSize)
        .offset((page - 1) * pageSize));

  const totals = await db
    .select({ value: count() })
    .from(suppliers)
    .leftJoin(cc, eq(cc.supplierId, suppliers.id))
    .leftJoin(classifications, eq(classifications.id, cc.idCol))
    .leftJoin(unspscCodes, eq(unspscCodes.code, sql`coalesce(${classifications.correctedCode}, ${classifications.unspscCode})`))
    .where(where);

  const total = Number(totals[0]?.value ?? 0);

  const mapped = rows.map((row) =>
    mapSupplierRow(
      { supplier: row.supplier, classification: row.classification, code: row.code },
      Number(row.childCount ?? 0),
    ),
  );

  return {
    rows: mapped,
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Fetch every supplier (no classification join) — used by hierarchy maths. */
export async function loadAllSupplierNodes(db: DbLike = getDb()): Promise<SupplierListRow[]> {
  const page = await listSuppliers({ all: true, filters: {} as ReportFilters, db, sort: 'name', dir: 'asc' });
  return page.rows;
}

export async function getSupplierById(id: number, db: DbLike = getDb()): Promise<SupplierListRow | null> {
  const rows = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
  const supplier = rows[0];
  if (!supplier) return null;

  const page = await listSuppliers({
    filters: { supplierIds: [id], rollup: 'supplier' } as ReportFilters,
    db,
  });
  const withClassification = page.rows.find((row) => row.id === id);
  if (withClassification) return withClassification;

  return mapSupplierRow({ supplier, classification: null, code: null }, 0);
}

/** Parents plus their direct subsidiaries, for the `/hierarchy` page. */
export async function getHierarchy(db: DbLike = getDb()): Promise<ReturnType<typeof buildHierarchy>> {
  const rows = await loadAllSupplierNodes(db);
  return buildHierarchy(rows.map((row) => toNode(row)));
}

export type SupplierStatsOptions = { filters?: ReportFilters; db?: DbLike };

/** Dashboard/report headline metrics. */
export async function getSupplierStats(options: SupplierStatsOptions = {}): Promise<SupplierStats> {
  const db = options.db ?? getDb();
  const env = getEnv();
  const page = await listSuppliers({
    all: true,
    filters: options.filters ?? ({} as ReportFilters),
    db,
    sort: 'name',
    dir: 'asc',
  });

  const rows = page.rows;
  const threshold = env.CLASSIFY_CONFIDENCE_THRESHOLD;

  let totalSpend = 0;
  let enriched = 0;
  let stale = 0;
  let parents = 0;
  let subsidiaries = 0;
  let classified = 0;
  let reviewed = 0;
  let lowConfidence = 0;
  let inherited = 0;
  let confidenceSum = 0;
  let confidenceCount = 0;

  for (const row of rows) {
    totalSpend += row.totalAmount;
    if (row.enrichedAt) enriched += 1;
    if (row.stale || !row.enrichedAt) stale += 1;
    if (row.isParent) parents += 1;
    if (row.parentId !== null) subsidiaries += 1;

    const classification = row.classification;
    if (classification) {
      classified += 1;
      if (classification.reviewed) reviewed += 1;
      if (classification.inheritedFromParent) inherited += 1;
      confidenceSum += classification.confidence;
      confidenceCount += 1;
      if (classification.confidence < threshold && !classification.reviewed) lowConfidence += 1;
    }
  }

  const total = rows.length;
  return {
    totalSuppliers: total,
    totalSpend,
    enriched,
    stale,
    parents,
    subsidiaries,
    classified,
    reviewed,
    lowConfidence,
    inherited,
    unclassified: total - classified,
    percentClassified: total ? (classified / total) * 100 : 0,
    percentLowConfidence: total ? (lowConfidence / total) * 100 : 0,
    avgConfidence: confidenceCount ? confidenceSum / confidenceCount : null,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type SupplierUpsertInput = {
  name: string;
  domain?: string | null;
  industry?: string | null;
  naics?: string | null;
  sic?: string | null;
  description?: string | null;
  country?: string | null;
  amount?: number | null;
  transactionCount?: number;
  currency?: string | null;
  parentName?: string | null;
  parentDomain?: string | null;
  enrichedAt?: Date | null;
  /** Skip the non-destructive merge (used by explicit admin edits). */
  overwrite?: boolean;
};

export type UpsertOutcome = {
  supplier: Supplier;
  created: boolean;
  /** Fields that actually changed on an existing row. */
  changedFields: string[];
};

/**
 * Non-destructive merge: `undefined`/`null`/empty incoming values never erase
 * existing data. Returns the list of fields that changed.
 */
export function mergeEnrichmentFields(
  existing: Supplier,
  incoming: SupplierUpsertInput,
  options: { overwrite?: boolean } = {},
): { values: Partial<Supplier>; changedFields: string[] } {
  const values: Partial<Supplier> = {};
  const changedFields: string[] = [];

  const textFields: Array<keyof SupplierUpsertInput & keyof Supplier> = [
    'domain',
    'industry',
    'naics',
    'sic',
    'description',
    'country',
    'parentName',
    'parentDomain',
  ];

  for (const field of textFields) {
    const nextRaw = (incoming as Record<string, unknown>)[field];
    if (nextRaw === undefined || nextRaw === null) continue;
    const next = typeof nextRaw === 'string' ? nextRaw.trim() : String(nextRaw);
    if (!next) continue;

    const currentRaw = (existing as unknown as Record<string, unknown>)[field];
    const current = typeof currentRaw === 'string' ? currentRaw : currentRaw === null || currentRaw === undefined ? '' : String(currentRaw);

    if (field === 'domain') {
      const normalized = extractDomain(next);
      if (!normalized) continue;
      if (normalized === current) continue;
      // Domains are high-signal: overwrite unless the incoming one is worse.
      (values as Record<string, unknown>)[field] = normalized;
      changedFields.push(field);
      continue;
    }

    if (options.overwrite || !current) {
      if (current !== next) {
        (values as Record<string, unknown>)[field] = next;
        changedFields.push(field);
      }
    } else if (current !== next && current.length < next.length) {
      // Prefer the richer description/industry string.
      (values as Record<string, unknown>)[field] = next;
      changedFields.push(field);
    }
  }

  if (incoming.amount !== undefined && incoming.amount !== null && Number.isFinite(incoming.amount)) {
    const currentAmount = existing.totalAmount === null ? null : Number(existing.totalAmount);
    if (currentAmount !== incoming.amount) {
      values.totalAmount = incoming.amount.toFixed(2);
      changedFields.push('totalAmount');
    }
  }

  if (incoming.transactionCount !== undefined && incoming.transactionCount > 0) {
    const nextCount = (existing.transactionCount ?? 0) + incoming.transactionCount;
    if (nextCount !== existing.transactionCount) {
      values.transactionCount = nextCount;
      changedFields.push('transactionCount');
    }
  }

  if (incoming.currency && incoming.currency !== existing.currency) {
    values.currency = incoming.currency.toUpperCase().slice(0, 8);
    changedFields.push('currency');
  }

  if (incoming.enrichedAt !== undefined && incoming.enrichedAt !== null) {
    const current = existing.enrichedAt?.getTime() ?? 0;
    if (incoming.enrichedAt.getTime() > current) {
      values.enrichedAt = incoming.enrichedAt;
      changedFields.push('enrichedAt');
    }
  }

  return { values, changedFields };
}

/** Fields whose change implies the classification may be out of date. */
export const RECLASSIFY_TRIGGER_FIELDS = new Set(['industry', 'naics', 'sic', 'description', 'domain', 'parentName']);

export function requiresReclassification(changedFields: readonly string[]): boolean {
  return changedFields.some((field) => RECLASSIFY_TRIGGER_FIELDS.has(field));
}

/**
 * Insert-or-update one supplier.
 *
 * The merge happens in application code (not a SQL `ON CONFLICT DO UPDATE`)
 * because the non-destructive rules depend on the existing row's contents.
 */
export async function upsertSupplier(
  input: SupplierUpsertInput,
  options: { db?: DbLike; actor?: string; audit?: boolean } = {},
): Promise<UpsertOutcome> {
  const db = options.db ?? getDb();
  const display = smartTitleCase(String(input.name ?? '').trim());
  if (!display) throw new Error('Supplier name is required');

  const normalized = normalizeSupplierName(display);
  const canonical = canonicalizeEntityName(display);

  const existingRows = await db
    .select()
    .from(suppliers)
    .where(or(eq(suppliers.normalizedName, normalized), eq(suppliers.name, display)))
    .limit(1);
  const existing = existingRows[0];

  if (!existing) {
    const inserted = await db
      .insert(suppliers)
      .values({
        name: display,
        normalizedName: normalized,
        domain: input.domain ? extractDomain(input.domain) : null,
        industry: input.industry ?? null,
        naics: input.naics ?? null,
        sic: input.sic ?? null,
        description: input.description ?? null,
        country: input.country ?? null,
        totalAmount:
          input.amount !== undefined && input.amount !== null && Number.isFinite(input.amount)
            ? input.amount.toFixed(2)
            : null,
        transactionCount: input.transactionCount ?? 0,
        currency: (input.currency ?? 'USD').toUpperCase(),
        parentName: input.parentName ?? null,
        parentDomain: input.parentDomain ? extractDomain(input.parentDomain) : null,
        enrichedAt: input.enrichedAt ?? null,
        parentSource: input.parentName ? 'enrichment' : null,
      })
      .onConflictDoUpdate({
        // Handle the race where two uploads insert the same supplier at once.
        target: suppliers.normalizedName,
        set: {
          updatedAt: new Date(),
          totalAmount: sql`coalesce(${suppliers.totalAmount}, 0) + coalesce(${input.amount ?? 0}, 0)`,
        },
      })
      .returning();

    const row = inserted[0]!;
    if (options.audit !== false) {
      await recordAudit(
        {
          entity: 'supplier',
          entityId: row.id,
          action: 'created',
          details: { name: row.name, normalizedName: normalized, hadLegalSuffix: canonical.hadLegalSuffix },
          actor: options.actor ?? 'system',
        },
        db,
      );
    }
    return { supplier: row, created: true, changedFields: ['*'] };
  }

  const { values, changedFields } = mergeEnrichmentFields(existing, input, { overwrite: input.overwrite });

  if (!changedFields.length) {
    return { supplier: existing, created: false, changedFields: [] };
  }

  const updated = await db
    .update(suppliers)
    .set({
      ...values,
      ...(changedFields.some((f) => RECLASSIFY_TRIGGER_FIELDS.has(f))
        ? { stale: false, staleReason: null }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(suppliers.id, existing.id))
    .returning();

  const row = updated[0] ?? existing;

  if (options.audit !== false) {
    await recordAudit(
      {
        entity: 'supplier',
        entityId: row.id,
        action: 'updated',
        details: { changedFields, needsReclassification: requiresReclassification(changedFields) },
        actor: options.actor ?? 'system',
      },
      db,
    );
  }

  return { supplier: row, created: false, changedFields };
}

export type BulkUpsertSummary = {
  created: number;
  updated: number;
  unchanged: number;
  totalRows: number;
  duplicateRowsInFile: number;
  needsReclassification: number[];
  supplierIds: number[];
  createdIds: number[];
  errors: Array<{ row: number; name: string; message: string }>;
};

/**
 * Bulk upsert with in-file de-duplication. Aggregates amounts for repeated
 * suppliers inside the same file and returns the full id list so the caller can
 * chain enrichment/classification.
 */
export async function bulkUpsertSuppliers(
  inputs: readonly SupplierUpsertInput[],
  options: { db?: DbLike; actor?: string; audit?: boolean } = {},
): Promise<BulkUpsertSummary> {
  const db = options.db ?? getDb();
  const summary: BulkUpsertSummary = {
    created: 0,
    updated: 0,
    unchanged: 0,
    totalRows: inputs.length,
    duplicateRowsInFile: 0,
    needsReclassification: [],
    supplierIds: [],
    createdIds: [],
    errors: [],
  };

  // Fold duplicates inside the uploaded file: sum amounts, keep first non-null text.
  const merged = new Map<string, SupplierUpsertInput>();
  inputs.forEach((input, index) => {
    const display = smartTitleCase(String(input.name ?? '').trim());
    if (!display) {
      summary.errors.push({ row: index + 1, name: String(input.name ?? ''), message: 'Missing supplier name' });
      return;
    }
    const key = normalizeSupplierName(display);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...input, name: display, transactionCount: input.transactionCount ?? 1 });
      return;
    }
    summary.duplicateRowsInFile += 1;
    merged.set(key, {
      ...existing,
      amount: (existing.amount ?? 0) + (input.amount ?? 0),
      transactionCount: (existing.transactionCount ?? 1) + (input.transactionCount ?? 1),
      industry: existing.industry ?? input.industry ?? null,
      domain: existing.domain ?? input.domain ?? null,
      naics: existing.naics ?? input.naics ?? null,
      sic: existing.sic ?? input.sic ?? null,
      description: existing.description ?? input.description ?? null,
      country: existing.country ?? input.country ?? null,
      parentName: existing.parentName ?? input.parentName ?? null,
      parentDomain: existing.parentDomain ?? input.parentDomain ?? null,
    });
  });

  for (const input of merged.values()) {
    try {
      const outcome = await upsertSupplier(input, { db, actor: options.actor, audit: options.audit });
      summary.supplierIds.push(outcome.supplier.id);
      if (outcome.created) {
        summary.created += 1;
        summary.createdIds.push(outcome.supplier.id);
      } else if (outcome.changedFields.length) {
        summary.updated += 1;
        if (requiresReclassification(outcome.changedFields)) summary.needsReclassification.push(outcome.supplier.id);
      } else {
        summary.unchanged += 1;
      }
    } catch (error) {
      summary.errors.push({
        row: summary.supplierIds.length + 1,
        name: input.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}

/** Parse a raw CSV record into a `SupplierUpsertInput`. */
export function mapCsvRecordToSupplier(record: Record<string, unknown>): SupplierUpsertInput | null {
  const nameKeys = ['name', 'supplier', 'supplier_name', 'supplier name', 'vendor', 'vendor_name', 'company'];
  const findKey = (candidates: string[]): string | undefined => {
    const keys = Object.keys(record);
    for (const candidate of candidates) {
      const match = keys.find((key) => key.trim().toLowerCase() === candidate);
      if (match) return match;
    }
    return undefined;
  };

  const nameKey = findKey(nameKeys);
  const rawName = nameKey ? record[nameKey] : undefined;
  const name = smartTitleCase(String(rawName ?? '').trim());
  if (!name) return null;

  const pick = (candidates: string[]): string | null => {
    const key = findKey(candidates);
    if (!key) return null;
    const value = record[key];
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text ? text : null;
  };

  const amountKey = findKey(['amount', 'spend', 'total', 'value', 'invoice_amount', 'transaction_amount']);
  const amountRaw = amountKey ? record[amountKey] : undefined;

  return {
    name,
    domain: pick(['domain', 'website', 'url', 'web', 'supplier_domain']),
    industry: pick(['industry', 'sector']),
    naics: pick(['naics', 'naics_code', 'naics code']),
    sic: pick(['sic', 'sic_code', 'sic code']),
    description: pick(['description', 'notes', 'summary']),
    country: pick(['country', 'country_code', 'region']),
    parentName: sanitizeParentName(pick(['parent', 'parent_name', 'parent_company', 'parent company', 'ultimate_parent'])),
    parentDomain: pick(['parent_domain', 'parent website']),
    amount: amountRaw === undefined ? null : parseAmountSafe(amountRaw),
    transactionCount: 1,
    currency: pick(['currency', 'ccy']) ?? 'USD',
  };
}

/** Map a `amount`-style value to a number, tolerating currency formatting. */
function parseAmountSafe(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/[^0-9.,()-]/g, '');
  if (!text) return null;
  const negative = /^\(|-/.test(text);
  const cleaned = text.replace(/[()]/g, '').replace(/-/g, '');
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;
  if (lastComma > lastDot) normalized = cleaned.replace(/\./g, '').replace(',', '.');
  else normalized = cleaned.replace(/,/g, '');
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

/**
 * Guard against a malformed CSV row poisoning the parent relationship.
 *
 * When a row has an unquoted comma (for example an amount written as
 * `$1,250.00`), PapaParse returns the overflow in `__parsed_extra` and every
 * later column shifts one position to the left — so a NAICS code can land in the
 * `parent` column. A purely numeric or over-long "parent" is a code, not a
 * company, and is dropped so the pipeline never builds a fake parent cluster.
 */
export function sanitizeParentName(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+[\d.\-\s]*$/.test(trimmed)) return null;
  if (trimmed.length > 200) return null;
  // Needs at least one letter to be a company name.
  if (!/[A-Za-z]/.test(trimmed)) return null;
  return trimmed;
}

/** True when a parsed CSV record looked structurally malformed. */
export function csvRecordIsShifted(record: Record<string, unknown>): boolean {
  const extra = record.__parsed_extra;
  return Array.isArray(extra) && extra.some((value) => String(value ?? '').trim().length > 0);
}

/** Extract a transaction date from a CSV record (informational). */
export function extractCsvDate(record: Record<string, unknown>): string | null {
  const keys = Object.keys(record);
  const dateKey = keys.find((key) =>
    ['date', 'transaction_date', 'invoice_date', 'posted_date', 'period'].includes(key.trim().toLowerCase()),
  );
  if (!dateKey) return null;
  return toIsoDate(record[dateKey]);
}

/** IDs that still need enrichment. */
export async function findSuppliersNeedingEnrichment(
  options: { olderThanDays?: number; limit?: number; onlyStale?: boolean; db?: DbLike } = {},
): Promise<Supplier[]> {
  const db = options.db ?? getDb();
  const env = getEnv();
  const olderThanDays = options.olderThanDays ?? env.SYNC_STALE_DAYS;

  const conditions: SQL[] = [];
  const neverEnriched = isNull(suppliers.enrichedAt);
  const tooOld = lt(suppliers.enrichedAt, new Date(Date.now() - olderThanDays * 86_400_000));

  if (options.onlyStale) {
    conditions.push(or(eq(suppliers.stale, true), neverEnriched, tooOld)!);
  } else if (options.olderThanDays !== undefined) {
    conditions.push(or(neverEnriched, tooOld)!);
  } else {
    conditions.push(neverEnriched);
  }

  return db
    .select()
    .from(suppliers)
    .where(and(...conditions))
    .orderBy(asc(suppliers.enrichedAt), desc(suppliers.totalAmount))
    .limit(options.limit ?? env.SYNC_BATCH_SIZE);
}

/** IDs that need (re)classification. */
export async function findSuppliersNeedingClassification(
  options: { limit?: number; force?: boolean; db?: DbLike } = {},
): Promise<Supplier[]> {
  const db = options.db ?? getDb();
  const env = getEnv();
  const cc = currentClassificationQuery(db);

  if (options.force) {
    return db.select().from(suppliers).orderBy(desc(suppliers.totalAmount)).limit(options.limit ?? env.SYNC_BATCH_SIZE);
  }

  return db
    .select({ supplier: suppliers })
    .from(suppliers)
    .leftJoin(cc, eq(cc.supplierId, suppliers.id))
    .where(isNull(cc.idCol))
    .orderBy(desc(suppliers.totalAmount))
    .limit(options.limit ?? env.SYNC_BATCH_SIZE)
    .then((rows) => rows.map((row) => row.supplier));
}

/** Mark a supplier as stale with a reason (audited). */
export async function markSupplierStale(
  supplierId: number,
  reason: string,
  options: { db?: DbLike; actor?: string } = {},
): Promise<void> {
  const db = options.db ?? getDb();
  await db
    .update(suppliers)
    .set({ stale: true, staleReason: reason, updatedAt: new Date() })
    .where(and(eq(suppliers.id, supplierId), ne(suppliers.staleReason, reason)));
  await recordAudit(
    { entity: 'supplier', entityId: supplierId, action: 'stale_marked', details: { reason }, actor: options.actor ?? 'system' },
    db,
  );
}

/** Clear the stale flag after a successful refresh. */
export async function clearSupplierStale(supplierId: number, options: { db?: DbLike } = {}): Promise<void> {
  const db = options.db ?? getDb();
  await db
    .update(suppliers)
    .set({ stale: false, staleReason: null, updatedAt: new Date() })
    .where(eq(suppliers.id, supplierId));
}

/** Persist enrichment results plus the parent linkage in one update. */
export async function applyEnrichmentToSupplier(
  supplierId: number,
  payload: {
    domain?: string | null;
    industry?: string | null;
    naics?: string | null;
    sic?: string | null;
    description?: string | null;
    country?: string | null;
    parentId?: number | null;
    parentName?: string | null;
    parentDomain?: string | null;
    parentSource?: 'enrichment' | 'llm' | 'manual' | null;
    parentConfidence?: number | null;
    fingerprint?: string | null;
    error?: string | null;
  },
  options: { db?: DbLike; actor?: string } = {},
): Promise<{ changedFields: string[]; supplier: Supplier }> {
  const db = options.db ?? getDb();
  const rows = await db.select().from(suppliers).where(eq(suppliers.id, supplierId)).limit(1);
  const existing = rows[0];
  if (!existing) throw new Error(`Supplier ${supplierId} not found`);

  const { values, changedFields } = mergeEnrichmentFields(existing, {
    name: existing.name,
    domain: payload.domain,
    industry: payload.industry,
    naics: payload.naics,
    sic: payload.sic,
    description: payload.description,
    country: payload.country,
    parentName: payload.parentName,
    parentDomain: payload.parentDomain,
  });

  if (payload.parentId !== undefined && payload.parentId !== existing.parentId) {
    values.parentId = payload.parentId;
    changedFields.push('parentId');
  }
  if (payload.parentSource !== undefined && payload.parentSource !== existing.parentSource) {
    values.parentSource = payload.parentSource;
    changedFields.push('parentSource');
  }
  if (payload.parentConfidence !== undefined && payload.parentConfidence !== null) {
    values.parentConfidence = payload.parentConfidence.toFixed(2);
    changedFields.push('parentConfidence');
  }
  if (payload.fingerprint && payload.fingerprint !== existing.enrichFingerprint) {
    values.enrichFingerprint = payload.fingerprint;
    changedFields.push('enrichFingerprint');
  }

  values.enrichAttempts = (existing.enrichAttempts ?? 0) + 1;
  values.updatedAt = new Date();

  if (payload.error) {
    values.lastEnrichError = payload.error.slice(0, 1000);
    values.stale = true;
    values.staleReason = 'enrichment_failed';
  } else {
    values.enrichedAt = new Date();
    values.lastEnrichError = null;
    values.stale = false;
    values.staleReason = null;
  }

  const updated = await db.update(suppliers).set(values).where(eq(suppliers.id, supplierId)).returning();
  const supplier = updated[0] ?? existing;

  await recordAudit(
    {
      entity: 'supplier',
      entityId: supplierId,
      action: payload.error ? 'enrich_failed' : 'enriched',
      details: {
        changedFields,
        fingerprint: payload.fingerprint ?? null,
        error: payload.error ?? null,
        needsReclassification: requiresReclassification(changedFields),
      },
      actor: options.actor ?? 'system',
    },
    db,
  );

  return { changedFields, supplier };
}

/** Link a subsidiary to a parent supplier row and maintain `is_parent`. */
export async function linkSubsidiary(
  supplierId: number,
  parentId: number | null,
  options: {
    db?: DbLike;
    actor?: string;
    source?: 'enrichment' | 'llm' | 'manual';
    parentName?: string | null;
    parentDomain?: string | null;
    confidence?: number | null;
  } = {},
): Promise<void> {
  const db = options.db ?? getDb();

  const previousRows = await db.select().from(suppliers).where(eq(suppliers.id, supplierId)).limit(1);
  const previous = previousRows[0];
  if (!previous) throw new Error(`Supplier ${supplierId} not found`);

  await db
    .update(suppliers)
    .set({
      parentId,
      parentName: options.parentName ?? null,
      parentDomain: options.parentDomain ? extractDomain(options.parentDomain) : null,
      parentSource: parentId !== null || options.parentName ? (options.source ?? 'manual') : null,
      parentConfidence:
        options.confidence !== undefined && options.confidence !== null ? options.confidence.toFixed(2) : null,
      updatedAt: new Date(),
    })
    .where(eq(suppliers.id, supplierId));

  if (parentId !== null) {
    await db.update(suppliers).set({ isParent: true, updatedAt: new Date() }).where(eq(suppliers.id, parentId));
  }

  // Recompute the previous parent's `is_parent` when it lost its last child.
  if (previous.parentId !== null && previous.parentId !== parentId) {
    const remaining = await db
      .select({ value: count() })
      .from(suppliers)
      .where(eq(suppliers.parentId, previous.parentId));
    if (Number(remaining[0]?.value ?? 0) === 0) {
      await db
        .update(suppliers)
        .set({ isParent: false, updatedAt: new Date() })
        .where(eq(suppliers.id, previous.parentId));
    }
  }

  if (parentId !== null) {
    const childCount = await db.select({ value: count() }).from(suppliers).where(eq(suppliers.parentId, parentId));
    await db
      .update(suppliers)
      .set({ isParent: Number(childCount[0]?.value ?? 0) > 0, updatedAt: new Date() })
      .where(eq(suppliers.id, parentId));
  }

  await recordAudit(
    {
      entity: 'supplier',
      entityId: supplierId,
      action: parentId === null ? 'unlinked' : 'linked',
      details: {
        previousParentId: previous.parentId,
        parentId,
        parentName: options.parentName ?? null,
        source: options.source ?? 'manual',
      },
      actor: options.actor ?? 'system',
    },
    db,
  );
}

/**
 * Find or create a supplier row for a parent company name so subsidiaries can
 * point at a real row. Returns null when the name is not usable.
 */
export async function ensureParentSupplier(
  parentName: string,
  options: { db?: DbLike; actor?: string; domain?: string | null; industry?: string | null } = {},
): Promise<Supplier | null> {
  const db = options.db ?? getDb();
  const display = smartTitleCase(parentName.trim());
  if (!display) return null;

  const normalized = normalizeSupplierName(display);
  const existing = await db
    .select()
    .from(suppliers)
    .where(or(eq(suppliers.normalizedName, normalized), ilike(suppliers.name, display)))
    .limit(1);
  if (existing[0]) return existing[0];

  const inserted = await db
    .insert(suppliers)
    .values({
      name: display,
      normalizedName: normalized,
      domain: options.domain ? extractDomain(options.domain) : null,
      industry: options.industry ?? null,
      isParent: true,
      parentSource: null,
    })
    .onConflictDoNothing({ target: suppliers.normalizedName })
    .returning();

  const row = inserted[0];
  if (row) {
    await recordAudit(
      {
        entity: 'supplier',
        entityId: row.id,
        action: 'created',
        details: { name: row.name, reason: 'parent_company_placeholder' },
        actor: options.actor ?? 'system',
      },
      db,
    );
    return row;
  }

  const fallback = await db.select().from(suppliers).where(eq(suppliers.normalizedName, normalized)).limit(1);
  return fallback[0] ?? null;
}

/** Simple fingerprint over the enrichment-relevant fields. */
export function enrichmentFingerprint(payload: {
  domain?: string | null;
  industry?: string | null;
  naics?: string | null;
  sic?: string | null;
  parentName?: string | null;
  description?: string | null;
}): string {
  const canonical = [
    (payload.domain ?? '').toLowerCase(),
    (payload.industry ?? '').toLowerCase(),
    (payload.naics ?? ''),
    (payload.sic ?? ''),
    (payload.parentName ?? '').toLowerCase(),
    fnv1a((payload.description ?? '').toLowerCase()),
  ].join('|');
  return fnv1a(canonical);
}
