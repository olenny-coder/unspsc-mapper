import type { MetadataRoute } from 'next';
import { canonicalUrl, isIndexingAllowed } from '@/lib/seo';

/**
 * Sitemap.
 *
 * Empty when indexing is disabled — advertising URLs for pages that return a
 * login redirect (or 401) is worse than having no sitemap, because it invites a
 * crawler to spend budget on pages it cannot read.
 *
 * Only the public landing surface is listed when indexing is on. The operational
 * pages are all behind authentication, so they are deliberately absent.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  if (!isIndexingAllowed()) return [];

  const now = new Date();
  return [
    {
      url: canonicalUrl('/'),
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 1,
    },
    {
      url: canonicalUrl('/login'),
      lastModified: now,
      changeFrequency: 'yearly',
      priority: 0.3,
    },
  ];
}
