/**
 * Audit logging. Every enrichment, classification, correction, sync and report
 * event lands here so the `/audit` page can explain how any number was derived.
 */
import { and, count, desc, eq, gte, ilike, lte, sql, type SQL } from 'drizzle-orm';
import { auditLog, type NewAuditLogRow } from '@/db/schema';
import { getDb, type DbLike } from '@/db/client';

export const AUDIT_ENTITIES = ['supplier', 'classification', 'correction', 'report', 'settings', 'sync'] as const;
export type AuditEntity = (typeof AUDIT_ENTITIES)[number];

export const AUDIT_ACTIONS = [
  'created',
  'updated',
  'enriched',
  'enrich_failed',
  'classified',
  'inherited',
  'corrected',
  'propagated',
  'linked',
  'unlinked',
  'synced',
  'stale_marked',
  'report_generated',
  'settings_updated',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditInput = {
  entity: AuditEntity;
  entityId?: number | null;
  action: AuditAction;
  details?: Record<string, unknown> | null;
  actor?: string;
};

/**
 * Append an audit row. Never throws: auditing must not break the operation it
 * describes, but failures are logged so they are visible in Render/Vercel logs.
 */
export async function recordAudit(input: AuditInput, db: DbLike = getDb()): Promise<void> {
  const row: NewAuditLogRow = {
    entity: input.entity,
    entityId: input.entityId ?? null,
    action: input.action,
    details: (input.details ?? {}) as Record<string, unknown>,
    actor: input.actor?.trim() || 'system',
  };
  try {
    await db.insert(auditLog).values(row);
  } catch (error) {
    console.error('[audit] failed to write audit row', { row, error });
  }
}

/** Append many audit rows in one statement. */
export async function recordAuditBatch(inputs: AuditInput[], db: DbLike = getDb()): Promise<void> {
  if (!inputs.length) return;
  const rows: NewAuditLogRow[] = inputs.map((input) => ({
    entity: input.entity,
    entityId: input.entityId ?? null,
    action: input.action,
    details: (input.details ?? {}) as Record<string, unknown>,
    actor: input.actor?.trim() || 'system',
  }));
  try {
    await db.insert(auditLog).values(rows);
  } catch (error) {
    console.error('[audit] failed to write audit batch', { count: rows.length, error });
  }
}

export type AuditQuery = {
  entity?: string;
  action?: string;
  actor?: string;
  search?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
};

export type AuditEntry = {
  id: number;
  entity: string;
  entityId: number | null;
  action: string;
  details: Record<string, unknown> | null;
  actor: string;
  createdAt: string;
};

export type AuditPage = {
  entries: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
};

/** Paginated audit log reader for the `/audit` page. */
export async function listAuditLog(query: AuditQuery = {}, db: DbLike = getDb()): Promise<AuditPage> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 50));

  const filters: SQL[] = [];
  if (query.entity) filters.push(eq(auditLog.entity, query.entity));
  if (query.action) filters.push(eq(auditLog.action, query.action));
  if (query.actor) filters.push(eq(auditLog.actor, query.actor));
  if (query.from) filters.push(gte(auditLog.createdAt, new Date(query.from)));
  if (query.to) {
    const to = new Date(query.to);
    // Include the whole day when only a date was supplied.
    if (/^\d{4}-\d{2}-\d{2}$/.test(query.to)) to.setUTCHours(23, 59, 59, 999);
    filters.push(lte(auditLog.createdAt, to));
  }
  if (query.search) {
    filters.push(ilike(sql`${auditLog.details}::text`, `%${query.search}%`));
  }

  const where = filters.length ? and(...filters) : undefined;

  const [entries, totals] = await Promise.all([
    db
      .select({
        id: auditLog.id,
        entity: auditLog.entity,
        entityId: auditLog.entityId,
        action: auditLog.action,
        details: auditLog.details,
        actor: auditLog.actor,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ value: count() }).from(auditLog).where(where),
  ]);

  const total = Number(totals[0]?.value ?? 0);

  return {
    entries: entries.map((entry) => ({
      ...entry,
      createdAt: entry.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
