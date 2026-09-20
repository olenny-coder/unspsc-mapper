/**
 * Site metadata and SEO.
 *
 * A single source of truth for the public origin, descriptions, keywords and
 * structured data, so the layout, manifest, sitemap, robots policy and Open Graph
 * tags cannot drift apart.
 *
 * ## Indexing policy
 *
 * `ALLOW_INDEXING` defaults to **false**. This application authenticates its users
 * and renders a supplier portfolio, spend totals and parent/subsidiary
 * relationships; allowing that to be indexed would leak commercially sensitive
 * data through search results and cached snippets. The default is `noindex`, and
 * a public demo must opt in explicitly.
 *
 * Even when indexing is off, Open Graph and Twitter tags are still emitted: they
 * control how the link renders when *you* paste it into Slack, Teams or an email,
 * which is unrelated to crawler policy.
 */
import type { Metadata } from 'next';
import { getEnv } from '@/lib/env';

export const SITE_NAME = 'UNSPSC Spend Categorizer';

export const SITE_TAGLINE = 'AI spend classification with parent/subsidiary roll-up';

export const SITE_DESCRIPTION =
  'Categorise procurement spend into 8-digit UNSPSC commodity codes automatically. ' +
  'Hybrid supplier enrichment plus LLM classification, parent/subsidiary mapping with code ' +
  'inheritance, human review queue, live supplier sync, and CSV/PDF reporting — deployable on ' +
  'Neon, Render and Vercel free tiers.';

export const SITE_KEYWORDS = [
  'UNSPSC',
  'UNSPSC classification',
  'spend categorization',
  'spend analysis',
  'procurement analytics',
  'supplier classification',
  'commodity code classification',
  'parent subsidiary mapping',
  'corporate family resolution',
  'procurement taxonomy',
  'direct spend',
  'tail spend',
  'LLM classification',
  'Llama 3.3',
  'Groq',
  'supplier enrichment',
  'NAICS',
  'SIC',
  'Next.js',
  'Drizzle ORM',
  'Neon Postgres',
  'spend cube alternative',
  'CSV export',
  'PDF report',
] as const;

/**
 * Resolve a string to an absolute origin, or null when it cannot be one.
 *
 * Never throws. `metadataBase: new URL(...)` in the root metadata is evaluated
 * while Next collects page data, so a single malformed value here aborts the
 * whole build with `Failed to collect page data for /_not-found` and a bare
 * `TypeError: Invalid URL` that names nothing.
 */
export function toAbsoluteOrigin(value: string | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  if (/\s/.test(raw)) return null;

  /*
   * Strip an optional scheme, then inspect the host on its own.
   *
   * Doing this in one step (rather than testing the full string with a regex)
   * avoids a trap: `http://localhost:4321` does not match a "bare host" pattern
   * because of the scheme, so a localhost origin was being rejected and silently
   * replaced by the localhost *default* — which looked like the variable was
   * being ignored.
   */
  const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const hostPart = withoutScheme.split('/')[0] ?? '';
  if (!hostPart) return null;

  // Bare schemes and placeholders that get copied out of dashboards.
  const lowered = hostPart.toLowerCase();
  if (['undefined', 'null', 'none', 'false', '""', "''", ':', 'http', 'https'].includes(lowered)) return null;

  // A localhost/loopback origin has no dot but is legitimate.
  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i.test(hostPart);
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const candidate = hasScheme ? raw : `${isLocal ? 'http' : 'https'}://${raw}`;

  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname) return null;
    // A public origin needs a dot (or a bracketed IPv6 host) — this rejects
    // nonsense like "https://http/" that would otherwise parse.
    const host = parsed.hostname;
    if (!host.includes('.') && !isLocal && !host.startsWith('[')) return null;
    return candidate.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * Public origin for canonical URLs.
 *
 * Resolution order:
 *   1. `SITE_URL`                              — explicit, recommended for custom domains
 *   2. `VERCEL_PROJECT_PRODUCTION_URL`         — supplied automatically by Vercel
 *   3. `APP_ORIGIN`                            — explicit, for other hosts
 *   4. `NEXT_PUBLIC_APP_URL`                   — legacy fallback (statically inlined)
 *   5. `http://localhost:3000`
 *
 * Every candidate goes through `toAbsoluteOrigin`, so a malformed value degrades
 * to the next option instead of crashing the build. A slightly wrong canonical
 * URL is a far better outcome than a failed deploy — and the failure this guards
 * against (`Failed to collect page data for /_not-found`) gives no useful message.
 */
export function siteUrl(): string {
  const env = getEnv();
  return (
    toAbsoluteOrigin(env.SITE_URL) ??
    toAbsoluteOrigin(process.env.VERCEL_PROJECT_PRODUCTION_URL) ??
    toAbsoluteOrigin(env.APP_ORIGIN) ??
    toAbsoluteOrigin(process.env.NEXT_PUBLIC_APP_URL) ??
    'http://localhost:3000'
  );
}

export function isIndexingAllowed(): boolean {
  return getEnv().ALLOW_INDEXING;
}

/** Canonical URL for a path, always absolute. */
export function canonicalUrl(path = '/'): string {
  const base = siteUrl();
  if (path === '/' || path === '') return base;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Social/Google preview card.
 *
 * PNG rather than SVG: most social scrapers will not render an SVG `og:image`
 * (they fetch it and fall back to a blank card). Generated reproducibly by
 * `node scripts/generate-icons.mjs`.
 */
export const OG_IMAGE = {
  path: '/opengraph-image.png',
  width: 1200,
  height: 630,
  alt: 'UNSPSC Spend Categorizer — classify procurement spend into UNSPSC codes and roll it up by parent company',
  type: 'image/png',
} as const;

/** Brand icons. All produced by `node scripts/generate-icons.mjs`. */
export const BRAND_ICONS = {
  /** Vector master, referenced by the header mark and the PWA manifest. */
  svg: '/icon.svg',
  favicon: '/favicon.ico',
  png192: '/icon-192.png',
  png512: '/icon-512.png',
  appleTouch: '/apple-touch-icon.png',
} as const;

/**
 * Root metadata.
 *
 * `metadataBase` makes every relative URL absolute, which is what Open Graph
 * consumers require — relative `og:image` values are silently ignored by most of
 * them.
 */
export function rootMetadata(): Metadata {
  const base = siteUrl();
  const indexable = isIndexingAllowed();

  return {
    metadataBase: new URL(base),
    title: {
      default: `${SITE_NAME} — automatic UNSPSC spend classification`,
      template: `%s · ${SITE_NAME}`,
    },
    description: SITE_DESCRIPTION,
    applicationName: SITE_NAME,
    generator: 'Next.js',
    keywords: [...SITE_KEYWORDS],
    authors: [{ name: 'UNSPSC Spend Categorizer contributors' }],
    creator: 'UNSPSC Spend Categorizer contributors',
    publisher: 'UNSPSC Spend Categorizer contributors',
    category: 'Procurement software',
    alternates: {
      canonical: '/',
    },
    // Crawler policy. See the indexing note at the top of this file.
    robots: indexable
      ? {
          index: true,
          follow: true,
          googleBot: {
            index: true,
            follow: true,
            'max-image-preview': 'large',
            'max-snippet': -1,
            'max-video-preview': -1,
          },
        }
      : {
          index: false,
          follow: false,
          nocache: true,
          googleBot: { index: false, follow: false, noimageindex: true },
        },
    openGraph: {
      type: 'website',
      siteName: SITE_NAME,
      title: `${SITE_NAME} — automatic UNSPSC spend classification`,
      description: SITE_DESCRIPTION,
      url: base,
      locale: 'en_US',
      images: [
        {
          url: OG_IMAGE.path,
          width: OG_IMAGE.width,
          height: OG_IMAGE.height,
          alt: OG_IMAGE.alt,
          type: OG_IMAGE.type,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${SITE_NAME} — automatic UNSPSC spend classification`,
      description:
        'Enrich suppliers, classify them into 8-digit UNSPSC codes with LLMs, map subsidiaries to ' +
        'parents, and export CSV/PDF reports.',
      images: [OG_IMAGE.path],
    },
    icons: {
      /*
       * A complete icon set, declared explicitly rather than relying on Next's
       * file conventions, so every platform gets the right asset:
       *   - `shortcut`/`icon`  browser tabs (ICO for legacy, PNG for modern,
       *                        SVG for anything that supports it)
       *   - `apple`            iOS home screen, opaque and inset
       */
      icon: [
        { url: BRAND_ICONS.favicon, sizes: '16x16 32x32 48x48', type: 'image/x-icon' },
        { url: BRAND_ICONS.png192, sizes: '192x192', type: 'image/png' },
        { url: BRAND_ICONS.png512, sizes: '512x512', type: 'image/png' },
        { url: BRAND_ICONS.svg, type: 'image/svg+xml' },
      ],
      shortcut: [{ url: BRAND_ICONS.favicon, type: 'image/x-icon' }],
      apple: [{ url: BRAND_ICONS.appleTouch, sizes: '180x180', type: 'image/png' }],
    },
    manifest: '/manifest.webmanifest',
    other: {
      'format-detection': 'telephone=no',
    },
  };
}

/** Per-page metadata with a canonical path and Open Graph title. */
export function pageMetadata(options: {
  title: string;
  description: string;
  path: string;
  /** Pages behind auth should never be indexed, regardless of the global flag. */
  noIndex?: boolean;
}): Metadata {
  const indexable = isIndexingAllowed() && options.noIndex !== true;
  return {
    title: options.title,
    description: options.description,
    alternates: { canonical: options.path },
    openGraph: {
      type: 'website',
      title: `${options.title} · ${SITE_NAME}`,
      description: options.description,
      url: canonicalUrl(options.path),
    },
    robots: indexable
      ? { index: true, follow: true }
      : { index: false, follow: false, nocache: true },
  };
}

/**
 * JSON-LD structured data.
 *
 * Schema.org `SoftwareApplication` gives search engines and LLM crawlers an
 * explicit, machine-readable statement of what this is. Deliberately omits
 * `aggregateRating` and `offers`: inventing ratings or a price would be
 * misleading structured data and is penalised.
 */
export function softwareApplicationJsonLd(): Record<string, unknown> {
  const base = siteUrl();
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE_NAME,
    alternateName: 'UNSPSC spend categorizer',
    applicationCategory: 'BusinessApplication',
    applicationSubCategory: 'Procurement analytics',
    operatingSystem: 'Web browser (server: Linux)',
    description: SITE_DESCRIPTION,
    url: base,
    license: 'https://opensource.org/licenses/MIT',
    isAccessibleForFree: true,
    softwareVersion: process.env.npm_package_version ?? '1.0.0',
    featureList: [
      'CSV supplier upload with deduplication on normalised name',
      'Supplier enrichment (domain, industry, NAICS, SIC, description, parent company)',
      'Automatic parent/subsidiary detection and mapping',
      'Parent-first classification into 8-digit UNSPSC commodity codes',
      'Code inheritance from parent to subsidiaries',
      'Confidence scoring with a human review queue',
      'Correction feedback loop into future classifications',
      'Scheduled re-enrichment and stale-supplier detection with an audit log',
      'CSV and PDF reporting with filters and roll-up by parent company',
    ],
    keywords: SITE_KEYWORDS.join(', '),
    inLanguage: 'en',
    programmingLanguage: ['TypeScript'],
    runtimePlatform: ['Node.js', 'Vercel', 'Render'],
    softwareRequirements: 'PostgreSQL (Neon-compatible), Node.js 20+',
    codeRepository: 'https://github.com/olenny-coder/unspsc-mapper',
  };
}

/** `WebSite` node — lets a search engine treat the app as a distinct site. */
export function webSiteJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    alternateName: SITE_TAGLINE,
    url: siteUrl(),
    inLanguage: 'en',
    description: SITE_DESCRIPTION,
  };
}
