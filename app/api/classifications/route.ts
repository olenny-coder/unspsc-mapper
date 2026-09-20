/**
 * GET /api/classifications
 *
 * List current classifications with filters, plus the review queue and the
 * segment breakdown when requested.
 *
 * Query:
 *   page, pageSize, sort (confidence|spend|name), dir
 *   threshold=<0..1>      confidence threshold for the review queue
 *   state=low|reviewed|unreviewed|unclassified
 *   view=queue|segments   alternative payloads used by the /review page
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { dynamic, jsonHandler, readFilters } from '@/lib/api';
import { requireAuth } from '@/lib/auth';
import { getEnv } from '@/lib/env';
import { listSuppliers } from '@/services/suppliers';
import { getReviewQueue, segmentBreakdown } from '@/services/classification';

export { dynamic };

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.enum(['confidence', 'spend', 'name']).default('confidence'),
  dir: z.enum(['asc', 'desc']).default('asc'),
  threshold: z.coerce.number().min(0).max(1).optional(),
  state: z.enum(['all', 'low', 'reviewed', 'unreviewed', 'unclassified']).default('all'),
  view: z.enum(['list', 'queue', 'segments']).default('list'),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

export const GET = jsonHandler(async (request: NextRequest) => {
  await requireAuth(request);

  const env = getEnv();
  const params = Object.fromEntries(request.nextUrl.searchParams.entries());
  const parsed = querySchema.safeParse(params);
  const query = parsed.success ? parsed.data : querySchema.parse({});
  const threshold = query.threshold ?? env.CLASSIFY_CONFIDENCE_THRESHOLD;

  if (query.view === 'queue') {
    const queue = await getReviewQueue({
      threshold,
      limit: query.limit ?? 200,
      includeUnclassified: true,
      includeUncertainParents: true,
    });
    return NextResponse.json({
      ok: true,
      data: {
        threshold,
        count: queue.length,
        rows: queue,
      },
    });
  }

  if (query.view === 'segments') {
    const segments = await segmentBreakdown({ filters: { minConfidence: query.threshold } });
    return NextResponse.json({ ok: true, data: { segments } });
  }

  const filters = readFilters(request);
  if (query.state !== 'all') filters.confidenceState = query.state;

  const page = await listSuppliers({
    filters,
    page: query.page,
    pageSize: query.pageSize,
    sort: query.sort === 'confidence' ? 'confidence' : query.sort === 'spend' ? 'spend' : 'name',
    dir: query.dir,
  });

  return NextResponse.json({ ok: true, data: { ...page, threshold } });
});
