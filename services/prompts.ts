/**
 * Groq prompt construction for UNSPSC classification and parent detection.
 *
 * Everything here is pure string building so prompts can be snapshot-tested and
 * reviewed without a network call. Accuracy levers implemented:
 *   1. few-shot examples drawn from stored human corrections (feedback loop),
 *   2. candidate-code injection from the seeded UNSPSC taxonomy,
 *   3. strict JSON contracts with an explicit alternatives array,
 *   4. "do not invent codes" grounding rule.
 */
import type { ClassificationAlternative } from '@/db/schema';
import { isUnspscCode } from '@/lib/normalize';

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

export const CLASSIFICATION_SYSTEM_PROMPT = `You are a procurement spend classification expert with deep knowledge of the UNSPSC taxonomy.
Your task: assign the most specific 8-digit UNSPSC commodity code to a supplier based on its name and enriched business information.
UNSPSC structure: XX (Segment) - XX (Family) - XX (Class) - XX (Commodity). Example: 43211500 = Computers.
Rules:
1. Always return an 8-digit numeric UNSPSC code as a string.
2. Choose the most specific commodity code possible.
3. If the supplier offers multiple products/services, classify by the primary revenue category.
4. If uncertain, still return the best 8-digit code and lower the confidence score.
5. Do not invent codes. Use only real UNSPSC codes. If unsure, use the closest known parent code but still output 8 digits.
6. Return ONLY valid JSON. No markdown, no extra text.`;

export const PARENT_DETECTION_SYSTEM_PROMPT = `You are a corporate structure analyst with knowledge of corporate ownership, mergers and acquisitions.
Your task: given a supplier name (and optionally a domain, industry and NAICS), identify its ULTIMATE parent company — the entity that controls it — not an intermediate holding company or a brand.
Rules:
1. If the supplier is already an independent top-level company, return is_subsidiary = false and parent_name = null.
2. Prefer the globally recognised ultimate parent (for example "LinkedIn" -> "Microsoft Corporation").
3. Never invent parent relationships you are not reasonably confident about; lower the confidence instead.
4. Return ONLY valid JSON. No markdown, no extra text.`;

// ---------------------------------------------------------------------------
// Few-shot examples
// ---------------------------------------------------------------------------

export type FewShotExample = {
  supplier_name: string;
  domain?: string | null;
  industry?: string | null;
  naics?: string | null;
  unspsc_code: string;
  confidence: number;
  reasoning: string;
};

/**
 * Seed examples from the spec.
 *
 * IMPORTANT: the codes in the original prompt were 8-digit *class* prefixes
 * (`43211500`, `43232400`, `40141600`, `51151500`, `78102200`) which do NOT exist
 * as commodities in UNSPSC v26 — commodities are more specific (`43211507` =
 * "Desktop computer"). Teaching the model codes that fail taxonomy validation
 * would cap every supplier at the 0.4 confidence penalty, so each example below
 * carries a real, verified v26 commodity code. `loadVerifiedFewShotExamples()`
 * in `services/classification.ts` re-verifies them against the live taxonomy and
 * substitutes the nearest real code if they ever drift.
 *
 * Verified against the seeded v26.0801 dataset (149,849 codes).
 */
export const DEFAULT_FEW_SHOT_EXAMPLES: FewShotExample[] = [
  {
    supplier_name: 'Dell Technologies',
    domain: 'dell.com',
    industry: 'Computer manufacturing',
    naics: '334111',
    unspsc_code: '43211507',
    confidence: 0.95,
    reasoning: 'Dell manufactures desktop and laptop computers, servers and storage.',
  },
  {
    supplier_name: 'Grainger',
    domain: 'grainger.com',
    industry: 'Industrial supplies',
    naics: '423840',
    unspsc_code: '40141602',
    confidence: 0.9,
    reasoning: 'Grainger distributes industrial hardware, including valves and fittings.',
  },
  {
    supplier_name: 'Microsoft',
    domain: 'microsoft.com',
    industry: 'Software publishing',
    naics: '511210',
    unspsc_code: '43232401',
    confidence: 0.92,
    reasoning: 'Microsoft develops and licenses enterprise software.',
  },
  {
    supplier_name: 'Pfizer',
    domain: 'pfizer.com',
    industry: 'Pharmaceutical preparation manufacturing',
    naics: '325412',
    unspsc_code: '51201604',
    confidence: 0.93,
    reasoning: 'Pfizer manufactures pharmaceutical products and vaccines.',
  },
  {
    supplier_name: 'FedEx',
    domain: 'fedex.com',
    industry: 'Courier and express delivery services',
    naics: '492110',
    unspsc_code: '78102204',
    confidence: 0.94,
    reasoning: 'FedEx provides worldwide letter and small parcel courier services.',
  },
];

/**
 * Merge stored corrections (most-recent first) on top of the defaults,
 * de-duplicating by supplier name so the prompt stays compact.
 */
export function buildFewShotExamples(
  corrections: readonly FewShotExample[] = [],
  limit = 8,
): FewShotExample[] {
  const seen = new Set<string>();
  const merged: FewShotExample[] = [];
  for (const example of [...corrections, ...DEFAULT_FEW_SHOT_EXAMPLES]) {
    const key = example.supplier_name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    if (!isUnspscCode(example.unspsc_code)) continue;
    seen.add(key);
    merged.push(example);
    if (merged.length >= limit) break;
  }
  return merged;
}

function formatFewShot(examples: readonly FewShotExample[]): string {
  return examples
    .map(
      (example, index) =>
        `${index + 1}. Supplier: "${example.supplier_name}", Domain: "${example.domain ?? 'unknown'}", Industry: "${
          example.industry ?? 'unknown'
        }", NAICS: "${example.naics ?? 'unknown'}" -> unspsc_code: "${example.unspsc_code}", confidence: ${
          example.confidence
        }, reasoning: "${example.reasoning}"`,
    )
    .join('\n');
}

// ---------------------------------------------------------------------------
// Candidate codes
// ---------------------------------------------------------------------------

export type CandidateCode = {
  code: string;
  commodity: string;
  segment?: string | null;
  family?: string | null;
  className?: string | null;
};

function formatCandidates(candidates: readonly CandidateCode[]): string {
  if (!candidates.length) {
    return 'No candidate codes were retrieved. Use your own knowledge of the UNSPSC taxonomy.';
  }
  return candidates
    .map(
      (candidate) =>
        `- ${candidate.code} | ${candidate.segment ?? '?'} > ${candidate.family ?? '?'} > ${
          candidate.className ?? '?'
        } > ${candidate.commodity}`,
    )
    .join('\n');
}

// ---------------------------------------------------------------------------
// Single classification
// ---------------------------------------------------------------------------

export type ClassificationSubject = {
  supplier_name: string;
  domain?: string | null;
  industry?: string | null;
  naics?: string | null;
  sic?: string | null;
  description?: string | null;
  country?: string | null;
  parent_name?: string | null;
  parent_domain?: string | null;
  /** Aggregated spend, used only as an ambiguity hint. */
  amount?: number | null;
  /** Subsidy names: helps the model understand the cluster. */
  known_subsidiaries?: string[] | null;
};

export function buildClassificationUserPrompt(
  subject: ClassificationSubject,
  options: { fewShot?: FewShotExample[]; candidates?: CandidateCode[] } = {},
): string {
  // Corrections are merged ON TOP of the defaults rather than replacing them:
  // a handful of human corrections should refine the prompt, not leave the model
  // without its baseline examples.
  const examples = options.fewShot?.length ? buildFewShotExamples(options.fewShot, 10) : DEFAULT_FEW_SHOT_EXAMPLES;
  const subsidiaryLine =
    subject.known_subsidiaries && subject.known_subsidiaries.length
      ? `- Known subsidiaries: ${subject.known_subsidiaries.slice(0, 8).join(', ')}`
      : null;

  return `Classify the following supplier into the most specific 8-digit UNSPSC commodity code.

Few-shot examples:
${formatFewShot(examples)}

Candidate UNSPSC codes retrieved from the official taxonomy for this industry (prefer one of these when it fits; you may pick another real code if none fit):
${formatCandidates(options.candidates ?? [])}

Now classify this supplier:
- Name: ${subject.supplier_name}
- Domain: ${subject.domain ?? 'unknown'}
- Industry: ${subject.industry ?? 'unknown'}
- NAICS: ${subject.naics ?? 'unknown'}
- SIC: ${subject.sic ?? 'unknown'}
- Description: ${subject.description ?? 'unknown'}
- Country: ${subject.country ?? 'unknown'}
- Parent Company: ${subject.parent_name ?? 'none (independent)'}
- Parent Domain: ${subject.parent_domain ?? 'unknown'}${subsidiaryLine ? `\n${subsidiaryLine}` : ''}

Return JSON exactly:
{
  "unspsc_code": "8-digit string",
  "confidence": 0.0-1.0,
  "reasoning": "short explanation",
  "alternatives": [ { "code": "8-digit string", "confidence": 0.0-1.0 } ]
}`;
}

// ---------------------------------------------------------------------------
// Batched classification (up to LLM_BATCH_SIZE suppliers per request)
// ---------------------------------------------------------------------------

export type BatchSubject = ClassificationSubject & { index: number };

export function buildBatchClassificationUserPrompt(
  subjects: readonly BatchSubject[],
  options: { fewShot?: FewShotExample[]; candidates?: CandidateCode[] } = {},
): string {
  const examples = options.fewShot?.length ? buildFewShotExamples(options.fewShot, 10) : DEFAULT_FEW_SHOT_EXAMPLES;

  const lines = subjects
    .map(
      (subject) =>
        `${subject.index + 1}. Name: "${subject.supplier_name}", Domain: "${subject.domain ?? 'unknown'}", Industry: "${
          subject.industry ?? 'unknown'
        }", NAICS: "${subject.naics ?? 'unknown'}", SIC: "${subject.sic ?? 'unknown'}", Description: "${
          subject.description ? subject.description.slice(0, 200) : 'unknown'
        }", Parent: "${subject.parent_name ?? 'none'}"`,
    )
    .join('\n');

  return `Classify each supplier below into the most specific 8-digit UNSPSC commodity code.
Use the same rules and few-shot examples as before.

Few-shot examples:
${formatFewShot(examples)}

Candidate UNSPSC codes retrieved from the official taxonomy for these industries (prefer one of these when it fits; you may pick another real code if none fit):
${formatCandidates(options.candidates ?? [])}

Suppliers:
${lines}

Return a JSON object with a single key "results" whose value is an array with exactly ${subjects.length} items, one per supplier, in the same order:
{
  "results": [
    { "supplier_name": "...", "unspsc_code": "8-digit string", "confidence": 0.0-1.0, "reasoning": "..." }
  ]
}`;
}

// ---------------------------------------------------------------------------
// Parent detection
// ---------------------------------------------------------------------------

export type ParentDetectionSubject = {
  supplier_name: string;
  domain?: string | null;
  industry?: string | null;
  naics?: string | null;
  country?: string | null;
};

export function buildParentDetectionUserPrompt(subject: ParentDetectionSubject): string {
  return `Given the supplier name and domain, identify its ultimate parent company. If the supplier is independent, return null.

Supplier: ${subject.supplier_name}
Domain: ${subject.domain ?? 'unknown'}
Industry: ${subject.industry ?? 'unknown'}
NAICS: ${subject.naics ?? 'unknown'}
Country: ${subject.country ?? 'unknown'}

Return JSON exactly:
{ "parent_name": "...", "parent_domain": "...", "is_subsidiary": true, "confidence": 0.0-1.0 }`;
}

export function buildBatchParentDetectionUserPrompt(subjects: readonly BatchSubject[]): string {
  const lines = subjects
    .map(
      (subject) =>
        `${subject.index + 1}. Name: "${subject.supplier_name}", Domain: "${subject.domain ?? 'unknown'}", Industry: "${
          subject.industry ?? 'unknown'
        }"`,
    )
    .join('\n');

  return `For each supplier below, identify its ultimate parent company. If the supplier is already an independent top-level company, use null.

Suppliers:
${lines}

Return a JSON object with a single key "results" whose value is an array with exactly ${subjects.length} items, in the same order:
{
  "results": [
    { "supplier_name": "...", "parent_name": "...", "parent_domain": "...", "is_subsidiary": true, "confidence": 0.0-1.0 }
  ]
}`;
}

// ---------------------------------------------------------------------------
// Response validation helpers
// ---------------------------------------------------------------------------

export type ParsedClassification = {
  unspsc_code: string;
  confidence: number;
  reasoning: string;
  alternatives: ClassificationAlternative[];
};

function toAlternative(value: unknown): ClassificationAlternative | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const code = String(record.code ?? '').replace(/\D/g, '');
  if (!isUnspscCode(code)) return null;
  const rawConfidence = Number(record.confidence);
  return {
    code,
    confidence: Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0.5,
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
  };
}

/**
 * Validate a single classification object. Returns null when the payload is
 * unusable (no valid 8-digit code), so callers can fall back to review.
 */
export function parseClassificationPayload(payload: unknown): ParsedClassification | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;

  const code = String(record.unspsc_code ?? record.code ?? '').replace(/\D/g, '');
  if (!isUnspscCode(code)) return null;

  const rawConfidence = Number(record.confidence);
  const confidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0.5;

  const reasoning =
    typeof record.reasoning === 'string' && record.reasoning.trim()
      ? record.reasoning.trim().slice(0, 1000)
      : 'No reasoning provided by the model.';

  const alternatives = Array.isArray(record.alternatives)
    ? record.alternatives.map(toAlternative).filter((item): item is ClassificationAlternative => item !== null)
    : [];

  // Deduplicate alternatives against the primary code and cap the list.
  const seen = new Set([code]);
  const uniqueAlternatives = alternatives
    .filter((alt) => {
      if (seen.has(alt.code)) return false;
      seen.add(alt.code);
      return true;
    })
    .slice(0, 5);

  return { unspsc_code: code, confidence, reasoning, alternatives: uniqueAlternatives };
}

/** Normalise the batch (or single) classification response into an array. */
export function parseBatchClassificationResponse(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    for (const key of ['results', 'classifications', 'suppliers', 'data', 'items']) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
    // A single object was returned for a non-batch call.
    if ('unspsc_code' in record || 'code' in record) return [record];
  }
  return [];
}

export type ParsedParentDetection = {
  parent_name: string | null;
  parent_domain: string | null;
  is_subsidiary: boolean;
  confidence: number;
};

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  if (['null', 'none', 'n/a', 'na', 'unknown', 'independent'].includes(lowered)) return null;
  return trimmed.slice(0, 300);
}

export function parseParentDetectionPayload(payload: unknown): ParsedParentDetection | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;

  const parentName = cleanName(record.parent_name ?? record.parent ?? record.ultimate_parent);
  const parentDomainRaw = record.parent_domain ?? record.domain;
  const parentDomain =
    typeof parentDomainRaw === 'string' && parentDomainRaw.trim() && parentDomainRaw.trim().toLowerCase() !== 'null'
      ? parentDomainRaw.trim()
      : null;

  const rawConfidence = Number(record.confidence);
  const confidence = Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0.5;

  const explicit = record.is_subsidiary;
  const isSubsidiary = typeof explicit === 'boolean' ? explicit : Boolean(parentName);

  if (!parentName) {
    return { parent_name: null, parent_domain: null, is_subsidiary: false, confidence };
  }
  return { parent_name: parentName, parent_domain: parentDomain, is_subsidiary: isSubsidiary, confidence };
}

export function parseBatchParentDetectionResponse(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    for (const key of ['results', 'parents', 'data', 'items']) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
    if ('parent_name' in record || 'is_subsidiary' in record) return [record];
  }
  return [];
}
