/**
 * Server page wrapper.
 *
 * The page body is a client component (it holds filter state and fetches from the
 * API), and a client component cannot export `metadata`. This wrapper provides
 * the title, description, canonical URL, Open Graph tags and robots policy; the
 * implementation lives in `app/_components/dashboard-client.tsx`.
 */
import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import DashboardPage from '@/app/_components/dashboard-client';

export const metadata: Metadata = pageMetadata({
  title: 'Dashboard',
  description: 'Supplier portfolio at a glance: spend by UNSPSC segment, top parent companies by rolled-up spend, classification confidence, and stale-supplier status. Export the current view as CSV or PDF.',
  path: '/',
});

export default DashboardPage;