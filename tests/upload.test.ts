/**
 * CSV parsing / upload mapping tests, plus the taxonomy seed mapper.
 */
import { describe, expect, it } from 'vitest';
import Papa from 'papaparse';
import { mapCsvRecordToSupplier } from '@/services/suppliers';
import { detectDelimiter } from '@/lib/csv';
import { hierarchyFromCode, mapSeedRecord } from '@/lib/unspsc-seed';

/** Mirror of the route's parser (the route itself needs a Request object). */
function parseLikeUpload(csv: string) {
  const clean = csv.replace(/^\uFEFF/, '');
  return Papa.parse<Record<string, unknown>>(clean, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.replace(/^\uFEFF/, '').trim(),
  });
}

describe('detectDelimiter', () => {
  it('detects comma, semicolon, tab and pipe separated files', () => {
    expect(detectDelimiter('name,amount,date')).toBe(',');
    expect(detectDelimiter('name;amount;date')).toBe(';');
    expect(detectDelimiter('name\tamount\tdate')).toBe('\t');
    expect(detectDelimiter('name|amount|date')).toBe('|');
    expect(detectDelimiter('name')).toBe(',');
  });
});

describe('supplier CSV parsing', () => {
  const csv = [
    'name,amount,date,parent',
    'Dell Technologies,"1,250,000.00",2024-03-01,',
    'EMC Corporation,184500.50,2024-03-04,Dell Technologies',
    '"ACME  CO., LTD",1250,2024-03-24,',
    'Acme Co,8750,2024-03-25,',
  ].join('\n');

  it('parses rows and keeps the parent column', () => {
    const parsed = parseLikeUpload(csv);
    expect(parsed.data).toHaveLength(4);

    const inputs = parsed.data.map((record) => mapCsvRecordToSupplier(record));
    expect(inputs[0]?.name).toBe('Dell Technologies');
    expect(inputs[0]?.amount).toBe(1_250_000);
    expect(inputs[1]?.parentName).toBe('Dell Technologies');
  });

  it('collapses the two ACME spellings to the same normalised key', async () => {
    const { normalizeSupplierName } = await import('@/lib/normalize');
    const parsed = parseLikeUpload(csv);
    const acmeRows = parsed.data.slice(2).map((record) => mapCsvRecordToSupplier(record));
    expect(acmeRows).toHaveLength(2);
    expect(normalizeSupplierName(acmeRows[0]!.name)).toBe(normalizeSupplierName(acmeRows[1]!.name));
  });

  it('skips comment and blank lines', () => {
    const withComments = ['# a comment', '', 'name,amount', 'Grainger,100', ''].join('\n');
    const parsed = Papa.parse<Record<string, unknown>>(withComments, {
      header: true,
      skipEmptyLines: 'greedy',
      comments: '#',
    });
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0]?.name).toBe('Grainger');
  });

  it('handles the bundled sample file shape', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const raw = readFileSync(resolve(process.cwd(), 'samples', 'suppliers.csv'), 'utf8');
    const parsed = Papa.parse<Record<string, unknown>>(raw.replace(/^\uFEFF/, ''), {
      header: true,
      skipEmptyLines: 'greedy',
      comments: '#',
    });
    const mapped = parsed.data.map((record) => mapCsvRecordToSupplier(record)).filter(Boolean);
    expect(mapped.length).toBeGreaterThan(100);

    // The sample must actually contain parent/subsidiary pairs.
    const withParent = mapped.filter((row) => row && row.parentName);
    expect(withParent.length).toBeGreaterThan(10);
    expect(withParent.some((row) => row?.parentName === 'Dell Technologies')).toBe(true);
    expect(withParent.some((row) => row?.parentName === 'Siemens AG')).toBe(true);
  });
});

describe('UNSPSC seed mapping', () => {
  it('splits a commodity code into hierarchy prefixes', () => {
    expect(hierarchyFromCode('43211500')).toEqual({ segmentCode: '43', familyCode: '4321', classCode: '432115' });
  });

  it('maps a well-formed record', () => {
    const mapped = mapSeedRecord(
      {
        code: '43211500',
        segment: 'Information Technology Broadcasting and Telecommunications',
        family: 'Computer accessories and supplies',
        class: 'Computers',
        commodity: 'Computers',
        description: 'A machine that processes data.',
      },
      'v26.0801',
    );
    expect(mapped?.code).toBe('43211500');
    expect(mapped?.segmentCode).toBe('43');
    expect(mapped?.searchText).toContain('computers');
    expect(mapped?.version).toBe('v26.0801');
  });

  it('rejects rows without an 8-digit code or commodity name', () => {
    expect(mapSeedRecord({ commodity: 'Computers' }, 'v26')).toBeNull();
    expect(mapSeedRecord({ code: '4321150', commodity: 'Computers' }, 'v26')).toBeNull();
    expect(mapSeedRecord({ code: '43211500' }, 'v26')).toBeNull();
  });

  it('accepts alternate column names and zero-pads codes', () => {
    const mapped = mapSeedRecord({ commodity_code: '84111506', title_en: 'Accounting', segment: 'Financial' }, 'v26');
    expect(mapped?.code).toBe('84111506');
    expect(mapped?.commodity).toBe('Accounting');
  });
});
