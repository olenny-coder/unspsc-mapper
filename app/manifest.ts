import type { MetadataRoute } from 'next';
import { SITE_DESCRIPTION, SITE_NAME } from '@/lib/seo';

/**
 * PWA web app manifest.
 *
 * Installing the dashboard makes sense for the reviewers and analysts who live in
 * it daily, so it is offered as a standalone app. `theme_color` matches the
 * header so the mobile browser chrome blends in.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME,
    short_name: 'UNSPSC Spend',
    description: SITE_DESCRIPTION,
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#ffffff',
    theme_color: '#2563eb',
    categories: ['business', 'productivity', 'finance'],
    lang: 'en',
    dir: 'ltr',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/icon-maskable.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
    ],
  };
}
