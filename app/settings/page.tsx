/**
 * Server page wrapper.
 *
 * The page body is a client component (it holds filter state and fetches from the
 * API), and a client component cannot export `metadata`. This wrapper provides
 * the title, description, canonical URL, Open Graph tags and robots policy; the
 * implementation lives in `app/_components/settings-client.tsx`.
 */
import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import SettingsPage from '@/app/_components/settings-client';

export const metadata: Metadata = pageMetadata({
  title: 'Settings',
  description: 'Confidence threshold, model routing, parent-detection toggle, enrichment provider, sync schedule and free-tier budget. Secrets stay in environment variables.',
  path: '/settings',
});

export default SettingsPage;