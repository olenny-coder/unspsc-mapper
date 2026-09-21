'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, Eye, KeyRound, Loader2, Lock, ShieldCheck } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

type SessionState = {
  authenticated: boolean;
  via: string | null;
  authConfigured: boolean;
  authDisabled: boolean;
  hint: string | null;
  /** Set only when this deployment runs with DEMO_MODE and nobody is signed in. */
  demo?: boolean;
};

export default function LoginPage() {
  return (
    <React.Suspense fallback={<Skeleton className="h-64 w-full max-w-md" />}>
      <LoginForm />
    </React.Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get('next') ?? '/';

  const [state, setState] = React.useState<SessionState | null>(null);
  const [secret, setSecret] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetch('/api/auth/session', { cache: 'no-store' })
      .then((response) => response.json())
      .then((payload: { data?: SessionState }) => {
        if (payload.data) setState(payload.data);
      })
      .catch(() => setState(null));
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: { message: string } };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
      }
      // Full navigation so the middleware sees the new cookie on every route.
      router.replace(nextPath);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 pt-10">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5 text-primary" />
            Sign in
          </CardTitle>
          <CardDescription>
            Enter the dashboard shared secret to manage suppliers, classifications and reports.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {state?.authDisabled ? (
            <Alert variant="info">
              <ShieldCheck className="h-4 w-4" />
              <AlertTitle>Authentication is disabled in development</AlertTitle>
              <AlertDescription>
                No <code>DASHBOARD_SECRET</code> or <code>WORKER_SECRET</code> is set and this is not a production
                build, so the app is open. Set one in <code>.env.local</code> to exercise the login flow.
              </AlertDescription>
            </Alert>
          ) : null}

          {state && !state.authConfigured && !state.authDisabled ? (
            <Alert variant="warning">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>No secret configured</AlertTitle>
              <AlertDescription>
                The API is disabled because neither <code>DASHBOARD_SECRET</code> nor <code>WORKER_SECRET</code> is set.
                Add one to the Vercel (and Render) environment variables, then redeploy.
              </AlertDescription>
            </Alert>
          ) : null}

          {state?.authenticated ? (
            <Alert variant="success">
              <ShieldCheck className="h-4 w-4" />
              <AlertTitle>Already signed in</AlertTitle>
              <AlertDescription>
                Session granted via {state.via}. <a className="underline" href="/">Continue to the dashboard</a>.
              </AlertDescription>
            </Alert>
          ) : null}

          {/*
            The demo entry point. Offered only when the deployment has opted in via
            DEMO_MODE, so a normal installation never advertises a way in.
          */}
          {state?.demo ? (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
              <p className="flex items-center gap-2 text-sm font-medium text-amber-950 dark:text-amber-100">
                <Eye className="h-4 w-4" aria-hidden />
                Just looking around?
              </p>
              <p className="mt-1 text-xs text-amber-900/90 dark:text-amber-100/90">
                This deployment has a read-only demo with illustrative sample data. Nothing you do there changes
                anything, and no real spend data is shown.
              </p>
              <Button variant="outline" className="mt-2 w-full" asChild>
                <a href="/">
                  <Eye className="h-4 w-4" />
                  Explore the demo
                </a>
              </Button>
            </div>
          ) : null}

          <form onSubmit={submit} className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="secret">Dashboard secret</Label>
              <Input
                id="secret"
                type="password"
                autoComplete="current-password"
                placeholder="DASHBOARD_SECRET"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                This is the <code>DASHBOARD_SECRET</code> (or <code>WORKER_SECRET</code>) value from your environment —
                the same string you would send as a bearer token.
              </p>
            </div>

            {error ? (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Sign-in failed</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <Button type="submit" disabled={submitting || secret.length === 0} className="w-full">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              Sign in
            </Button>
          </form>

          <div className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Prefer the command line?</p>
            <pre className="mt-1 overflow-x-auto font-mono text-[11px]">
{`curl -H "Authorization: Bearer $DASHBOARD_SECRET" \\
  https://your-app.vercel.app/api/metrics`}
            </pre>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
