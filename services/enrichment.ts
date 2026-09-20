/**
 * Supplier enrichment: web-API lookup (CompanyEnrich / Context.dev free tiers),
 * durable caching, heuristics, and the LLM parent-detection fallback.
 *
 * Flow for a batch of suppliers
 * -----------------------------
 *  1. Normalise the supplier name and strip legal suffixes for the query.
 *  2. Look up `enrichment_cache` by (provider, normalized name) — a cache HIT
 *     costs zero provider credits (the free tier is only 500).
 *  3. On a miss, call the provider with retries/backoff.
 *  4. Derive parent company information from the payload.
 *  5. If the provider returned nothing usable, either fall back to a
 *     deterministic guess (when `ENRICH_PROVIDER=none`) or to the LLM parent
 *     detector.
 *  6. Upsert `enrichment_cache`, and apply the merged result to the supplier row.
 */
import { and, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { enrichmentCache, suppliers as suppliersTable, type Supplier } from '@/db/schema';
import { getDb, type DbLike } from '@/db/client';
import { getEnv, isEnrichmentConfigured } from '@/lib/env';
import { ProviderError } from '@/lib/errors';
import { fetchWithTimeout, isRetryableStatus, mapLimit, parseRetryAfterMs, retry } from '@/lib/retry';
import { canonicalizeEntityName, extractDomain, normalizeSupplierName } from '@/lib/normalize';
import { chatCompletion, parseJsonResponse } from '@/services/groq';
import {
  PARENT_DETECTION_SYSTEM_PROMPT,
  buildBatchParentDetectionUserPrompt,
  buildParentDetectionUserPrompt,
  parseBatchParentDetectionResponse,
  parseParentDetectionPayload,
  type BatchSubject,
} from '@/services/prompts';
import { recordAudit } from '@/services/audit';
import { collectDescendantIds } from '@/services/hierarchy';
import {
  applyEnrichmentToSupplier,
  enrichmentFingerprint,
  ensureParentSupplier,
  findSuppliersNeedingEnrichment,
  linkSubsidiary,
  markSupplierStale,
} from '@/services/suppliers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EnrichmentResult = {
  domain: string | null;
  industry: string | null;
  naics: string | null;
  sic: string | null;
  description: string | null;
  country: string | null;
  /** Parent company name when the provider exposes ownership data. */
  parentName?: string | null;
  parentDomain?: string | null;
  /** Raw provider payload (stored in the cache for traceability). */
  raw?: Record<string, unknown> | null;
  /** True when this result came from `enrichment_cache`. */
  fromCache: boolean;
  /** Provider credits consumed (0 on a cache hit). */
  creditsUsed: number;
  provider: string;
};

export type ParentDetection = {
  parentName: string | null;
  parentDomain: string | null;
  isSubsidiary: boolean;
  confidence: number;
  source: 'enrichment' | 'llm' | 'heuristic' | 'none';
  model?: string;
};

export type EnrichOptions = {
  force?: boolean;
  /** Run the LLM parent detector when the provider returns no parent. */
  detectParent?: boolean;
  actor?: string;
  db?: DbLike;
  concurrency?: number;
  /** Cache TTL in days; defaults to the stale threshold. */
  cacheTtlDays?: number;
};

export type EnrichItemResult = {
  supplierId: number;
  name: string;
  status: 'enriched' | 'cached' | 'skipped' | 'failed';
  provider: string;
  changedFields: string[];
  parent: ParentDetection | null;
  needsReclassification: boolean;
  error?: string;
};

export type EnrichBatchSummary = {
  processed: number;
  enriched: number;
  cached: number;
  failed: number;
  skipped: number;
  creditsUsed: number;
  llmParentCalls: number;
  needsReclassification: number[];
  items: EnrichItemResult[];
  durationMs: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Name used for the provider lookup: legal suffixes removed. */
export function enrichmentQueryName(name: string): string {
  return canonicalizeEntityName(name).key || name.trim();
}

export function cacheKeyFor(provider: string, name: string): string {
  return `${provider}:${normalizeSupplierName(name)}`;
}

function truncate(value: unknown, max = 600): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function pickString(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

/**
 * Heuristics that work even without an enrichment provider: derive a likely
 * domain from the name, and detect a parent from an explicit "(a <Parent>
 * company)" style name.
 */
export function heuristicEnrichment(name: string): EnrichmentResult {
  const canonical = canonicalizeEntityName(name);
  const firstToken = canonical.key.split(' ')[0] ?? '';
  const domain =
    /\s/.test(canonical.key) || firstToken.length < 4 ? null : `${firstToken.replace(/[^a-z0-9]/g, '')}.com`;

  // "Acme Robotics, a Schneider Electric company"
  const parentMatch = /,\s*(?:an?|the)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4})\s+(?:company|group|subsidiary|brand)/.exec(
    name,
  );

  return {
    domain,
    industry: null,
    naics: null,
    sic: null,
    description: null,
    country: null,
    parentName: parentMatch?.[1] ? parentMatch[1].trim() : null,
    parentDomain: null,
    raw: null,
    fromCache: false,
    creditsUsed: 0,
    provider: 'heuristic',
  };
}

/** Normalise a CompanyEnrich-style payload. */
export function normalizeCompanyEnrichPayload(raw: unknown): Omit<EnrichmentResult, 'fromCache' | 'creditsUsed' | 'provider'> {
  const root = asRecord(raw) ?? {};
  const company = asRecord(root.company) ?? asRecord(root.data) ?? asRecord(root.result) ?? root;

  const domain =
    extractDomain(
      pickString(company, ['domain', 'primary_domain', 'website', 'url', 'company_domain', 'homepage']) ?? '',
    ) ?? null;

  const naics =
    pickString(company, ['naics', 'naics_code', 'naicsCode', 'primary_naics', 'naics_2022']) ??
    pickString(asRecord(company.industry) ?? {}, ['naics', 'code']) ??
    null;

  const sic = pickString(company, ['sic', 'sic_code', 'sicCode', 'primary_sic']) ?? null;

  const industry =
    pickString(company, ['industry', 'industry_name', 'sector', 'primary_industry', 'category']) ??
    pickString(asRecord(company.industry) ?? {}, ['name', 'label', 'description']) ??
    null;

  const description =
    truncate(
      pickString(company, ['description', 'long_description', 'short_description', 'summary', 'about', 'tagline']),
      1200,
    ) ?? null;

  const country =
    pickString(company, ['country', 'country_name', 'hq_country', 'country_code']) ??
    pickString(asRecord(company.location) ?? {}, ['country', 'country_name']) ??
    null;

  // Parent company: several providers nest ownership data differently.
  const parentRecord = asRecord(company.parent) ?? asRecord(company.parent_company) ?? asRecord(company.ultimate_parent);
  const parentName =
    pickString(company, ['parent_name', 'parent_company_name', 'ultimate_parent_name']) ??
    (parentRecord ? pickString(parentRecord, ['name', 'company_name', 'legal_name']) : null);

  const parentDomain =
    pickString(company, ['parent_domain', 'parent_website']) ??
    (parentRecord ? pickString(parentRecord, ['domain', 'website', 'url']) : null);

  return {
    domain,
    industry: truncate(industry, 200),
    naics: naics ? naics.replace(/\D/g, '').slice(0, 8) || null : null,
    sic: sic ? sic.replace(/\D/g, '').slice(0, 6) || null : null,
    description,
    country: truncate(country, 100),
    parentName: parentName ? parentName.trim() : null,
    parentDomain: parentDomain ? extractDomain(parentDomain) : null,
    raw: root,
  };
}

/**
 * Normalise a Context.dev payload (its `company` object differs slightly:
 * `industry`, `naics`, `employeeCount`, `parent` may be a string or object).
 */
export function normalizeContextDevPayload(raw: unknown): Omit<EnrichmentResult, 'fromCache' | 'creditsUsed' | 'provider'> {
  const base = normalizeCompanyEnrichPayload(raw);
  const root = asRecord(raw) ?? {};
  const company = asRecord(root.company) ?? asRecord(root.data) ?? root;

  const parentValue = company.parent ?? company.parentCompany ?? company.ultimate_parent;
  if (typeof parentValue === 'string' && parentValue.trim() && !base.parentName) {
    base.parentName = parentValue.trim();
  }
  if (Array.isArray(company.technologies) && !base.description) {
    base.description = truncate(`Technologies: ${company.technologies.slice(0, 12).join(', ')}`, 600);
  }
  return base;
}

// ---------------------------------------------------------------------------
// Provider calls
// ---------------------------------------------------------------------------

export type ProviderLookupResponse = {
  ok: boolean;
  status: number;
  data: unknown;
  error?: string;
  creditsUsed: number;
};

/**
 * CompanyEnrich `GET /v1/company/enrich?website=...` (their free tier supports
 * lookup by domain or by name). We try domain first, then name.
 */
export async function callCompanyEnrich(
  input: { name: string; domain?: string | null },
  options: { apiKey: string; baseUrl?: string; timeoutMs?: number } = { apiKey: '' },
): Promise<ProviderLookupResponse> {
  const baseUrl = (options.baseUrl ?? 'https://api.companyenrich.com').replace(/\/$/, '');

  const attempt = async (query: { website?: string; name?: string }): Promise<ProviderLookupResponse> => {
    const url = new URL(`${baseUrl}/v1/company/enrich`);
    if (query.website) url.searchParams.set('website', query.website);
    if (query.name) url.searchParams.set('name', query.name);

    return retry(
      async () => {
        const response = await fetchWithTimeout(url.toString(), {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            Accept: 'application/json',
            'User-Agent': 'unspsc-spend-categorizer/1.0',
          },
          timeoutMs: options.timeoutMs ?? 25_000,
        });

        if (!response.ok) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
          const body = await response.text().catch(() => '');
          if (response.status === 404) {
            return { ok: false, status: 404, data: null, error: 'not_found', creditsUsed: 0 };
          }
          if (response.status === 401 || response.status === 403) {
            return { ok: false, status: response.status, data: null, error: 'unauthorized', creditsUsed: 0 };
          }
          if (!isRetryableStatus(response.status)) {
            return { ok: false, status: response.status, data: null, error: body.slice(0, 300), creditsUsed: 0 };
          }
          throw new ProviderError('companyenrich', `HTTP ${response.status}: ${body.slice(0, 200)}`, {
            status: 503,
            retryable: true,
            details: { retryAfterMs },
          });
        }

        const data = (await response.json()) as unknown;
        return { ok: true, status: 200, data, creditsUsed: 1 };
      },
      { attempts: 3, baseDelayMs: 700, maxDelayMs: 15_000, label: 'companyenrich' },
    );
  };

  const byDomain = input.domain ? await attempt({ website: input.domain }) : null;
  if (byDomain?.ok) return byDomain;
  if (byDomain && byDomain.status === 401) return byDomain;

  const byName = await attempt({ name: enrichmentQueryName(input.name) });
  if (byName.ok) return byName;
  return byDomain && byDomain.status !== 404 ? byDomain : byName;
}

/** Context.dev `GET /v1/company?domain=...` */
export async function callContextDev(
  input: { name: string; domain?: string | null },
  options: { apiKey: string; baseUrl?: string; timeoutMs?: number } = { apiKey: '' },
): Promise<ProviderLookupResponse> {
  const baseUrl = (options.baseUrl ?? 'https://api.context.dev').replace(/\/$/, '');

  const attempt = async (query: { domain?: string; name?: string }): Promise<ProviderLookupResponse> => {
    const url = new URL(`${baseUrl}/v1/company`);
    if (query.domain) url.searchParams.set('domain', query.domain);
    if (query.name) url.searchParams.set('name', query.name);

    return retry(
      async () => {
        const response = await fetchWithTimeout(url.toString(), {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            Accept: 'application/json',
            'User-Agent': 'unspsc-spend-categorizer/1.0',
          },
          timeoutMs: options.timeoutMs ?? 25_000,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          if (response.status === 404) return { ok: false, status: 404, data: null, error: 'not_found', creditsUsed: 0 };
          if (response.status === 401 || response.status === 403) {
            return { ok: false, status: response.status, data: null, error: 'unauthorized', creditsUsed: 0 };
          }
          if (!isRetryableStatus(response.status)) {
            return { ok: false, status: response.status, data: null, error: body.slice(0, 300), creditsUsed: 0 };
          }
          throw new ProviderError('contextdev', `HTTP ${response.status}: ${body.slice(0, 200)}`, {
            status: 503,
            retryable: true,
          });
        }

        const data = (await response.json()) as unknown;
        return { ok: true, status: 200, data, creditsUsed: 1 };
      },
      { attempts: 3, baseDelayMs: 700, maxDelayMs: 15_000, label: 'contextdev' },
    );
  };

  if (input.domain) {
    const byDomain = await attempt({ domain: input.domain });
    if (byDomain.ok) return byDomain;
    if (byDomain.status === 401) return byDomain;
  }
  return attempt({ name: enrichmentQueryName(input.name) });
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

type CacheRow = typeof enrichmentCache.$inferSelect;

export async function readEnrichmentCache(
  provider: string,
  name: string,
  db: DbLike = getDb(),
): Promise<CacheRow | null> {
  const key = cacheKeyFor(provider, name);
  const rows = await db.select().from(enrichmentCache).where(eq(enrichmentCache.cacheKey, key)).limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;

  // Best-effort hit counter; never fail the lookup because of it.
  db.update(enrichmentCache)
    .set({ hitCount: sql`${enrichmentCache.hitCount} + 1` })
    .where(eq(enrichmentCache.id, row.id))
    .catch(() => undefined);

  return row;
}

export async function writeEnrichmentCache(
  entry: {
    supplierName: string;
    provider: string;
    domain?: string | null;
    payload: Record<string, unknown>;
    rawResponse?: Record<string, unknown> | null;
    creditsUsed: number;
    ttlDays: number;
  },
  db: DbLike = getDb(),
): Promise<void> {
  const key = cacheKeyFor(entry.provider, entry.supplierName);
  const expiresAt = new Date(Date.now() + entry.ttlDays * 86_400_000);

  await db
    .insert(enrichmentCache)
    .values({
      supplierName: entry.supplierName,
      cacheKey: key,
      provider: entry.provider,
      domain: entry.domain ?? null,
      payload: entry.payload,
      rawResponse: entry.rawResponse ?? null,
      creditsUsed: entry.creditsUsed,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: enrichmentCache.cacheKey,
      set: {
        payload: entry.payload,
        rawResponse: entry.rawResponse ?? null,
        domain: entry.domain ?? null,
        creditsUsed: entry.creditsUsed,
        expiresAt,
        provider: entry.provider,
      },
    });
}

/** Count provider credits consumed in the last 30 days (free-tier guard). */
export async function enrichmentCreditsUsedThisMonth(db: DbLike = getDb()): Promise<number> {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${enrichmentCache.creditsUsed}), 0)` })
    .from(enrichmentCache)
    .where(and(gte(enrichmentCache.createdAt, since), eq(enrichmentCache.provider, getEnv().ENRICH_PROVIDER)));
  return Number(rows[0]?.total ?? 0);
}

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------

/**
 * Enrich one supplier: cache first, then provider, then heuristic fallback.
 * Never throws for provider failures — the supplier is marked stale instead.
 */
export async function enrichOne(
  supplier: Pick<Supplier, 'id' | 'name' | 'domain' | 'industry' | 'naics' | 'sic' | 'description' | 'country'>,
  options: EnrichOptions = {},
): Promise<EnrichmentResult & { error?: string }> {
  const db = options.db ?? getDb();
  const env = getEnv();
  const provider = isEnrichmentConfigured() ? env.ENRICH_PROVIDER : 'heuristic';
  const ttlDays = options.cacheTtlDays ?? env.SYNC_STALE_DAYS;

  if (!options.force) {
    const cached = await readEnrichmentCache(provider, supplier.name, db);
    const payload = cached?.payload as Record<string, unknown> | null | undefined;
    if (cached && payload && typeof payload === 'object') {
      const restored = normalizeCompanyEnrichPayload(payload);
      return {
        ...restored,
        raw: payload,
        fromCache: true,
        creditsUsed: 0,
        provider,
      };
    }
  }

  if (!isEnrichmentConfigured()) {
    const heuristic = heuristicEnrichment(supplier.name);
    // A supplier that already carries data keeps it; otherwise we apply the
    // heuristic so the UI has something to show while offline.
    const merged = {
      ...heuristic,
      domain: supplier.domain ?? heuristic.domain,
      industry: supplier.industry ?? heuristic.industry,
      naics: supplier.naics ?? heuristic.naics,
      sic: supplier.sic ?? heuristic.sic,
      description: supplier.description ?? heuristic.description,
      country: supplier.country ?? heuristic.country,
    };
    return { ...merged, provider: 'heuristic' };
  }

  try {
    const response =
      env.ENRICH_PROVIDER === 'contextdev'
        ? await callContextDev(
            { name: supplier.name, domain: supplier.domain },
            { apiKey: env.ENRICH_API_KEY!, baseUrl: env.ENRICH_BASE_URL },
          )
        : await callCompanyEnrich(
            { name: supplier.name, domain: supplier.domain },
            { apiKey: env.ENRICH_API_KEY!, baseUrl: env.ENRICH_BASE_URL },
          );

    if (!response.ok || !response.data) {
      if (response.status === 401 || response.status === 403) {
        throw new ProviderError(provider, `Enrichment API rejected the key (${response.status})`, {
          status: 500,
          retryable: false,
        });
      }
      const heuristic = heuristicEnrichment(supplier.name);
      return {
        ...heuristic,
        domain: supplier.domain ?? heuristic.domain,
        industry: supplier.industry ?? heuristic.industry,
        description: supplier.description ?? heuristic.description,
        provider,
        error: response.error ?? `no data (${response.status})`,
      };
    }

    const normalized =
      env.ENRICH_PROVIDER === 'contextdev'
        ? normalizeContextDevPayload(response.data)
        : normalizeCompanyEnrichPayload(response.data);

    await writeEnrichmentCache(
      {
        supplierName: supplier.name,
        provider,
        domain: normalized.domain,
        payload: (normalized.raw ?? {}) as Record<string, unknown>,
        rawResponse: (asRecord(response.data) ?? {}) as Record<string, unknown>,
        creditsUsed: response.creditsUsed,
        ttlDays,
      },
      db,
    );

    return { ...normalized, fromCache: false, creditsUsed: response.creditsUsed, provider };
  } catch (error) {
    const heuristic = heuristicEnrichment(supplier.name);
    return {
      ...heuristic,
      domain: supplier.domain ?? heuristic.domain,
      industry: supplier.industry ?? heuristic.industry,
      description: supplier.description ?? heuristic.description,
      provider,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Parent detection
// ---------------------------------------------------------------------------

/**
 * Ask the accurate model for the ultimate parent company. Used only when the
 * enrichment provider returned no ownership data (keeps 70B quota for what
 * matters).
 */
export async function detectParentWithLlm(
  subject: {
    supplier_name: string;
    domain?: string | null;
    industry?: string | null;
    naics?: string | null;
    country?: string | null;
  },
  options: { model?: string } = {},
): Promise<ParentDetection> {
  const env = getEnv();
  const model = options.model ?? env.GROQ_MODEL_ACCURATE;

  const completion = await chatCompletion({
    model,
    temperature: 0,
    maxTokens: 300,
    responseFormat: { type: 'json_object' },
    messages: [
      { role: 'system', content: PARENT_DETECTION_SYSTEM_PROMPT },
      { role: 'user', content: buildParentDetectionUserPrompt(subject) },
    ],
  });

  const parsed = parseParentDetectionPayload(parseJsonResponse(completion.content));
  if (!parsed || !parsed.parent_name || !parsed.is_subsidiary) {
    return { parentName: null, parentDomain: null, isSubsidiary: false, confidence: parsed?.confidence ?? 0.5, source: 'llm', model };
  }

  // Guard against the model echoing the supplier itself.
  if (normalizeSupplierName(parsed.parent_name) === normalizeSupplierName(subject.supplier_name)) {
    return { parentName: null, parentDomain: null, isSubsidiary: false, confidence: 0.4, source: 'llm', model };
  }

  return {
    parentName: parsed.parent_name,
    parentDomain: parsed.parent_domain,
    isSubsidiary: true,
    confidence: parsed.confidence,
    source: 'llm',
    model,
  };
}

/** Batched variant of `detectParentWithLlm` (up to 10 subjects per request). */
export async function detectParentsWithLlm(
  subjects: Array<{
    supplier_name: string;
    domain?: string | null;
    industry?: string | null;
    naics?: string | null;
    country?: string | null;
  }>,
  options: { model?: string } = {},
): Promise<Map<string, ParentDetection>> {
  const env = getEnv();
  const results = new Map<string, ParentDetection>();
  if (!subjects.length) return results;

  const model = options.model ?? env.GROQ_MODEL_ACCURATE;
  const batchSubjects: BatchSubject[] = subjects.map((subject, index) => ({ ...subject, index }));

  const completion = await chatCompletion({
    model,
    temperature: 0,
    maxTokens: 2048,
    responseFormat: { type: 'json_object' },
    messages: [
      { role: 'system', content: PARENT_DETECTION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildBatchParentDetectionUserPrompt(batchSubjects),
      },
    ],
  });

  const parsedItems = parseBatchParentDetectionResponse(parseJsonResponse(completion.content));
  parsedItems.forEach((item, index) => {
    const parsed = parseParentDetectionPayload(item);
    const subject = subjects[index];
    if (!subject) return;
    const key = normalizeSupplierName(subject.supplier_name);
    if (!parsed || !parsed.parent_name || !parsed.is_subsidiary) {
      results.set(key, {
        parentName: null,
        parentDomain: null,
        isSubsidiary: false,
        confidence: parsed?.confidence ?? 0.5,
        source: 'llm',
        model,
      });
      return;
    }
    if (normalizeSupplierName(parsed.parent_name) === key) {
      results.set(key, {
        parentName: null,
        parentDomain: null,
        isSubsidiary: false,
        confidence: 0.4,
        source: 'llm',
        model,
      });
      return;
    }
    results.set(key, {
      parentName: parsed.parent_name,
      parentDomain: parsed.parent_domain,
      isSubsidiary: true,
      confidence: parsed.confidence,
      source: 'llm',
      model,
    });
  });

  return results;
}

// ---------------------------------------------------------------------------
// Batch orchestration
// ---------------------------------------------------------------------------

/**
 * Enrich suppliers. Batch 1 uses the provider (+ cache), batch 2 runs LLM parent
 * detection for suppliers the provider could not place inside a corporate
 * family.
 */
export async function enrichSuppliers(
  supplierIds: number[] | undefined,
  options: EnrichOptions & { limit?: number } = {},
): Promise<EnrichBatchSummary> {
  const started = Date.now();
  const db = options.db ?? getDb();
  const env = getEnv();
  const actor = options.actor ?? 'system';

  const targetRows: Supplier[] = supplierIds?.length
    ? await db.select().from(suppliersTable).where(inArray(suppliersTable.id, supplierIds))
    : await findSuppliersNeedingEnrichment({
        olderThanDays: options.force ? 0 : undefined,
        limit: options.limit ?? env.SYNC_BATCH_SIZE,
        db,
      });

  const summary: EnrichBatchSummary = {
    processed: 0,
    enriched: 0,
    cached: 0,
    failed: 0,
    skipped: 0,
    creditsUsed: 0,
    llmParentCalls: 0,
    needsReclassification: [],
    items: [],
    durationMs: 0,
  };

  if (!targetRows.length) {
    summary.durationMs = Date.now() - started;
    return summary;
  }

  // ---- pass 1: provider / cache ------------------------------------------
  const lookups = await mapLimit(targetRows, options.concurrency ?? env.ENRICH_CONCURRENCY, async (row) =>
    enrichOne(row, { ...options, db }),
  );

  const pendingParentDetection: Array<{ row: Supplier; result: EnrichmentResult & { error?: string } }> = [];

  for (let i = 0; i < targetRows.length; i += 1) {
    const row = targetRows[i]!;
    const outcome = lookups[i];
    summary.processed += 1;

    if (!outcome) {
      summary.failed += 1;
      await markSupplierStale(row.id, 'enrichment_failed', { db, actor });
      await applyEnrichmentToSupplier(row.id, { error: 'enrichment worker returned no result' }, { db, actor });
      summary.items.push({
        supplierId: row.id,
        name: row.name,
        status: 'failed',
        provider: 'unknown',
        changedFields: [],
        parent: null,
        needsReclassification: false,
        error: 'enrichment worker returned no result',
      });
      continue;
    }

    if (!outcome.ok) {
      const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      summary.failed += 1;
      await markSupplierStale(row.id, 'enrichment_failed', { db, actor });
      await applyEnrichmentToSupplier(row.id, { error: message }, { db, actor });
      summary.items.push({
        supplierId: row.id,
        name: row.name,
        status: 'failed',
        provider: 'unknown',
        changedFields: [],
        parent: null,
        needsReclassification: false,
        error: message,
      });
      continue;
    }

    const result = outcome.value;
    if (result.fromCache) summary.cached += 1;
    else if (!result.error) summary.enriched += 1;
    else summary.failed += 1;
    summary.creditsUsed += result.creditsUsed;

    const parent: ParentDetection | null = result.parentName
      ? {
          parentName: result.parentName,
          parentDomain: result.parentDomain ?? null,
          isSubsidiary: true,
          confidence: 0.8,
          source: 'enrichment',
        }
      : null;

    const fingerprint = enrichmentFingerprint({
      domain: result.domain,
      industry: result.industry,
      naics: result.naics,
      sic: result.sic,
      parentName: result.parentName ?? null,
      description: result.description,
    });

    const applied = await applyEnrichmentToSupplier(
      row.id,
      {
        domain: result.domain,
        industry: result.industry,
        naics: result.naics,
        sic: result.sic,
        description: result.description,
        country: result.country,
        parentName: parent?.parentName ?? null,
        parentDomain: parent?.parentDomain ?? null,
        parentSource: parent ? 'enrichment' : null,
        parentConfidence: parent?.confidence ?? null,
        fingerprint,
        error: result.error ?? null,
      },
      { db, actor },
    );

    summary.items.push({
      supplierId: row.id,
      name: row.name,
      status: result.fromCache ? 'cached' : result.error ? 'failed' : 'enriched',
      provider: result.provider,
      changedFields: applied.changedFields,
      parent,
      needsReclassification:
        applied.changedFields.includes('industry') ||
        applied.changedFields.includes('naics') ||
        applied.changedFields.includes('sic'),
      error: result.error,
    });

    if (!parent && (options.detectParent ?? true) && env.GROQ_API_KEY) {
      pendingParentDetection.push({ row, result });
    }
  }

  // ---- pass 2: LLM parent detection --------------------------------------
  if (pendingParentDetection.length && (options.detectParent ?? true)) {
    const batchSize = Math.max(1, Math.min(10, env.LLM_BATCH_SIZE));
    for (let i = 0; i < pendingParentDetection.length; i += batchSize) {
      const slice = pendingParentDetection.slice(i, i + batchSize);
      try {
        const detections = await detectParentsWithLlm(
          slice.map((entry) => ({
            supplier_name: entry.row.name,
            domain: entry.result.domain ?? entry.row.domain,
            industry: entry.result.industry ?? entry.row.industry,
            naics: entry.result.naics ?? entry.row.naics,
          })),
        );
        summary.llmParentCalls += 1;

        for (const entry of slice) {
          const detection = detections.get(normalizeSupplierName(entry.row.name));
          if (!detection || !detection.parentName) continue;
          const item = summary.items.find((candidate) => candidate.supplierId === entry.row.id);
          if (item) item.parent = detection;

          await applyEnrichmentToSupplier(
            entry.row.id,
            {
              parentName: detection.parentName,
              parentDomain: detection.parentDomain,
              parentSource: 'llm',
              parentConfidence: detection.confidence,
            },
            { db, actor },
          );
          await recordAudit(
            {
              entity: 'supplier',
              entityId: entry.row.id,
              action: 'updated',
              details: { parentDetection: detection, model: detection.model },
              actor,
            },
            db,
          );
        }
      } catch (error) {
        for (const entry of slice) {
          const item = summary.items.find((candidate) => candidate.supplierId === entry.row.id);
          if (item) item.error = error instanceof Error ? error.message : String(error);
        }
      }
    }
  }

  summary.needsReclassification = summary.items
    .filter((item) => item.needsReclassification)
    .map((item) => item.supplierId);

  summary.durationMs = Date.now() - started;
  return summary;
}

/**
 * Persist the corporate structure after enrichment: any supplier with a
 * `parent_name` gets a parent row (created if needed) and a `parent_id` link so
 * classification can run parent-first.
 */
export async function resolveParentLinks(
  options: { supplierIds?: number[]; db?: DbLike; actor?: string; minConfidence?: number } = {},
): Promise<{ linked: number; parentsCreated: number; skipped: number }> {
  const db = options.db ?? getDb();
  const actor = options.actor ?? 'system';
  const minConfidence = options.minConfidence ?? 0.5;

  const candidates = options.supplierIds?.length
    ? await db.select().from(suppliersTable).where(inArray(suppliersTable.id, options.supplierIds))
    : await db
        .select()
        .from(suppliersTable)
        .where(and(isNotNull(suppliersTable.parentName), isNull(suppliersTable.parentId)));

  let linked = 0;
  let parentsCreated = 0;
  let skipped = 0;

  // Load the hierarchy columns once; they are re-used for cycle checks.
  const allRows = await db
    .select({
      id: suppliersTable.id,
      name: suppliersTable.name,
      parentId: suppliersTable.parentId,
      parentName: suppliersTable.parentName,
      isParent: suppliersTable.isParent,
    })
    .from(suppliersTable);

  for (const row of candidates) {
    if (!row.parentName) continue;
    if (row.parentConfidence !== null && Number(row.parentConfidence) < minConfidence) {
      skipped += 1;
      continue;
    }
    if (normalizeSupplierName(row.parentName) === row.normalizedName) {
      skipped += 1;
      continue;
    }

    try {
      const existingParent = allRows.find(
        (candidate) => normalizeSupplierName(candidate.name) === normalizeSupplierName(row.parentName!),
      );
      const parent = await ensureParentSupplier(row.parentName, {
        db,
        actor,
        domain: row.parentDomain,
        industry: row.industry,
      });
      if (!parent) {
        skipped += 1;
        continue;
      }
      if (!existingParent) parentsCreated += 1;

      // Never create a cycle: the parent must not already be a descendant.
      if (collectDescendantIds(allRows, row.id).includes(parent.id)) {
        skipped += 1;
        continue;
      }
      if (row.parentId === parent.id) {
        skipped += 1;
        continue;
      }

      await linkSubsidiary(row.id, parent.id, {
        db,
        actor,
        source: row.parentSource === 'llm' ? 'llm' : 'enrichment',
        parentName: row.parentName,
        parentDomain: row.parentDomain,
        confidence: row.parentConfidence === null ? null : Number(row.parentConfidence),
      });
      linked += 1;
    } catch (error) {
      console.error('[enrich] parent link failed', { supplierId: row.id, error });
      skipped += 1;
    }
  }

  return { linked, parentsCreated, skipped };
}
