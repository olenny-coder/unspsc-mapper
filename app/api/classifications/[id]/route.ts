/**
 * PATCH /api/classifications/[id]
 *
 * Manual correction. `[id]` is the SUPPLIER id (the UI edits a supplier's
 * classification, and a supplier may have several classification rows over time).
 *
 * Behaviour
 * ---------
 *  - Marks the new row `reviewed = true` so the sync job will not overwrite it.
 *  - Records the change in `corrections`, which feeds the few-shot feedback loop.
 *  - When the supplier is a parent and `applyToSubsidiaries` is set, propagates
 *    the code to every descendant with `inherited_from_parent = true`.
 *
 * Body: { unspscCode, correctedBy?, reason?, applyToSubsidiaries? }
 */
import { NextResponse, type NextRequest } from 'next/server';
import { dynamic, jsonHandler, parseIdParam, readJsonBody } from '@/lib/api';
import { requireAuth } from '@/lib/auth';
import { correctionRequestSchema } from '@/lib/validation';
import { applyCorrection } from '@/services/classification';

export { dynamic };

export const PATCH = jsonHandler(async (request: NextRequest, context: { params: { id: string } }) => {
  await requireAuth(request);

  const supplierId = parseIdParam(context.params.id, 'supplier id');
  const body = await readJsonBody(request, correctionRequestSchema);

  const result = await applyCorrection({
    supplierId,
    unspscCode: body.unspscCode,
    correctedBy: body.correctedBy,
    reason: body.reason,
    applyToSubsidiaries: body.applyToSubsidiaries ?? false,
  });

  return NextResponse.json({
    ok: true,
    data: {
      ...result,
      warnings: result.codeKnown
        ? []
        : [
            `UNSPSC code ${result.correctedCode} is not a commodity in the seeded taxonomy (it may be a class or family prefix, which is not a valid classification target). It was stored as provided.`,
          ],
    },
  });
});

/** DELETE /api/classifications/[id] — clear the correction (falls back to the last model row). */
export const DELETE = jsonHandler(async (request: NextRequest, context: { params: { id: string } }) => {
  await requireAuth(request);
  const supplierId = parseIdParam(context.params.id, 'supplier id');
  const { getDb } = await import('@/db/client');
  const { classifications } = await import('@/db/schema');
  const { and, desc, eq } = await import('drizzle-orm');
  const { recordAudit } = await import('@/services/audit');
  const { NotFoundError } = await import('@/lib/errors');

  const db = getDb();
  const rows = await db
    .select()
    .from(classifications)
    .where(and(eq(classifications.supplierId, supplierId), eq(classifications.superseded, false)))
    .orderBy(desc(classifications.id))
    .limit(1);

  const current = rows[0];
  if (!current) throw new NotFoundError(`Supplier ${supplierId} has no current classification.`);

  await db
    .update(classifications)
    .set({ correctedCode: null, correctedBy: null, correctedAt: null, reviewed: false })
    .where(eq(classifications.id, current.id));

  await recordAudit({
    entity: 'classification',
    entityId: supplierId,
    action: 'updated',
    details: { clearedCorrection: current.id, previousCode: current.correctedCode },
    actor: 'dashboard',
  });

  return NextResponse.json({ ok: true, data: { supplierId, clearedClassificationId: current.id } });
});
