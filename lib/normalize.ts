/**
 * Normalisation helpers shared by the API routes, the worker and the tests.
 *
 * These functions are intentionally pure and dependency-free so they can be
 * unit-tested without a database or network access.
 */

/**
 * Legal-entity suffixes stripped when building the dedupe key.
 *
 * Punctuation inside a suffix is preserved here ("s.a." and "s.a" both appear)
 * because punctuation is normalised to spaces BEFORE matching: a German
 * "GmbH & Co. KG" becomes the token sequence `gmbh and co kg`, so the multi-word
 * forms are matched as contiguous token sequences rather than literal strings.
 */
const LEGAL_SUFFIXES = [
  'limited liability company',
  'limited liability partnership',
  'limited partnership',
  'public limited company',
  'proprietary limited',
  'incorporated',
  'corporation',
  'corporate',
  'company',
  'pty ltd',
  'pty limited',
  'gmbh and co kg',
  'aktiengesellschaft',
  'gmbh',
  'sarl',
  'sas',
  'srl',
  'spa',
  'inc',
  'corp',
  'co',
  'ltd',
  'limited',
  'llc',
  'llp',
  'lp',
  'plc',
  'pvt',
  'pte',
  'pty',
  'ag',
  'nv',
  'bv',
  'sa',
  'se',
  'oy',
  'ab',
  'aps',
  'kk',
  'kg',
  'holdings',
  'holding',
  'group',
  'international',
  'intl',
  'worldwide',
] satisfies readonly string[];

/** Union of the known suffix strings, for type-safe lookups. */
export type LegalSuffix = (typeof LEGAL_SUFFIXES)[number];

/**
 * Build the canonical dedupe key for a supplier name.
 *
 * `"Dell Technologies, Inc."` -> `"dell technologies"`
 * `"ACME  CO., LTD"` -> `"acme"`
 *
 * The transformation is deliberately conservative: only punctuation, legal
 * suffixes and a small set of corporate noise words are removed. Distinct
 * trading names must never collapse into one another.
 */
export function normalizeSupplierName(name: string): string {
  return canonicalizeEntityName(name).key;
}

export type CanonicalEntityName = {
  /** Dedupe key. */
  key: string;
  /** Human display form: cleaned but suffixes preserved. */
  display: string;
  /** True when a legal suffix was stripped. */
  hadLegalSuffix: boolean;
};

/**
 * Split a raw entity name into a display form and a normalised key.
 *
 * Rules
 * -----
 *  1. Normalise punctuation: `&` -> `and`, dashes/quotes -> spaces, collapse
 *     whitespace. `Barnes & Noble` and `Barnes and Noble` must agree.
 *  2. Strip trailing legal suffixes (`Inc`, `Co`, `Ltd`, `GmbH`, `AG`, `LLC`,
 *     `KK`, ...) repeatedly, so `ACME CO., LTD` -> `acme`.
 *  3. Never strip everything: a company literally called "Group" or "Limited"
 *     keeps its name, and a two-token name keeps at least one token.
 *  4. Do NOT remove interior words like "and": doing so would make
 *     "Barnes & Noble" and "Barnes Noble" collide with unrelated names, and the
 *     punctuation pass already handles the common variants.
 */
export function canonicalizeEntityName(raw: string): CanonicalEntityName {
  const cleaned = String(raw ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[’‘`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

  // Unify punctuation: ampersands and slashes become words/spaces.
  let working = cleaned
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s*\+\s*/g, ' and ')
    .replace(/[\/\\|]/g, ' ')
    .replace(/[.,;:!?"'()\[\]{}]/g, ' ')
    .replace(/[–—−]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!working) {
    return { key: '', display: cleaned, hadLegalSuffix: false };
  }

  const tokens = working.split(' ').filter(Boolean);
  let end = tokens.length;
  let hadLegalSuffix = false;

  // Strip trailing legal suffixes. A name of two or more tokens keeps at least
  // one token; a single-token name is never stripped.
  while (end > 1) {
    const last = tokens[end - 1]!;
    const lastTwo = end >= 2 ? `${tokens[end - 2]!} ${last}` : '';
    const lastThree = end >= 3 ? `${tokens[end - 3]!} ${tokens[end - 2]!} ${last}` : '';

    const matched = [lastThree, lastTwo, last]
      .filter(Boolean)
      .map((candidate) => candidate.toLowerCase())
      .find((candidate) => LEGAL_SUFFIXES.includes(candidate));

    if (!matched) break;

    end -= matched.split(' ').length;
    hadLegalSuffix = true;
  }

  const meaningful = tokens.slice(0, end).map((token) => token.toLowerCase());
  const key = (meaningful.length ? meaningful : tokens.map((token) => token.toLowerCase())).join(' ');

  return {
    key: key || working.toLowerCase(),
    display: working,
    hadLegalSuffix,
  };
}

const MULTI_PART_PUBLIC_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'co.jp',
  'or.jp',
  'ne.jp',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'com.br',
  'com.mx',
  'com.cn',
  'com.hk',
  'com.sg',
  'co.in',
  'co.za',
  'com.tr',
  'com.tw',
]);

/**
 * Extract a bare registrable-looking domain from a URL, host or email.
 *
 * `"https://www.dell.com/en-us"` -> `"dell.com"`
 * `"orders@acme.co.uk"` -> `"acme.co.uk"`
 */
export function extractDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let value = String(input).trim().toLowerCase();
  if (!value) return null;

  // Emails: keep the part after '@'.
  const at = value.lastIndexOf('@');
  if (at >= 0) value = value.slice(at + 1);

  // Strip scheme.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');

  // Strip credentials, path, query, fragment, port.
  value = value.split('/')[0]!.split('?')[0]!.split('#')[0]!;
  value = value.split('@').pop() ?? value;
  value = value.split(':')[0]!;

  // Strip trailing dot and www.
  value = value.replace(/\.+$/, '');
  value = value.replace(/^www\d?\./, '');

  // A domain needs at least one dot and plausible labels.
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) return null;
  if (value.startsWith('.') || value.includes('..')) return null;

  const parts = value.split('.');
  if (parts.length > 2) {
    const lastTwo = parts.slice(-2).join('.');
    if (MULTI_PART_PUBLIC_SUFFIXES.has(lastTwo) && parts.length >= 3) {
      return parts.slice(-3).join('.');
    }
    return lastTwo;
  }
  return value;
}

/**
 * Best-effort domain guess from a supplier name ("Dell Technologies" ->
 * "delltechnologies.com" is NOT guessed; we only derive the first token, which
 * is the convention that matches most corporate domains).
 */
export function guessDomainFromName(name: string): string | null {
  const { key } = canonicalizeEntityName(name);
  const tokens = key.split(' ').filter(Boolean);
  const first = tokens[0];
  if (!first || first.length < 3) return null;
  if (!/^[a-z0-9]+$/.test(first)) return null;
  return `${first}.com`;
}

/** Collapse ISO dates / free text to a `YYYY-MM-DD` string, or null. */
export function toIsoDate(input: unknown): string | null {
  if (input === null || input === undefined || input === '') return null;
  if (input instanceof Date && !Number.isNaN(input.getTime())) {
    return input.toISOString().slice(0, 10);
  }
  const raw = String(input).trim();
  if (!raw) return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  if (iso) {
    const [, y, m, d] = iso;
    return `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
  }

  const slash = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(raw);
  if (slash) {
    let [, a, b, y] = slash;
    if (y!.length === 2) y = `20${y}`;
    const month = Number(a);
    const day = Number(b);
    // Ambiguous: assume US M/D/Y when the first number is <= 12, else D/M/Y.
    const [mm, dd] = month <= 12 ? [month, day] : [day, month];
    if (mm! >= 1 && mm! <= 12 && dd! >= 1 && dd! <= 31) {
      return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    }
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

/** Parse a money-ish string ("$1,234.56", "1234,56", "1 234") into a number. */
export function parseAmount(input: unknown): number | null {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  let raw = String(input).trim();
  if (!raw) return null;

  const negative = /^\(.*\)$/.test(raw) || raw.startsWith('-');
  raw = raw.replace(/[()]/g, '').replace(/[^0-9.,-]/g, '');
  if (!raw) return null;

  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  if (lastComma > lastDot) {
    // European style: 1.234,56
    raw = raw.replace(/\./g, '').replace(',', '.');
  } else {
    raw = raw.replace(/,/g, '');
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return negative && value > 0 ? -value : value;
}

/** Round to `dp` decimals without floating point surprises. */
export function roundTo(value: number, dp = 2): number {
  const factor = 10 ** dp;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** Clamp a number into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 8-digit UNSPSC code check. */
export function isUnspscCode(value: unknown): value is string {
  return typeof value === 'string' && /^\d{8}$/.test(value.trim());
}

/** Coerce anything code-like ("43211500", 43211500, "43-211-500") to 8 digits. */
export function coerceUnspscCode(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const digits = String(value).replace(/\D/g, '');
  if (digits.length === 8) return digits;
  // Some sources zero-pad to 8 only after stripping a leading segment label.
  if (digits.length === 7) return `0${digits}`;
  return null;
}

/** Deterministic small hash (FNV-1a 32-bit) used for fingerprints. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Title-case a SHOUTY supplier name, preserving known all-caps acronyms. */
const PRESERVED_ACRONYMS = new Set([
  'IBM',
  'HP',
  'AMD',
  'SAP',
  'NEC',
  'ABB',
  'BMW',
  'UPS',
  'DHL',
  'GE',
  'LG',
  'SK',
  '3M',
  'AT&T',
  'BP',
  'GSK',
  'SAS',
  'ASML',
  'TSMC',
  'NTT',
  'KPMG',
  'PwC',
  'EY',
  'DXC',
]);

export function smartTitleCase(name: string): string {
  const cleaned = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return cleaned;
  // Only touch names that are entirely upper-case (and longer than 4 chars).
  if (cleaned.length <= 4 || cleaned !== cleaned.toUpperCase()) return cleaned;
  return cleaned
    .split(' ')
    .map((token) => {
      const bare = token.replace(/[^A-Za-z0-9&]/g, '');
      if (PRESERVED_ACRONYMS.has(bare)) return token;
      if (bare.length <= 3) return token;
      return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
    })
    .join(' ');
}

/** Stable chunking helper used across batching code. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) throw new RangeError('chunk size must be > 0');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
