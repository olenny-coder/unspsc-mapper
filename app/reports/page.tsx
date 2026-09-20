/**
 * Server page wrapper.
 *
 * The page body is a client component (it holds filter state and fetches from the
 * API), and a client component cannot export `metadata`. This wrapper provides
 * the title, description, canonical URL, Open Graph tags and robots policy; the
 * implementation lives in `app/_components/reports-client.tsx`.
 */
import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import ReportsPage from '@/app/_components/reports-client';

export const metadata: Metadata = pageMetadata({
  title: 'Reports',
  description: 'Generate and download UNSPSC spend reports as CSV or PDF, with filters and roll-up by parent company, and review the weekly PDFs produced by the scheduled worker.',
  path: '/reports',
});

export default ReportsPage;