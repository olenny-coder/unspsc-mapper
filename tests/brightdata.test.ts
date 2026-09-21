/**
 * Bright Data provider tests.
 *
 * The field mapping is the part of this integration that cannot be verified by
 * reading Bright Data's docs, because every dataset defines its own record shape.
 * These tests pin the behaviour that matters regardless of which dataset is chosen:
 *
 *   - a value that cannot be found yields `null`, never a guess. A wrong `industry`
 *     silently misleads classification; a missing one is visible on screen;
 *   - a record that *is* an error is reported as a failure rather than being
 *     normalised into a company whose every field happens to be null;
 *   - an empty result set from the API is "not found", not "enriched with nothing";
 *   - the input URL is the dataset's business, so a template can override it.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('@/db/client', () => ({
  getDb: () => {
    throw new Error('bright data tests must not touch the database');
  },
  closeDb: async () => undefined,
}));

// `vi.mock` is hoisted above the imports, so the spy has to be created in a hoisted
// scope too — a plain `const` here would still be uninitialised when the factory runs.
const { fetchWithTimeout } = vi.hoisted(() => ({ fetchWithTimeout: vi.fn() }));

vi.mock('@/lib/retry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/retry')>();
  return { ...actual, fetchWithTimeout };
});

import { brightDataInputUrl, callBrightData, normalizeBrightDataPayload } from '@/services/enrichment';

/** Minimal stand-in for the subset of `Response` the provider reads. */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

const OPTIONS = { apiKey: 'test-key', datasetId: 'gd_testdataset' };

beforeEach(() => {
  fetchWithTimeout.mockReset();
});

describe('brightDataInputUrl', () => {
  it('sends the company site by default', () => {
    expect(brightDataInputUrl({ name: 'Dell Technologies', domain: 'dell.com' })).toBe('https://dell.com');
  });

  it('normalises a domain that already carries a scheme or a trailing slash', () => {
    expect(brightDataInputUrl({ name: 'Dell', domain: 'https://dell.com/' })).toBe('https://dell.com');
    expect(brightDataInputUrl({ name: 'Dell', domain: 'http://dell.com' })).toBe('https://dell.com');
  });

  it('returns null when there is no domain, since the dataset is URL-keyed', () => {
    expect(brightDataInputUrl({ name: 'Dell Technologies', domain: null })).toBeNull();
    expect(brightDataInputUrl({ name: 'Dell Technologies', domain: '' })).toBeNull();
  });

  it('honours a template, because a dataset may key on a different site', () => {
    // The common case: a LinkedIn company dataset rejects the company's own domain
    // and needs the profile path, which is the registrable name without its TLD.
    expect(
      brightDataInputUrl({ name: 'Dell', domain: 'dell.com' }, 'https://www.linkedin.com/company/{slug}'),
    ).toBe('https://www.linkedin.com/company/dell');
  });

  it('keeps {domain} as the full host, distinct from {slug}', () => {
    expect(brightDataInputUrl({ name: 'Dell', domain: 'www.dell.com' }, 'https://x.test/{domain}/{slug}')).toBe(
      'https://x.test/dell.com/dell',
    );
  });

  it('derives a slug from a multi-part suffix', () => {
    expect(brightDataInputUrl({ name: 'Dell', domain: 'dell.co.uk' }, 'https://x.test/{slug}')).toBe(
      'https://x.test/dell',
    );
  });

  it('substitutes the company name too', () => {
    expect(
      brightDataInputUrl({ name: 'Dell Technologies', domain: null }, 'https://example.com/search?q={name}'),
    ).toBe('https://example.com/search?q=Dell Technologies');
  });

  it('treats a blank template as unset', () => {
    expect(brightDataInputUrl({ name: 'Dell', domain: 'dell.com' }, '   ')).toBe('https://dell.com');
  });
});

describe('normalizeBrightDataPayload', () => {
  it('maps a flat LinkedIn-style company record', () => {
    const result = normalizeBrightDataPayload({
      name: 'Dell Technologies',
      website: 'https://www.dell.com',
      industry: 'IT Services and IT Consulting',
      company_size: '10,001+ employees',
      country: 'United States',
      description: 'Dell Technologies designs and manufactures computer hardware.',
    });

    expect(result.domain).toBe('dell.com');
    expect(result.industry).toBe('IT Services and IT Consulting');
    expect(result.country).toBe('United States');
    expect(result.description).toContain('computer hardware');
  });

  it('maps a nested Crunchbase-style record and its parent object', () => {
    const result = normalizeBrightDataPayload({
      data: {
        company_website: 'emc.com',
        sector: 'Data Storage',
        short_description: 'Enterprise storage systems.',
        location: { country: 'United States' },
        parent: { name: 'Dell Technologies', domain: 'dell.com' },
      },
    });

    expect(result.domain).toBe('emc.com');
    expect(result.industry).toBe('Data Storage');
    expect(result.country).toBe('United States');
    expect(result.parentName).toBe('Dell Technologies');
    expect(result.parentDomain).toBe('dell.com');
  });

  it('joins a list-valued industry rather than dropping it', () => {
    const result = normalizeBrightDataPayload({ industries: ['Software', 'IT Services'] });
    expect(result.industry).toBe('Software, IT Services');
  });

  it('reads a dot-path field, as the docs use for nested output columns', () => {
    const result = normalizeBrightDataPayload({ about: { description: 'Nested description.' } });
    expect(result.description).toBe('Nested description.');
  });

  it('treats a string parent as a name', () => {
    expect(normalizeBrightDataPayload({ parent_company: 'Siemens AG' }).parentName).toBe('Siemens AG');
  });

  it('keeps only digits in NAICS and SIC, the way the rest of the app stores them', () => {
    const result = normalizeBrightDataPayload({ naics: 'NAICS 334111', sic: 'SIC 3571' });
    expect(result.naics).toBe('334111');
    expect(result.sic).toBe('3571');
  });

  it('returns nulls rather than guesses for a record it does not recognise', () => {
    // The important property: an unfamiliar dataset must not produce plausible-looking
    // nonsense. Every field is null, so the gap is visible instead of silently wrong.
    const result = normalizeBrightDataPayload({ some_unmapped_column: 'value', another: 42 });

    expect(result).toMatchObject({
      domain: null,
      industry: null,
      naics: null,
      sic: null,
      description: null,
      country: null,
      parentName: null,
      parentDomain: null,
    });
  });

  it('keeps the raw record for traceability and later remapping', () => {
    const raw = { industry: 'Software', unknown_column: 'kept' };
    expect(normalizeBrightDataPayload(raw).raw).toEqual(raw);
  });

  it('survives a non-object payload without throwing', () => {
    expect(normalizeBrightDataPayload(null).industry).toBeNull();
    expect(normalizeBrightDataPayload('nonsense').industry).toBeNull();
    expect(normalizeBrightDataPayload([1, 2, 3]).industry).toBeNull();
  });
});

/**
 * The documented LinkedIn Companies response, copied verbatim from Bright Data's
 * docs. It is the one record shape that can be checked against a real example rather
 * than imagined, and it caught two bugs that would have corrupted data silently.
 */
describe('normalizeBrightDataPayload against the documented LinkedIn company record', () => {
  const LINKEDIN_COMPANY = {
    name: 'Microsoft',
    followers: 29034884,
    employees_in_linkedin: 232354,
    about:
      "Every company has a mission. What's ours? To empower every person and every organization on Earth to achieve more.",
    industries: 'Software Development',
    company_size: '10,001+ employees',
    headquarters: 'Redmond, Washington',
    website: 'https://news.microsoft.com/',
    id: 'microsoft',
    country_code: 'US,AU,CA,FR,DE,JP,GB,DK,BE,FI,IT,KR,NL,NO,ES,SE,CH,BR,CN,IN,MX,RU,ZA,TR,AT,HK,IE,IL,NZ',
    url: 'https://www.linkedin.com/company/microsoft',
  };

  it('maps the fields the app uses', () => {
    const result = normalizeBrightDataPayload(LINKEDIN_COMPANY);

    // The record's `website` is `https://news.microsoft.com/`; subdomains reduce to
    // the registrable domain, which is what the rest of the app matches on.
    expect(result.domain).toBe('microsoft.com');
    expect(result.industry).toBe('Software Development');
    expect(result.description).toContain('empower every person');
    expect(result.country).toBe('US');
  });

  it('never stores the scraped directory as the company domain', () => {
    // Without the directory guard this record yields `linkedin.com`, because `url` is
    // the LinkedIn profile rather than the company's site. That would overwrite a real
    // supplier domain, and every later classification would reason about LinkedIn.
    const linkedinOnly = { ...LINKEDIN_COMPANY, website: undefined };

    const result = normalizeBrightDataPayload(linkedinOnly);

    expect(result.domain).not.toBe('linkedin.com');
    expect(result.domain).toBeNull();
  });

  it('reduces the multi-country list to the primary country', () => {
    // The raw value lists every country Microsoft operates in. Writing it verbatim
    // would put forty codes in a country column.
    const result = normalizeBrightDataPayload(LINKEDIN_COMPANY);
    expect(result.country).toBe('US');
    expect(result.country).not.toContain(',');
  });

  it('does not mistake a city, state, country string for a country', () => {
    // Only an all-ISO-code list is collapsed. A place name must not become "Redmond".
    const result = normalizeBrightDataPayload({ country: 'Redmond, Washington, United States' });
    expect(result.country).toBeNull();
  });

  it('passes a plain country name through untouched', () => {
    expect(normalizeBrightDataPayload({ country: 'United States' }).country).toBe('United States');
  });

  it('blocks every known directory host, not just LinkedIn', () => {
    for (const host of ['crunchbase.com', 'owler.com', 'www.zoominfo.com', 'glassdoor.com']) {
      expect(normalizeBrightDataPayload({ url: `https://${host}/company/acme` }).domain).toBeNull();
    }
  });

  it('still accepts a normal company site that merely contains a blocked word', () => {
    // Guard against an over-eager blocklist: `notlinkedin.com` is not LinkedIn.
    expect(normalizeBrightDataPayload({ website: 'https://notlinkedin.com' }).domain).toBe('notlinkedin.com');
  });
});

describe('callBrightData', () => {
  it('sends a single input with the dataset id, json format and the API key', async () => {
    fetchWithTimeout.mockResolvedValueOnce(jsonResponse([{ industry: 'Software' }]));

    await callBrightData({ name: 'Acme', domain: 'acme.com' }, OPTIONS);

    const [calledUrl, init] = fetchWithTimeout.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain('/datasets/v3/scrape');
    expect(calledUrl).toContain('dataset_id=gd_testdataset');
    // `format=json` matters: the endpoint defaults to ndjson.
    expect(calledUrl).toContain('format=json');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    expect(JSON.parse(String(init.body))).toEqual([{ url: 'https://acme.com', supplier_name: 'Acme' }]);
  });

  it('returns the first record and charges one credit', async () => {
    fetchWithTimeout.mockResolvedValueOnce(jsonResponse([{ industry: 'Software', name: 'Acme' }]));

    const result = await callBrightData({ name: 'Acme', domain: 'acme.com' }, OPTIONS);

    expect(result).toMatchObject({ ok: true, status: 200, creditsUsed: 1 });
    expect(result.data).toMatchObject({ industry: 'Software' });
  });

  it('reports an empty array as not found rather than as a successful empty enrichment', async () => {
    // The API documents an empty array as "these inputs produced no records".
    fetchWithTimeout.mockResolvedValueOnce(jsonResponse([]));

    const result = await callBrightData({ name: 'Acme', domain: 'acme.com' }, OPTIONS);

    expect(result).toMatchObject({ ok: false, status: 404, error: 'not_found', creditsUsed: 0 });
  });

  it('treats a record carrying an error as a failure, not as a company with no fields', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      jsonResponse([{ error: 'Dead page', error_code: 'dead_page' }]),
    );

    const result = await callBrightData({ name: 'Acme', domain: 'acme.com' }, OPTIONS);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('dead_page');
    expect(result.creditsUsed).toBe(0);
  });

  it('surfaces a 400 with Bright Data\'s own explanation, since it names the bad field', async () => {
    fetchWithTimeout.mockResolvedValueOnce(
      textResponse('{"error":"Invalid input provided","code":"validation_error","errors":[["url","invalid"]]}', 400),
    );

    const result = await callBrightData({ name: 'Acme', domain: 'acme.com' }, OPTIONS);

    expect(result.status).toBe(400);
    expect(result.error).toContain('invalid_input');
    expect(result.error).toContain('validation_error');
  });

  it('maps 401 to unauthorized so the caller reports a key problem, not a data problem', async () => {
    fetchWithTimeout.mockResolvedValueOnce(textResponse('Unauthorized', 401));

    const result = await callBrightData({ name: 'Acme', domain: 'acme.com' }, OPTIONS);

    expect(result).toMatchObject({ ok: false, status: 401, error: 'unauthorized' });
  });

  it('does not call the API at all when the supplier has no domain', async () => {
    const result = await callBrightData({ name: 'Acme', domain: null }, OPTIONS);

    expect(result).toMatchObject({ ok: false, status: 422, error: 'no_domain' });
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('follows the documented 202 path through progress and snapshot', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(jsonResponse({ snapshot_id: 'sd_abc', message: 'in progress' }, 202, { 'retry-after': '2' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'ready' }))
      .mockResolvedValueOnce(jsonResponse([{ industry: 'Software' }]));

    // retry-after is 2s; fake timers keep the suite fast without changing behaviour.
    vi.useFakeTimers();
    try {
      const pending = callBrightData({ name: 'Acme', domain: 'acme.com' }, { ...OPTIONS, timeoutMs: 90_000 });
      await vi.advanceTimersByTimeAsync(3_000);
      const result = await pending;

      expect(result).toMatchObject({ ok: true, status: 200, creditsUsed: 1 });
      expect(fetchWithTimeout.mock.calls[1]?.[0]).toContain('/datasets/v3/progress/sd_abc');
      expect(fetchWithTimeout.mock.calls[2]?.[0]).toContain('/datasets/v3/snapshot/sd_abc');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a 202 without a snapshot id rather than hanging', async () => {
    fetchWithTimeout.mockResolvedValueOnce(jsonResponse({ message: 'in progress' }, 202, { 'retry-after': '2' }));

    const result = await callBrightData({ name: 'Acme', domain: 'acme.com' }, OPTIONS);

    expect(result).toMatchObject({ ok: false, status: 202, error: 'snapshot_id_missing' });
  });
});
