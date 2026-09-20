/**
 * CSV helpers shared by the upload route and the seed scripts.
 *
 * Kept free of Next.js and database imports so they can be unit-tested directly.
 */
import Papa from 'papaparse';

/**
 * Guess the delimiter from the header line. Vendors export "CSV" with commas,
 * semicolons (European Excel), tabs or pipes; guessing beats asking.
 */
export function detectDelimiter(sample: string): string {
  const firstLine = sample.split(/\r?\n/)[0] ?? '';
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = -1;
  for (const candidate of candidates) {
    const count = firstLine.split(candidate).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}

export type ParsedCsvResult = {
  records: Array<Record<string, unknown>>;
  headers: string[];
  errors: Array<{ row: number; message: string }>;
  detectedDelimiter: string;
};

/**
 * Parse supplier/transaction CSV text into records with a normalised header row,
 * dropping rows where every value is empty.
 */
export function parseSupplierCsv(text: string, options: { comment?: string } = {}): ParsedCsvResult {
  const clean = text.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(clean);

  const parsed = Papa.parse<Record<string, unknown>>(clean, {
    header: true,
    skipEmptyLines: 'greedy',
    dynamicTyping: false,
    comments: options.comment,
    transformHeader: (header) => header.replace(/^\uFEFF/, '').trim(),
    delimiter,
  });

  const errors = parsed.errors
    .slice(0, 25)
    .map((error) => ({ row: (error.row ?? 0) + 1, message: error.message }));

  const records = (parsed.data ?? []).filter((record) => {
    if (!record || typeof record !== 'object') return false;
    return Object.values(record).some((value) => String(value ?? '').trim().length > 0);
  });

  return {
    records,
    headers: parsed.meta.fields ?? [],
    errors,
    detectedDelimiter: delimiter,
  };
}

/** Render records back to CSV (used by the upload template endpoint). */
export function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (columns?.length) {
    return Papa.unparse({ fields: columns, data: rows.map((row) => columns.map((column) => row[column] ?? '')) });
  }
  return Papa.unparse(rows);
}
