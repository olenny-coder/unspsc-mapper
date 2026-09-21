'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LogIn, LogOut, Menu, X } from 'lucide-react';
import { NavLinks } from '@/components/nav-links';
import { ThemeToggle } from '@/components/theme-toggle';
import { LogoMark } from '@/components/logo-mark';
import { Button } from '@/components/ui/button';
import { DemoBanner, DemoProvider, useDemoMode } from '@/components/demo-mode';
import { cn } from '@/lib/utils';

/**
 * Application chrome.
 *
 * Responsive strategy:
 *   - < lg  : a compact bar with the brand, an icon-only theme toggle and a
 *             hamburger that opens a full-width link list. Seven navigation items
 *             plus the theme toggle cannot fit a 360px viewport, so they are
 *             never wrapped — they collapse.
 *   - >= lg : brand on the left, links and controls inline on the right.
 *
 * The login page renders none of this.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (pathname === '/login') {
    return <main className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6">{children}</main>;
  }

  return (
    <DemoProvider>
      <ShellChrome>{children}</ShellChrome>
    </DemoProvider>
  );
}

/**
 * The header, navigation and footer.
 *
 * Split out of `AppShell` so it can read the demo state that `AppShell` provides. A
 * demo visitor has no session to end, so the header offers them a way *in* instead
 * of a sign-out control that could only mislead.
 */
function ShellChrome({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const { demo } = useDemoMode();

  // Close the mobile menu whenever the route changes.
  React.useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // Prevent the page behind the mobile menu from scrolling.
  React.useEffect(() => {
    if (!menuOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [menuOpen]);

  const signOut = async () => {
    try {
      await fetch('/api/auth/login', { method: 'DELETE' });
    } finally {
      router.replace('/login');
      router.refresh();
    }
  };

  return (
    <>
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex w-full max-w-[1600px] items-center gap-3 px-4 py-3 sm:px-6">
          <Link href="/" className="flex min-w-0 items-center gap-2.5" aria-label="UNSPSC Spend Categorizer — dashboard">
            <LogoMark className="h-8 w-8 shrink-0 rounded-lg shadow-sm" />
            <span className="min-w-0 text-sm font-semibold leading-tight">
              <span className="block truncate">UNSPSC Spend Categorizer</span>
              <span className="hidden text-xs font-normal text-muted-foreground sm:block">
                Enrichment + LLM classification + parent roll-up
              </span>
            </span>
          </Link>

          {/* Desktop: inline navigation. */}
          <div className="ml-auto hidden items-center gap-1 lg:flex">
            <NavLinks />
            <ThemeToggle />
            {demo ? (
              <Button variant="outline" size="sm" asChild>
                <Link href="/login">
                  <LogIn className="h-4 w-4" />
                  Sign in
                </Link>
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void signOut()}
                aria-label="Sign out"
                title="Sign out"
              >
                <LogOut className="h-[1.15rem] w-[1.15rem]" />
              </Button>
            )}
          </div>

          {/* Mobile: theme toggle stays reachable, navigation collapses. */}
          <div className="ml-auto flex items-center gap-1 lg:hidden">
            <ThemeToggle />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              aria-controls="mobile-nav"
              aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
            >
              {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </Button>
          </div>
        </div>

        {/* Mobile navigation panel. */}
        <div
          id="mobile-nav"
          hidden={!menuOpen}
          className="border-t bg-background lg:hidden"
        >
          <nav className="mx-auto w-full max-w-[1600px] px-2 py-2" aria-label="Main">
            <NavLinks orientation="vertical" onNavigate={() => setMenuOpen(false)} />
            <div className="mt-1 border-t pt-1">
              {demo ? (
                <Link
                  href="/login"
                  onClick={() => setMenuOpen(false)}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <LogIn className="h-4 w-4" />
                  Sign in
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={() => void signOut()}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <LogOut className="h-4 w-4" />
                  Sign out
                </button>
              )}
            </div>
          </nav>
        </div>

        <DemoBanner />
      </header>

      <main className="mx-auto w-full max-w-[1600px] px-4 py-4 sm:px-6 sm:py-6">{children}</main>

      <footer className="mx-auto w-full max-w-[1600px] px-4 pb-10 pt-4 text-xs text-muted-foreground sm:px-6">
        <p className={cn('max-w-3xl')}>
          Built for free tiers: Neon Postgres, Render background worker, Vercel Hobby and Groq. Classification runs
          parent-first, and every enrichment, classification and correction is written to the audit log.
        </p>
      </footer>
    </>
  );
}
