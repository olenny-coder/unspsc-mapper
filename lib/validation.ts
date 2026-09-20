/**
 * Shared Zod contracts for query strings and request bodies.
 *
 * The export endpoint, the dashboard API routes and the worker all validate the
 * same filter shape, so the definition lives in one place.
 *
 * Implementation note: every field uses `z.preprocess` rather than
 * `.transform()`. That keeps the resulting schema a `ZodObject`, so `.partial()`
 * and `.extend()` work and the same schema can validate a `URLSearchParams`
 * record, a JSON body, or values that arrive already typed.
 *
 * The OUTPUT types are declared as plain interfaces and the schemas are
 * type-parameterised with them (`z.ZodType<ReportFilters, z.ZodTypeDef, unknown>`).
 * That gives callers a concrete, readable type without depending on Zod's
 * inference through nested effects.
 */
import { z } from 'zod';
import { isUnspscCode } from '@/lib/normalize';

const optionalTrimmed = z.preprocess(
  (value) => {
    if (value === null || value === undefined) return undefined;
    const text = String(value).trim();
    return text.length ? text : undefined;
  },
  z.string().optional(),
) as unknown as z.ZodType<string | undefined, z.ZodTypeDef, unknown>;

/** `?flag=true|1|on` or a JSON boolean. Unknown values become undefined. */
export const queryBoolean = z.preprocess((value) => {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}, z.boolean().optional()) as unknown as z.ZodType<boolean | undefined, z.ZodTypeDef, unknown>;

/** Numeric field that tolerates string input and empty values. */
const optionalNumber = (min: number, max: number): z.ZodType<number | undefined, z.ZodTypeDef, unknown> =>
  z.preprocess((value) => {
    if (value === null || value === undefined || value === '') return undefined;
    const parsed = typeof value === 'number' ? value : Number(String(value).trim());
    return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
  }, z.number().min(min).max(max).optional()) as unknown as z.ZodType<number | undefined, z.ZodTypeDef, unknown>;

const optionalInt = (min: number, max: number): z.ZodType<number | undefined, z.ZodTypeDef, unknown> =>
  z.preprocess((value) => {
    if (value === null || value === undefined || value === '') return undefined;
    const parsed = typeof value === 'number' ? value : Number(String(value).trim());
    return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
  }, z.number().int().min(min).max(max).optional()) as unknown as z.ZodType<number | undefined, z.ZodTypeDef, unknown>;

/** Numeric field with a default, used for `?page=`/`?pageSize=` style params. */
const intWithDefault = (min: number, max: number, fallback: number): z.ZodType<number, z.ZodTypeDef, unknown> =>
  z.preprocess((value) => {
    if (value === null || value === undefined || value === '') return fallback;
    const parsed = typeof value === 'number' ? value : Number(String(value).trim());
    return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
  }, z.number().int().min(min).max(max)) as unknown as z.ZodType<number, z.ZodTypeDef, unknown>;

/** Comma-separated list or array -> number[] (undefined when nothing valid). */
export const numericList = z.preprocess((value) => {
  if (value === null || value === undefined || value === '') return undefined;
  const items = Array.isArray(value) ? value : String(value).split(',');
  const cleaned = items
    .map((item) => Number(String(item).trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
  return cleaned.length ? cleaned : undefined;
}, z.array(z.number().int().positive()).optional()) as unknown as z.ZodType<number[] | undefined, z.ZodTypeDef, unknown>;

/** Comma-separated list or array -> string[] (undefined when nothing valid). */
export const stringList = z.preprocess((value) => {
  if (value === null || value === undefined || value === '') return undefined;
  const items = Array.isArray(value) ? value : String(value).split(',');
  const cleaned = items.map((item) => String(item).trim()).filter(Boolean);
  return cleaned.length ? cleaned : undefined;
}, z.array(z.string()).optional()) as unknown as z.ZodType<string[] | undefined, z.ZodTypeDef, unknown>;

/**
 * Enum field that tolerates unknown values (and empty strings).
 *
 * TypeScript cannot infer literal union types through a runtime `includes`
 * lookup, so the enum type is passed explicitly as the first type argument.
 * The `values.includes` check is what actually enforces it at runtime.
 *
 * @example looseEnum<'a' | 'b'>(['a', 'b'])
 */
const looseEnum = <T extends string = never>(
  values: readonly string[],
  fallback?: T,
): z.ZodType<T | undefined, z.ZodTypeDef, unknown> =>
  z.preprocess(
    (value) => {
      if (value === null || value === undefined || value === '') return fallback;
      const normalized = String(value).trim().toLowerCase();
      return values.includes(normalized) ? (normalized as T) : fallback;
    },
    z.string().optional(),
  ) as unknown as z.ZodType<T | undefined, z.ZodTypeDef, unknown>;

/** Enum field with a default, so the output type is never undefined. */
const enumWithDefault = <T extends string = never>(
  values: readonly string[],
  fallback: T,
): z.ZodType<T, z.ZodTypeDef, unknown> =>
  z.preprocess(
    (value) => {
      if (value === null || value === undefined || value === '') return fallback;
      const normalized = String(value).trim().toLowerCase();
      return values.includes(normalized) ? (normalized as T) : fallback;
    },
    z.string(),
  ) as unknown as z.ZodType<T, z.ZodTypeDef, unknown>;

export const unspscCodeSchema = z
  .string()
  .trim()
  .refine((value) => isUnspscCode(value), { message: 'UNSPSC code must be exactly 8 digits' });

// ---------------------------------------------------------------------------
// Report filters
// ---------------------------------------------------------------------------

export type ConfidenceState = 'all' | 'low' | 'reviewed' | 'unreviewed' | 'unclassified';
export type RollupMode = 'supplier' | 'parent';

export interface ReportFilters {
  minConfidence?: number;
  maxConfidence?: number;
  confidenceState?: ConfidenceState;
  /** 2-digit UNSPSC segment, e.g. '43'. */
  segment?: string;
  /** Any UNSPSC prefix (2, 4, 6 or 8 digits). */
  unspscPrefix?: string;
  /** Parent company name. */
  parent?: string;
  parentId?: number;
  onlyParents?: boolean;
  onlySubsidiaries?: boolean;
  onlyStale?: boolean;
  from?: string;
  to?: string;
  industry?: string;
  country?: string;
  search?: string;
  /** 'parent' rolls spend and classification up to the parent company. */
  rollup: RollupMode;
  /** Restrict to specific supplier ids. */
  supplierIds?: number[];
  limit?: number;
}

export const reportFiltersSchema = z.object({
  minConfidence: optionalNumber(0, 1),
  maxConfidence: optionalNumber(0, 1),
  confidenceState: looseEnum<ConfidenceState>(['all', 'low', 'reviewed', 'unreviewed', 'unclassified']),
  segment: optionalTrimmed,
  unspscPrefix: optionalTrimmed,
  parent: optionalTrimmed,
  parentId: optionalInt(1, Number.MAX_SAFE_INTEGER),
  onlyParents: queryBoolean,
  onlySubsidiaries: queryBoolean,
  onlyStale: queryBoolean,
  from: optionalTrimmed,
  to: optionalTrimmed,
  industry: optionalTrimmed,
  country: optionalTrimmed,
  search: optionalTrimmed,
  rollup: enumWithDefault<RollupMode>(['supplier', 'parent'], 'supplier'),
  supplierIds: numericList,
  limit: optionalInt(1, 200_000),
});

/** Every filter is optional, for `{ filters: {...} }` request bodies. */
export type PartialReportFilters = Partial<ReportFilters>;

const partialFilterFields = {
  minConfidence: optionalNumber(0, 1),
  maxConfidence: optionalNumber(0, 1),
  confidenceState: looseEnum<ConfidenceState>(['all', 'low', 'reviewed', 'unreviewed', 'unclassified']),
  segment: optionalTrimmed,
  unspscPrefix: optionalTrimmed,
  parent: optionalTrimmed,
  parentId: optionalInt(1, Number.MAX_SAFE_INTEGER),
  onlyParents: queryBoolean,
  onlySubsidiaries: queryBoolean,
  onlyStale: queryBoolean,
  from: optionalTrimmed,
  to: optionalTrimmed,
  industry: optionalTrimmed,
  country: optionalTrimmed,
  search: optionalTrimmed,
  rollup: looseEnum<RollupMode>(['supplier', 'parent']),
  supplierIds: numericList,
  limit: optionalInt(1, 200_000),
} as const;

export const partialReportFiltersSchema = z.object(partialFilterFields);

/** Parse a `URLSearchParams`-like record into validated filters. */
export function parseReportFilters(
  input: Record<string, string | string[] | undefined> | URLSearchParams,
): ReportFilters {
  const record: Record<string, unknown> = {};
  if (input instanceof URLSearchParams) {
    for (const [key, value] of input.entries()) {
      const existing = record[key];
      if (existing === undefined) record[key] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else record[key] = [existing as string, value];
    }
  } else {
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      // Ignore pagination/format keys that are not filters.
      if (['format', 'page', 'pageSize', 'sort', 'dir', 'view', 'meta', 'usage', 'secret'].includes(key)) continue;
      record[key] = value;
    }
  }
  const parsed = reportFiltersSchema.safeParse(record);
  if (!parsed.success) {
    // Fall back to an unfiltered view rather than 500-ing the dashboard.
    return { rollup: 'supplier' };
  }
  return parsed.data;
}

/** Human-readable summary of active filters, used in report headers. */
export function describeFilters(filters: Partial<ReportFilters>): string[] {
  const parts: string[] = [];
  if (filters.minConfidence !== undefined) parts.push(`confidence >= ${filters.minConfidence}`);
  if (filters.maxConfidence !== undefined) parts.push(`confidence <= ${filters.maxConfidence}`);
  if (filters.confidenceState && filters.confidenceState !== 'all') {
    parts.push(`state: ${filters.confidenceState}`);
  }
  if (filters.segment) parts.push(`segment ${filters.segment}`);
  if (filters.unspscPrefix) parts.push(`UNSPSC prefix ${filters.unspscPrefix}`);
  if (filters.parent) parts.push(`parent "${filters.parent}"`);
  if (filters.parentId) parts.push(`parent #${filters.parentId}`);
  if (filters.onlyParents) parts.push('parents only');
  if (filters.onlySubsidiaries) parts.push('subsidiaries only');
  if (filters.onlyStale) parts.push('stale only');
  if (filters.industry) parts.push(`industry "${filters.industry}"`);
  if (filters.country) parts.push(`country "${filters.country}"`);
  if (filters.search) parts.push(`search "${filters.search}"`);
  if (filters.from || filters.to) parts.push(`dates ${filters.from ?? '...'} -> ${filters.to ?? '...'}`);
  if (filters.rollup === 'parent') parts.push('rolled up by parent');
  return parts;
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export interface UploadOptions {
  enrich?: boolean;
  classify?: boolean;
  skipEnrichment?: boolean;
  defaultDate?: string;
  actor?: string;
}

export const uploadOptionsSchema = z.object({
  enrich: queryBoolean,
  classify: queryBoolean,
  skipEnrichment: queryBoolean,
  defaultDate: optionalTrimmed,
  actor: optionalTrimmed,
});

export interface EnrichRequest {
  supplierIds?: number[];
  pending?: boolean;
  olderThanDays?: number;
  onlyStale?: boolean;
  limit?: number;
  actor?: string;
  force?: boolean;
}

export const enrichRequestSchema = z.object({
  supplierIds: numericList,
  pending: queryBoolean,
  olderThanDays: optionalInt(1, 3650),
  onlyStale: queryBoolean,
  limit: optionalInt(1, 500),
  actor: optionalTrimmed,
  force: queryBoolean,
});

export type ModelStrategy = 'tiered' | 'accurate' | 'bulk';

export interface ClassifyRequest {
  supplierIds?: number[];
  pending?: boolean;
  force?: boolean;
  limit?: number;
  actor?: string;
  modelStrategy?: ModelStrategy;
}

export const classifyRequestSchema = z.object({
  supplierIds: numericList,
  pending: queryBoolean,
  force: queryBoolean,
  limit: optionalInt(1, 500),
  actor: optionalTrimmed,
  modelStrategy: looseEnum<ModelStrategy>(['tiered', 'accurate', 'bulk']),
});

export interface CorrectionRequest {
  unspscCode: string;
  correctedBy?: string;
  reason?: string;
  applyToSubsidiaries?: boolean;
}

export const correctionRequestSchema = z.object({
  unspscCode: unspscCodeSchema,
  correctedBy: optionalTrimmed,
  reason: optionalTrimmed,
  applyToSubsidiaries: queryBoolean,
});

export interface LinkParentRequest {
  supplierId: number;
  parentId?: number;
  parentName?: string;
  parentDomain?: string;
  actor?: string;
}

export const linkParentRequestSchema = z.object({
  supplierId: intWithDefault(1, Number.MAX_SAFE_INTEGER, 1),
  parentId: optionalInt(1, Number.MAX_SAFE_INTEGER),
  parentName: optionalTrimmed,
  parentDomain: optionalTrimmed,
  actor: optionalTrimmed,
});

export interface UnlinkParentRequest {
  supplierId: number;
  actor?: string;
}

export const unlinkParentRequestSchema = z.object({
  supplierId: intWithDefault(1, Number.MAX_SAFE_INTEGER, 1),
  actor: optionalTrimmed,
});

export type SyncMode = 'enrich' | 'classify' | 'full' | 'report';

export interface SyncRequest {
  mode: SyncMode;
  limit?: number;
  staleAfterDays?: number;
  actor?: string;
}

export const syncRequestSchema = z.object({
  mode: enumWithDefault<SyncMode>(['enrich', 'classify', 'full', 'report'], 'full'),
  limit: optionalInt(1, 1000),
  staleAfterDays: optionalInt(1, 3650),
  actor: optionalTrimmed,
});

export interface GenerateReportRequest {
  name?: string;
  format: 'csv' | 'pdf';
  filters?: PartialReportFilters;
  generatedBy?: string;
  store?: boolean;
  schedule?: 'manual' | 'weekly' | 'monthly';
}

export const generateReportRequestSchema = z.object({
  name: optionalTrimmed,
  format: enumWithDefault<'csv' | 'pdf'>(['csv', 'pdf'], 'pdf'),
  filters: partialReportFiltersSchema.optional(),
  generatedBy: optionalTrimmed,
  store: queryBoolean,
  schedule: looseEnum<'manual' | 'weekly' | 'monthly'>(['manual', 'weekly', 'monthly']),
});

export interface SettingsUpdate {
  confidenceThreshold?: number;
  modelStrategy?: ModelStrategy;
  accurateModel?: string;
  bulkModel?: string;
  parentDetectionEnabled?: boolean;
  enrichmentEnabled?: boolean;
  enrichProvider?: 'companyenrich' | 'contextdev' | 'none';
  syncEnabled?: boolean;
  syncCron?: string;
  staleAfterDays?: number;
  batchSize?: number;
  weeklyReportEnabled?: boolean;
  weeklyReportCron?: string;
  reportRecipients?: string;
  groqApiKey?: string;
  enrichApiKey?: string;
  actor?: string;
}

export const settingsUpdateSchema = z.object({
  confidenceThreshold: optionalNumber(0, 1),
  modelStrategy: looseEnum<ModelStrategy>(['tiered', 'accurate', 'bulk']),
  accurateModel: optionalTrimmed,
  bulkModel: optionalTrimmed,
  parentDetectionEnabled: queryBoolean,
  enrichmentEnabled: queryBoolean,
  enrichProvider: looseEnum<'companyenrich' | 'contextdev' | 'none'>(['companyenrich', 'contextdev', 'none']),
  syncEnabled: queryBoolean,
  syncCron: optionalTrimmed,
  staleAfterDays: optionalInt(1, 3650),
  batchSize: optionalInt(1, 10),
  weeklyReportEnabled: queryBoolean,
  weeklyReportCron: optionalTrimmed,
  reportRecipients: optionalTrimmed,
  groqApiKey: optionalTrimmed,
  enrichApiKey: optionalTrimmed,
  actor: optionalTrimmed,
});

export type SupplierSort = 'name' | 'spend' | 'confidence' | 'updatedAt' | 'createdAt';

export interface SupplierQuery {
  page: number;
  pageSize: number;
  sort: SupplierSort;
  dir: 'asc' | 'desc';
  filters?: PartialReportFilters;
}

export const supplierQuerySchema = z.object({
  page: intWithDefault(1, 100_000, 1),
  pageSize: intWithDefault(1, 200, 25),
  sort: enumWithDefault<SupplierSort>(['name', 'spend', 'confidence', 'updatedAt', 'createdAt'], 'name'),
  dir: enumWithDefault<'asc' | 'desc'>(['asc', 'desc'], 'asc'),
  filters: partialReportFiltersSchema.optional(),
});

