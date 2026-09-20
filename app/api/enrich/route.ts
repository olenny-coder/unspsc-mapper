/**
 * POST /api/enrich
 *
 * Enrich a batch of suppliers, detect parent companies, and (optionally) link
 * subsidiaries to their parent so `POST /api/classify` can run parent-first.
 *
 * Body: { supplierIds?, pending?, olderThanDays?, onlyStale?, limit?, force?, actor? }
 */
import { NextResponse, type NextRequest } from 'next/server';
import { dynamic, jsonHandler, readJsonBody, readQuery } from '@/lib/api';
import { requireAuth } from '@/lib/auth';
import { enrichRequestSchema } from '@/lib/validation';
import { enrichSuppliers, resolveParentLinks } from '@/services/enrichment';

export { dynamic };

export const POST = jsonHandler(async (request: NextRequest) => {
  await requireAuth(request);

  const hasBody = (request.headers.get('content-length') ?? '0') !== '0' || Boolean(request.headers.get('transfer-encoding'));

  // Accept either a JSON body or query parameters (so `?pending=true` works).
  const params = hasBody ? await readJsonBody(request, enrichRequestSchema) : readQuery(request, enrichRequestSchema);

  // `force` re-enriches regardless of cache/TTL; `pending` targets
  // never-enriched suppliers; `olderThanDays` implements the 30-day refresh.
  const summary = await enrichSuppliers(params.supplierIds, {
    force: params.force ?? false,
    detectParent: true,
    actor: params.actor,
    limit: params.limit,
    ...(params.olderThanDays ? { cacheTtlDays: params.olderThanDays } : {}),
  });

  const links = await resolveParentLinks({
    supplierIds: params.supplierIds,
    actor: params.actor,
  });

  return NextResponse.json({
    ok: true,
    data: {
      ...summary,
      parentLinks: links,
      notes: [
        params.force ? 'force=true: cache was bypassed, provider credits were consumed.' : 'Cache-first lookup.',
        params.pending ? 'pending=true: targeted never-enriched suppliers.' : undefined,
      ].filter(Boolean),
    },
  });
});

/** GET returns the batch that a `pending` call would process, without doing work. */
export const GET = jsonHandler(async (request: NextRequest) => {
  await requireAuth(request);

  const params = readQuery(request, enrichRequestSchema);
  const { findSuppliersNeedingEnrichment } = await import('@/services/suppliers');
  const rows = await findSuppliersNeedingEnrichment({
    olderThanDays: params.olderThanDays,
    onlyStale: params.onlyStale,
    limit: params.limit ?? 25,
  });

  return NextResponse.json({
    ok: true,
    data: {
      count: rows.length,
      suppliers: rows.map((row) => ({
        id: row.id,
        name: row.name,
        enrichedAt: row.enrichedAt ? row.enrichedAt.toISOString() : null,
        stale: row.stale,
        staleReason: row.staleReason,
        totalAmount: row.totalAmount === null ? null : Number(row.totalAmount),
      })),
    },
  });
});
