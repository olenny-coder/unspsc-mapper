import { describe, expect, it } from 'vitest';
import {
  canonicalizeEntityName,
  chunk,
  clamp,
  coerceUnspscCode,
  extractDomain,
  fnv1a,
  guessDomainFromName,
  isUnspscCode,
  normalizeSupplierName,
  parseAmount,
  roundTo,
  smartTitleCase,
  toIsoDate,
} from '@/lib/normalize';

describe('normalizeSupplierName', () => {
  it('folds legal suffixes so the same company dedupes to one key', () => {
    expect(normalizeSupplierName('Dell Technologies, Inc.')).toBe('dell technologies');
    expect(normalizeSupplierName('Dell Technologies Inc')).toBe(normalizeSupplierName('Dell Technologies, Inc.'));
    expect(normalizeSupplierName('ACME  CO., LTD')).toBe('acme');
    expect(normalizeSupplierName('Acme Co')).toBe('acme');
    expect(normalizeSupplierName('acme')).toBe('acme');
  });

  it('normalises ampersands, punctuation and casing', () => {
    expect(normalizeSupplierName('Barnes & Noble')).toBe('barnes and noble');
    expect(normalizeSupplierName('Barnes and Noble, Inc.')).toBe('barnes and noble');
    expect(normalizeSupplierName('Ernst & Young LLP')).toBe('ernst and young');
    // "&" and "+" are both spelled out so the same vendor under either form dedupes.
    expect(normalizeSupplierName('Kuehne + Nagel')).toBe('kuehne and nagel');
    expect(normalizeSupplierName('Kuehne & Nagel')).toBe('kuehne and nagel');
  });

  it('strips corporate noise words but keeps distinctive names', () => {
    expect(normalizeSupplierName('Siemens AG')).toBe('siemens');
    expect(normalizeSupplierName('SAP SE')).toBe('sap');
    expect(normalizeSupplierName('Unilever Group')).toBe('unilever');
    // A name that IS a suffix must survive intact.
    expect(normalizeSupplierName('Group')).toBe('group');
    expect(normalizeSupplierName('Limited')).toBe('limited');
  });

  it('never merges genuinely different companies', () => {
    expect(normalizeSupplierName('Dell Technologies')).not.toBe(normalizeSupplierName('Dell Monitors'));
    expect(normalizeSupplierName('Microsoft')).not.toBe(normalizeSupplierName('Microsoft Azure'));
    expect(normalizeSupplierName('Acme Industrial')).not.toBe(normalizeSupplierName('Acme Healthcare'));
  });

  it('is stable for empty and whitespace input', () => {
    expect(normalizeSupplierName('')).toBe('');
    expect(normalizeSupplierName('   ')).toBe('');
    expect(normalizeSupplierName('\u00a0Acme\u00a0')).toBe('acme');
  });
});

describe('canonicalizeEntityName', () => {
  it('reports whether a legal suffix was removed', () => {
    expect(canonicalizeEntityName('Dell Technologies, Inc.').hadLegalSuffix).toBe(true);
    expect(canonicalizeEntityName('Dell Technologies').hadLegalSuffix).toBe(false);
  });

  it('keeps a readable display form', () => {
    expect(canonicalizeEntityName('  ACME   CO., LTD ').display).toBe('ACME CO LTD');
  });
});

describe('extractDomain', () => {
  it('extracts registrable domains from URLs, hosts and emails', () => {
    expect(extractDomain('https://www.dell.com/en-us/shop')).toBe('dell.com');
    expect(extractDomain('http://grainger.com')).toBe('grainger.com');
    expect(extractDomain('orders@acme.co.uk')).toBe('acme.co.uk');
    expect(extractDomain('www.microsoft.com')).toBe('microsoft.com');
    expect(extractDomain('siemens-healthineers.com:443')).toBe('siemens-healthineers.com');
    expect(extractDomain('sub.domain.example.co.jp/path')).toBe('example.co.jp');
  });

  it('rejects values that are not domains', () => {
    expect(extractDomain('')).toBeNull();
    expect(extractDomain('not a domain')).toBeNull();
    expect(extractDomain('localhost')).toBeNull();
    expect(extractDomain(null)).toBeNull();
    expect(extractDomain('...')).toBeNull();
  });
});

describe('guessDomainFromName', () => {
  it('derives a conventional .com from the first token', () => {
    expect(guessDomainFromName('Grainger')).toBe('grainger.com');
    expect(guessDomainFromName('Dell Technologies, Inc.')).toBe('dell.com');
  });

  it('declines to guess for very short or non-alphabetic first tokens', () => {
    expect(guessDomainFromName('3M')).toBeNull();
    expect(guessDomainFromName('AB Corp')).toBeNull();
  });
});

describe('toIsoDate', () => {
  it('accepts ISO, US and European formats', () => {
    expect(toIsoDate('2024-03-01')).toBe('2024-03-01');
    expect(toIsoDate('2024-3-9')).toBe('2024-03-09');
    expect(toIsoDate('03/18/2024')).toBe('2024-03-18');
    expect(toIsoDate('18/03/2024')).toBe('2024-03-18');
    expect(toIsoDate('2024-03-01T12:00:00Z')).toBe('2024-03-01');
  });

  it('returns null for missing or unparsable values', () => {
    expect(toIsoDate('')).toBeNull();
    expect(toIsoDate(null)).toBeNull();
    expect(toIsoDate(undefined)).toBeNull();
  });
});

describe('parseAmount', () => {
  it('handles currency symbols, thousands separators and parentheses', () => {
    expect(parseAmount('$1,250.00')).toBe(1250);
    expect(parseAmount('$1,250,000.00')).toBe(1_250_000);
    expect(parseAmount('1.234,56')).toBe(1234.56);
    expect(parseAmount('(500.25)')).toBe(-500.25);
    expect(parseAmount('1250')).toBe(1250);
    expect(parseAmount(1250.5)).toBe(1250.5);
  });

  it('returns null when there is no number', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('n/a')).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });
});

describe('unspsc code helpers', () => {
  it('validates 8-digit codes', () => {
    expect(isUnspscCode('43211500')).toBe(true);
    expect(isUnspscCode('4321150')).toBe(false);
    expect(isUnspscCode(43211500)).toBe(false);
    expect(isUnspscCode('4321150a')).toBe(false);
  });

  it('coerces code-like values', () => {
    expect(coerceUnspscCode('43211500')).toBe('43211500');
    expect(coerceUnspscCode(43211500)).toBe('43211500');
    expect(coerceUnspscCode('43-211-500')).toBe('43211500');
    expect(coerceUnspscCode('4321150')).toBe('04321150');
    expect(coerceUnspscCode('nope')).toBeNull();
  });
});

describe('misc helpers', () => {
  it('rounds, clamps and hashes deterministically', () => {
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-2, 0, 1)).toBe(0);
    expect(fnv1a('abc')).toBe(fnv1a('abc'));
    expect(fnv1a('abc')).not.toBe(fnv1a('abd'));
  });

  it('chunks arrays', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });

  it('title-cases SHOUTY names while keeping acronyms', () => {
    expect(smartTitleCase('DELL TECHNOLOGIES')).toBe('Dell Technologies');
    expect(smartTitleCase('IBM CORPORATION')).toBe('IBM Corporation');
    expect(smartTitleCase('Dell Technologies')).toBe('Dell Technologies');
  });
});
