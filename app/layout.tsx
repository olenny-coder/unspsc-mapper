/**
 * Root layout.
 *
 * The two theme scripts are rendered first so the correct theme class is on
 * `<html>` before the body paints — without them a dark-mode user gets a white
 * flash on every cold load. Metadata comes from `lib/seo.ts`, the single source of
 * truth for the public origin, descriptions and crawler policy.
 */
import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AppShell } from '@/components/app-shell';
import { ThemeProvider, ThemeScripts } from '@/components/theme-provider';
import { THEME_COLORS } from '@/lib/theme';
import { rootMetadata, softwareApplicationJsonLd, webSiteJsonLd } from '@/lib/seo';

export const metadata: Metadata = rootMetadata();

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Matches the browser chrome to the active theme on mobile.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: THEME_COLORS.light },
    { media: '(prefers-color-scheme: dark)', color: THEME_COLORS.dark },
  ],
};

/** Entered in <head> so crawlers see it in the initial HTML response. */
const STRUCTURED_DATA = [softwareApplicationJsonLd(), webSiteJsonLd()];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScripts />
        <script
          type="application/ld+json"
          // JSON.stringify output is escaped for `<` to make `</script>` injection
          // impossible; the content is generated here, never user input.
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(STRUCTURED_DATA).replace(/</g, '\\u003c'),
          }}
        />
      </head>
      <body className="min-h-screen bg-background text-foreground">
        <ThemeProvider>
          <AppShell>{children}</AppShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
