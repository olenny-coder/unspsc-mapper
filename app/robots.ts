import type { MetadataRoute } from 'next';
import { canonicalUrl, isIndexingAllowed } from '@/lib/seo';

/**
 * Dynamic robots policy.
 *
 * Two states, decided by `ALLOW_INDEXING`:
 *
 *   - **false (default)** — the whole site is disallowed. This deployment renders
 *     supplier names, spend and corporate structure behind auth; a crawler that
 *     reached an authenticated page (or a cached snippet) would leak commercially
 *     sensitive data. Nothing is exposed.
 *   - **true (public demo)** — crawling is allowed for the landing surface only,
 *     with the API and every data-bearing page still blocked.
 *
 * The `noindex` meta tag emitted by `lib/seo.ts` is the belt to this braces: some
 * crawlers honour the meta tag but not this file, and vice versa.
 */
export default function robots(): MetadataRoute.Robots {
  const indexable = isIndexingAllowed();

  if (!indexable) {
    return {
      rules: [
        {
          userAgent: '*',
          disallow: '/',
        },
      ],
      // No sitemap or host advertised: we are asking to be left alone entirely.
    };
  }

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // The API returns JSON, never useful search results, and the data pages
        // require a session anyway — block them explicitly rather than relying on
        // the login redirect, which some crawlers follow.
        disallow: [
          '/api/',
          '/audit',
          '/reports',
          '/review',
          '/settings',
          '/hierarchy',
          '/upload',
          '/login',
        ],
      },
    ],
    sitemap: canonicalUrl('/sitemap.xml'),
    host: canonicalUrl('/'),
  };
}
