import type { Metadata } from 'next';
import { SITE_NAME, SITE_TAGLINE, pageMetadata } from '@/lib/seo';

/**
 * Metadata for the sign-in page.
 *
 * The application UI itself is client-rendered, so this layout is the correct
 * place for metadata. The description is deliberately generic — it must not
 * reveal supplier names, spend figures or any customer detail, because a login
 * page's tags can surface in link previews.
 */
export const metadata: Metadata = pageMetadata({
  title: 'Sign in',
  description: `${SITE_NAME} — ${SITE_TAGLINE}. Sign in to manage suppliers, review UNSPSC classifications and export spend reports.`,
  path: '/login',
  // Always noindex: this is an authentication page with nothing to rank for.
  noIndex: true,
});

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
