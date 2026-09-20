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
 * Public origin for canonical URLs.
 *
 * Vercel exposes `VERCEL_PROJECT_PRODUCTION_URL` automatically, so a deployment
 * gets correct canonical/OG URLs without extra configuration.
 */
export function siteUrl(): string {
  const env = getEnv();
  const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (env.SITE_URL) return env.SITE_URL.replace(/\/+$/, '');
  if (vercelHost) return `https://${vercelHost.replace(/\/+$/, '')}`;
  return env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '');
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

export const OG_IMAGE = {
  path: '/opengraph-image.svg',
  width: 1200,
  height: 630,
  alt: 'UNSPSC Spend Categorizer — classify procurement spend into UNSPSC codes',
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
      // Only files that actually exist in `public/`. Referencing a missing
      // `favicon.ico` makes every page request 404 on it.
      icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
      shortcut: [{ url: '/icon.svg', type: 'image/svg+xml' }],
      apple: [{ url: '/icon.svg', type: 'image/svg+xml' }],
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
    codeRepository: 'https://github.com/olenny-coder/unspsc-spend-categorizer',
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
