/**
 * GET /api/suppliers/[id]
 *
 * Supplier detail: full row, current classification, classification history,
 * corrections, subsidiaries and audits for that supplier.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { dynamic, jsonHandler, parseIdParam } from '@/lib/api';
import { requireAuth } from '@/lib/auth';
import { auditLog, suppliers as suppliersTable } from '@/db/schema';
import { getDb } from '@/db/client';
import { NotFoundError } from '@/lib/errors';
import { getSupplierById } from '@/services/suppliers';
import { getClassificationHistory } from '@/services/classification';
import { collectDescendantIds } from '@/services/hierarchy';

export { dynamic };

export const GET = jsonHandler(async (request: NextRequest, context: { params: { id: string } }) => {
  await requireAuth(request);

  const id = parseIdParam(context.params.id, 'supplier id');
  const supplier = await getSupplierById(id);
  if (!supplier) throw new NotFoundError(`Supplier ${id} not found.`);

  const db = getDb();

  const [history, allRows, audits] = await Promise.all([
    getClassificationHistory(id, db),
    db
      .select({
        id: suppliersTable.id,
        name: suppliersTable.name,
        parentId: suppliersTable.parentId,
        parentName: suppliersTable.parentName,
        isParent: suppliersTable.isParent,
      })
      .from(suppliersTable),
    db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, id))
      .orderBy(desc(auditLog.createdAt))
      .limit(25),
  ]);

  const descendantIds = collectDescendantIds(allRows, id);
  const subsidiaryRows =
    descendantIds.length > 0
      ? await db
          .select({
            id: suppliersTable.id,
            name: suppliersTable.name,
            domain: suppliersTable.domain,
            totalAmount: suppliersTable.totalAmount,
            parentId: suppliersTable.parentId,
          })
          .from(suppliersTable)
          .where(eq(suppliersTable.parentId, id))
      : [];

  const parent = supplier.parentId !== null ? await getSupplierById(supplier.parentId) : null;

  return NextResponse.json({
    ok: true,
    data: {
      supplier,
      parent: parent
        ? { id: parent.id, name: parent.name, domain: parent.domain, classification: parent.classification }
        : null,
      subsidiaries: subsidiaryRows.map((row) => ({
        id: row.id,
        name: row.name,
        domain: row.domain,
        totalAmount: row.totalAmount === null ? 0 : Number(row.totalAmount),
      })),
      descendantCount: descendantIds.length,
      history: history.history,
      corrections: history.corrections,
      audits: audits.map((row) => ({
        id: row.id,
        entity: row.entity,
        action: row.action,
        details: row.details,
        actor: row.actor,
        createdAt: row.createdAt.toISOString(),
      })),
    },
  });
});
