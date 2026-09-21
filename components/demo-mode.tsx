'use client';

import * as React from 'react';
import Link from 'next/link';
import { Eye, LockKeyhole } from 'lucide-react';

/**
 * Client-side awareness of demo mode.
 *
 * The server is what actually enforces the demo — `jsonHandler` refuses every
 * mutation before a handler runs — so nothing here is a security boundary. Its job
 * is to stop a visitor from repeatedly pressing buttons that can only fail, and to
 * make it obvious *why* they fail.
 *
 * `/api/auth/session` is the source of truth: it reports `demo: true` only for an
 * anonymous caller on a deployment with `DEMO_MODE=true`. A signed-in caller never
 * sees it, so the same components keep working normally for the owner.
 */
type DemoState = { demo: boolean; resolved: boolean };

const DemoContext = React.createContext<DemoState>({ demo: false, resolved: false });

export function DemoProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<DemoState>({ demo: false, resolved: false });

  React.useEffect(() => {
    let cancelled = false;

    fetch('/api/auth/session', { cache: 'no-store' })
      .then((response) => response.json())
      .then((payload: { data?: { demo?: boolean } }) => {
        if (!cancelled) setState({ demo: payload.data?.demo === true, resolved: true });
      })
      .catch(() => {
        // Treat an unreachable session endpoint as "not a demo": the server still
        // refuses anything a demo visitor should not do.
        if (!cancelled) setState({ demo: false, resolved: true });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const value = React.useMemo(() => state, [state]);
  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}

/** Whether this browser is looking at the read-only demo. */
export function useDemoMode(): DemoState {
  return React.useContext(DemoContext);
}

/**
 * The demo's standing notice.
 *
 * Deliberately not dismissible: a visitor who forgets they are looking at
 * illustrative figures could draw real conclusions from them, and every number on
 * screen is invented.
 */
export function DemoBanner() {
  const { demo } = useDemoMode();
  if (!demo) return null;

  return (
    <div
      role="status"
      className="border-b border-amber-500/40 bg-amber-500/10 text-amber-950 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100"
    >
      <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs sm:px-6">
        <span className="flex items-center gap-1.5 font-semibold">
          <Eye className="h-3.5 w-3.5" aria-hidden />
          Read-only demo
        </span>
        <span className="text-amber-900/90 dark:text-amber-100/90">
          Every supplier, amount and classification shown here is illustrative sample data — not a real spend file.
          Uploading, classifying, syncing and settings changes are disabled.
        </span>
        <Link
          href="/login"
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-amber-600/40 px-2 py-0.5 font-medium underline-offset-2 hover:bg-amber-500/20 hover:underline dark:border-amber-300/40"
        >
          <LockKeyhole className="h-3 w-3" aria-hidden />
          Sign in
        </Link>
      </div>
    </div>
  );
}
