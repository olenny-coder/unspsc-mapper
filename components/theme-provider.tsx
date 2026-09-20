'use client';

import * as React from 'react';
import {
  THEME_COLORS,
  THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY,
  THEME_TRANSITION_GUARD_SCRIPT,
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from '@/lib/theme';

type ThemeContextValue = {
  /** What the user chose: light, dark, or follow the OS. */
  preference: ThemePreference;
  /** What is actually applied right now. */
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  /** Cycle light -> dark -> system, for a single-button toggle. */
  cycle: () => void;
};

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

const DARK_QUERY = '(prefers-color-scheme: dark)';

function readStoredPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // Private mode / storage disabled: fall back to following the OS.
  }
  return 'system';
}

/**
 * Apply a resolved theme to <html>.
 *
 * Kept identical to what the boot script does so a client-side change and a cold
 * load produce the same DOM state.
 */
function applyResolvedTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  if (resolved === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
  root.style.colorScheme = resolved;
  root.setAttribute('data-theme', resolved);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[resolved]);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // The boot script already applied the right theme; this state only drives the
  // toggle UI, so it starts from the same source of truth.
  const [preference, setPreferenceState] = React.useState<ThemePreference>('system');
  const [resolved, setResolved] = React.useState<ResolvedTheme>('light');

  // Sync from storage/system after mount (the server cannot know either value,
  // so this deliberately happens in an effect to keep the markup identical).
  React.useEffect(() => {
    const stored = readStoredPreference();
    const prefersDark = window.matchMedia(DARK_QUERY).matches;
    setPreferenceState(stored);
    setResolved(resolveTheme(stored, prefersDark));
  }, []);

  // Follow the OS while the preference is "system".
  React.useEffect(() => {
    const media = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      if (readStoredPreference() !== 'system') return;
      const next = resolveTheme('system', event.matches);
      setResolved(next);
      applyResolvedTheme(next);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const setPreference = React.useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage unavailable: the choice still applies for this session.
    }
    const prefersDark = window.matchMedia(DARK_QUERY).matches;
    const nextResolved = resolveTheme(next, prefersDark);
    setResolved(nextResolved);
    applyResolvedTheme(nextResolved);
  }, []);

  const cycle = React.useCallback(() => {
    const order: ThemePreference[] = ['light', 'dark', 'system'];
    const currentIndex = order.indexOf(preference);
    const next = order[(currentIndex + 1) % order.length] ?? 'system';
    setPreference(next);
  }, [preference, setPreference]);

  const value = React.useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference, cycle }),
    [preference, resolved, setPreference, cycle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = React.useContext(ThemeContext);
  if (!context) {
    // A missing provider should degrade to "system", not crash a page.
    return {
      preference: 'system',
      resolved: 'light',
      setPreference: () => undefined,
      cycle: () => undefined,
    };
  }
  return context;
}

/**
 * Injects the two <script> tags that must run before paint.
 *
 * Rendered from a client component is fine: React hoists these into <head> for
 * the initial document, and they are only ever evaluated once.
 */
export function ThemeScripts() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      <script dangerouslySetInnerHTML={{ __html: THEME_TRANSITION_GUARD_SCRIPT }} />
    </>
  );
}

export { THEME_STORAGE_KEY };
export type { ResolvedTheme, ThemePreference };
