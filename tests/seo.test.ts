/**
 * SEO tests.
 *
 * The important property here is the *safe default*: this app renders supplier
 * names, spend and corporate structure, so a regression that opened it up to
 * crawlers would be a data-leak bug rather than a marketing one.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  OG_IMAGE,
  SITE_DESCRIPTION,
  SITE_KEYWORDS,
  SITE_NAME,
  canonicalUrl,
  isIndexingAllowed,
  pageMetadata,
  rootMetadata,
  siteUrl,
  softwareApplicationJsonLd,
  webSiteJsonLd,
} from '@/lib/seo';
import { resetEnvCache } from '@/lib/env';
import robots from '@/app/robots';
import sitemap from '@/app/sitemap';

const mutableEnv = process.env as Record<string, string | undefined>;

const TOUCHED = ['SITE_URL', 'ALLOW_INDEXING', 'NEXT_PUBLIC_APP_URL', 'VERCEL_PROJECT_PRODUCTION_URL'] as const;

beforeEach(() => {
  for (const key of TOUCHED) delete mutableEnv[key];
  resetEnvCache();
});

afterEach(() => {
  for (const key of TOUCHED) delete mutableEnv[key];
  resetEnvCache();
});

function setEnv(values: Partial<Record<(typeof TOUCHED)[number], string>>) {
  for (const [key, value] of Object.entries(values)) mutableEnv[key] = value;
  resetEnvCache();
}

describe('indexing policy', () => {
  it('is disabled by default', () => {
    expect(isIndexingAllowed()).toBe(false);
  });

  it('treats common truthy spellings as opt-in', () => {
    for (const value of ['true', '1', 'yes', 'on']) {
      setEnv({ ALLOW_INDEXING: value });
      expect(isIndexingAllowed(), `ALLOW_INDEXING=${value}`).toBe(true);
    }
  });

  it('stays off for falsy spellings', () => {
    for (const value of ['false', '0', 'no', 'off']) {
      setEnv({ ALLOW_INDEXING: value });
      expect(isIndexingAllowed(), `ALLOW_INDEXING=${value}`).toBe(false);
    }
  });
});

describe('siteUrl', () => {
  it('prefers an explicit SITE_URL and strips trailing slashes', () => {
    setEnv({ SITE_URL: 'https://spend.example.com///' });
    expect(siteUrl()).toBe('https://spend.example.com');
  });

  it('falls back to the Vercel production URL, which needs a scheme added', () => {
    setEnv({ VERCEL_PROJECT_PRODUCTION_URL: 'unspsc.vercel.app' });
    expect(siteUrl()).toBe('https://unspsc.vercel.app');
  });

  it('falls back to NEXT_PUBLIC_APP_URL last', () => {
    setEnv({ NEXT_PUBLIC_APP_URL: 'http://localhost:4321' });
    expect(siteUrl()).toBe('http://localhost:4321');
  });

  /*
   * Regression tests for a real Vercel build failure:
   * "Failed to collect page data for /_not-found" caused by `new URL()` throwing
   * on a scheme-less NEXT_PUBLIC_APP_URL. That surfaced as a bare
   * `TypeError: Invalid URL` with no indication of which variable was at fault.
   */
  it('tolerates a missing scheme instead of crashing the build', () => {
    setEnv({ NEXT_PUBLIC_APP_URL: 'unspsc-mapper.vercel.app' });
    expect(siteUrl()).toBe('http://unspsc-mapper.vercel.app');
  });

  it('tolerates a missing scheme in SITE_URL too', () => {
    setEnv({ SITE_URL: 'spend.example.com' });
    expect(siteUrl()).toBe('http://spend.example.com');
  });

  it('treats a literal "undefined" string as unset', () => {
    // A dashboard that stored the string would otherwise yield http://undefined.
    setEnv({ NEXT_PUBLIC_APP_URL: 'undefined' });
    expect(siteUrl()).toBe('http://localhost:3000');
  });

  it('normalises so callers can append paths safely', () => {
    setEnv({ SITE_URL: 'https://spend.example.com/' });
    expect(canonicalUrl('/review')).toBe('https://spend.example.com/review');
  });
});

describe('canonicalUrl', () => {
  it('builds absolute URLs', () => {
    setEnv({ SITE_URL: 'https://spend.example.com' });
    expect(canonicalUrl('/')).toBe('https://spend.example.com');
    expect(canonicalUrl('/review')).toBe('https://spend.example.com/review');
    expect(canonicalUrl('review')).toBe('https://spend.example.com/review');
  });
});

describe('rootMetadata', () => {
  it('sets metadataBase so Open Graph image URLs resolve absolutely', () => {
    setEnv({ SITE_URL: 'https://spend.example.com' });
    const metadata = rootMetadata();
    expect(metadata.metadataBase?.toString()).toBe('https://spend.example.com/');
  });

  it('blocks indexing when the policy is off', () => {
    const robotsMeta = rootMetadata().robots;
    expect(robotsMeta).toMatchObject({ index: false, follow: false, nocache: true });
  });

  it('allows indexing only when explicitly enabled', () => {
    setEnv({ ALLOW_INDEXING: 'true' });
    expect(rootMetadata().robots).toMatchObject({ index: true, follow: true });
  });

  it('always publishes social preview tags, even when not indexable', () => {
    // Link previews in Slack/Teams/email are unrelated to crawler policy, so
    // these must survive the noindex default.
    const metadata = rootMetadata();
    expect(metadata.openGraph?.images).toBeDefined();
    expect(metadata.twitter).toBeDefined();
    const images = metadata.openGraph?.images as Array<{ url: string }>;
    expect(images[0]?.url).toBe(OG_IMAGE.path);
  });

  it('uses a title template so page titles stay consistent', () => {
    const title = rootMetadata().title as { default: string; template: string };
    expect(title.default).toContain(SITE_NAME);
    expect(title.template).toContain(SITE_NAME);
  });
});

describe('pageMetadata', () => {
  it('forces noindex for an explicitly private page even when indexing is on', () => {
    setEnv({ ALLOW_INDEXING: 'true' });
    expect(pageMetadata({ title: 'x', description: 'y', path: '/login', noIndex: true }).robots).toMatchObject({
      index: false,
    });
  });

  it('inherits the global policy otherwise', () => {
    setEnv({ ALLOW_INDEXING: 'true' });
    expect(pageMetadata({ title: 'x', description: 'y', path: '/reports' }).robots).toMatchObject({ index: true });

    setEnv({ ALLOW_INDEXING: 'false' });
    expect(pageMetadata({ title: 'x', description: 'y', path: '/reports' }).robots).toMatchObject({ index: false });
  });

  it('sets a canonical path and absolute Open Graph URL', () => {
    setEnv({ SITE_URL: 'https://spend.example.com' });
    const metadata = pageMetadata({ title: 'Reports', description: 'd', path: '/reports' });
    expect(metadata.alternates?.canonical).toBe('/reports');
    expect(metadata.openGraph?.url).toBe('https://spend.example.com/reports');
  });
});

describe('robots.txt', () => {
  it('disallows everything when indexing is off', () => {
    const result = robots();
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    expect(rules[0]?.disallow).toBe('/');
    expect(rules[0]?.allow).toBeUndefined();
    // No sitemap advertised: we are asking to be left alone.
    expect(result.sitemap).toBeUndefined();
  });

  it('allows the landing surface but keeps data pages blocked when enabled', () => {
    setEnv({ ALLOW_INDEXING: 'true', SITE_URL: 'https://spend.example.com' });
    const result = robots();
    const rules = Array.isArray(result.rules) ? result.rules : [result.rules];
    const disallow = rules[0]?.disallow;
    const list = Array.isArray(disallow) ? disallow : [disallow];
    for (const path of ['/api/', '/audit', '/reports', '/review', '/settings', '/hierarchy', '/upload', '/login']) {
      expect(list).toContain(path);
    }
    expect(result.sitemap).toBe('https://spend.example.com/sitemap.xml');
  });
});

describe('sitemap', () => {
  it('is empty when indexing is off, so crawl budget is not wasted on redirects', () => {
    expect(sitemap()).toEqual([]);
  });

  it('lists only public pages when enabled', () => {
    setEnv({ ALLOW_INDEXING: 'true', SITE_URL: 'https://spend.example.com' });
    const entries = sitemap();
    const urls = entries.map((entry) => entry.url);
    expect(urls).toContain('https://spend.example.com');
    expect(urls).toContain('https://spend.example.com/login');
    // Operational pages must never be advertised.
    for (const privatePath of ['/audit', '/reports', '/review', '/settings', '/hierarchy', '/upload']) {
      expect(urls.some((url) => url.endsWith(privatePath))).toBe(false);
    }
  });
});

describe('structured data', () => {
  it('describes the application accurately', () => {
    setEnv({ SITE_URL: 'https://spend.example.com' });
    const jsonLd = softwareApplicationJsonLd();
    expect(jsonLd['@type']).toBe('SoftwareApplication');
    expect(jsonLd.name).toBe(SITE_NAME);
    expect(jsonLd.url).toBe('https://spend.example.com');
    expect(jsonLd.inLanguage).toBe('en');
    expect(Array.isArray(jsonLd.featureList)).toBe(true);
    expect((jsonLd.featureList as string[]).length).toBeGreaterThan(5);
  });

  it('does not invent ratings or pricing', () => {
    // Fabricated aggregateRating or offers is misleading structured data and is
    // penalised by search engines.
    const jsonLd = softwareApplicationJsonLd();
    expect(jsonLd).not.toHaveProperty('aggregateRating');
    expect(jsonLd).not.toHaveProperty('offers');
    expect(jsonLd).not.toHaveProperty('review');
  });

  it('emits a WebSite node with an absolute URL', () => {
    setEnv({ SITE_URL: 'https://spend.example.com' });
    const jsonLd = webSiteJsonLd();
    expect(jsonLd['@type']).toBe('WebSite');
    expect(jsonLd.url).toBe('https://spend.example.com');
  });

  it('serialises to valid JSON that cannot break out of a script tag', () => {
    const serialised = JSON.stringify([softwareApplicationJsonLd(), webSiteJsonLd()]);
    expect(() => JSON.parse(serialised)).not.toThrow();
    expect(serialised.replace(/</g, '\\u003c')).not.toMatch(/<\/script/i);
  });
});

describe('copy', () => {
  it('has a description within the length search engines display', () => {
    // Google truncates around 155-160 characters.
    expect(SITE_DESCRIPTION.length).toBeGreaterThan(80);
    expect(SITE_DESCRIPTION.length).toBeLessThanOrEqual(320);
  });

  it('targets the terms a buyer would actually search for', () => {
    const keywords = SITE_KEYWORDS.map((keyword) => keyword.toLowerCase());
    expect(keywords).toContain('unspsc');
    expect(keywords).toContain('spend categorization');
    expect(keywords.some((keyword) => keyword.includes('procurement'))).toBe(true);
  });

  it('does not claim an affiliation with UNDP or GS1', () => {
    // UNSPSC is a registered trademark; the copy must stay descriptive.
    const copy = `${SITE_NAME} ${SITE_DESCRIPTION}`.toLowerCase();
    for (const claim of ['official', 'certified', 'partner', 'endorsed', 'affiliated']) {
      expect(copy).not.toContain(claim);
    }
  });
});
