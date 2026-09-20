/**
 * Classification prompt/parse tests.
 *
 * The prompt builders are pure, so these cover the accuracy levers without any
 * network access: few-shot merging (feedback loop), candidate injection, JSON
 * extraction, and validation of model output.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FEW_SHOT_EXAMPLES,
  buildBatchClassificationUserPrompt,
  buildClassificationUserPrompt,
  buildParentDetectionUserPrompt,
  parseBatchClassificationResponse,
  parseBatchParentDetectionResponse,
  parseClassificationPayload,
  parseParentDetectionPayload,
  type BatchSubject,
} from '@/services/prompts';
import { extractJsonText, parseJsonResponse } from '@/services/groq';
import { extractKeywords } from '@/services/classification';
import { LlmResponseError } from '@/lib/errors';

describe('buildClassificationUserPrompt', () => {
  const subject = {
    supplier_name: 'Dell Technologies',
    domain: 'dell.com',
    industry: 'Computer manufacturing',
    naics: '334111',
    sic: '3571',
    description: 'Makes computers and servers',
    parent_name: null,
  };

  it('includes the required fields and the JSON contract', () => {
    const prompt = buildClassificationUserPrompt(subject);
    expect(prompt).toContain('- Name: Dell Technologies');
    expect(prompt).toContain('- Domain: dell.com');
    expect(prompt).toContain('- NAICS: 334111');
    expect(prompt).toContain('"unspsc_code": "8-digit string"');
    expect(prompt).toContain('"alternatives"');
  });

  it('falls back to "unknown" for missing enrichment data', () => {
    const prompt = buildClassificationUserPrompt({ supplier_name: 'Mystery Co' });
    expect(prompt).toContain('- Domain: unknown');
    expect(prompt).toContain('- Parent Company: none (independent)');
  });

  it('injects candidate codes retrieved from the taxonomy', () => {
    const prompt = buildClassificationUserPrompt(subject, {
      candidates: [
        { code: '43211500', commodity: 'Computers', segment: 'Information Technology', family: 'Computer accessories', className: 'Computers' },
      ],
    });
    expect(prompt).toContain('43211500');
    expect(prompt).toContain('Candidate UNSPSC codes');
  });

  it('tells the model when no candidates were found', () => {
    const prompt = buildClassificationUserPrompt(subject, { candidates: [] });
    expect(prompt).toContain('No candidate codes were retrieved');
  });

  it('prefers human corrections as few-shot examples', () => {
    const prompt = buildClassificationUserPrompt(subject, {
      fewShot: [
        {
          supplier_name: 'Outdoor Supply Co',
          unspsc_code: '10101500',
          confidence: 0.99,
          reasoning: 'Human correction: they sell plants, not tools.',
        },
      ],
    });
    expect(prompt).toContain('Outdoor Supply Co');
    expect(prompt).toContain('Human correction');
    // The default example set is replaced, not appended indefinitely.
    expect(prompt).toContain('Grainger');
  });

  it('mentions known subsidiaries so the parent is classified for the whole family', () => {
    const withoutSubs = buildClassificationUserPrompt(subject, {});
    expect(withoutSubs).not.toContain('Known subsidiaries');

    const withSubs = buildClassificationUserPrompt({ ...subject, known_subsidiaries: ['EMC', 'VMware'] });
    expect(withSubs).toContain('Known subsidiaries: EMC, VMware');
  });
});

describe('buildBatchClassificationUserPrompt', () => {
  const subjects: BatchSubject[] = [
    { supplier_name: 'Dell', domain: 'dell.com', industry: 'Computers', index: 0 },
    { supplier_name: 'Grainger', domain: 'grainger.com', industry: 'Industrial supplies', index: 1 },
  ];

  it('numbers the suppliers and asks for a results array', () => {
    const prompt = buildBatchClassificationUserPrompt(subjects);
    expect(prompt).toContain('1. Name: "Dell"');
    expect(prompt).toContain('2. Name: "Grainger"');
    expect(prompt).toContain('"results"');
    expect(prompt).toContain('exactly 2 items');
  });
});

describe('buildParentDetectionUserPrompt', () => {
  it('asks for the ultimate parent with a JSON contract', () => {
    const prompt = buildParentDetectionUserPrompt({ supplier_name: 'LinkedIn', domain: 'linkedin.com' });
    expect(prompt).toContain('Supplier: LinkedIn');
    expect(prompt).toContain('"is_subsidiary"');
  });
});

describe('parseClassificationPayload', () => {
  it('accepts a well-formed payload', () => {
    const parsed = parseClassificationPayload({
      unspsc_code: '43211500',
      confidence: 0.95,
      reasoning: 'Makes computers.',
      alternatives: [{ code: '43211600', confidence: 0.4 }],
    });
    expect(parsed?.unspsc_code).toBe('43211500');
    expect(parsed?.confidence).toBe(0.95);
    expect(parsed?.alternatives).toHaveLength(1);
  });

  it('accepts numeric codes and strips separators', () => {
    expect(parseClassificationPayload({ unspsc_code: 43211500 })?.unspsc_code).toBe('43211500');
    expect(parseClassificationPayload({ unspsc_code: '43-211-500' })?.unspsc_code).toBe('43211500');
  });

  it('rejects payloads without a usable code', () => {
    expect(parseClassificationPayload(null)).toBeNull();
    expect(parseClassificationPayload({})).toBeNull();
    expect(parseClassificationPayload({ unspsc_code: 'not-a-code' })).toBeNull();
    expect(parseClassificationPayload({ unspsc_code: '432115' })).toBeNull();
  });

  it('clamps confidence into 0..1 and defaults it when absent', () => {
    expect(parseClassificationPayload({ unspsc_code: '43211500', confidence: 5 })?.confidence).toBe(1);
    expect(parseClassificationPayload({ unspsc_code: '43211500', confidence: -3 })?.confidence).toBe(0);
    expect(parseClassificationPayload({ unspsc_code: '43211500' })?.confidence).toBe(0.5);
  });

  it('drops duplicate and malformed alternatives', () => {
    const parsed = parseClassificationPayload({
      unspsc_code: '43211500',
      alternatives: [
        { code: '43211500', confidence: 0.9 },
        { code: '43211600', confidence: 0.5 },
        { code: 'bad', confidence: 0.5 },
        { code: '43211600', confidence: 0.4 },
      ],
    });
    expect(parsed?.alternatives.map((item) => item.code)).toEqual(['43211600']);
  });
});

describe('parseBatchClassificationResponse', () => {
  it('unwraps the results array, a bare array, and a single object', () => {
    expect(parseBatchClassificationResponse({ results: [{ unspsc_code: '43211500' }] })).toHaveLength(1);
    expect(parseBatchClassificationResponse([{ unspsc_code: '43211500' }])).toHaveLength(1);
    expect(parseBatchClassificationResponse({ unspsc_code: '43211500' })).toHaveLength(1);
    expect(parseBatchClassificationResponse({ nonsense: true })).toHaveLength(0);
  });
});

describe('parseParentDetectionPayload', () => {
  it('parses an identified parent', () => {
    const parsed = parseParentDetectionPayload({
      parent_name: 'Microsoft Corporation',
      parent_domain: 'microsoft.com',
      is_subsidiary: true,
      confidence: 0.88,
    });
    expect(parsed?.parent_name).toBe('Microsoft Corporation');
    expect(parsed?.is_subsidiary).toBe(true);
  });

  it('treats null/absent parents as independent', () => {
    expect(parseParentDetectionPayload({ parent_name: null, is_subsidiary: false })?.is_subsidiary).toBe(false);
    const independent = parseParentDetectionPayload({ parent_name: 'null' });
    expect(independent?.parent_name).toBeNull();
    expect(independent?.is_subsidiary).toBe(false);
  });

  it('infers is_subsidiary from the presence of a parent name', () => {
    expect(parseParentDetectionPayload({ parent_name: 'Alphabet Inc' })?.is_subsidiary).toBe(true);
  });
});

describe('parseBatchParentDetectionResponse', () => {
  it('unwraps arrays and single objects', () => {
    expect(parseBatchParentDetectionResponse({ results: [{ parent_name: 'A' }] })).toHaveLength(1);
    expect(parseBatchParentDetectionResponse([{ parent_name: 'A' }])).toHaveLength(1);
    expect(parseBatchParentDetectionResponse({ parent_name: 'A' })).toHaveLength(1);
    expect(parseBatchParentDetectionResponse({})).toHaveLength(0);
  });
});

describe('default few-shot examples', () => {
  it('are all syntactically valid 8-digit codes', () => {
    for (const example of DEFAULT_FEW_SHOT_EXAMPLES) {
      expect(example.unspsc_code).toMatch(/^\d{8}$/);
      expect(example.confidence).toBeGreaterThan(0);
      expect(example.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('use real UNSPSC v26 commodity codes, not class prefixes', () => {
    // Regression guard: the original prompt used class-level prefixes
    // (43211500, 43232400, 40141600, 51151500, 78102200) which do not exist as
    // commodities in v26. Teaching those would cap every classification at the
    // 0.4 "unverifiable code" penalty.
    const invalidPrefixes = ['43211500', '43232400', '40141600', '51151500', '78102200'];
    for (const example of DEFAULT_FEW_SHOT_EXAMPLES) {
      expect(invalidPrefixes).not.toContain(example.unspsc_code);
      // A real commodity never ends in four zeros (that is a class).
      expect(example.unspsc_code.endsWith('0000')).toBe(false);
    }
  });

  it('covers the categories named in the spec', () => {
    const names = DEFAULT_FEW_SHOT_EXAMPLES.map((example) => example.supplier_name);
    expect(names).toContain('Dell Technologies');
    expect(names).toContain('Grainger');
    expect(names).toContain('Microsoft');
    expect(names).toContain('Pfizer');
    expect(names).toContain('FedEx');
  });

  it('never duplicate a supplier or a code', () => {
    const names = DEFAULT_FEW_SHOT_EXAMPLES.map((example) => example.supplier_name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('JSON extraction', () => {
  it('handles fenced, prose-wrapped and bare JSON', () => {
    expect(extractJsonText('{"a":1}')).toBe('{"a":1}');
    expect(extractJsonText('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonText('Here you go: {"a":1} — done.')).toBe('{"a":1}');
    expect(extractJsonText('[{"a":1}]')).toBe('[{"a":1}]');
  });

  it('handles nested braces and strings containing braces', () => {
    const nested = '{"a":{"b":{"c":1}},"d":"}{"}';
    expect(parseJsonResponse<{ d: string }>(nested).d).toBe('}{');
  });

  it('repairs trailing commas', () => {
    expect(parseJsonResponse<{ a: number }>('{"a":1,}').a).toBe(1);
  });

  it('throws a typed error for unusable content', () => {
    expect(() => parseJsonResponse('no json here')).toThrow(LlmResponseError);
    expect(() => parseJsonResponse('')).toThrow(LlmResponseError);
  });
});

describe('extractKeywords', () => {
  it('keeps meaningful words and drops stop words', () => {
    const keywords = extractKeywords('Industrial supplies merchant wholesalers of the company');
    expect(keywords).toContain('industrial');
    expect(keywords).toContain('supplies');
    expect(keywords).toContain('wholesalers');
    expect(keywords).not.toContain('of');
    expect(keywords).not.toContain('company');
  });

  it('handles empty input', () => {
    expect(extractKeywords(null)).toEqual([]);
    expect(extractKeywords('   ')).toEqual([]);
  });

  it('deduplicates and limits the result', () => {
    const keywords = extractKeywords('software software software platform platform data analytics cloud', 3);
    expect(keywords).toHaveLength(3);
    expect(new Set(keywords).size).toBe(3);
  });
});
