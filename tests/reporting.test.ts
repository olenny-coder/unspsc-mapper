/**
 * Query/filter validation and report aggregation tests.
 */
import { describe, expect, it } from 'vitest';
import {
  describeFilters,
  parseReportFilters,
  reportFiltersSchema,
  unspscCodeSchema,
} from '@/lib/validation';
import { breakdownBySegment, collectLowConfidence, summarize, topParentsBySpend } from '@/services/reporting/aggregate';
import { renderSupplierCsv, csvBytes } from '@/services/reporting/csv';
import { sanitizePdfText, wrapText, clipText } from '@/services/reporting/pdf';
import type { SupplierListRow } from '@/services/suppliers';
import type { ParentRollup } from '@/services/hierarchy';

function row(partial: Partial<SupplierListRow> & { id: number; name: string }): SupplierListRow {
  return {
    normalizedName: partial.name.toLowerCase(),
    domain: null,
    industry: null,
    naics: null,
    sic: null,
    description: null,
    country: null,
    totalAmount: 0,
    transactionCount: 1,
    currency: 'USD',
    parentId: null,
    parentName: null,
    parentDomain: null,
    isParent: false,
    parentSource: null,
    parentConfidence: null,
    enrichedAt: '2024-06-01T00:00:00.000Z',
    enrichedAtAgeDays: 1,
    lastEnrichError: null,
    stale: false,
    staleReason: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-06-01T00:00:00.000Z',
    subsidiaryCount: 0,
    classification: null,
    ...partial,
  };
}

function classification(code: string, confidence: number, overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    unspscCode: code,
    effectiveCode: code,
    confidence,
    reasoning: 'Because reasons.',
    llmModel: 'llama-3.3-70b-versatile',
    inheritedFromParent: false,
    reviewed: false,
    correctedCode: null,
    correctedBy: null,
    segment: 'Information Technology',
    segmentCode: code.slice(0, 2),
    family: 'Computer accessories',
    className: 'Computers',
    commodity: 'Computers',
    codeDescription: null,
    ...overrides,
  } as SupplierListRow['classification'];
}

describe('parseReportFilters', () => {
  it('normalises query strings', () => {
    const filters = parseReportFilters(
      new URLSearchParams({
        minConfidence: '0.8',
        segment: '43',
        parent: 'Dell Technologies',
        onlyStale: 'true',
        rollup: 'parent',
        supplierIds: '1,2,3',
      }),
    );
    expect(filters.minConfidence).toBe(0.8);
    expect(filters.segment).toBe('43');
    expect(filters.parent).toBe('Dell Technologies');
    expect(filters.onlyStale).toBe(true);
    expect(filters.rollup).toBe('parent');
    expect(filters.supplierIds).toEqual([1, 2, 3]);
  });

  it('treats falsy booleans as undefined/absent', () => {
    const filters = parseReportFilters({ onlyStale: 'false', onlyParents: '0' });
    expect(filters.onlyStale).toBe(false);
    expect(filters.onlyParents).toBe(false);
  });

  it('ignores pagination and format keys', () => {
    const filters = parseReportFilters({ page: '3', pageSize: '100', format: 'pdf', sort: 'name' });
    expect(filters).not.toHaveProperty('page');
    expect(filters).not.toHaveProperty('format');
  });

  it('falls back to defaults for invalid input instead of throwing', () => {
    const filters = parseReportFilters({ minConfidence: 'not-a-number', rollup: 'nonsense' });
    expect(filters.rollup).toBe('supplier');
    expect(filters.minConfidence).toBeUndefined();
  });

  it('defaults rollup to supplier', () => {
    expect(reportFiltersSchema.parse({}).rollup).toBe('supplier');
  });
});

describe('describeFilters', () => {
  it('produces a human-readable summary', () => {
    const summary = describeFilters({
      minConfidence: 0.7,
      segment: '43',
      parent: 'Dell',
      onlyStale: true,
      rollup: 'parent',
      from: '2024-01-01',
      to: '2024-06-30',
    });
    expect(summary.join(' ')).toContain('confidence >= 0.7');
    expect(summary.join(' ')).toContain('segment 43');
    expect(summary.join(' ')).toContain('parent "Dell"');
    expect(summary.join(' ')).toContain('stale only');
    expect(summary.join(' ')).toContain('rolled up by parent');
  });

  it('is empty when no filters are set', () => {
    expect(describeFilters({ rollup: 'supplier' })).toEqual([]);
  });
});

describe('unspscCodeSchema', () => {
  it('accepts only 8 digits', () => {
    expect(unspscCodeSchema.safeParse('43211500').success).toBe(true);
    expect(unspscCodeSchema.safeParse('4321150').success).toBe(false);
    expect(unspscCodeSchema.safeParse('4321150X').success).toBe(false);
  });
});

describe('summarize', () => {
  const rows = [
    row({ id: 1, name: 'Dell', totalAmount: 1000, isParent: true, subsidiaryCount: 1, classification: classification('43211500', 0.95) }),
    row({ id: 2, name: 'EMC', totalAmount: 500, parentId: 1, classification: classification('43211500', 0.85, { inheritedFromParent: true }) }),
    row({ id: 3, name: 'Grainger', totalAmount: 250, classification: classification('40141600', 0.5) }),
    row({ id: 4, name: 'Unclassified Co', totalAmount: 100, stale: true, enrichedAt: null }),
  ];

  it('computes the headline metrics the report needs', () => {
    const summary = summarize(rows, { confidenceThreshold: 0.7 });
    expect(summary.totalSuppliers).toBe(4);
    expect(summary.totalSpend).toBe(1850);
    expect(summary.classified).toBe(3);
    expect(summary.unclassified).toBe(1);
    expect(summary.percentClassified).toBe(75);
    expect(summary.lowConfidence).toBe(1);
    expect(summary.percentLowConfidence).toBe(25);
    expect(summary.inherited).toBe(1);
    expect(summary.parents).toBe(1);
    expect(summary.subsidiaries).toBe(1);
    expect(summary.stale).toBe(1);
  });

  it('excludes reviewed classifications from the low-confidence count', () => {
    const reviewed = [row({ id: 1, name: 'X', classification: classification('43211500', 0.3, { reviewed: true }) })];
    expect(summarize(reviewed, { confidenceThreshold: 0.7 }).lowConfidence).toBe(0);
  });

  it('handles an empty dataset without dividing by zero', () => {
    const summary = summarize([], { confidenceThreshold: 0.7 });
    expect(summary.totalSuppliers).toBe(0);
    expect(summary.percentClassified).toBe(0);
    expect(summary.percentLowConfidence).toBe(0);
    expect(summary.averageConfidence).toBeNull();
  });
});

describe('breakdownBySegment', () => {
  it('groups by segment and computes spend share', () => {
    const rows = [
      row({ id: 1, name: 'Dell', totalAmount: 750, classification: classification('43211500', 0.9) }),
      row({ id: 2, name: 'Microsoft', totalAmount: 250, classification: classification('43232400', 0.9) }),
      row({ id: 3, name: 'Unclassified', totalAmount: 100 }),
    ];
    const segments = breakdownBySegment(rows);
    expect(segments[0]?.segmentCode).toBe('43');
    expect(segments[0]?.spend).toBeCloseTo(1000, 2);
    expect(segments[0]?.spendShare).toBeCloseTo(90.9, 1);
    const unclassified = segments.find((segment) => segment.segmentCode === '--');
    expect(unclassified?.segment).toBe('Not classified');
    expect(unclassified?.suppliers).toBe(1);
  });
});

describe('collectLowConfidence', () => {
  it('sorts the lowest confidence first and includes unclassified suppliers', () => {
    const rows = [
      row({ id: 1, name: 'Good', classification: classification('43211500', 0.95) }),
      row({ id: 2, name: 'Bad', classification: classification('40141600', 0.35) }),
      row({ id: 3, name: 'Missing' }),
      row({ id: 4, name: 'Reviewed', classification: classification('43211500', 0.2, { reviewed: true }) }),
    ];
    const low = collectLowConfidence(rows, { confidenceThreshold: 0.7 });
    expect(low.map((item) => item.name)).toEqual(['Missing', 'Bad']);
  });

  it('caps the appendix size', () => {
    const rows = Array.from({ length: 20 }, (_, index) =>
      row({ id: index + 1, name: `Supplier ${index}`, classification: classification('43211500', 0.1) }),
    );
    expect(collectLowConfidence(rows, { confidenceThreshold: 0.7, limit: 5 })).toHaveLength(5);
  });
});

describe('topParentsBySpend', () => {
  it('sorts by spend and limits the list', () => {
    const parents: ParentRollup[] = [
      { clusterKey: 'a', parentId: 1, parentName: 'A', parentDomain: null, isVirtualRoot: false, supplierCount: 1, subsidiaryCount: 0, totalAmount: 10, unspscCode: null, confidence: null, staleCount: 0, lowConfidenceCount: 0 },
      { clusterKey: 'b', parentId: 2, parentName: 'B', parentDomain: null, isVirtualRoot: false, supplierCount: 1, subsidiaryCount: 0, totalAmount: 100, unspscCode: null, confidence: null, staleCount: 0, lowConfidenceCount: 0 },
      { clusterKey: 'c', parentId: 3, parentName: 'C', parentDomain: null, isVirtualRoot: false, supplierCount: 1, subsidiaryCount: 0, totalAmount: 50, unspscCode: null, confidence: null, staleCount: 0, lowConfidenceCount: 0 },
    ];
    expect(topParentsBySpend(parents, 2).map((parent) => parent.parentName)).toEqual(['B', 'C']);
  });
});

describe('renderSupplierCsv', () => {
  const dataset = {
    meta: {
      name: 'Test report',
      format: 'csv' as const,
      generatedAt: '2024-06-01T00:00:00.000Z',
      generatedBy: 'tester',
      filters: { rollup: 'parent' as const },
      filterSummary: ['confidence >= 0.7'],
      dateRange: { from: null, to: null },
      rollup: 'parent' as const,
      taxonomyVersion: 'v26.0801',
      appUrl: 'http://localhost:3000',
    },
    summary: {
      totalSuppliers: 2,
      totalSpend: 1500,
      classified: 2,
      unclassified: 0,
      percentClassified: 100,
      lowConfidence: 0,
      percentLowConfidence: 0,
      reviewed: 0,
      inherited: 1,
      stale: 0,
      parents: 1,
      subsidiaries: 1,
      averageConfidence: 0.9,
      confidenceThreshold: 0.7,
      currency: 'USD',
    },
    segments: [
      { segmentCode: '43', segment: 'Information Technology', suppliers: 2, spend: 1500, spendShare: 100, avgConfidence: 0.9 },
    ],
    parents: [
      { clusterKey: 's:1', parentId: 1, parentName: 'Dell', parentDomain: 'dell.com', isVirtualRoot: false, supplierCount: 2, subsidiaryCount: 1, totalAmount: 1500, unspscCode: '43211500', confidence: 0.9, staleCount: 0, lowConfidenceCount: 0 },
    ],
    topParents: [],
    lowConfidence: [
      { supplierId: 3, name: 'Shaky Co', code: '40141600', commodity: 'Hardware', confidence: 0.4, reasoning: 'Unsure', model: 'llama-3.1-8b-instant', parentName: null, spend: 100 },
    ],
    rows: [
      {
        supplier: row({ id: 1, name: 'Dell', totalAmount: 1000, isParent: true, classification: classification('43211500', 0.95) }),
        effectiveCode: '43211500',
        commodity: 'Computers',
        parentLabel: 'Dell',
        confidence: 0.95,
      },
      {
        supplier: row({ id: 2, name: 'EMC', totalAmount: 500, parentId: 1, classification: classification('43211500', 0.85, { inheritedFromParent: true }) }),
        effectiveCode: '43211500',
        commodity: 'Computers',
        parentLabel: 'Dell',
        confidence: 0.85,
      },
    ],
  };

  it('includes the metadata preamble, header row and both suppliers', () => {
    const csv = renderSupplierCsv(dataset);
    expect(csv).toContain('# UNSPSC Spend Report: Test report');
    expect(csv).toContain('# Rollup: parent');
    expect(csv).toContain('supplier_id,supplier_name,domain,industry');
    expect(csv).toContain('Dell');
    expect(csv).toContain('EMC');
    expect(csv).toContain('43211500');
  });

  it('appends the segment, parent roll-up and appendix sections', () => {
    const csv = renderSupplierCsv(dataset);
    expect(csv).toContain('# Segment breakdown');
    expect(csv).toContain('# Parent roll-up');
    expect(csv).toContain('# Low-confidence review appendix');
    expect(csv).toContain('Shaky Co');
  });

  it('quotes values containing commas', () => {
    const withComma = {
      ...dataset,
      rows: [
        {
          supplier: row({ id: 9, name: 'Smith, Jones & Co', totalAmount: 10 }),
          effectiveCode: null,
          commodity: null,
          parentLabel: 'Independent',
          confidence: null,
        },
      ],
    };
    const csv = renderSupplierCsv(withComma);
    expect(csv).toContain('"Smith, Jones & Co"');
  });

  it('prepends a UTF-8 BOM in the byte output for Excel', () => {
    const bytes = csvBytes('a,b\n1,2');
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('omits the parent roll-up section when there are no families', () => {
    const flat = { ...dataset, meta: { ...dataset.meta, rollup: 'supplier' as const }, parents: [] };
    expect(renderSupplierCsv(flat)).not.toContain('# Parent roll-up');
  });
});

describe('PDF text sanitisation', () => {
  it('transliterates characters the standard fonts cannot encode', () => {
    expect(sanitizePdfText('Dell\u2019s \u201cservers\u201d \u2014 fast')).toBe('Dell\'s "servers" - fast');
    expect(sanitizePdfText('caf\u00e9')).toBe('caf\u00e9');
    expect(sanitizePdfText('emoji \u{1F600} here')).toBe('emoji here');
    expect(sanitizePdfText('a\u2026b')).toBe('a...b');
  });

  it('handles null and undefined', () => {
    expect(sanitizePdfText(null)).toBe('');
    expect(sanitizePdfText(undefined, 'fallback')).toBe('fallback');
  });

  it('wraps and clips using font metrics', () => {
    // Minimal font stub: every character is 5 units wide.
    const font = { widthOfTextAtSize: (text: string, size: number) => text.length * size * 0.5 } as never;
    const lines = wrapText('one two three four five', font, 10, 60);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe('one two three four five');

    const clipped = clipText('a very long supplier name', font, 10, 40);
    expect(clipped.endsWith('...')).toBe(true);
    expect(clipped.length).toBeLessThan('a very long supplier name'.length);
  });
});
