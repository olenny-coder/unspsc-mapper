/**
 * POST /api/classify
 *
 * Classify suppliers into 8-digit UNSPSC codes with Groq, parent-first.
 *
 * Body: { supplierIds?, pending?, force?, limit?, actor?, modelStrategy? }
 *
 * `pending=true` (the default when no ids are given) picks the suppliers with no
 * current classification. `GET` previews the plan without spending a request.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { dynamic, jsonHandler, readJsonBody, readQuery } from '@/lib/api';
import { requireAuth } from '@/lib/auth';
import { classifyRequestSchema } from '@/lib/validation';
import { buildPlan, classifySuppliers, listSegments, searchUnspscCodes, taxonomySize } from '@/services/classification';

export { dynamic };

export const POST = jsonHandler(async (request: NextRequest) => {
  await requireAuth(request);

  const hasBody = (request.headers.get('content-length') ?? '0') !== '0' || Boolean(request.headers.get('transfer-encoding'));
  const params = hasBody
    ? await readJsonBody(request, classifyRequestSchema)
    : readQuery(request, classifyRequestSchema);

  const summary = await classifySuppliers({
    supplierIds: params.supplierIds,
    force: params.force ?? false,
    limit: params.limit,
    actor: params.actor,
    modelStrategy: params.modelStrategy,
    // `pending` simply means "don't restrict to specific ids".
    preserveReviewed: !(params.force ?? false),
  });

  return NextResponse.json({
    ok: true,
    data: {
      ...summary,
      // Trim the per-item payload for very large batches.
      items: summary.items.slice(0, 500),
      truncated: summary.items.length > 500,
    },
  });
});

/**
 * GET /api/classify
 *   ?plan=true  -> parent-first work plan and estimated request count
 *   ?q=dell     -> search the seeded UNSPSC taxonomy (autocomplete)
 *   (no params) -> taxonomy metadata
 */
export const GET = jsonHandler(async (request: NextRequest) => {
  await requireAuth(request);

  const searchParams = request.nextUrl.searchParams;
  const query = searchParams.get('q');
  if (query !== null) {
    const results = await searchUnspscCodes(query, { limit: Number(searchParams.get('limit') ?? 25) });
    return NextResponse.json({ ok: true, data: { query, results } });
  }

  if (searchParams.get('plan') !== null) {
    const ids = searchParams.get('supplierIds');
    const supplierIds = ids
      ? ids
          .split(',')
          .map((value) => Number(value.trim()))
          .filter((value) => Number.isInteger(value) && value > 0)
      : undefined;
    const { preview } = await buildPlan({ supplierIds });
    return NextResponse.json({ ok: true, data: preview });
  }

  const [codes, segments] = await Promise.all([taxonomySize(), listSegments()]);
  return NextResponse.json({ ok: true, data: { taxonomyCodes: codes, segments } });
});
