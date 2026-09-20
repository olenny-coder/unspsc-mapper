/**
 * Upsert / sync merge-logic tests.
 *
 * These lock in the "non-destructive merge" contract: a refresh never erases good
 * data with an empty value, changed industry data flags the supplier for
 * reclassification, and repeated CSV rows are aggregated rather than duplicated.
 */
import { describe, expect, it } from 'vitest';
import type { Supplier } from '@/db/schema';
import {
  RECLASSIFY_TRIGGER_FIELDS,
  csvRecordIsShifted,
  enrichmentFingerprint,
  extractCsvDate,
  mapCsvRecordToSupplier,
  mergeEnrichmentFields,
  requiresReclassification,
  sanitizeParentName,
  segmentLikePattern,
} from '@/services/suppliers';
import { findStaleSuppliers } from '@/services/sync';

function supplier(partial: Partial<Supplier> = {}): Supplier {
  return {
    id: 1,
    name: 'Dell Technologies',
    normalizedName: 'dell technologies',
    domain: 'dell.com',
    industry: 'Computer manufacturing',
    naics: '334111',
    sic: '3571',
    description: 'Designs and manufactures computers, servers and storage.',
    country: 'US',
    totalAmount: '1250000.00',
    transactionCount: 3,
    currency: 'USD',
    parentId: null,
    parentName: null,
    parentDomain: null,
    isParent: false,
    parentSource: null,
    parentConfidence: null,
    enrichedAt: new Date('2024-01-01T00:00:00Z'),
    enrichAttempts: 1,
    lastEnrichError: null,
    enrichFingerprint: null,
    stale: false,
    staleReason: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...partial,
  };
}

describe('mergeEnrichmentFields', () => {
  it('never erases existing data with empty incoming values', () => {
    const { values, changedFields } = mergeEnrichmentFields(supplier(), {
      name: 'Dell Technologies',
      domain: null,
      industry: '',
      naics: null,
      description: '   ',
    });
    expect(changedFields).toEqual([]);
    expect(values).toEqual({});
  });

  it('fills in missing fields', () => {
    const { values, changedFields } = mergeEnrichmentFields(supplier({ country: null, sic: null }), {
      name: 'Dell Technologies',
      country: 'US',
      sic: '3571',
    });
    expect(changedFields.sort()).toEqual(['country', 'sic']);
    expect(values.country).toBe('US');
    expect(values.sic).toBe('3571');
  });

  it('normalises domains before storing them', () => {
    const { values, changedFields } = mergeEnrichmentFields(supplier({ domain: null }), {
      name: 'Dell Technologies',
      domain: 'https://www.dell.com/en-us',
    });
    expect(values.domain).toBe('dell.com');
    expect(changedFields).toContain('domain');
  });

  it('replaces a shorter description with a richer one', () => {
    const { values } = mergeEnrichmentFields(supplier({ description: 'Computers' }), {
      name: 'Dell Technologies',
      description: 'Designs, manufactures and sells personal computers, servers, storage and networking products.',
    });
    expect(values.description).toContain('networking');
  });

  it('does not downgrade a rich description to a shorter one', () => {
    const existing = supplier({ description: 'A very long and detailed description of the company operations.' });
    const { values, changedFields } = mergeEnrichmentFields(existing, {
      name: 'Dell Technologies',
      description: 'Short.',
    });
    expect(values.description).toBeUndefined();
    expect(changedFields).not.toContain('description');
  });

  it('overwrites when explicitly requested', () => {
    const { values, changedFields } = mergeEnrichmentFields(
      supplier({ industry: 'Computer manufacturing' }),
      { name: 'Dell Technologies', industry: 'IT hardware' },
      { overwrite: true },
    );
    expect(values.industry).toBe('IT hardware');
    expect(changedFields).toContain('industry');
  });

  it('adds transaction counts and updates amounts', () => {
    const { values, changedFields } = mergeEnrichmentFields(supplier(), {
      name: 'Dell Technologies',
      amount: 500,
      transactionCount: 2,
    });
    expect(values.totalAmount).toBe('500.00');
    expect(values.transactionCount).toBe(5);
    expect(changedFields).toContain('totalAmount');
    expect(changedFields).toContain('transactionCount');
  });

  it('only moves enrichedAt forward', () => {
    const older = mergeEnrichmentFields(supplier({ enrichedAt: new Date('2024-06-01T00:00:00Z') }), {
      name: 'Dell Technologies',
      enrichedAt: new Date('2024-01-01T00:00:00Z'),
    });
    expect(older.changedFields).not.toContain('enrichedAt');

    const newer = mergeEnrichmentFields(supplier({ enrichedAt: new Date('2024-01-01T00:00:00Z') }), {
      name: 'Dell Technologies',
      enrichedAt: new Date('2024-06-01T00:00:00Z'),
    });
    expect(newer.changedFields).toContain('enrichedAt');
  });

  it('records parent company information', () => {
    const { values, changedFields } = mergeEnrichmentFields(supplier({ parentName: null }), {
      name: 'EMC Corporation',
      parentName: 'Dell Technologies',
      parentDomain: 'dell.com',
    });
    expect(values.parentName).toBe('Dell Technologies');
    expect(values.parentDomain).toBe('dell.com');
    expect(changedFields).toContain('parentName');
  });
});

describe('requiresReclassification', () => {
  it('triggers on every field the spec calls significant', () => {
    for (const field of ['industry', 'naics', 'sic', 'description', 'domain', 'parentName']) {
      expect(RECLASSIFY_TRIGGER_FIELDS.has(field)).toBe(true);
      expect(requiresReclassification([field])).toBe(true);
    }
  });

  it('does not trigger for cosmetic changes', () => {
    expect(requiresReclassification(['totalAmount'])).toBe(false);
    expect(requiresReclassification(['country'])).toBe(false);
    expect(requiresReclassification([])).toBe(false);
  });
});

describe('enrichmentFingerprint', () => {
  it('is stable for identical payloads', () => {
    const payload = { domain: 'dell.com', industry: 'IT', naics: '334111', description: 'computers' };
    expect(enrichmentFingerprint(payload)).toBe(enrichmentFingerprint({ ...payload }));
  });

  it('changes when a material field changes', () => {
    const base = { domain: 'dell.com', industry: 'IT', naics: '334111', description: 'computers' };
    expect(enrichmentFingerprint(base)).not.toBe(enrichmentFingerprint({ ...base, industry: 'Hardware' }));
    expect(enrichmentFingerprint(base)).not.toBe(enrichmentFingerprint({ ...base, parentName: 'Dell Inc' }));
  });

  it('ignores case-only differences', () => {
    expect(enrichmentFingerprint({ domain: 'DELL.com' })).toBe(enrichmentFingerprint({ domain: 'dell.com' }));
  });
});

describe('mapCsvRecordToSupplier', () => {
  it('accepts flexible header names', () => {
    expect(mapCsvRecordToSupplier({ supplier: 'Dell Technologies', spend: '1,250.00' })?.name).toBe('Dell Technologies');
    expect(mapCsvRecordToSupplier({ vendor: 'Grainger' })?.name).toBe('Grainger');
    expect(mapCsvRecordToSupplier({ 'Supplier Name': 'FedEx' })?.name).toBe('FedEx');
    expect(mapCsvRecordToSupplier({ company: 'Pfizer', total: '410000' })?.amount).toBe(410000);
  });

  it('returns null when there is no usable name', () => {
    expect(mapCsvRecordToSupplier({ amount: '100' })).toBeNull();
    expect(mapCsvRecordToSupplier({ name: '   ' })).toBeNull();
  });

  it('parses the parent column variants', () => {
    expect(mapCsvRecordToSupplier({ name: 'EMC Corporation', parent: 'Dell Technologies' })?.parentName).toBe(
      'Dell Technologies',
    );
    expect(mapCsvRecordToSupplier({ name: 'EMC', parent_company: 'Dell' })?.parentName).toBe('Dell');
    expect(mapCsvRecordToSupplier({ name: 'EMC', ultimate_parent: 'Dell Inc' })?.parentName).toBe('Dell Inc');
  });

  it('rejects a numeric "parent" so a shifted CSV column cannot invent a parent company', () => {
    // A row with an unquoted comma (e.g. an amount written as $1,250.00) shifts
    // every later column left, so a NAICS code lands in the parent column.
    const shifted = mapCsvRecordToSupplier({
      name: 'ACME CO., LTD',
      amount: '$1',
      date: '250.00',
      domain: '2024-03-24',
      industry: 'acme.com',
      naics: 'Fastener manufacturing',
      parent: '332722',
    });
    expect(shifted?.parentName).toBeNull();
  });

  it('normalises display names', () => {
    expect(mapCsvRecordToSupplier({ name: 'DELL TECHNOLOGIES' })?.name).toBe('Dell Technologies');
  });
});

describe('sanitizeParentName', () => {
  it('keeps real company names', () => {
    expect(sanitizeParentName('Dell Technologies')).toBe('Dell Technologies');
    expect(sanitizeParentName('3M')).toBe('3M');
    expect(sanitizeParentName('Siemens AG')).toBe('Siemens AG');
  });

  it('drops codes, empty values and absurd strings', () => {
    expect(sanitizeParentName('332722')).toBeNull();
    expect(sanitizeParentName('  ')).toBeNull();
    expect(sanitizeParentName(null)).toBeNull();
    expect(sanitizeParentName('123-456')).toBeNull();
    expect(sanitizeParentName('9'.repeat(201))).toBeNull();
    expect(sanitizeParentName('!!! ???')).toBeNull();
  });
});

describe('csvRecordIsShifted', () => {
  it('detects rows with more fields than the header', () => {
    expect(csvRecordIsShifted({ name: 'X', __parsed_extra: ['extra'] })).toBe(true);
    expect(csvRecordIsShifted({ name: 'X', __parsed_extra: [''] })).toBe(false);
    expect(csvRecordIsShifted({ name: 'X', __parsed_extra: [] })).toBe(false);
    expect(csvRecordIsShifted({ name: 'X' })).toBe(false);
  });
});

describe('extractCsvDate', () => {
  it('finds a date column under several names', () => {
    expect(extractCsvDate({ name: 'X', date: '2024-03-01' })).toBe('2024-03-01');
    expect(extractCsvDate({ name: 'X', transaction_date: '03/18/2024' })).toBe('2024-03-18');
    expect(extractCsvDate({ name: 'X' })).toBeNull();
  });
});

describe('segmentLikePattern', () => {
  it('builds prefix patterns that work for segments, families and commodities', () => {
    expect(segmentLikePattern('43')).toBe('43%');
    expect(segmentLikePattern('4321')).toBe('4321%');
    expect(segmentLikePattern('43-211-500')).toBe('43211500%');
    expect(segmentLikePattern('')).toBeNull();
    expect(segmentLikePattern(undefined)).toBeNull();
  });
});

describe('findStaleSuppliers', () => {
  const now = Date.parse('2024-06-01T00:00:00Z');

  it('flags suppliers that were never enriched', () => {
    const rows = [supplier({ id: 1, enrichedAt: null })];
    const candidates = findStaleSuppliers(rows, { staleAfterDays: 30, now });
    expect(candidates[0]?.reason).toBe('never_enriched');
    expect(candidates[0]?.ageDays).toBeNull();
  });

  it('flags enrichment older than the threshold', () => {
    const rows = [supplier({ id: 1, enrichedAt: new Date('2024-01-01T00:00:00Z') })];
    const candidates = findStaleSuppliers(rows, { staleAfterDays: 30, now });
    expect(candidates[0]?.reason).toBe('enrichment_old');
    expect(candidates[0]?.ageDays).toBeGreaterThan(30);
  });

  it('leaves fresh suppliers alone', () => {
    const rows = [supplier({ id: 1, enrichedAt: new Date('2024-05-30T00:00:00Z') })];
    expect(findStaleSuppliers(rows, { staleAfterDays: 30, now })).toHaveLength(0);
  });

  it('flags explicitly stale rows and previous failures', () => {
    const rows = [
      supplier({ id: 1, stale: true, enrichedAt: new Date('2024-05-30T00:00:00Z') }),
      supplier({ id: 2, lastEnrichError: 'HTTP 500', enrichedAt: new Date('2024-05-30T00:00:00Z') }),
    ];
    const candidates = findStaleSuppliers(rows, { staleAfterDays: 30, now });
    expect(candidates.map((candidate) => candidate.reason).sort()).toEqual(['flagged_stale', 'previous_failure']);
  });

  it('orders candidates by spend so the important suppliers refresh first', () => {
    const rows = [
      supplier({ id: 1, name: 'Small', totalAmount: '100.00', enrichedAt: null }),
      supplier({ id: 2, name: 'Huge', totalAmount: '900000.00', enrichedAt: null }),
      supplier({ id: 3, name: 'Medium', totalAmount: '50000.00', enrichedAt: null }),
    ];
    const candidates = findStaleSuppliers(rows, { staleAfterDays: 30, now });
    expect(candidates.map((candidate) => candidate.supplier.id)).toEqual([2, 3, 1]);
  });

  it('respects the limit', () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      supplier({ id: index + 1, name: `Supplier ${index}`, enrichedAt: null, totalAmount: String(index * 100) }),
    );
    expect(findStaleSuppliers(rows, { staleAfterDays: 30, now, limit: 3 })).toHaveLength(3);
  });
});
