/**
 * /api/hierarchy
 *
 *  GET                        — parent clusters with their subsidiaries
 *  POST  { supplierId, parentId | parentName } — link a subsidiary to a parent
 *  DELETE ?supplierId=<n>     — unlink a subsidiary
 *
 * Cycle safety: linking is refused when the target parent is already a
 * descendant of the supplier, so the tree can never become a loop.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { dynamic, jsonHandler, readJsonBody, requireWorkerAuth } from '@/lib/api';
import { requireAuth } from '@/lib/auth';
import { linkParentRequestSchema, unlinkParentRequestSchema } from '@/lib/validation';
import { ValidationError } from '@/lib/errors';
import { getEnv } from '@/lib/env';
import { getHierarchy } from '@/services/suppliers';
import { collectDescendantIds, normalizeSupplierName } from '@/services/hierarchy';
import { ensureParentSupplier, linkSubsidiary, loadAllSupplierNodes } from '@/services/suppliers';
import { applyCorrection } from '@/services/classification';

export { dynamic };

export const GET = jsonHandler(async (request: NextRequest) => {
  await requireAuth(request);

  const searchParams = request.nextUrl.searchParams;
  const onlyWithSubsidiaries = searchParams.get('flat') !== 'true';
  const hierarchy = await getHierarchy();

  const clusters = (onlyWithSubsidiaries
    ? hierarchy.clusters.filter((cluster) => cluster.subsidiaryCount > 0)
    : hierarchy.clusters
  ).map((cluster) => ({
    key: cluster.key,
    rootId: cluster.rootId,
    rootName: cluster.rootName,
    rootDomain: cluster.rootDomain,
    isVirtualRoot: cluster.isVirtualRoot,
    subsidiaryCount: cluster.subsidiaryCount,
    totalAmount: cluster.totalAmount,
    members: cluster.members.map((member) => ({
      id: member.supplier.id,
      name: member.supplier.name,
      domain: member.supplier.domain ?? null,
      industry: member.supplier.industry ?? null,
      isRoot: member.isRoot,
      depth: member.depth,
      totalAmount: Number(member.supplier.totalAmount ?? 0),
      parentSource: (member.supplier as { parentSource?: string | null }).parentSource ?? null,
      stale: Boolean(member.supplier.stale),
    })),
  }));

  return NextResponse.json({
    ok: true,
    data: {
      clusters,
      totals: {
        clusters: hierarchy.clusters.length,
        parents: hierarchy.clusters.filter((cluster) => cluster.subsidiaryCount > 0).length,
        suppliers: hierarchy.clusters.reduce((sum, cluster) => sum + cluster.members.length, 0),
        orphans: hierarchy.orphans.length,
      },
      hadCycle: hierarchy.hadCycle,
      orphans: hierarchy.orphans.map((node) => ({ id: node.id, name: node.name, parentName: node.parentName })),
    },
  });
});

export const POST = jsonHandler(async (request: NextRequest) => {
  await requireAuth(request);

  const env = getEnv();
  const body = await readJsonBody(request, linkParentRequestSchema);

  if (!body.parentId && !body.parentName) {
    throw new ValidationError('Provide either `parentId` (existing supplier) or `parentName` (external parent).');
  }

  const nodes = (await loadAllSupplierNodes()).map((row) => ({
    id: row.id,
    name: row.name,
    parentId: row.parentId,
    parentName: row.parentName,
    parentDomain: row.parentDomain,
    isParent: row.isParent,
  }));

  const supplier = nodes.find((node) => node.id === body.supplierId);
  if (!supplier) throw new ValidationError(`Supplier ${body.supplierId} not found.`);

  let parentId = body.parentId ?? null;
  let parentName = body.parentName ?? null;
  let parentDomain = body.parentDomain ?? null;
  let createdPlaceholder = false;

  if (parentId !== null) {
    const parent = nodes.find((node) => node.id === parentId);
    if (!parent) throw new ValidationError(`Parent supplier ${parentId} not found.`);
    parentName = parent.name;

    if (parentId === body.supplierId) {
      throw new ValidationError('A supplier cannot be its own parent.');
    }
    if (collectDescendantIds(nodes, body.supplierId).includes(parentId)) {
      throw new ValidationError(
        `Refusing to link ${parent.name} as the parent of ${supplier.name}: it is already a subsidiary of it. Unlink the existing relationship first.`,
      );
    }
  } else if (parentName) {
    const parentKey = normalizeSupplierName(parentName);

    // Reuse an existing row for that parent name before creating a placeholder —
    // otherwise "3M" supplied as its own parent would look like a new company and
    // silently create a duplicate row.
    const existing = nodes.find((node) => normalizeSupplierName(node.name) === parentKey);
    if (existing) {
      if (existing.id === body.supplierId) {
        throw new ValidationError(
          `"${parentName}" resolves to ${supplier.name} itself. A supplier cannot be its own parent — link it to the real parent company instead.`,
        );
      }
      if (collectDescendantIds(nodes, body.supplierId).includes(existing.id)) {
        throw new ValidationError(
          `Refusing to link ${existing.name} as the parent of ${supplier.name}: it is already a subsidiary of it.`,
        );
      }
      parentId = existing.id;
      parentName = existing.name;
      parentDomain = existing.parentDomain ?? parentDomain;
    } else {
      if (parentKey === normalizeSupplierName(supplier.name)) {
        throw new ValidationError('A supplier cannot be its own parent.');
      }
      const created = await ensureParentSupplier(parentName, {
        actor: body.actor ?? env.APP_ACTOR,
        domain: parentDomain,
      });
      if (!created) throw new ValidationError(`Could not create a parent company row for "${parentName}".`);
      parentId = created.id;
      parentDomain = created.domain ?? parentDomain;
      createdPlaceholder = true;
      if (collectDescendantIds(nodes, body.supplierId).includes(created.id)) {
        throw new ValidationError('That parent company is already a subsidiary of this supplier.');
      }
    }
  }

  await linkSubsidiary(body.supplierId, parentId, {
    actor: body.actor ?? env.APP_ACTOR,
    source: 'manual',
    parentName,
    parentDomain,
    confidence: 1,
  });

  return NextResponse.json({
    ok: true,
    data: { supplierId: body.supplierId, parentId, parentName, parentDomain, createdPlaceholder },
  });
});

/**
 * DELETE /api/hierarchy?supplierId=<n>
 * Unlinks a subsidiary. `?propagateCode=<8 digits>` additionally re-classifies
 * the newly independent supplier instead of leaving the inherited code behind.
 */
export const DELETE = jsonHandler(async (request: NextRequest) => {
  requireWorkerAuth(request);
  const searchParams = request.nextUrl.searchParams;
  const parsed = unlinkParentRequestSchema.safeParse({
    supplierId: searchParams.get('supplierId'),
    actor: searchParams.get('actor') ?? undefined,
  });
  if (!parsed.success) {
    throw new ValidationError('Query parameter `supplierId` must be a positive integer.');
  }

  const { supplierId, actor } = parsed.data;
  const env = getEnv();
  const code = searchParams.get('propagateCode');

  await linkSubsidiary(supplierId, null, { actor: actor ?? env.APP_ACTOR, source: 'manual' });

  if (code) {
    await applyCorrection({
      supplierId,
      unspscCode: code,
      correctedBy: actor ?? env.APP_ACTOR,
      reason: 'Re-classified after being unlinked from its parent company.',
      applyToSubsidiaries: false,
    });
  }

  return NextResponse.json({ ok: true, data: { supplierId, parentId: null } });
});
