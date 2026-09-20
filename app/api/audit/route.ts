/**
 * GET /api/audit
 *
 * Paginated audit log. Supports entity/action/actor/date/search filters and a
 * `view=summary` mode that returns per-action counts for the dashboard chart.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { dynamic, jsonHandler } from '@/lib/api';
import { requireAuth } from '@/lib/auth';
import { listAuditLog } from '@/services/audit';
import { getDb } from '@/db/client';
import { auditLog } from '@/db/schema';
import { desc, sql } from 'drizzle-orm';

export { dynamic };

const querySchema = z.object({
  entity: z.string().optional(),
  action: z.string().optional(),
  actor: z.string().optional(),
  search: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  view: z.enum(['list', 'summary']).default('list'),
});

export const GET = jsonHandler(async (request: NextRequest) => {
  await requireAuth(request);

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));
  const query = parsed.success ? parsed.data : querySchema.parse({});

  if (query.view === 'summary') {
    const db = getDb();
    const [byAction, byEntity, recent] = await Promise.all([
      db
        .select({ action: auditLog.action, count: sql<number>`count(*)` })
        .from(auditLog)
        .groupBy(auditLog.action)
        .orderBy(sql`count(*) desc`),
      db
        .select({ entity: auditLog.entity, count: sql<number>`count(*)` })
        .from(auditLog)
        .groupBy(auditLog.entity)
        .orderBy(sql`count(*) desc`),
      db
        .select()
        .from(auditLog)
        .orderBy(desc(auditLog.createdAt))
        .limit(10),
    ]);

    return NextResponse.json({
      ok: true,
      data: {
        byAction: byAction.map((row) => ({ action: row.action, count: Number(row.count) })),
        byEntity: byEntity.map((row) => ({ entity: row.entity, count: Number(row.count) })),
        recent: recent.map((row) => ({
          id: row.id,
          entity: row.entity,
          entityId: row.entityId,
          action: row.action,
          actor: row.actor,
          details: row.details,
          createdAt: row.createdAt.toISOString(),
        })),
      },
    });
  }

  const page = await listAuditLog({
    entity: query.entity,
    action: query.action,
    actor: query.actor,
    search: query.search,
    from: query.from,
    to: query.to,
    page: query.page,
    pageSize: query.pageSize,
  });

  return NextResponse.json({ ok: true, data: page });
});
