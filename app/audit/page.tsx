/**
 * Server page wrapper.
 *
 * The page body is a client component (it holds filter state and fetches from the
 * API), and a client component cannot export `metadata`. This wrapper provides
 * the title, description, canonical URL, Open Graph tags and robots policy; the
 * implementation lives in `app/_components/audit-client.tsx`.
 */
import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import AuditPage from '@/app/_components/audit-client';

export const metadata: Metadata = pageMetadata({
  title: 'Audit log',
  description: 'Every enrichment, classification, correction, parent link, sync run and report generation, with the actor and details needed to reconstruct how any number was derived.',
  path: '/audit',
});

export default AuditPage;