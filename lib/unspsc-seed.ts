/**
 * Pure helpers for seeding `unspsc_codes` from a UNSPSC taxonomy export.
 *
 * Separated from `scripts/seed-unspsc.ts` so they can be unit-tested without a
 * database connection or a process exit on import.
 */

export type UnspscSeedRow = {
  code: string;
  segment: string | null;
  segmentCode: string;
  family: string | null;
  familyCode: string;
  class: string | null;
  classCode: string;
  commodity: string;
  description: string | null;
  version: string;
};

/** Split an 8-digit commodity code into its 2/4/6-digit hierarchy prefixes. */
export function hierarchyFromCode(code: string): {
  segmentCode: string;
  familyCode: string;
  classCode: string;
} {
  const padded = code.padStart(8, '0');
  return {
    segmentCode: padded.slice(0, 2),
    familyCode: padded.slice(0, 4),
    classCode: padded.slice(0, 6),
  };
}

function clean(value: unknown, max = 4000): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

/**
 * Normalise one CSV record from any of the common UNSPSC export shapes
 * (unspsc-fr, UNSPSC.org, O*NET, custom extracts) into a `unspsc_codes` row.
 * Returns null when the record cannot produce a usable code+title.
 */
export function mapSeedRecord(record: Record<string, unknown>, version = 'v26.0801'): UnspscSeedRow | null {
  const rawCode = clean(record.code ?? record.commodity_code ?? record['Commodity Code'] ?? record['UNSPSC Code']);
  if (!rawCode) return null;
  const digits = rawCode.replace(/\D/g, '');
  if (digits.length !== 8) return null;
  const code = digits.padStart(8, '0');

  const commodity = clean(
    record.commodity ?? record.title ?? record['Commodity Title'] ?? record.title_en ?? record['Commodity Name'],
    500,
  );
  if (!commodity) return null;

  const segment = clean(record.segment ?? record['Segment Title'] ?? record.segment_en ?? record['Segment Name'], 500);
  const family = clean(record.family ?? record['Family Title'] ?? record.family_en ?? record['Family Name'], 500);
  const className = clean(record.class ?? record['Class Title'] ?? record.class_en ?? record['Class Name'], 500);
  const description = clean(record.description ?? record.definition ?? record.definition_en, 4000);

  const { segmentCode, familyCode, classCode } = hierarchyFromCode(code);

  return {
    code,
    segment,
    segmentCode,
    family,
    familyCode,
    class: className,
    classCode,
    commodity,
    description,
    version,
  };
}
