import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AppShell } from '@/components/app-shell';
import { ThemeProvider, ThemeScripts } from '@/components/theme-provider';
import { THEME_COLORS } from '@/lib/theme';
import { rootMetadata, softwareApplicationJsonLd, webSiteJsonLd } from '@/lib/seo';

/**
 * Metadata is resolved defensively.
 *
 * `app/layout.tsx` is evaluated while Next collects page data, before any page
 * renders. Anything that throws here aborts the entire build with
 * `Failed to collect page data for /_not-found`, a message that names nothing —
 * so metadata resolution is not allowed to fail a deploy. The runtime
 * configuration is still validated strictly on the first request, where the error
 * is visible and actionable.
 */
function safeMetadata(): Metadata {
  try {
    return rootMetadata();
  } catch (error) {
    console.warn(
      '[layout] Falling back to minimal metadata because root metadata could not be built:',
      error instanceof Error ? error.message : String(error),
    );
    return {
      title: 'UNSPSC Spend Categorizer',
      description: 'Categorise procurement spend into 8-digit UNSPSC commodity codes.',
      robots: { index: false, follow: false },
    };
  }
}

export const metadata: Metadata = safeMetadata();

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
function structuredData(): Array<Record<string, unknown>> {
  try {
    return [softwareApplicationJsonLd(), webSiteJsonLd()];
  } catch {
    // Structured data is a nice-to-have; never let it break rendering.
    return [];
  }
}

const STRUCTURED_DATA = structuredData();

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScripts />
        {STRUCTURED_DATA.length ? (
          <script
            type="application/ld+json"
            // JSON.stringify output is escaped for `<` to make `</script>` injection
            // impossible; the content is generated here, never user input.
            dangerouslySetInnerHTML={{
              __html: JSON.stringify(STRUCTURED_DATA).replace(/</g, '\\u003c'),
            }}
          />
        ) : null}
      </head>
      <body className="min-h-screen bg-background text-foreground">
        <ThemeProvider>
          <AppShell>{children}</AppShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
