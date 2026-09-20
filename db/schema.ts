/**
 * Drizzle schema — single source of truth for the Neon Postgres database.
 *
 * Design notes
 * ------------
 * - `suppliers.parent_id` is a self-referencing FK. A supplier that has a parent
 *   is a subsidiary; a supplier that has children has `is_parent = true`.
 * - ONLY_ONE_LEVEL: a supplier cannot be both a parent and a subsidiary. The
 *   hierarchy service enforces this in application code (see
 *   `services/hierarchy.ts`) because Postgres cannot express it as a simple
 *   CHECK constraint across rows.
 * - `classifications` keeps history: a correction inserts a new current row and
 *   marks the previous one reviewed. The "current" classification is the newest
 *   row per supplier that has not been superseded.
 * - Everything that mutates supplier/classification state writes an `audit_log`
 *   row.
 */
import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  char,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** Postgres `bytea` mapped to a Node Buffer (used for stored report blobs). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

// ---------------------------------------------------------------------------
// suppliers
// ---------------------------------------------------------------------------
export const suppliers = pgTable(
  'suppliers',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    /** Case/whitespace-insensitive dedupe key: lower(trim(name)) collapsed. */
    normalizedName: text('normalized_name').notNull(),
    domain: text('domain'),
    industry: text('industry'),
    naics: text('naics'),
    sic: text('sic'),
    description: text('description'),
    country: text('country'),
    /** Aggregated spend loaded from the source CSV (may be null). */
    totalAmount: numeric('total_amount', { precision: 18, scale: 2 }),
    transactionCount: integer('transaction_count').default(0).notNull(),
    currency: text('currency').default('USD').notNull(),

    parentId: integer('parent_id'),
    parentName: text('parent_name'),
    parentDomain: text('parent_domain'),
    isParent: boolean('is_parent').default(false).notNull(),
    /** How the parent link was established. */
    parentSource: text('parent_source'), // 'enrichment' | 'llm' | 'manual'
    parentConfidence: numeric('parent_confidence', { precision: 3, scale: 2 }),

    enrichedAt: timestamp('enriched_at', { withTimezone: true }),
    enrichAttempts: integer('enrich_attempts').default(0).notNull(),
    lastEnrichError: text('last_enrich_error'),
    /** Hash of the enriched payload — used to detect "significant" changes. */
    enrichFingerprint: text('enrich_fingerprint'),
    stale: boolean('stale').default(false).notNull(),
    staleReason: text('stale_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    nameUnique: uniqueIndex('suppliers_name_key').on(table.name),
    normalizedUnique: uniqueIndex('suppliers_normalized_name_key').on(table.normalizedName),
    parentIdx: index('suppliers_parent_id_idx').on(table.parentId),
    domainIdx: index('suppliers_domain_idx').on(table.domain),
    staleIdx: index('suppliers_stale_idx').on(table.stale, table.enrichedAt),
    isParentIdx: index('suppliers_is_parent_idx').on(table.isParent),
  }),
);

// ---------------------------------------------------------------------------
// unspsc_codes
// ---------------------------------------------------------------------------
export const unspscCodes = pgTable(
  'unspsc_codes',
  {
    code: char('code', { length: 8 }).primaryKey(),
    segment: text('segment'),
    segmentCode: char('segment_code', { length: 2 }),
    family: text('family'),
    familyCode: char('family_code', { length: 4 }),
    class: text('class'),
    classCode: char('class_code', { length: 6 }),
    commodity: text('commodity').notNull(),
    description: text('description'),
    /** Lowercased commodity+description text, used for keyword candidate retrieval. */
    searchText: text('search_text'),
    version: text('version').default('v26.0801').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    segmentIdx: index('unspsc_codes_segment_code_idx').on(table.segmentCode),
    familyIdx: index('unspsc_codes_family_code_idx').on(table.familyCode),
  }),
);

// ---------------------------------------------------------------------------
// classifications
// ---------------------------------------------------------------------------
export const classifications = pgTable(
  'classifications',
  {
    id: serial('id').primaryKey(),
    supplierId: integer('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'cascade' }),
    unspscCode: char('unspsc_code', { length: 8 }).notNull(),
    confidence: numeric('confidence', { precision: 3, scale: 2 }).notNull(),
    reasoning: text('reasoning'),
    llmModel: text('llm_model'),
    alternatives: jsonb('alternatives').$type<ClassificationAlternative[]>(),
    inheritedFromParent: boolean('inherited_from_parent').default(false).notNull(),
    inheritedFromSupplierId: integer('inherited_from_supplier_id'),
    reviewed: boolean('reviewed').default(false).notNull(),
    correctedCode: char('corrected_code', { length: 8 }),
    correctedBy: text('corrected_by'),
    correctedAt: timestamp('corrected_at', { withTimezone: true }),
    /** Only the newest non-superseded row per supplier is current. */
    superseded: boolean('superseded').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    supplierIdx: index('classifications_supplier_id_idx').on(table.supplierId),
    currentIdx: index('classifications_current_idx').on(table.supplierId, table.superseded),
    codeIdx: index('classifications_unspsc_code_idx').on(table.unspscCode),
    reviewedIdx: index('classifications_reviewed_idx').on(table.reviewed, table.confidence),
  }),
);

export type ClassificationAlternative = {
  code: string;
  confidence: number;
  description?: string;
};

// ---------------------------------------------------------------------------
// corrections
// ---------------------------------------------------------------------------
export const corrections = pgTable(
  'corrections',
  {
    id: serial('id').primaryKey(),
    supplierId: integer('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'cascade' }),
    classificationId: integer('classification_id'),
    originalCode: char('original_code', { length: 8 }),
    correctedCode: char('corrected_code', { length: 8 }).notNull(),
    reason: text('reason'),
    correctedBy: text('corrected_by').notNull(),
    appliedToSubsidiaries: boolean('applied_to_subsidiaries').default(false).notNull(),
    affectedSupplierIds: jsonb('affected_supplier_ids').$type<number[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    supplierIdx: index('corrections_supplier_id_idx').on(table.supplierId),
    createdIdx: index('corrections_created_at_idx').on(table.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// enrichment_cache
// ---------------------------------------------------------------------------
export const enrichmentCache = pgTable(
  'enrichment_cache',
  {
    id: serial('id').primaryKey(),
    supplierName: text('supplier_name').notNull(),
    cacheKey: text('cache_key').notNull(),
    provider: text('provider').notNull(),
    domain: text('domain'),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    rawResponse: jsonb('raw_response').$type<Record<string, unknown>>(),
    /** Number of provider credits consumed to produce this row. */
    creditsUsed: integer('credits_used').default(0).notNull(),
    hitCount: integer('hit_count').default(0).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    cacheKeyUnique: uniqueIndex('enrichment_cache_cache_key_key').on(table.cacheKey),
    supplierIdx: index('enrichment_cache_supplier_name_idx').on(table.supplierName),
  }),
);

// ---------------------------------------------------------------------------
// audit_log
// ---------------------------------------------------------------------------
export const auditLog = pgTable(
  'audit_log',
  {
    id: serial('id').primaryKey(),
    entity: text('entity').notNull(), // 'supplier' | 'classification' | 'correction' | 'report' | 'settings' | 'sync'
    entityId: integer('entity_id'),
    action: text('action').notNull(), // 'enriched' | 'classified' | 'corrected' | 'synced' | ...
    details: jsonb('details').$type<Record<string, unknown>>(),
    actor: text('actor').default('system').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    entityIdx: index('audit_log_entity_idx').on(table.entity, table.entityId),
    createdIdx: index('audit_log_created_at_idx').on(table.createdAt),
    actionIdx: index('audit_log_action_idx').on(table.action),
  }),
);

// ---------------------------------------------------------------------------
// reports
// ---------------------------------------------------------------------------
export const reports = pgTable(
  'reports',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    format: text('format').notNull(), // 'csv' | 'pdf'
    filters: jsonb('filters').$type<Record<string, unknown>>(),
    rowCount: integer('row_count').default(0).notNull(),
    sizeBytes: integer('size_bytes').default(0).notNull(),
    generatedBy: text('generated_by').default('system').notNull(),
    blob: bytea('blob'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    createdIdx: index('reports_created_at_idx').on(table.createdAt),
    formatIdx: index('reports_format_idx').on(table.format),
  }),
);

// ---------------------------------------------------------------------------
// app_settings (singleton row, id = 1)
// ---------------------------------------------------------------------------
export const appSettings = pgTable('app_settings', {
  id: integer('id').primaryKey().default(1),
  confidenceThreshold: numeric('confidence_threshold', { precision: 3, scale: 2 })
    .default('0.70')
    .notNull(),
  modelStrategy: text('model_strategy').default('tiered').notNull(), // 'tiered' | 'accurate' | 'bulk'
  accurateModel: text('accurate_model').default('llama-3.3-70b-versatile').notNull(),
  bulkModel: text('bulk_model').default('llama-3.1-8b-instant').notNull(),
  parentDetectionEnabled: boolean('parent_detection_enabled').default(true).notNull(),
  enrichmentEnabled: boolean('enrichment_enabled').default(true).notNull(),
  enrichProvider: text('enrich_provider').default('companyenrich').notNull(),
  /** Stored masked; only for display. The runtime key always comes from env. */
  enrichApiKeyMasked: text('enrich_api_key_masked'),
  groqApiKeyMasked: text('groq_api_key_masked'),
  syncEnabled: boolean('sync_enabled').default(true).notNull(),
  syncCron: text('sync_cron').default('0 3 * * *').notNull(),
  staleAfterDays: integer('stale_after_days').default(30).notNull(),
  batchSize: integer('batch_size').default(25).notNull(),
  weeklyReportEnabled: boolean('weekly_report_enabled').default(true).notNull(),
  weeklyReportCron: text('weekly_report_cron').default('0 6 * * 1').notNull(),
  reportRecipients: text('report_recipients'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  updatedBy: text('updated_by').default('system').notNull(),
});

// ---------------------------------------------------------------------------
// llm_usage (rate-limit + free-tier budget accounting)
// ---------------------------------------------------------------------------
export const llmUsage = pgTable(
  'llm_usage',
  {
    id: serial('id').primaryKey(),
    model: text('model').notNull(),
    /** UTC day bucket, 'YYYY-MM-DD'. */
    usageDay: text('usage_day').notNull(),
    requestCount: integer('request_count').default(0).notNull(),
    promptTokens: integer('prompt_tokens').default(0).notNull(),
    completionTokens: integer('completion_tokens').default(0).notNull(),
    failureCount: integer('failure_count').default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    modelDayUnique: uniqueIndex('llm_usage_model_day_key').on(table.model, table.usageDay),
  }),
);

// ---------------------------------------------------------------------------
// relations
// ---------------------------------------------------------------------------
export const suppliersRelations = relations(suppliers, ({ one, many }) => ({
  parent: one(suppliers, {
    fields: [suppliers.parentId],
    references: [suppliers.id],
    relationName: 'supplier_hierarchy',
  }),
  subsidiaries: many(suppliers, { relationName: 'supplier_hierarchy' }),
  classifications: many(classifications),
  corrections: many(corrections),
}));

export const classificationsRelations = relations(classifications, ({ one }) => ({
  supplier: one(suppliers, {
    fields: [classifications.supplierId],
    references: [suppliers.id],
  }),
  code: one(unspscCodes, {
    fields: [classifications.unspscCode],
    references: [unspscCodes.code],
  }),
}));

export const correctionsRelations = relations(corrections, ({ one }) => ({
  supplier: one(suppliers, {
    fields: [corrections.supplierId],
    references: [suppliers.id],
  }),
}));

// ---------------------------------------------------------------------------
// inferred types
// ---------------------------------------------------------------------------
export type Supplier = typeof suppliers.$inferSelect;
export type NewSupplier = typeof suppliers.$inferInsert;
export type UnspscCode = typeof unspscCodes.$inferSelect;
export type NewUnspscCode = typeof unspscCodes.$inferInsert;
export type Classification = typeof classifications.$inferSelect;
export type NewClassification = typeof classifications.$inferInsert;
export type Correction = typeof corrections.$inferSelect;
export type NewCorrection = typeof corrections.$inferInsert;
export type EnrichmentCacheRow = typeof enrichmentCache.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
export type ReportRow = typeof reports.$inferSelect;
export type NewReportRow = typeof reports.$inferInsert;
export type AppSettings = typeof appSettings.$inferSelect;
export type LlmUsageRow = typeof llmUsage.$inferSelect;

/** SQL helper: newest-first, current classification per supplier. */
export const currentClassificationPredicate = sql`superseded = false`;
