/**
 * Sync orchestration — the "live supplier database" logic.
 *
 * A sync run does, in order:
 *   1. detect suppliers that have become stale (never enriched, enrichment older
 *      than the threshold, or a previous enrichment failure);
 *   2. re-enrich them (cache-first, so repeat runs are free);
 *   3. resolve parent links so parent-first classification can work;
 *   4. classify new or materially-changed suppliers, including their
 *      subsidiaries;
 *   5. mark stale again if a re-enrichment attempt failed;
 *   6. write a single `synced` audit entry summarising the run.
 *
 * It is driven by `POST /api/sync` (worker secret) and by the Render worker's
 * internal scheduler, so it must be safe to call concurrently: every step is
 * idempotent and bounded by SYNC_BATCH_SIZE / SYNC_MAX_BATCHES_PER_RUN.
 */
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { suppliers as suppliersTable, type Supplier } from '@/db/schema';
import { getDb, type DbLike } from '@/db/client';
import { getEnv } from '@/lib/env';
import { recordAudit } from '@/services/audit';
import { remainingWorkerBudget } from '@/services/llm-usage';
import { resolveParentLinks, enrichSuppliers } from '@/services/enrichment';
import { classifySuppliers } from '@/services/classification';
import { getSupplierStats, markSupplierStale } from '@/services/suppliers';

export type SyncMode = 'enrich' | 'classify' | 'full' | 'report';

export type SyncOptions = {
  mode?: SyncMode;
  limit?: number;
  staleAfterDays?: number;
  actor?: string;
  db?: DbLike;
  /** Stop early instead of running every configured batch. */
  maxBatches?: number;
};

export type StaleCandidate = {
  supplier: Supplier;
  reason: 'never_enriched' | 'enrichment_old' | 'previous_failure' | 'flagged_stale';
  ageDays: number | null;
};

export type SyncSummary = {
  mode: SyncMode;
  startedAt: string;
  durationMs: number;
  staleAfterDays: number;
  candidatesFound: number;
  enriched: number;
  enrichmentFailed: number;
  classified: number
  inherited: number;
  lowConfidence: number;
  parentLinksCreated: number;
  parentsPresent: number;
  staleMarked: number;
  llmRequests: number;
  batches: number;
  stoppedReason: 'completed' | 'batch_limit' | 'llm_budget' | 'no_work' | 'error';
  errors: string[];
  report?: { id: number | null; name: string; bytes: number };
};

// ---------------------------------------------------------------------------
// Stale detection
// ---------------------------------------------------------------------------

/**
 * Find suppliers that need attention. Pure enough to unit-test with a supplied
 * row list (pass `rows` to skip the query).
 */
export function findStaleSuppliers(
  rows: readonly Supplier[],
  options: { staleAfterDays: number; now?: number; limit?: number },
): StaleCandidate[] {
  const now = options.now ?? Date.now();
  const cutoffMs = now - options.staleAfterDays * 86_400_000;
  const candidates: StaleCandidate[] = [];

  for (const supplier of rows) {
    const enrichedMs = supplier.enrichedAt ? supplier.enrichedAt.getTime() : null;
    const ageDays = enrichedMs === null ? null : Math.floor((now - enrichedMs) / 86_400_000);

    if (supplier.stale) {
      candidates.push({ supplier, reason: 'flagged_stale', ageDays });
      continue;
    }
    if (enrichedMs === null) {
      candidates.push({ supplier, reason: 'never_enriched', ageDays: null });
      continue;
    }
    if (enrichedMs <= cutoffMs) {
      candidates.push({ supplier, reason: 'enrichment_old', ageDays });
      continue;
    }
    if (supplier.lastEnrichError) {
      candidates.push({ supplier, reason: 'previous_failure', ageDays });
    }
  }

  const limited = options.limit ? candidates.slice(0, options.limit) : candidates;
  // Highest spend first: the suppliers that matter most get refreshed soonest.
  return limited.sort((a, b) => {
    const amountA = a.supplier.totalAmount === null ? 0 : Number(a.supplier.totalAmount);
    const amountB = b.supplier.totalAmount === null ? 0 : Number(b.supplier.totalAmount);
    if (amountB !== amountA) return amountB - amountA;
    return a.supplier.name.localeCompare(b.supplier.name);
  });
}

/** Query the database for stale candidates. */
export async function queryStaleSuppliers(
  options: { staleAfterDays: number; limit?: number; db?: DbLike },
): Promise<StaleCandidate[]> {
  const db = options.db ?? getDb();
  const cutoff = new Date(Date.now() - options.staleAfterDays * 86_400_000);

  const rows = await db
    .select()
    .from(suppliersTable)
    .where(
      or(
        eq(suppliersTable.stale, true),
        isNull(suppliersTable.enrichedAt),
        lt(suppliersTable.enrichedAt, cutoff),
        sql`${suppliersTable.lastEnrichError} is not null`,
      )!,
    )
    .limit(options.limit ?? 1000);

  return findStaleSuppliers(rows, { staleAfterDays: options.staleAfterDays, limit: options.limit });
}

// ---------------------------------------------------------------------------
// Sync run
// ---------------------------------------------------------------------------

export async function runSync(options: SyncOptions = {}): Promise<SyncSummary> {
  const startedAt = new Date();
  const db = options.db ?? getDb();
  const env = getEnv();
  const actor = options.actor ?? 'worker';
  const mode = options.mode ?? 'full';
  const staleAfterDays = options.staleAfterDays ?? env.SYNC_STALE_DAYS;
  const batchSize = options.limit ?? env.SYNC_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? env.SYNC_MAX_BATCHES_PER_RUN;

  const summary: SyncSummary = {
    mode,
    startedAt: startedAt.toISOString(),
    durationMs: 0,
    staleAfterDays,
    candidatesFound: 0,
    enriched: 0,
    enrichmentFailed: 0,
    classified: 0,
    inherited: 0,
    lowConfidence: 0,
    parentLinksCreated: 0,
    parentsPresent: 0,
    staleMarked: 0,
    llmRequests: 0,
    batches: 0,
    stoppedReason: 'no_work',
    errors: [],
  };

  try {
    // ---- 1 & 2: enrichment -------------------------------------------------
    if (mode === 'enrich' || mode === 'full') {
      const candidates = await queryStaleSuppliers({ staleAfterDays, limit: batchSize * maxBatches, db });
      summary.candidatesFound = candidates.length;

      if (!candidates.length) {
        summary.stoppedReason = mode === 'full' ? 'completed' : 'no_work';
      }

      for (let batch = 0; batch < maxBatches && batch * batchSize < candidates.length; batch += 1) {
        const slice = candidates.slice(batch * batchSize, (batch + 1) * batchSize);
        if (!slice.length) break;

        const enrichment = await enrichSuppliers(
          slice.map((candidate) => candidate.supplier.id),
          { actor, db, detectParent: true, force: false },
        );

        summary.batches += 1;
        summary.enriched += enrichment.enriched + enrichment.cached;
        summary.enrichmentFailed += enrichment.failed;
        summary.llmRequests += enrichment.llmParentCalls;

        for (const item of enrichment.items) {
          if (item.status === 'failed') {
            summary.staleMarked += 1;
            await markSupplierStale(item.supplierId, 'enrichment_failed', { db, actor });
          }
        }
      }

      // ---- 3: parent links -------------------------------------------------
      const links = await resolveParentLinks({ db, actor });
      summary.parentLinksCreated = links.linked;
    }

    // ---- 4: classification -------------------------------------------------
    if (mode === 'classify' || mode === 'full') {
      const budget = await remainingWorkerBudget(env.GROQ_MODEL_ACCURATE, db);
      if (budget <= 0) {
        summary.stoppedReason = 'llm_budget';
        summary.errors.push('Daily Groq budget for the accurate model is exhausted; classification skipped.');
      } else {
        const classification = await classifySuppliers({
          actor,
          db,
          limit: batchSize,
          maxBatches: Math.min(maxBatches, Math.max(1, Math.floor(budget / Math.max(1, batchSize)))),
          preserveReviewed: true,
        });
        summary.classified += classification.classified;
        summary.inherited += classification.inherited;
        summary.lowConfidence += classification.lowConfidence;
        summary.llmRequests += classification.llmRequests;
        summary.errors.push(...classification.errors);

        if (classification.processed === 0) {
          summary.stoppedReason = summary.stoppedReason === 'no_work' ? 'no_work' : summary.stoppedReason;
        } else if (summary.candidatesFound === 0) {
          summary.stoppedReason = 'completed';
        }
      }
    }

    // ---- 5: accounting -----------------------------------------------------
    const stats = await getSupplierStats({ db });
    summary.parentsPresent = stats.parents;

    if (summary.stoppedReason === 'no_work' && (summary.enriched || summary.classified)) {
      summary.stoppedReason = 'completed';
    }

    // ---- 6: audit ----------------------------------------------------------
    await recordAudit(
      {
        entity: 'sync',
        entityId: null,
        action: 'synced',
        details: { ...summary, durationMs: Date.now() - startedAt.getTime() },
        actor,
      },
      db,
    );
  } catch (error) {
    summary.errors.push(error instanceof Error ? error.message : String(error));
    summary.stoppedReason = 'error';
    console.error('[sync] run failed', error);
  }

  summary.durationMs = Date.now() - startedAt.getTime();
  return summary;
}

/**
 * Reclassification trigger: after enrichment changed industry/NAICS/parent, the
 * supplier and its subsidiaries must be re-queued. This marks the affected
 * suppliers so the next classification pass picks them up (their existing
 * classification is left in place until a new one is written).
 */
export async function triggerReclassification(
  supplierIds: readonly number[],
  options: { db?: DbLike; actor?: string; includeSubsidiaries?: boolean } = {},
): Promise<number[]> {
  const db = options.db ?? getDb();
  if (!supplierIds.length) return [];

  const allRows = await db
    .select({
      id: suppliersTable.id,
      name: suppliersTable.name,
      parentId: suppliersTable.parentId,
      parentName: suppliersTable.parentName,
      isParent: suppliersTable.isParent,
    })
    .from(suppliersTable);

  const { collectDescendantIds } = await import('@/services/hierarchy');
  const targets = new Set<number>(supplierIds);
  if (options.includeSubsidiaries !== false) {
    for (const id of supplierIds) {
      for (const descendant of collectDescendantIds(allRows, id)) targets.add(descendant);
    }
  }

  // Flag the affected suppliers so they surface in the review queue.
  for (const id of targets) {
    await db
      .update(suppliersTable)
      .set({ updatedAt: new Date() })
      .where(and(eq(suppliersTable.id, id)));
  }

  await recordAudit(
    {
      entity: 'sync',
      entityId: null,
      action: 'classified',
      details: { trigger: 'reclassification', supplierIds: [...targets] },
      actor: options.actor ?? 'system',
    },
    db,
  );

  return [...targets];
}

/** Health snapshot used by `/api/health` and the worker's own health endpoint. */
export async function getSyncHealth(db: DbLike = getDb()): Promise<{
  ok: boolean;
  stats: Awaited<ReturnType<typeof getSupplierStats>>;
  lastSync: { at: string; summary: Record<string, unknown> } | null;
}> {
  const { auditLog } = await import('@/db/schema');
  const stats = await getSupplierStats({ db });

  const lastRun = await db
    .select({ createdAt: auditLog.createdAt, details: auditLog.details })
    .from(auditLog)
    .where(eq(auditLog.action, 'synced'))
    .orderBy(sql`${auditLog.createdAt} desc`)
    .limit(1);

  return {
    ok: true,
    stats,
    lastSync: lastRun[0]
      ? { at: lastRun[0].createdAt.toISOString(), summary: (lastRun[0].details as Record<string, unknown>) ?? {} }
      : null,
  };
}
