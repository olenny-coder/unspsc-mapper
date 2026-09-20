/**
 * GET /api/suppliers
 *
 * Paginated supplier list with current classification, hierarchy filters and
 * optional parent roll-up.
 *
 * Query: page, pageSize, sort, dir + every filter in `reportFiltersSchema`
 * (`minConfidence`, `segment`, `parent`, `onlyStale`, `rollup=parent`, ...).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { dynamic, jsonHandler, readFilters, readQuery } from '@/lib/api';
import { requireAuth } from '@/lib/auth';
import { supplierQuerySchema } from '@/lib/validation';
import { getHierarchy, getSupplierStats, listSuppliers, toNode } from '@/services/suppliers';
import { rollupByParent } from '@/services/hierarchy';
import { getEnv } from '@/lib/env';
import { listSegments } from '@/services/classification';

export { dynamic };

/** GET /api/suppliers?meta=true returns filter options instead of rows. */
export const GET = jsonHandler(async (request: NextRequest) => {
  await requireAuth(request);

  const query = readQuery(request, supplierQuerySchema);

  if (request.nextUrl.searchParams.get('meta') !== null) {
    const [segments, hierarchy] = await Promise.all([listSegments(), getHierarchy()]);
    return NextResponse.json({
      ok: true,
      data: {
        segments,
        parents: hierarchy.clusters
          .filter((cluster) => cluster.subsidiaryCount > 0)
          .map((cluster) => ({
            id: cluster.rootId,
            name: cluster.rootName,
            subsidiaries: cluster.subsidiaryCount,
            totalAmount: cluster.totalAmount,
          })),
        currency: 'USD',
      },
    });
  }

  const filters = { ...readFilters(request), ...(query.filters ?? {}) };
  const env = getEnv();

  if (filters.rollup === 'parent') {
    // Roll-up needs whole-cluster context, so read all matching rows and
    // aggregate in process (this is the same code path the reports use).
    const all = await listSuppliers({ all: true, filters, sort: query.sort, dir: query.dir });
    const rollup = rollupByParent(all.rows.map((row) => toNode(row)), env.CLASSIFY_CONFIDENCE_THRESHOLD);
    const stats = await getSupplierStats({ filters });
    return NextResponse.json({
      ok: true,
      data: {
        rollup,
        stats,
        total: rollup.length,
        rows: [],
      },
    });
  }

  const page = await listSuppliers({
    filters,
    page: query.page,
    pageSize: query.pageSize,
    sort: query.sort,
    dir: query.dir,
  });
  const stats = await getSupplierStats({ filters });

  return NextResponse.json({
    ok: true,
    data: { ...page, stats, rollup: [] },
  });
});
