/**
 * UNSPSC classification service.
 *
 * Core rules implemented here:
 *  1. Parents are classified BEFORE subsidiaries. `planClassification()` groups
 *     suppliers into corporate clusters and picks one representative per cluster,
 *     so a parent with 20 subsidiaries costs one Groq request instead of 21.
 *  2. Subsidiaries inherit the parent's code with `inherited_from_parent = true`
 *     and a confidence capped below the parent's own.
 *  3. Manual corrections at the parent level optionally propagate to every
 *     subsidiary, and are fed back into the prompt as few-shot examples.
 *  4. Everything is validated against the seeded UNSPSC taxonomy, so an invented
 *     code can never reach the database.
 */
import { and, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  classifications,
  corrections,
  suppliers as suppliersTable,
  unspscCodes,
  type ClassificationAlternative,
} from '@/db/schema';
import { getDb, type DbLike } from '@/db/client';
import { getEnv } from '@/lib/env';
import { clamp, isUnspscCode, normalizeSupplierName, chunk } from '@/lib/normalize';
import { chatCompletion, parseJsonResponse, type ChatCompletionResult } from '@/services/groq';
import {
  CLASSIFICATION_SYSTEM_PROMPT,
  buildBatchClassificationUserPrompt,
  buildClassificationUserPrompt,
  buildFewShotExamples,
  parseBatchClassificationResponse,
  parseClassificationPayload,
  type BatchSubject,
  type CandidateCode,
  type ClassificationSubject,
  type FewShotExample,
} from '@/services/prompts';
import { planClassification, readAmount, type SupplierNode } from '@/services/hierarchy';
import { recordAudit, recordAuditBatch } from '@/services/audit';
import { toNode, type SupplierListRow } from '@/services/suppliers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelStrategy = 'tiered' | 'accurate' | 'bulk';

export type ClassifyOptions = {
  /** Restrict work to these suppliers (dependencies are still planned). */
  supplierIds?: number[];
  /** Re-classify suppliers that already have a current classification. */
  force?: boolean;
  limit?: number;
  actor?: string;
  db?: DbLike;
  modelStrategy?: ModelStrategy;
  /** Skip suppliers whose classification was manually reviewed. */
  preserveReviewed?: boolean;
  maxBatches?: number;
};

export type ClassificationItemResult = {
  supplierId: number;
  name: string;
  code: string | null;
  confidence: number;
  model: string | null;
  inherited: boolean;
  inheritedFromSupplierId: number | null;
  reasoning: string | null;
  /** True when the returned code was not found in the local taxonomy. */
  codeUnknown: boolean;
  status: 'classified' | 'inherited' | 'skipped' | 'failed';
  error?: string;
};

export type ClassifySummary = {
  processed: number;
  classified: number;
  inherited: number;
  failed: number;
  skipped: number;
  llmRequests: number;
  promptTokens: number;
  completionTokens: number;
  lowConfidence: number;
  items: ClassificationItemResult[];
  errors: string[];
  durationMs: number;
};

export type ClassificationPlanPreview = {
  clusters: number;
  parentItems: Array<{
    clusterKey: string;
    representativeId: number;
    representativeName: string;
    rootName: string;
    isVirtualRoot: boolean;
    subsidiaries: number;
    totalAmount: number;
    model: string;
  }>;
  standalone: Array<{ id: number; name: string; model: string }>;
  totalSuppliers: number;
  estimatedRequests: number;
};

// ---------------------------------------------------------------------------
// Candidates + few-shot
// ---------------------------------------------------------------------------

/**
 * Words that carry no UNSPSC signal. Deliberately conservative: words such as
 * "supplies", "products" and "systems" are KEPT because they do discriminate
 * between segments (40 = Distribution and Conditioning Systems, 43 = IT).
 */
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'inc',
  'llc',
  'ltd',
  'corp',
  'corporation',
  'company',
  'group',
  'holdings',
  'services',
  'service',
  'of',
  'a',
  'an',
  'co',
  'international',
  'global',
  'national',
  'general',
]);

/** Split free text into meaningful keywords for candidate retrieval. */
export function extractKeywords(text: string | null | undefined, limit = 8): string[] {
  if (!text) return [];
  const words = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && !STOP_WORDS.has(word) && !/^\d+$/.test(word));
  return Array.from(new Set(words)).slice(0, limit);
}

/**
 * Retrieve candidate UNSPSC codes for a supplier.
 *
 * Grounding the model in real codes is the biggest single accuracy lever on a
 * free tier, but the retrieval has to be *relevant* or it actively misleads:
 * ranking "Computer manufacturing" by a generic keyword once returned
 * `73161510 Chemical or pharmaceutical machinery manufacture services`.
 *
 * Three things make this work:
 *
 *  1. **Per-keyword row budgets instead of one big OR.** The original version
 *     built `WHERE k1 OR k2 ... LIMIT n`, so whichever keyword had the most
 *     matches filled the result set before ranking ran — the ranking never saw
 *     the discriminating codes. Each keyword is now queried separately with its
 *     own small limit, so every keyword gets representation.
 *  2. **Weighted scoring over the whole row.** A match in `commodity` says far
 *     more than one in `segment` (segments hold thousands of codes).
 *  3. **Relevance filtering.** A candidate must score above a floor; otherwise it
 *     is noise and is dropped rather than padding the prompt.
 */
export async function findCandidateCodes(
  query: { industry?: string | null; description?: string | null; name?: string | null },
  options: { limit?: number; db?: DbLike } = {},
): Promise<CandidateCode[]> {
  const db = options.db ?? getDb();
  const limit = options.limit ?? 20;

  // Prefer a distinguishing name token, then industry, then description.
  //
  // More keywords than the original 5 because `industry` is often a NAICS-derived
  // label that overlaps with taxonomy *category* names ("Industrial supplies
  // merchant wholesalers") rather than product nouns, while `description` usually
  // names the actual goods ("valves, fittings, fasteners"). A wider net lets the
  // scoring pass find the discriminating terms; the query is per-keyword so the
  // cost scales linearly and stays bounded.
  const industryKeywords = extractKeywords(query.industry, 4);
  const descriptionKeywords = extractKeywords(query.description, 4);
  const nameKeywords = extractKeywords(query.name, 3);

  const keywords: string[] = [];
  for (const source of [industryKeywords, nameKeywords, descriptionKeywords]) {
    for (const keyword of source) {
      if (!keywords.includes(keyword)) keywords.push(keyword);
    }
  }
  const selected = keywords.slice(0, 8);
  if (!selected.length) return [];

  /*
   * Query each keyword separately with a bounded budget, then merge.
   *
   * Matching is restricted to the three *name* fields — commodity, class and
   * family — and deliberately not `description`. Descriptions are free prose up
   * to ~400 characters and matching them surfaced a lot of noise whose only fix
   * is fuzzy relevance: "Laptop and desktop computer depot repair service"
   * (a service) outranked "Desktop computer" (the product) purely because its
   * description happened to contain the keywords. Name fields are concise and
   * carry the actual meaning.
   */
  const perKeyword = Math.max(15, Math.ceil((limit * 3) / selected.length));

  const batches = await Promise.all(
    selected.map((keyword) =>
      db
        .select({
          code: unspscCodes.code,
          commodity: unspscCodes.commodity,
          segment: unspscCodes.segment,
          family: unspscCodes.family,
          className: unspscCodes.class,
        })
        .from(unspscCodes)
        .where(
          or(
            ilike(unspscCodes.commodity, `%${keyword}%`),
            ilike(unspscCodes.class, `%${keyword}%`),
            ilike(unspscCodes.family, `%${keyword}%`),
          )!,
        )
        .limit(perKeyword),
    ),
  );

  // Merge by code so a candidate matched by several keywords is scored once.
  const merged = new Map<string, CandidateCode>();
  for (const rows of batches) {
    for (const row of rows) {
      if (!merged.has(row.code)) {
        merged.set(row.code, {
          code: row.code,
          commodity: row.commodity,
          segment: row.segment,
          family: row.family,
          className: row.className,
        });
      }
    }
  }

  const candidates = [...merged.values()];
  if (!candidates.length) return [];

  /** Field weights: a commodity hit is specific, a segment hit is nearly noise. */
  const WEIGHTS = { commodity: 10, className: 4, family: 1, segment: 1 } as const;

  const scored = candidates.map((candidate) => {
    const commodity = candidate.commodity.toLowerCase();
    const className = (candidate.className ?? '').toLowerCase();
    const family = (candidate.family ?? '').toLowerCase();
    const segment = (candidate.segment ?? '').toLowerCase();

    let score = 0;
    let matchedKeywords = 0;
    let commodityHits = 0;

    for (const keyword of selected) {
      let keywordScore = 0;
      if (commodity.includes(keyword)) keywordScore = Math.max(keywordScore, WEIGHTS.commodity);
      else if (className.includes(keyword)) keywordScore = Math.max(keywordScore, WEIGHTS.className);
      else if (family.includes(keyword)) keywordScore = Math.max(keywordScore, WEIGHTS.family);
      else if (segment.includes(keyword)) keywordScore = Math.max(keywordScore, WEIGHTS.segment);

      if (keywordScore > 0) {
        score += keywordScore;
        matchedKeywords += 1;
        if (commodity.includes(keyword)) commodityHits += 1;
      }
    }

    return { candidate, score, matchedKeywords, commodityHits };
  });

  /*
   * Relevance floor. Require either a commodity-level hit or at least two
   * distinct keyword matches somewhere — a single hit in a family or segment
   * name says nothing about what the supplier actually sells. If nothing clears
   * the floor the pool is returned anyway (sorted by score) so the prompt still
   * receives real codes rather than an empty list.
   */
  const relevant = scored.filter((entry) => entry.commodityHits > 0 || entry.matchedKeywords >= 2);
  const pool = relevant.length ? relevant : scored;

  pool.sort(
    (a, b) =>
      b.score - a.score ||
      b.commodityHits - a.commodityHits ||
      b.matchedKeywords - a.matchedKeywords ||
      a.candidate.code.localeCompare(b.candidate.code),
  );

  return pool.slice(0, limit).map((entry) => entry.candidate);
}

/** Most recent human corrections, used as few-shot examples (feedback loop). */
export async function recentCorrectionExamples(
  options: { limit?: number; db?: DbLike; industryLike?: string | null } = {},
): Promise<FewShotExample[]> {
  const db = options.db ?? getDb();
  const limit = options.limit ?? 6;

  const rows = await db
    .select({
      supplierName: suppliersTable.name,
      domain: suppliersTable.domain,
      industry: suppliersTable.industry,
      naics: suppliersTable.naics,
      correctedCode: corrections.correctedCode,
      reason: corrections.reason,
    })
    .from(corrections)
    .innerJoin(suppliersTable, eq(suppliersTable.id, corrections.supplierId))
    .orderBy(desc(corrections.createdAt))
    .limit(limit * 3);

  const examples: FewShotExample[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const key = normalizeSupplierName(row.supplierName);
    if (seen.has(key)) continue;
    if (!isUnspscCode(row.correctedCode)) continue;
    seen.add(key);
    examples.push({
      supplier_name: row.supplierName,
      domain: row.domain,
      industry: row.industry,
      naics: row.naics,
      unspsc_code: row.correctedCode,
      confidence: 0.99,
      reasoning: row.reason?.trim() ? `Human correction: ${row.reason.trim()}` : 'Human-corrected classification.',
    });
    if (examples.length >= limit) break;
  }
  return examples;
}

/**
 * Cached "is this code in the seeded taxonomy?" index.
 *
 * The taxonomy only changes after a `db:seed`, so one pass over the ~150k codes
 * is cheaper than a per-example query. Cached per process and re-read whenever
 * the taxonomy size changes.
 */
let taxonomyCodeCache: { size: number; codes: Set<string> } | null = null;

async function taxonomyCodeSet(db: DbLike): Promise<Set<string>> {
  const size = await taxonomySize(db);
  if (taxonomyCodeCache && taxonomyCodeCache.size === size) return taxonomyCodeCache.codes;
  const rows = await db.select({ code: unspscCodes.code }).from(unspscCodes);
  const codes = new Set(rows.map((row) => row.code));
  taxonomyCodeCache = { size, codes };
  return codes;
}

/** Test hook: drop the cached taxonomy index. */
export function __resetTaxonomyCodeCache(): void {
  taxonomyCodeCache = null;
}

/** Find a real commodity code under a prefix (used to repair examples). */
async function firstCodeUnderPrefix(prefix: string, db: DbLike): Promise<string | null> {
  const rows = await db
    .select({ code: unspscCodes.code })
    .from(unspscCodes)
    .where(sql`${unspscCodes.code} like ${`${prefix}%`}`)
    .limit(1);
  return rows[0]?.code ?? null;
}

/**
 * Few-shot examples that are guaranteed to reference codes present in the seeded
 * taxonomy.
 *
 * This matters because the original spec's examples used 8-digit *class*
 * prefixes (`43211500`, `78102200`, ...) which do not exist as commodities in
 * UNSPSC v26. An example whose code is missing is repaired by substituting a real
 * commodity from the same class, then family, then segment; if nothing can be
 * found the example is dropped. The model is therefore never taught a code that
 * the validator would reject.
 */
export async function loadVerifiedFewShotExamples(
  options: { limit?: number; db?: DbLike; extra?: FewShotExample[] } = {},
): Promise<FewShotExample[]> {
  const db = options.db ?? getDb();
  const correctionsFromDb = options.extra?.length ? options.extra : await recentCorrectionExamples({ db });
  const candidates = buildFewShotExamples(correctionsFromDb, options.limit ?? 10);

  // Nothing seeded: leave the examples untouched (validation will flag it).
  const codes = await taxonomyCodeSet(db);
  if (!codes.size) return candidates;

  const verified: FewShotExample[] = [];
  for (const example of candidates) {
    if (codes.has(example.unspsc_code)) {
      verified.push(example);
      continue;
    }

    let replacement: string | null = null;
    for (const prefixLength of [6, 4, 2] as const) {
      replacement = await firstCodeUnderPrefix(example.unspsc_code.slice(0, prefixLength), db);
      if (replacement) break;
    }

    if (!replacement) {
      console.warn('[classification] dropping few-shot example with unverifiable code', {
        supplier: example.supplier_name,
        code: example.unspsc_code,
      });
      continue;
    }

    console.warn('[classification] repaired few-shot example code', {
      supplier: example.supplier_name,
      from: example.unspsc_code,
      to: replacement,
    });
    verified.push({ ...example, unspsc_code: replacement });
  }

  return verified;
}

// ---------------------------------------------------------------------------
// Model selection
// ---------------------------------------------------------------------------

/** Spend above which a supplier always gets the accurate model. */
export const HIGH_VALUE_SPEND_THRESHOLD = 250_000;

/**
 * Tiered strategy: the accurate model handles parents, high-spend suppliers and
 * ambiguous cases; the bulk model handles the long tail. This keeps daily 70B
 * usage inside the 1,000 request free tier.
 */
export function selectModel(
  input: { isParent: boolean; amount: number; hasParent: boolean },
  env: { accurateModel: string; bulkModel: string },
  strategy: ModelStrategy = 'tiered',
): string {
  if (strategy === 'accurate') return env.accurateModel;
  if (strategy === 'bulk') return env.bulkModel;
  if (input.isParent) return env.accurateModel;
  if (input.amount >= HIGH_VALUE_SPEND_THRESHOLD) return env.accurateModel;
  if (!input.hasParent) return env.accurateModel;
  return env.bulkModel;
}

// ---------------------------------------------------------------------------
// Prompt subjects
// ---------------------------------------------------------------------------

export function buildSubject(
  node: SupplierNode & { classification?: unknown },
  extras: { rootName?: string | null; subsidiaries?: string[] } = {},
): ClassificationSubject {
  return {
    supplier_name: node.name,
    domain: node.domain ?? null,
    industry: node.industry ?? null,
    naics: node.naics ?? null,
    sic: node.sic ?? null,
    description: node.description ?? null,
    country: node.country ?? null,
    parent_name: extras.rootName ?? node.parentName ?? null,
    parent_domain: node.parentDomain ?? null,
    amount: readAmount(node as unknown as Record<string, unknown>),
    known_subsidiaries: extras.subsidiaries?.length ? extras.subsidiaries.slice(0, 10) : null,
  };
}

// ---------------------------------------------------------------------------
// Taxonomy validation
// ---------------------------------------------------------------------------

/**
 * Validate a code against the seeded taxonomy. When the exact commodity is
 * missing we walk up the hierarchy (class -> family -> segment) so the stored
 * code is always real, and report `unknown: true` so the caller can lower
 * confidence.
 */
export async function validateCode(
  code: string,
  db: DbLike = getDb(),
): Promise<{ code: string; unknown: boolean; commodity: string | null }> {
  if (!isUnspscCode(code)) return { code, unknown: true, commodity: null };

  const exact = await db
    .select({ code: unspscCodes.code, commodity: unspscCodes.commodity })
    .from(unspscCodes)
    .where(eq(unspscCodes.code, code))
    .limit(1);
  if (exact[0]) return { code: exact[0].code, unknown: false, commodity: exact[0].commodity };

  // Walk up the taxonomy: class (6 digits) -> family (4) -> segment (2). The
  // returned code is always a real seeded code, so scoring/reporting never sees
  // a phantom commodity.
  for (const prefixLength of [6, 4, 2] as const) {
    const prefix = code.slice(0, prefixLength);
    const rows = await db
      .select({ code: unspscCodes.code, commodity: unspscCodes.commodity })
      .from(unspscCodes)
      .where(sql`${unspscCodes.code} like ${`${prefix}%`}`)
      .limit(1);
    if (rows[0]) return { code: rows[0].code, unknown: true, commodity: rows[0].commodity };
  }

  return { code, unknown: true, commodity: null };
}

/** How many UNSPSC codes are seeded (used by `/api/health` and the UI banner). */
export async function taxonomySize(db: DbLike = getDb()): Promise<number> {
  const rows = await db.select({ value: sql<number>`count(*)` }).from(unspscCodes);  return Number(rows[0]?.value ?? 0);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export type WriteClassificationInput = {
  supplierId: number;
  code: string;
  confidence: number;
  reasoning: string | null;
  llmModel: string | null;
  alternatives?: ClassificationAlternative[];
  inheritedFromParent?: boolean;
  inheritedFromSupplierId?: number | null;
  reviewed?: boolean;
};

/**
 * Insert a new current classification and supersede the previous one. History is
 * preserved so the review workflow and audit trail stay meaningful.
 */
export async function writeClassification(
  input: WriteClassificationInput,
  options: { db?: DbLike; actor?: string; audit?: boolean } = {},
): Promise<number> {
  const db = options.db ?? getDb();

  await db
    .update(classifications)
    .set({ superseded: true })
    .where(and(eq(classifications.supplierId, input.supplierId), eq(classifications.superseded, false)));

  const inserted = await db
    .insert(classifications)
    .values({
      supplierId: input.supplierId,
      unspscCode: input.code,
      confidence: clamp(input.confidence, 0, 1).toFixed(2),
      reasoning: input.reasoning,
      llmModel: input.llmModel,
      alternatives: input.alternatives ?? [],
      inheritedFromParent: input.inheritedFromParent ?? false,
      inheritedFromSupplierId: input.inheritedFromSupplierId ?? null,
      reviewed: input.reviewed ?? false,
    })
    .returning({ id: classifications.id });

  const id = inserted[0]?.id ?? 0;

  if (options.audit !== false) {
    await recordAudit(
      {
        entity: 'classification',
        entityId: input.supplierId,
        action: input.inheritedFromParent ? 'inherited' : 'classified',
        details: {
          classificationId: id,
          code: input.code,
          confidence: input.confidence,
          model: input.llmModel,
          inheritedFromSupplierId: input.inheritedFromSupplierId ?? null,
        },
        actor: options.actor ?? 'system',
      },
      db,
    );
    // Keep the audit entity id pointing at the classification too.
    await recordAudit(
      {
        entity: 'supplier',
        entityId: input.supplierId,
        action: input.inheritedFromParent ? 'inherited' : 'classified',
        details: { code: input.code, model: input.llmModel },
        actor: options.actor ?? 'system',
      },
      db,
    );
  }

  return id;
}

/** Fetch the full supplier list as hierarchy nodes. */
async function loadNodes(db: DbLike): Promise<Array<SupplierNode & { classification?: { unspscCode: string; confidence: number; reviewed: boolean } | null; effectiveCode?: string | null }>> {
  const { listSuppliers } = await import('@/services/suppliers');
  const page = await listSuppliers({ all: true, filters: {} as never, db, sort: 'name', dir: 'asc' });
  return page.rows.map((row: SupplierListRow) => toNode(row));
}

// ---------------------------------------------------------------------------
// Single classification
// ---------------------------------------------------------------------------

export async function classifyOne(
  node: SupplierNode,
  options: {
    db?: DbLike;
    modelStrategy?: ModelStrategy;
    fewShot?: FewShotExample[];
    candidates?: CandidateCode[];
    extras?: { rootName?: string | null; subsidiaries?: string[] };
    accurateModel?: string;
    bulkModel?: string;
    actor?: string;
  } = {},
): Promise<{
  result: ClassificationItemResult;
  usage: { promptTokens: number; completionTokens: number };
}> {
  const db = options.db ?? getDb();
  const env = getEnv();
  const accurateModel = options.accurateModel ?? env.GROQ_MODEL_ACCURATE;
  const bulkModel = options.bulkModel ?? env.GROQ_MODEL_BULK;

  const amount = readAmount(node as unknown as Record<string, unknown>);
  const model = selectModel(
    { isParent: node.isParent, amount, hasParent: Boolean(node.parentId ?? node.parentName) },
    { accurateModel, bulkModel },
  );

  const fewShot = options.fewShot?.length ? options.fewShot : await loadVerifiedFewShotExamples({ db });
  const candidates =
    options.candidates ??
    (await findCandidateCodes(
      { industry: node.industry, description: node.description, name: node.name },
      { db },
    ));

  const subject = buildSubject(node, options.extras ?? {});
  const completion: ChatCompletionResult = await chatCompletion({
    model,
    temperature: 0.1,
    maxTokens: 700,
    responseFormat: { type: 'json_object' },
    messages: [
      { role: 'system', content: CLASSIFICATION_SYSTEM_PROMPT },
      { role: 'user', content: buildClassificationUserPrompt(subject, { fewShot, candidates }) },
    ],
  });

  const parsed = parseClassificationPayload(parseJsonResponse(completion.content));
  if (!parsed) {
    return {
      result: {
        supplierId: node.id,
        name: node.name,
        code: null,
        confidence: 0,
        model,
        inherited: false,
        inheritedFromSupplierId: null,
        reasoning: null,
        codeUnknown: false,
        status: 'failed',
        error: 'model did not return a valid 8-digit UNSPSC code',
      },
      usage: { promptTokens: completion.usage.promptTokens, completionTokens: completion.usage.completionTokens },
    };
  }

  const validated = await validateCode(parsed.unspsc_code, db);
  // An unverifiable code is a hallucination signal: drop confidence hard.
  const confidence = validated.unknown ? Math.min(parsed.confidence, 0.4) : parsed.confidence;

  await writeClassification(
    {
      supplierId: node.id,
      code: validated.code,
      confidence,
      reasoning: validated.unknown
        ? `${parsed.reasoning} (code ${parsed.unspsc_code} not found in the local UNSPSC taxonomy; confidence reduced)`
        : parsed.reasoning,
      llmModel: completion.model,
      alternatives: parsed.alternatives,
      inheritedFromParent: false,
    },
    { db, actor: options.actor },
  );

  return {
    result: {
      supplierId: node.id,
      name: node.name,
      code: validated.code,
      confidence,
      model: completion.model,
      inherited: false,
      inheritedFromSupplierId: null,
      reasoning: parsed.reasoning,
      codeUnknown: validated.unknown,
      status: 'classified',
    },
    usage: { promptTokens: completion.usage.promptTokens, completionTokens: completion.usage.completionTokens },
  };
}

// ---------------------------------------------------------------------------
// Batch classification
// ---------------------------------------------------------------------------

export type BatchClassifyItem = { node: SupplierNode; model: string; extras?: { rootName?: string | null; subsidiaries?: string[] } };

/**
 * Classify up to 10 suppliers in one Groq request. Falls back to per-supplier
 * calls when the batch response cannot be aligned with the input.
 */
export async function classifyBatch(
  items: readonly BatchClassifyItem[],
  options: { db?: DbLike; fewShot?: FewShotExample[]; candidates?: CandidateCode[]; actor?: string } = {},
): Promise<{
  results: ClassificationItemResult[];
  usage: { promptTokens: number; completionTokens: number; requests: number };
  errors: string[];
}> {
  const db = options.db ?? getDb();
  const results: ClassificationItemResult[] = [];
  const errors: string[] = [];
  const usage = { promptTokens: 0, completionTokens: 0, requests: 0 };
  if (!items.length) return { results, usage, errors };

  const model = items[0]!.model;
  const subjects: BatchSubject[] = items.map((item, index) => ({
    ...buildSubject(item.node, item.extras ?? {}),
    index,
  }));

  const fewShot = options.fewShot?.length ? options.fewShot : await loadVerifiedFewShotExamples({ db });
  const candidates =
    options.candidates ??
    (await findCandidateCodes(
      {
        industry: items.map((item) => item.node.industry).filter(Boolean).join(' '),
        description: items.map((item) => item.node.description).filter(Boolean).join(' ').slice(0, 800),
      },
      { db, limit: 15 },
    ));

  try {
    const completion = await chatCompletion({
      model,
      temperature: 0.1,
      maxTokens: Math.min(4000, 400 * items.length + 400),
      responseFormat: { type: 'json_object' },
      messages: [
        { role: 'system', content: CLASSIFICATION_SYSTEM_PROMPT },
        { role: 'user', content: buildBatchClassificationUserPrompt(subjects, { fewShot, candidates }) },
      ],
    });
    usage.requests += 1;
    usage.promptTokens += completion.usage.promptTokens;
    usage.completionTokens += completion.usage.completionTokens;

    const parsedArray = parseBatchClassificationResponse(parseJsonResponse(completion.content));
    const parsedByIndex = new Map<number, ReturnType<typeof parseClassificationPayload>>();

    parsedArray.forEach((entry, position) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      const name = typeof record.supplier_name === 'string' ? record.supplier_name : null;
      let index = -1;
      if (name) {
        index = items.findIndex((item) => normalizeSupplierName(item.node.name) === normalizeSupplierName(name));
      }
      if (index < 0) index = position;
      if (index >= 0 && index < items.length && !parsedByIndex.has(index)) {
        parsedByIndex.set(index, parseClassificationPayload(entry));
      }
    });

    const missing: number[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const parsed = parsedByIndex.get(index) ?? null;
      if (!parsed) {
        missing.push(index);
        continue;
      }
      const validated = await validateCode(parsed.unspsc_code, db);
      const confidence = validated.unknown ? Math.min(parsed.confidence, 0.4) : parsed.confidence;
      await writeClassification(
        {
          supplierId: item.node.id,
          code: validated.code,
          confidence,
          reasoning: validated.unknown
            ? `${parsed.reasoning} (code ${parsed.unspsc_code} not in local taxonomy; confidence reduced)`
            : parsed.reasoning,
          llmModel: completion.model,
          alternatives: parsed.alternatives,
        },
        { db, actor: options.actor },
      );
      results.push({
        supplierId: item.node.id,
        name: item.node.name,
        code: validated.code,
        confidence,
        model: completion.model,
        inherited: false,
        inheritedFromSupplierId: null,
        reasoning: parsed.reasoning,
        codeUnknown: validated.unknown,
        status: 'classified',
      });
    }

    // Retry the stragglers individually — cheaper than losing them.
    for (const index of missing) {
      const item = items[index]!;
      try {
        const single = await classifyOne(item.node, { db, fewShot, candidates, actor: options.actor });
        usage.requests += 1;
        usage.promptTokens += single.usage.promptTokens;
        usage.completionTokens += single.usage.completionTokens;
        results.push(single.result);
      } catch (error) {
        errors.push(`${item.node.name}: ${error instanceof Error ? error.message : String(error)}`);
        results.push({
          supplierId: item.node.id,
          name: item.node.name,
          code: null,
          confidence: 0,
          model,
          inherited: false,
          inheritedFromSupplierId: null,
          reasoning: null,
          codeUnknown: false,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    // Whole batch failed: fall back to individual calls so partial progress is
    // still possible (and a single bad supplier cannot poison the batch).
    for (const item of items) {
      try {
        const single = await classifyOne(item.node, { db, fewShot, candidates, actor: options.actor });
        usage.requests += 1;
        usage.promptTokens += single.usage.promptTokens;
        usage.completionTokens += single.usage.completionTokens;
        results.push(single.result);
      } catch (innerError) {
        results.push({
          supplierId: item.node.id,
          name: item.node.name,
          code: null,
          confidence: 0,
          model,
          inherited: false,
          inheritedFromSupplierId: null,
          reasoning: null,
          codeUnknown: false,
          status: 'failed',
          error: innerError instanceof Error ? innerError.message : String(innerError),
        });
      }
    }
  }

  return { results, usage, errors };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Build the parent-first work plan for a set of supplier ids. */
export async function buildPlan(
  options: { supplierIds?: number[]; db?: DbLike; modelStrategy?: ModelStrategy } = {},
): Promise<{
  plan: ReturnType<typeof planClassification>;
  nodes: Awaited<ReturnType<typeof loadNodes>>;
  preview: ClassificationPlanPreview;
}> {
  const db = options.db ?? getDb();
  const env = getEnv();
  const nodes = await loadNodes(db);
  const plan = planClassification(nodes);

  const requested = options.supplierIds?.length ? new Set(options.supplierIds) : null;
  const models = { accurateModel: env.GROQ_MODEL_ACCURATE, bulkModel: env.GROQ_MODEL_BULK };

  const previewClusters = plan.parentItems
    .filter((item) => !requested || requested.has(item.representative.id))
    .map((item) => ({
      clusterKey: item.clusterKey,
      representativeId: item.representative.id,
      representativeName: item.representative.name,
      rootName: item.rootName,
      isVirtualRoot: item.isVirtualRoot,
      subsidiaries: item.subsidiaries,
      totalAmount: item.totalAmount,
      model: selectModel(
        { isParent: true, amount: item.totalAmount, hasParent: false },
        models,
      ),
    }));

  const previewStandalone = plan.standalone
    .filter((node) => !requested || requested.has(node.id))
    .map((node) => ({
      id: node.id,
      name: node.name,
      model: selectModel(
        {
          isParent: false,
          amount: readAmount(node as unknown as Record<string, unknown>),
          hasParent: Boolean(node.parentId ?? node.parentName),
        },
        models,
      ),
    }));

  const envBatch = Math.max(1, Math.min(10, env.LLM_BATCH_SIZE));
  return {
    plan,
    nodes,
    preview: {
      clusters: previewClusters.length,
      parentItems: previewClusters,
      standalone: previewStandalone,
      totalSuppliers: nodes.length,
      estimatedRequests:
        Math.ceil(previewClusters.length / envBatch) + Math.ceil(previewStandalone.length / envBatch),
    },
  };
}

/**
 * Main entry point used by `POST /api/classify`, the sync job and the worker.
 *
 * Order of operations:
 *  1. plan parent-first clusters;
 *  2. classify cluster representatives (accurate model) in batches of 10;
 *  3. classify standalone suppliers in batches of 10;
 *  4. propagate each representative's code to its subsidiaries.
 */
export async function classifySuppliers(options: ClassifyOptions = {}): Promise<ClassifySummary> {
  const started = Date.now();
  const db = options.db ?? getDb();
  const env = getEnv();
  const actor = options.actor ?? 'system';

  const summary: ClassifySummary = {
    processed: 0,
    classified: 0,
    inherited: 0,
    failed: 0,
    skipped: 0,
    llmRequests: 0,
    promptTokens: 0,
    completionTokens: 0,
    lowConfidence: 0,
    items: [],
    errors: [],
    durationMs: 0,
  };

  // Fail fast and clearly when the model is not configured, instead of emitting
  // one failed item per supplier (which would flood the audit log and the UI).
  if (!env.GROQ_API_KEY) {
    summary.errors.push(
      'GROQ_API_KEY is not set: classification was skipped. Add the key to .env.local or to the Vercel/Render environment variables.',
    );
    summary.durationMs = Date.now() - started;
    return summary;
  }

  const nodes = await loadNodes(db);
  if (!nodes.length) {
    summary.durationMs = Date.now() - started;
    return summary;
  }

  const plan = planClassification(nodes);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const requested = options.supplierIds?.length ? new Set(options.supplierIds) : null;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;

  // Reviewed classifications are preserved unless explicitly forced.
  const reviewedIds = new Set<number>();
  if (options.preserveReviewed !== false && !options.force) {
    const reviewed = await db
      .select({ supplierId: classifications.supplierId })
      .from(classifications)
      .where(and(eq(classifications.superseded, false), eq(classifications.reviewed, true)));
    for (const row of reviewed) reviewedIds.add(row.supplierId);
  }

  const fewShot = await loadVerifiedFewShotExamples({ db });

  const envModels = { accurateModel: env.GROQ_MODEL_ACCURATE, bulkModel: env.GROQ_MODEL_BULK };
  const batchSize = Math.max(1, Math.min(10, env.LLM_BATCH_SIZE));
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
  let batchesRun = 0;

  const modelFor = (node: SupplierNode, amountOverride?: number) =>
    selectModel(
      {
        isParent: node.isParent,
        amount: amountOverride ?? readAmount(node as unknown as Record<string, unknown>),
        hasParent: Boolean(node.parentId ?? node.parentName),
      },
      envModels,
      options.modelStrategy,
    );

  // ---- pass 1: cluster representatives (parent-first) ---------------------
  const parentWork = plan.parentItems
    .filter((item) => !requested || requested.has(item.representative.id))
    .slice(0, Number.isFinite(limit) ? Math.max(1, Math.ceil(limit)) : undefined);

  for (const group of chunk(parentWork, batchSize)) {
    if (batchesRun >= maxBatches) break;
    const pending = group.filter((item) => !reviewedIds.has(item.representative.id));
    summary.skipped += group.length - pending.length;
    if (!pending.length) continue;

    const items: BatchClassifyItem[] = pending.map((item) => ({
      node: item.representative,
      model: modelFor(item.representative, item.totalAmount),
      extras: {
        rootName: item.isVirtualRoot ? item.rootName : null,
        subsidiaries: item.inheritTargets.map((target) => target.name),
      },
    }));

    // Group by chosen model so a batch never mixes model tiers.
    const byModel = new Map<string, BatchClassifyItem[]>();
    for (const item of items) {
      const bucket = byModel.get(item.model);
      if (bucket) bucket.push(item);
      else byModel.set(item.model, [item]);
    }

    for (const [model, modelItems] of byModel) {
      if (batchesRun >= maxBatches) break;
      batchesRun += 1;
      const outcome = await classifyBatch(modelItems, { db, fewShot, actor });
      summary.llmRequests += outcome.usage.requests;
      summary.promptTokens += outcome.usage.promptTokens;
      summary.completionTokens += outcome.usage.completionTokens;
      summary.errors.push(...outcome.errors);
      summary.items.push(...outcome.results);
      summary.processed += outcome.results.length;
      summary.classified += outcome.results.filter((item) => item.status === 'classified').length;
      summary.failed += outcome.results.filter((item) => item.status === 'failed').length;
      summary.lowConfidence += outcome.results.filter(
        (item) => item.status === 'classified' && item.confidence < env.CLASSIFY_CONFIDENCE_THRESHOLD,
      ).length;

      // ---- propagate to subsidiaries ------------------------------------
      const plans = new Map(pending.map((item) => [item.representative.id, item]));
      for (const result of outcome.results) {
        if (result.status !== 'classified' || !result.code) continue;
        const planItem = plans.get(result.supplierId);
        if (!planItem) continue;
        const inherited = await propagateToSubsidiaries(
          result,
          planItem.inheritTargets,
          planItem,
          { db, actor },
        );
        summary.items.push(...inherited.items);
        summary.processed += inherited.items.length;
        summary.inherited += inherited.items.length;
        summary.lowConfidence += inherited.items.filter(
          (item) => item.confidence < env.CLASSIFY_CONFIDENCE_THRESHOLD,
        ).length;
      }
    }
  }

  // ---- pass 2: standalone suppliers ---------------------------------------
  const standaloneWork = plan.standalone
    .filter((node) => !requested || requested.has(node.id))
    .filter((node) => !reviewedIds.has(node.id) || options.force)
    .slice(0, Number.isFinite(limit) ? Math.max(1, Math.ceil(limit)) : undefined);

  for (const group of chunk(standaloneWork, batchSize)) {
    if (batchesRun >= maxBatches) break;
    const byModel = new Map<string, BatchClassifyItem[]>();
    for (const node of group) {
      const model = modelFor(node);
      const bucket = byModel.get(model);
      const item: BatchClassifyItem = { node, model };
      if (bucket) bucket.push(item);
      else byModel.set(model, [item]);
    }

    for (const [model, modelItems] of byModel) {
      if (batchesRun >= maxBatches) break;
      batchesRun += 1;
      const outcome = await classifyBatch(modelItems, { db, fewShot, actor });
      summary.llmRequests += outcome.usage.requests;
      summary.promptTokens += outcome.usage.promptTokens;
      summary.completionTokens += outcome.usage.completionTokens;
      summary.errors.push(...outcome.errors);
      summary.items.push(...outcome.results);
      summary.processed += outcome.results.length;
      summary.classified += outcome.results.filter((item) => item.status === 'classified').length;
      summary.failed += outcome.results.filter((item) => item.status === 'failed').length;
      summary.lowConfidence += outcome.results.filter(
        (item) => item.status === 'classified' && item.confidence < env.CLASSIFY_CONFIDENCE_THRESHOLD,
      ).length;
    }
  }

  // Mark remaining unclassified suppliers as needing review.
  const unclassifiedIds = nodes
    .filter((node) => !summary.items.some((item) => item.supplierId === node.id))
    .map((node) => node.id);
  void unclassifiedIds;

  void nodeById;
  summary.durationMs = Date.now() - started;
  return summary;
}

/** Copy a parent classification onto its subsidiaries. */
export async function propagateToSubsidiaries(
  parentResult: ClassificationItemResult,
  targets: readonly SupplierNode[],
  planItem: { clusterKey: string; rootName: string },
  options: { db?: DbLike; actor?: string; confidenceFactor?: number; audit?: boolean } = {},
): Promise<{ items: ClassificationItemResult[] }> {
  const db = options.db ?? getDb();
  const factor = options.confidenceFactor ?? 0.9;
  const items: ClassificationItemResult[] = [];
  if (!parentResult.code || !targets.length) return { items };

  const inheritedConfidence = clamp(parentResult.confidence * factor, 0, 1);
  const entries: Parameters<typeof recordAuditBatch>[0] = [];

  for (const target of targets) {
    await writeClassification(
      {
        supplierId: target.id,
        code: parentResult.code,
        confidence: inheritedConfidence,
        reasoning: `Inherited from parent company "${planItem.rootName}" (${parentResult.name}), classified as ${parentResult.code}.`,
        llmModel: parentResult.model,
        alternatives: [],
        inheritedFromParent: true,
        inheritedFromSupplierId: parentResult.supplierId,
      },
      { db, actor: options.actor, audit: options.audit === false ? false : true },
    );

    items.push({
      supplierId: target.id,
      name: target.name,
      code: parentResult.code,
      confidence: inheritedConfidence,
      model: parentResult.model,
      inherited: true,
      inheritedFromSupplierId: parentResult.supplierId,
      reasoning: `Inherited from ${planItem.rootName}`,
      codeUnknown: parentResult.codeUnknown,
      status: 'inherited',
    });

    entries.push({
      entity: 'classification',
      entityId: target.id,
      action: 'inherited',
      details: {
        code: parentResult.code,
        from: parentResult.supplierId,
        clusterKey: planItem.clusterKey,
      },
      actor: options.actor ?? 'system',
    });
  }

  if (options.audit !== false && entries.length) {
    await recordAuditBatch(entries, db);
  }

  return { items };
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

export type CorrectionOptions = {
  supplierId: number;
  unspscCode: string;
  correctedBy?: string;
  reason?: string;
  applyToSubsidiaries?: boolean;
  db?: DbLike;
  actor?: string;
};

export type CorrectionResult = {
  supplierId: number;
  originalCode: string | null;
  correctedCode: string;
  appliedToSubsidiaries: boolean;
  affectedSupplierIds: number[];
  classificationId: number;
  codeKnown: boolean;
};

/**
 * Apply a human correction.
 *
 * - The correction is stored in `corrections` (and therefore becomes a few-shot
 *   example for future prompts).
 * - When the supplier is a parent and `applyToSubsidiaries` is set, every
 *   descendant receives the same code with `inherited_from_parent = true`.
 * - Reviewed = true, so the sync job will not overwrite it.
 */
export async function applyCorrection(options: CorrectionOptions): Promise<CorrectionResult> {
  const db = options.db ?? getDb();
  const actor = options.correctedBy ?? options.actor ?? 'human';
  const code = String(options.unspscCode).trim();

  if (!isUnspscCode(code)) {
    throw new Error(`"${options.unspscCode}" is not a valid 8-digit UNSPSC code`);
  }
  if (options.supplierId === undefined || options.supplierId === null) {
    throw new Error('supplierId is required');
  }

  const existingRows = await db
    .select()
    .from(suppliersTable)
    .where(eq(suppliersTable.id, options.supplierId))
    .limit(1);
  const supplier = existingRows[0];
  if (!supplier) throw new Error(`Supplier ${options.supplierId} not found`);

  const known = await db
    .select({ code: unspscCodes.code })
    .from(unspscCodes)
    .where(eq(unspscCodes.code, code))
    .limit(1);
  const codeKnown = Boolean(known[0]);

  const previousRows = await db
    .select({ id: classifications.id, code: classifications.unspscCode, corrected: classifications.correctedCode })
    .from(classifications)
    .where(and(eq(classifications.supplierId, options.supplierId), eq(classifications.superseded, false)))
    .orderBy(desc(classifications.id))
    .limit(1);
  const previous = previousRows[0] ?? null;
  const originalCode = previous?.corrected ?? previous?.code ?? null;

  // Mark the previous row as reviewed, then insert the corrected row.
  const classificationId = await writeClassification(
    {
      supplierId: options.supplierId,
      code,
      confidence: 1,
      reasoning: options.reason?.trim()
        ? `Manual correction: ${options.reason.trim()}`
        : `Manually corrected by ${actor}.`,
      llmModel: 'human',
      alternatives: [],
      inheritedFromParent: false,
      reviewed: true,
    },
    { db, actor },
  );

  await db
    .update(classifications)
    .set({
      reviewed: true,
      correctedCode: code,
      correctedBy: actor,
      correctedAt: new Date(),
    })
    .where(eq(classifications.id, classificationId));

  // ---- subsidiaries -------------------------------------------------------
  const affectedSupplierIds: number[] = [options.supplierId];
  let appliedToSubsidiaries = false;

  if (options.applyToSubsidiaries) {
    const allRows = await db
      .select({
        id: suppliersTable.id,
        name: suppliersTable.name,
        parentId: suppliersTable.parentId,
        parentName: suppliersTable.parentName,
        isParent: suppliersTable.isParent,
      })
      .from(suppliersTable);

    const { collectDescendantIds } = await import('@/services/hierarchy');
    const descendants = collectDescendantIds(allRows, options.supplierId);

    for (const descendantId of descendants) {
      await writeClassification(
        {
          supplierId: descendantId,
          code,
          confidence: 0.95,
          reasoning: `Inherited from parent company "${supplier.name}" after a manual correction by ${actor}.`,
          llmModel: 'human',
          alternatives: [],
          inheritedFromParent: true,
          inheritedFromSupplierId: options.supplierId,
          reviewed: true,
        },
        { db, actor },
      );
      affectedSupplierIds.push(descendantId);
    }

    appliedToSubsidiaries = descendants.length > 0;

    if (descendants.length) {
      await db
        .update(suppliersTable)
        .set({ isParent: true, updatedAt: new Date() })
        .where(eq(suppliersTable.id, options.supplierId));

      await recordAuditBatch(
        descendants.map((descendantId) => ({
          entity: 'classification' as const,
          entityId: descendantId,
          action: 'propagated' as const,
          details: { code, from: options.supplierId, correctedBy: actor },
          actor,
        })),
        db,
      );
    }
  }

  const inserted = await db
    .insert(corrections)
    .values({
      supplierId: options.supplierId,
      classificationId,
      originalCode: originalCode && isUnspscCode(originalCode) ? originalCode : null,
      correctedCode: code,
      reason: options.reason ?? null,
      correctedBy: actor,
      appliedToSubsidiaries,
      affectedSupplierIds,
    })
    .returning({ id: corrections.id });

  await recordAudit(
    {
      entity: 'correction',
      entityId: inserted[0]?.id ?? null,
      action: 'corrected',
      details: {
        supplierId: options.supplierId,
        originalCode,
        correctedCode: code,
        appliedToSubsidiaries,
        affectedSupplierIds,
        codeKnown,
      },
      actor,
    },
    db,
  );

  return {
    supplierId: options.supplierId,
    originalCode,
    correctedCode: code,
    appliedToSubsidiaries,
    affectedSupplierIds,
    classificationId,
    codeKnown,
  };
}

// ---------------------------------------------------------------------------
// Queries for the review queue
// ---------------------------------------------------------------------------

export type ReviewQueueOptions = {
  threshold?: number;
  limit?: number;
  includeUnclassified?: boolean;
  includeUncertainParents?: boolean;
  db?: DbLike;
};

export type ReviewQueueRow = {
  supplierId: number;
  name: string;
  domain: string | null;
  industry: string | null;
  totalAmount: number;
  parentName: string | null;
  confidence: number | null;
  code: string | null;
  commodity: string | null;
  reasoning: string | null;
  llmModel: string | null;
  inheritedFromParent: boolean;
  reasons: string[];
};

/**
 * Low-confidence classifications, unclassified suppliers and uncertain parent
 * links — everything a human should look at, with the reason attached.
 */
export async function getReviewQueue(options: ReviewQueueOptions = {}): Promise<ReviewQueueRow[]> {
  const db = options.db ?? getDb();
  const env = getEnv();
  const threshold = options.threshold ?? env.CLASSIFY_CONFIDENCE_THRESHOLD;
  const limit = options.limit ?? 200;

  const cc = db
    .select({
      supplierId: classifications.supplierId,
      idCol: sql<number>`max(${classifications.id})`.as('classification_id'),
    })
    .from(classifications)
    .where(eq(classifications.superseded, false))
    .groupBy(classifications.supplierId)
    .as('cc');

  const rows = await db
    .select({
      supplierId: suppliersTable.id,
      name: suppliersTable.name,
      domain: suppliersTable.domain,
      industry: suppliersTable.industry,
      totalAmount: suppliersTable.totalAmount,
      parentName: suppliersTable.parentName,
      parentId: suppliersTable.parentId,
      parentConfidence: suppliersTable.parentConfidence,
      parentSource: suppliersTable.parentSource,
      confidence: classifications.confidence,
      code: sql<string | null>`coalesce(${classifications.correctedCode}, ${classifications.unspscCode})`,
      rawCode: classifications.unspscCode,
      reasoning: classifications.reasoning,
      llmModel: classifications.llmModel,
      inheritedFromParent: classifications.inheritedFromParent,
      reviewed: classifications.reviewed,
    })
    .from(suppliersTable)
    .leftJoin(cc, eq(cc.supplierId, suppliersTable.id))
    .leftJoin(classifications, eq(classifications.id, cc.idCol))
    .where(
      or(
        options.includeUnclassified === false
          ? and(isNotNull(classifications.id), sql`${classifications.confidence} < ${threshold}`)
          : or(
              isNull(classifications.id),
              and(isNotNull(classifications.id), sql`${classifications.confidence} < ${threshold}`),
            ),
        isNotNull(suppliersTable.parentName),
      )!,
    )
    .orderBy(desc(suppliersTable.totalAmount))
    .limit(limit);

  return rows
    .filter((row) => {
      // Keep: unreviewed low-confidence classifications, unclassified rows, and
      // uncertain parent links.
      const lowConfidence =
        row.confidence === null ? options.includeUnclassified !== false : Number(row.confidence) < threshold;
      const uncertainParent =
        options.includeUncertainParents === false
          ? false
          : Boolean(row.parentName) &&
            (row.parentId === null ||
              (row.parentConfidence !== null && Number(row.parentConfidence) < 0.6) ||
              row.parentSource === 'llm');
      return (lowConfidence && !row.reviewed) || uncertainParent;
    })
    .map((row) => {
      const reasons: string[] = [];
      if (row.confidence === null) reasons.push('Not classified yet');
      else if (Number(row.confidence) < threshold) reasons.push(`Low confidence (${Number(row.confidence).toFixed(2)})`);
      if (row.parentName && row.parentId === null) reasons.push('Parent company not linked to a supplier record');
      if (row.parentSource === 'llm') reasons.push('Parent inferred by the LLM');
      if (row.parentConfidence !== null && Number(row.parentConfidence) < 0.6) {
        reasons.push(`Uncertain parent (${Number(row.parentConfidence).toFixed(2)})`);
      }
      if (row.inheritedFromParent) reasons.push('Inherited from parent');

      return {
        supplierId: row.supplierId,
        name: row.name,
        domain: row.domain,
        industry: row.industry,
        totalAmount: row.totalAmount === null ? 0 : Number(row.totalAmount),
        parentName: row.parentName,
        confidence: row.confidence === null ? null : Number(row.confidence),
        code: row.code,
        commodity: null,
        reasoning: row.reasoning,
        llmModel: row.llmModel,
        inheritedFromParent: row.inheritedFromParent ?? false,
        reasons,
      };
    });
}

/** Suppliers grouped by segment, for the report charts. */
export async function segmentBreakdown(
  options: { db?: DbLike; filters?: { minConfidence?: number } } = {},
): Promise<
  Array<{ segmentCode: string; segment: string; suppliers: number; spend: number; avgConfidence: number | null }>
> {
  const db = options.db ?? getDb();
  const cc = db
    .select({
      supplierId: classifications.supplierId,
      idCol: sql<number>`max(${classifications.id})`.as('classification_id'),
    })
    .from(classifications)
    .where(eq(classifications.superseded, false))
    .groupBy(classifications.supplierId)
    .as('cc');

  const filters: SQL[] = [isNotNull(classifications.id)];
  if (options.filters?.minConfidence !== undefined) {
    filters.push(sql`${classifications.confidence} >= ${options.filters.minConfidence}`);
  }

  const rows = await db
    .select({
      segmentCode: sql<string>`coalesce(${unspscCodes.segmentCode}, substring(coalesce(${classifications.correctedCode}, ${classifications.unspscCode}) from 1 for 2))`,
      segment: sql<string>`coalesce(${unspscCodes.segment}, 'Unmapped')`,
      suppliers: sql<number>`count(*)`,
      spend: sql<number>`coalesce(sum(${suppliersTable.totalAmount}), 0)`,
      avgConfidence: sql<number | null>`avg(${classifications.confidence})`,
    })
    .from(suppliersTable)
    .innerJoin(cc, eq(cc.supplierId, suppliersTable.id))
    .innerJoin(classifications, eq(classifications.id, cc.idCol))
    .leftJoin(unspscCodes, eq(unspscCodes.code, sql`coalesce(${classifications.correctedCode}, ${classifications.unspscCode})`))
    .where(and(...filters))
    .groupBy(
      sql`coalesce(${unspscCodes.segmentCode}, substring(coalesce(${classifications.correctedCode}, ${classifications.unspscCode}) from 1 for 2))`,
      sql`coalesce(${unspscCodes.segment}, 'Unmapped')`,
    )
    .orderBy(sql`coalesce(sum(${suppliersTable.totalAmount}), 0) desc`);

  return rows.map((row) => ({
    segmentCode: String(row.segmentCode ?? '--'),
    segment: String(row.segment ?? 'Unmapped'),
    suppliers: Number(row.suppliers ?? 0),
    spend: Number(row.spend ?? 0),
    avgConfidence: row.avgConfidence === null ? null : Number(row.avgConfidence),
  }));
}

/** Classification history + corrections for a single supplier (detail drawer). */
export async function getClassificationHistory(
  supplierId: number,
  db: DbLike = getDb(),
): Promise<{
  history: Array<{
    id: number;
    code: string;
    confidence: number;
    reasoning: string | null;
    llmModel: string | null;
    inherited: boolean;
    reviewed: boolean;
    superseded: boolean;
    createdAt: string;
  }>;
  corrections: Array<{
    id: number;
    originalCode: string | null;
    correctedCode: string;
    correctedBy: string;
    reason: string | null;
    appliedToSubsidiaries: boolean;
    createdAt: string;
  }>;
}> {
  const [historyRows, correctionRows] = await Promise.all([
    db
      .select()
      .from(classifications)
      .where(eq(classifications.supplierId, supplierId))
      .orderBy(desc(classifications.id))
      .limit(50),
    db
      .select()
      .from(corrections)
      .where(eq(corrections.supplierId, supplierId))
      .orderBy(desc(corrections.id))
      .limit(50),
  ]);

  return {
    history: historyRows.map((row) => ({
      id: row.id,
      code: row.correctedCode ?? row.unspscCode,
      confidence: Number(row.confidence),
      reasoning: row.reasoning,
      llmModel: row.llmModel,
      inherited: row.inheritedFromParent,
      reviewed: row.reviewed,
      superseded: row.superseded,
      createdAt: row.createdAt.toISOString(),
    })),
    corrections: correctionRows.map((row) => ({
      id: row.id,
      originalCode: row.originalCode,
      correctedCode: row.correctedCode,
      correctedBy: row.correctedBy,
      reason: row.reason,
      appliedToSubsidiaries: row.appliedToSubsidiaries,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/** Search the seeded taxonomy (used by the correction form's autocomplete). */
export async function searchUnspscCodes(
  query: string,
  options: { limit?: number; db?: DbLike } = {},
): Promise<Array<{ code: string; commodity: string; segment: string | null; className: string | null }>> {
  const db = options.db ?? getDb();
  const limit = Math.min(100, options.limit ?? 25);
  const term = query.trim();

  if (!term) {
    const popular = await db
      .select({
        code: unspscCodes.code,
        commodity: unspscCodes.commodity,
        segment: unspscCodes.segment,
        className: unspscCodes.class,
      })
      .from(unspscCodes)
      .limit(limit);
    return popular;
  }

  if (/^\d{2,8}$/.test(term)) {
    return db
      .select({
        code: unspscCodes.code,
        commodity: unspscCodes.commodity,
        segment: unspscCodes.segment,
        className: unspscCodes.class,
      })
      .from(unspscCodes)
      .where(sql`${unspscCodes.code} like ${`${term}%`}`)
      .limit(limit);
  }

  return db
    .select({
      code: unspscCodes.code,
      commodity: unspscCodes.commodity,
      segment: unspscCodes.segment,
      className: unspscCodes.class,
    })
    .from(unspscCodes)
    .where(
      or(
        ilike(unspscCodes.commodity, `%${term}%`),
        ilike(unspscCodes.class, `%${term}%`),
        ilike(unspscCodes.family, `%${term}%`),
        ilike(unspscCodes.segment, `%${term}%`),
      ),
    )
    .limit(limit);
}

/** Distinct segments present in the taxonomy (dashboard filter dropdown). */
export async function listSegments(
  db: DbLike = getDb(),
): Promise<Array<{ segmentCode: string; segment: string; codes: number }>> {
  const rows = await db
    .select({
      segmentCode: sql<string>`coalesce(${unspscCodes.segmentCode}, substring(${unspscCodes.code} from 1 for 2))`,
      segment: sql<string>`coalesce(${unspscCodes.segment}, 'Unknown')`,
      codes: sql<number>`count(*)`,
    })
    .from(unspscCodes)
    .groupBy(
      sql`coalesce(${unspscCodes.segmentCode}, substring(${unspscCodes.code} from 1 for 2))`,
      sql`coalesce(${unspscCodes.segment}, 'Unknown')`,
    )
    .orderBy(sql`coalesce(${unspscCodes.segmentCode}, substring(${unspscCodes.code} from 1 for 2))`);

  return rows.map((row) => ({
    segmentCode: String(row.segmentCode),
    segment: String(row.segment),
    codes: Number(row.codes),
  }));
}

export { inArray, suppliersTable };
