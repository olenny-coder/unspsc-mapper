/**
 * Demo-mode tests.
 *
 * The security property under test is structural, not cosmetic: when
 * `DEMO_MODE=true`, an anonymous request must be answered from the bundled fixture
 * and the real route handler must not run at all. The strongest way to assert that
 * is to make the database itself throw — if any demo path reaches it, the test
 * fails loudly rather than quietly leaking a row.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Any attempt to open a connection from a demo path is a bug, so make it explosive.
vi.mock('@/db/client', () => ({
  getDb: () => {
    throw new Error('demo path reached the database');
  },
  closeDb: async () => undefined,
}));

import { jsonHandler, ok } from '@/lib/api';
import { resolveRequestRole } from '@/lib/auth';
import { resetEnvCache } from '@/lib/env';
import { demoRespond } from '@/lib/demo/responses';
import { DEMO_SUPPLIER_ROWS } from '@/lib/demo/dataset';

const mutableEnv = process.env as Record<string, string | undefined>;

const TOUCHED = ['DEMO_MODE', 'DASHBOARD_SECRET', 'WORKER_SECRET', 'NODE_ENV', 'ALLOW_UNAUTHENTICATED_DEV'] as const;

let original: Record<string, string | undefined> = {};

beforeEach(() => {
  original = {};
  for (const key of TOUCHED) original[key] = mutableEnv[key];
  resetEnvCache();
});

afterEach(() => {
  for (const key of TOUCHED) {
    if (original[key] === undefined) delete mutableEnv[key];
    else mutableEnv[key] = original[key];
  }
  resetEnvCache();
  vi.restoreAllMocks();
});

function enableDemo(secret = 'test-dashboard-secret'): void {
  mutableEnv.DEMO_MODE = 'true';
  mutableEnv.DASHBOARD_SECRET = secret;
  mutableEnv.WORKER_SECRET = secret;
  mutableEnv.NODE_ENV = 'production';
  delete mutableEnv.ALLOW_UNAUTHENTICATED_DEV;
  resetEnvCache();
}

/** `NextRequest` takes Next's own `RequestInit`, which is narrower than the DOM one. */
type NextInit = ConstructorParameters<typeof NextRequest>[1];

function get(path: string, init: NextInit = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, init);
}

describe('role resolution', () => {
  it('treats an anonymous caller as a demo visitor only when DEMO_MODE is on', async () => {
    enableDemo();
    expect(await resolveRequestRole(get('/api/metrics'))).toBe('demo');

    mutableEnv.DEMO_MODE = 'false';
    resetEnvCache();
    expect(await resolveRequestRole(get('/api/metrics'))).toBe('denied');
  });

  it('never downgrades a signed-in caller', async () => {
    enableDemo('the-real-secret');
    const request = get('/api/metrics', { headers: { authorization: 'Bearer the-real-secret' } });
    expect(await resolveRequestRole(request)).toBe('admin');
  });

  it('treats a failed credential as a denied sign-in, not as a demo visitor', async () => {
    enableDemo('the-real-secret');
    // The distinction that matters: a caller who *tried* to authenticate gets a 401
    // and the login flow. Answering them from the fixture would show fabricated
    // figures to someone who believes they are looking at their real deployment —
    // exactly the situation an expired session or a rotated secret creates.
    const request = get('/api/metrics', { headers: { authorization: 'Bearer wrong' } });
    expect(await resolveRequestRole(request)).toBe('denied');
  });

  it('treats a tampered session cookie as a denied sign-in too', async () => {
    enableDemo('the-real-secret');
    const request = get('/api/metrics', { headers: { cookie: 'unspsc_session=not-a-valid-token' } });
    expect(await resolveRequestRole(request)).toBe('denied');
  });
});

describe('writes are refused before any handler runs', () => {
  it('blocks a mutation and never invokes the real handler', async () => {
    enableDemo();
    const handler = vi.fn(async () => ok({ uploaded: true }));
    const wrapped = jsonHandler(handler);

    const response = await wrapped(get('/api/upload', { method: 'POST' }));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'demo_read_only' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('refuses %s', async (method) => {
    enableDemo();
    const handler = vi.fn(async () => ok({}));
    const response = await jsonHandler(handler)(get('/api/metrics', { method }));

    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('lets the real handler run for a signed-in caller on the same deployment', async () => {
    enableDemo('the-real-secret');
    const handler = vi.fn(async () => ok({ real: true }));
    const wrapped = jsonHandler(handler);

    const response = await wrapped(
      get('/api/upload', { method: 'POST', headers: { authorization: 'Bearer the-real-secret' } }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { real: true } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not divert anyone when DEMO_MODE is off', async () => {
    mutableEnv.DEMO_MODE = 'false';
    mutableEnv.DASHBOARD_SECRET = 'a-secret';
    mutableEnv.NODE_ENV = 'production';
    resetEnvCache();

    const handler = vi.fn(async () => ok({ reached: true }));
    // The real handler is reached and is responsible for its own requireAuth, which
    // is exactly the pre-existing behaviour for a normal deployment.
    await jsonHandler(handler)(get('/api/metrics'));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('reads are served without touching the database', () => {
  it('answers dashboard metrics from the fixture', async () => {
    enableDemo();
    const response = demoRespond(get('/api/metrics'));

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; data: { summary: { totalSuppliers: number } } };
    expect(payload.ok).toBe(true);
    expect(payload.data.summary.totalSuppliers).toBe(DEMO_SUPPLIER_ROWS.length);
  });

  it.each([
    '/api/metrics',
    '/api/suppliers',
    '/api/suppliers?meta=true',
    '/api/classifications?view=queue',
    '/api/classifications?view=segments',
    '/api/hierarchy?flat=true',
    '/api/audit',
    '/api/audit?view=summary',
    '/api/reports',
    '/api/reports?view=budget',
    '/api/settings',
    '/api/classify?q=software',
    '/api/upload',
    '/api/auth/session',
  ])('serves %s from the fixture', async (path) => {
    enableDemo();
    const response = demoRespond(get(path));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it('reports itself as a demo to the client', async () => {
    enableDemo();
    const payload = (await demoRespond(get('/api/auth/session')).json()) as { data: { demo: boolean } };
    expect(payload.data.demo).toBe(true);
  });

  it('refuses an endpoint it does not know rather than falling through', async () => {
    enableDemo();
    const response = demoRespond(get('/api/some-future-endpoint'));

    // A newly added endpoint must be private by default, not inherited by the demo.
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('refuses downloads and stored exports', async () => {
    enableDemo();
    const response = demoRespond(get('/api/export?format=csv'));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'demo_read_only' } });
  });
});

describe('fixture consistency', () => {
  it('has unique supplier and classification ids', () => {
    const supplierIds = DEMO_SUPPLIER_ROWS.map((row) => row.id);
    expect(new Set(supplierIds).size).toBe(supplierIds.length);

    const classificationIds = DEMO_SUPPLIER_ROWS
      .map((row) => row.classification?.id)
      .filter((id): id is number => typeof id === 'number');
    expect(new Set(classificationIds).size).toBe(classificationIds.length);
  });

  it('points every parentId at a real row and counts children correctly', () => {
    const byId = new Map(DEMO_SUPPLIER_ROWS.map((row) => [row.id, row]));

    for (const row of DEMO_SUPPLIER_ROWS) {
      if (row.parentId === null) continue;
      expect(byId.has(row.parentId), `${row.name} references missing parent ${row.parentId}`).toBe(true);
    }

    for (const row of DEMO_SUPPLIER_ROWS) {
      const children = DEMO_SUPPLIER_ROWS.filter((candidate) => candidate.parentId === row.id);
      expect(row.subsidiaryCount, `${row.name} subsidiaryCount`).toBe(children.length);
    }
  });

  it('marks every reasoning string as illustrative', () => {
    // A demo row must be unmistakable for real model output if it ever leaks into a
    // screenshot, a support thread or a report.
    for (const row of DEMO_SUPPLIER_ROWS) {
      if (!row.classification) continue;
      expect(row.classification.reasoning ?? '').toMatch(/^DEMO:/);
    }
  });

  it('uses effectiveCode that matches the corrected code when present', () => {
    for (const row of DEMO_SUPPLIER_ROWS) {
      const classification = row.classification;
      if (!classification) continue;
      if (classification.correctedCode) {
        expect(classification.effectiveCode).toBe(classification.correctedCode);
      } else {
        expect(classification.effectiveCode).toBe(classification.unspscCode);
      }
    }
  });

  it('derives its segment bars from effectiveCode, matching production', async () => {
    enableDemo();
    const payload = (await demoRespond(get('/api/metrics')).json()) as {
      data: { segments: Array<{ segmentCode: string }> };
    };

    const reported = [...new Set(payload.data.segments.map((segment) => segment.segmentCode))].sort();
    const expected = [
      ...new Set(
        DEMO_SUPPLIER_ROWS
          .map((row) => row.classification?.effectiveCode.slice(0, 2))
          .filter((code): code is string => Boolean(code)),
      ),
    ].sort();

    // Production groups by `coalesce(correctedCode, unspscCode)`. Grouping by the
    // superseded code instead silently files a human-corrected row under its old
    // segment, so a bar ends up labelled with the wrong segment's name.
    expect(reported).toEqual(expected);
    expect(DEMO_SUPPLIER_ROWS.some((row) => row.classification?.correctedCode)).toBe(true);
  });

  it('classes a mix of rows so every dashboard state is visible', () => {
    const classified = DEMO_SUPPLIER_ROWS.filter((row) => row.classification !== null);
    expect(classified.length).toBeGreaterThan(0);
    expect(classified.length).toBeLessThan(DEMO_SUPPLIER_ROWS.length);

    expect(DEMO_SUPPLIER_ROWS.some((row) => row.classification?.inheritedFromParent)).toBe(true);
    expect(DEMO_SUPPLIER_ROWS.some((row) => row.stale)).toBe(true);

    const segments = new Set(
      classified.map((row) => row.classification?.unspscCode.slice(0, 2)).filter(Boolean),
    );
    expect(segments.size).toBeGreaterThanOrEqual(5);
  });
});
