/**
 * Server page wrapper.
 *
 * The page body is a client component (it holds filter state and fetches from the
 * API), and a client component cannot export `metadata`. This wrapper provides
 * the title, description, canonical URL, Open Graph tags and robots policy; the
 * implementation lives in `app/_components/upload-client.tsx`.
 */
import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import UploadPage from '@/app/_components/upload-client';

export const metadata: Metadata = pageMetadata({
  title: 'Upload suppliers',
  description: 'Upload a supplier or transaction CSV, deduplicate on normalised supplier name, then enrich, link parent companies and classify into 8-digit UNSPSC codes.',
  path: '/upload',
});

export default UploadPage;