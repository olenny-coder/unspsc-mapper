/**
 * Server page wrapper.
 *
 * The page body is a client component (it holds filter state and fetches from the
 * API), and a client component cannot export `metadata`. This wrapper provides
 * the title, description, canonical URL, Open Graph tags and robots policy; the
 * implementation lives in `app/_components/hierarchy-client.tsx`.
 */
import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import HierarchyPage from '@/app/_components/hierarchy-client';

export const metadata: Metadata = pageMetadata({
  title: 'Parent / subsidiary hierarchy',
  description: 'Corporate families with their subsidiaries, rolled-up spend and inherited UNSPSC codes. Link or unlink subsidiaries manually, with automatic cycle rejection.',
  path: '/hierarchy',
});

export default HierarchyPage;