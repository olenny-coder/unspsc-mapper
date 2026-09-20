/**
 * Server page wrapper.
 *
 * The page body is a client component (it holds filter state and fetches from the
 * API), and a client component cannot export `metadata`. This wrapper provides
 * the title, description, canonical URL, Open Graph tags and robots policy; the
 * implementation lives in `app/_components/review-client.tsx`.
 */
import type { Metadata } from 'next';
import { pageMetadata } from '@/lib/seo';
import ReviewPage from '@/app/_components/review-client';

export const metadata: Metadata = pageMetadata({
  title: 'Classification review queue',
  description: 'Suppliers whose UNSPSC classification confidence is below the threshold, plus uncertain parent mappings. Correct a code and propagate it to every subsidiary; corrections become few-shot examples for future classifications.',
  path: '/review',
});

export default ReviewPage;