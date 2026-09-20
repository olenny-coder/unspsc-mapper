/**
 * Parent / subsidiary hierarchy logic.
 *
 * Pure, array-in / structure-out helpers live here so the tricky parts (cycle
 * safety, cluster selection, propagation scope) are unit-testable without a
 * database. `services/suppliers.ts` supplies the rows and persists the results.
 *
 * Model
 * -----
 * - A supplier whose `parentId`/`parentName` points at something is a
 *   SUBSIDIARY.
 * - A supplier that other suppliers point at is a PARENT (`isParent = true`).
 * - The hierarchy is flattened to at most two levels: a cluster has one
 *   classification target (the root) and N members. If a chain A -> B -> C is
 *   discovered, it is collapsed to B (root) with A and C as members.
 */
import { normalizeSupplierName } from '@/lib/normalize';

export { normalizeSupplierName };

export type SupplierNode = {
  id: number;
  name: string;
  parentId: number | null;
  parentName: string | null;
  parentDomain?: string | null;
  isParent: boolean;
  domain?: string | null;
  industry?: string | null;
  naics?: string | null;
  sic?: string | null;
  description?: string | null;
  country?: string | null;
  totalAmount?: number | string | null;
  enrichedAt?: Date | string | null;
  stale?: boolean;
};

export type HierarchyMember = {
  supplier: SupplierNode;
  isRoot: boolean;
  /** Depth relative to the cluster root (0 = root). */
  depth: number;
};

export type HierarchyCluster = {
  /** Registry key: `s:<id>` for a real root, `v:<normalized name>` for a virtual one. */
  key: string;
  /** Real supplier id of the root, or null when the root is not in the registry. */
  rootId: number | null;
  rootName: string;
  rootDomain: string | null;
  /** True when the parent company is referenced but not itself a supplier row. */
  isVirtualRoot: boolean;
  members: HierarchyMember[];
  /** Sum of member spend. */
  totalAmount: number;
  /** Members excluding the root. */
  subsidiaryCount: number;
};

export type HierarchyTree = {
  clusters: HierarchyCluster[];
  bySupplierId: Map<number, HierarchyCluster>;
  /** Suppliers whose parent link could not be resolved (dangling FK / cycle). */
  orphans: SupplierNode[];
  /** True when a parent->child cycle was detected and broken. */
  hadCycle: boolean;
};

const AMOUNT_KEYS = ['totalAmount', 'amount', 'total_amount'] as const;

/** Coerce `numeric` columns (returned as strings by postgres.js) to number. */
export function toAmount(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Read a spend value from either camelCase or snake_case row shapes. */
export function readAmount(row: Record<string, unknown>): number {
  for (const key of AMOUNT_KEYS) {
    if (key in row) return toAmount(row[key]);
  }
  return 0;
}

function isRootCandidate(node: SupplierNode, index: Map<number, SupplierNode>): boolean {
  if (node.parentId === null && !node.parentName) return true;
  if (node.parentId !== null && !index.has(node.parentId)) return true;
  return false;
}

/**
 * Group suppliers into parent-led clusters.
 *
 * @param nodes flat supplier rows (hierarchy columns only need to be populated)
 */
export function buildHierarchy(nodes: readonly SupplierNode[]): HierarchyTree {
  const index = new Map<number, SupplierNode>();
  for (const node of nodes) index.set(node.id, node);

  // -- cycle-safe root resolution -------------------------------------------
  const rootOf = new Map<number, number>();
  let hadCycle = false;

  const resolveRoot = (node: SupplierNode): number => {
    const cached = rootOf.get(node.id);
    if (cached !== undefined) return cached;

    const seen = new Set<number>([node.id]);
    let current = node;
    for (;;) {
      const parentId = current.parentId;
      if (parentId === null || !index.has(parentId)) break;
      if (seen.has(parentId)) {
        // Cycle: treat the current node as the root of its own cluster.
        hadCycle = true;
        break;
      }
      seen.add(parentId);
      current = index.get(parentId)!;
    }

    for (const id of seen) rootOf.set(id, current.id);
    return current.id;
  };

  // -- group real roots ------------------------------------------------------
  const clusters = new Map<string, HierarchyCluster>();
  const orphans: SupplierNode[] = [];

  const ensureRealCluster = (root: SupplierNode): HierarchyCluster => {
    const key = `s:${root.id}`;
    let cluster = clusters.get(key);
    if (!cluster) {
      cluster = {
        key,
        rootId: root.id,
        rootName: root.name,
        rootDomain: root.domain ?? root.parentDomain ?? null,
        isVirtualRoot: false,
        members: [],
        totalAmount: 0,
        subsidiaryCount: 0,
      };
      clusters.set(key, cluster);
    }
    return cluster;
  };

  const ensureVirtualCluster = (parentName: string, parentDomain: string | null): HierarchyCluster => {
    const normalized = normalizeSupplierName(parentName) || parentName.trim().toLowerCase();
    const key = `v:${normalized}`;
    let cluster = clusters.get(key);
    if (!cluster) {
      cluster = {
        key,
        rootId: null,
        rootName: parentName,
        rootDomain: parentDomain,
        isVirtualRoot: true,
        members: [],
        totalAmount: 0,
        subsidiaryCount: 0,
      };
      clusters.set(key, cluster);
    } else if (!cluster.rootDomain && parentDomain) {
      cluster.rootDomain = parentDomain;
    }
    return cluster;
  };

  const depthCache = new Map<number, number>();
  const depthOf = (node: SupplierNode): number => {
    const cached = depthCache.get(node.id);
    if (cached !== undefined) return cached;
    let depth = 0;
    let current = node;
    const seen = new Set<number>([node.id]);
    while (current.parentId !== null && index.has(current.parentId)) {
      if (seen.has(current.parentId)) break;
      seen.add(current.parentId);
      depth += 1;
      current = index.get(current.parentId)!;
      if (depth > 32) break;
    }
    depthCache.set(node.id, depth);
    return depth;
  };

  // -- virtual clusters for parent companies that are not in the registry ----
  // A supplier enriched with `parent_name` whose parent is not itself a tracked
  // supplier must still be grouped, otherwise nothing propagates to it.
  // Suppliers with a dangling `parent_id` are excluded here: they are reported
  // as orphans and treated as independent.
  const virtualMemberIds = new Set<number>();
  for (const node of nodes) {
    if (node.parentId !== null) continue;
    if (!node.parentName) continue;
    const parentKey = normalizeSupplierName(node.parentName);
    if (!parentKey) continue;
    // A parent name equal to the supplier's own name is an enrichment artefact.
    if (parentKey === normalizeSupplierName(node.name)) continue;
    virtualMemberIds.add(node.id);
  }

  const virtualClusters = new Map<number, HierarchyCluster>();
  for (const node of nodes) {
    if (!virtualMemberIds.has(node.id)) continue;
    const cluster = ensureVirtualCluster(node.parentName!, node.parentDomain ?? null);
    cluster.members.push({ supplier: node, isRoot: false, depth: 1 });
    virtualClusters.set(node.id, cluster);
  }

  // -- assign every other supplier to its real root cluster ------------------
  for (const node of nodes) {
    // A dangling FK (parent id present, row missing) is surfaced as an orphan
    // and treated as independent rather than joining the parent's family.
    if (node.parentId !== null && !index.has(node.parentId)) orphans.push(node);
    if (virtualClusters.has(node.id)) continue;

    let cluster: HierarchyCluster;
    if (isRootCandidate(node, index)) {
      cluster = ensureRealCluster(node);
    } else {
      const rootId = resolveRoot(node);
      const root = index.get(rootId)!;
      cluster = ensureRealCluster(root);
    }

    const depth = node.id === cluster.rootId ? 0 : Math.max(1, depthOf(node));
    cluster.members.push({ supplier: node, isRoot: node.id === cluster.rootId, depth });
  }

  // -- drop empty clusters, compute aggregates, sort members -----------------
  const result: HierarchyCluster[] = [];
  for (const cluster of clusters.values()) {
    if (!cluster.members.length) continue;
    cluster.members.sort((a, b) => {
      if (a.isRoot !== b.isRoot) return a.isRoot ? -1 : 1;
      return a.supplier.name.localeCompare(b.supplier.name);
    });
    cluster.totalAmount = cluster.members.reduce((sum, member) => sum + readAmount(member.supplier), 0);
    cluster.subsidiaryCount = cluster.members.filter((member) => !member.isRoot).length;
    result.push(cluster);
  }

  result.sort((a, b) => {
    if (b.subsidiaryCount !== a.subsidiaryCount) return b.subsidiaryCount - a.subsidiaryCount;
    return a.rootName.localeCompare(b.rootName);
  });

  const bySupplierId = new Map<number, HierarchyCluster>();
  for (const cluster of result) {
    for (const member of cluster.members) {
      bySupplierId.set(member.supplier.id, cluster);
    }
  }

  return { clusters: result, bySupplierId, orphans, hadCycle };
}

export type ClassificationAssignment = {
  /** Supplier that receives a classification. */
  supplierId: number;
  /** Reason the supplier is classified. */
  mode: 'direct' | 'parent' | 'inherit';
  /** For `inherit`, the id of the supplier whose code is copied (cluster root). */
  inheritFromSupplierId?: number | null;
  /** For `parent`, the parent company name when it is virtual. */
  parentName?: string | null;
};

export type ClassificationPlanItem = {
  clusterKey: string;
  rootName: string;
  rootDomain: string | null;
  isVirtualRoot: boolean;
  /**
   * Supplier that will actually be sent to the LLM. For virtual roots we pick
   * the richest member as the representative of the parent company.
   */
  representative: SupplierNode;
  /** Everything that inherits the representative's code (subsidiaries). */
  inheritTargets: SupplierNode[];
  /** Aggregate spend used to pick the model tier. */
  totalAmount: number;
  subsidiaries: number;
};

export type ClassificationPlan = {
  /** One item per distinct parent cluster. */
  parentItems: ClassificationPlanItem[];
  /** Suppliers with no parent at all. */
  standalone: SupplierNode[];
  /**
   * Assignments keyed by supplier id, describing how each supplier's current
   * classification should be produced.
   */
  assignments: Map<number, ClassificationAssignment>;
};

/** How much usable enrichment data a supplier has (higher = better prompt). */
export function enrichmentScore(node: SupplierNode): number {
  let score = 0;
  if (node.domain) score += 3;
  if (node.industry) score += 3;
  if (node.naics) score += 2;
  if (node.sic) score += 1;
  if (node.description) score += Math.min(3, Math.ceil((node.description?.length ?? 0) / 120));
  if (node.isParent) score += 1;
  return score;
}

/**
 * Pick the cluster member that gives the model the best signal: most enriched
 * data first, then largest spend, then name length.
 */
export function pickRepresentative(members: readonly HierarchyMember[]): SupplierNode | null {
  if (!members.length) return null;
  const ranked = [...members].sort((a, b) => {
    const scoreDiff = enrichmentScore(b.supplier) - enrichmentScore(a.supplier);
    if (scoreDiff !== 0) return scoreDiff;
    const amountDiff = readAmount(b.supplier as unknown as Record<string, unknown>)
      - readAmount(a.supplier as unknown as Record<string, unknown>);
    if (amountDiff !== 0) return amountDiff;
    return a.supplier.name.localeCompare(b.supplier.name);
  });
  return ranked[0]!.supplier;
}

/**
 * Decide what to classify. Parent companies are always classified before their
 * subsidiaries, so one billed request covers the whole cluster.
 */
export function planClassification(nodes: readonly SupplierNode[]): ClassificationPlan {
  const tree = buildHierarchy(nodes);
  const parentItems: ClassificationPlanItem[] = [];
  const standalone: SupplierNode[] = [];
  const assignments = new Map<number, ClassificationAssignment>();

  for (const cluster of tree.clusters) {
    // A virtual cluster exists only because its members named an external parent.
    // Even a single-member virtual cluster is classified as a family so the
    // prompt receives the parent-company context and any later subsidiary joins
    // the same cluster.
    const isFamily = cluster.members.length > 1 || cluster.isVirtualRoot;
    if (!isFamily) {
      const only = cluster.members[0]!.supplier;
      assignments.set(only.id, { supplierId: only.id, mode: 'direct' });
      if (!standalone.some((node) => node.id === only.id)) standalone.push(only);
      continue;
    }

    const representative = pickRepresentative(cluster.members);
    if (!representative) continue;

    const inheritTargets = cluster.members
      .map((member) => member.supplier)
      .filter((supplier) => supplier.id !== representative.id);

    parentItems.push({
      clusterKey: cluster.key,
      rootName: cluster.rootName,
      rootDomain: cluster.rootDomain,
      isVirtualRoot: cluster.isVirtualRoot,
      representative,
      inheritTargets,
      totalAmount: cluster.totalAmount,
      subsidiaries: cluster.subsidiaryCount,
    });

    assignments.set(representative.id, {
      supplierId: representative.id,
      mode: 'parent',
      parentName: cluster.isVirtualRoot ? cluster.rootName : null,
    });
    for (const target of inheritTargets) {
      assignments.set(target.id, {
        supplierId: target.id,
        mode: 'inherit',
        inheritFromSupplierId: representative.id,
      });
    }
  }

  return { parentItems, standalone, assignments };
}

/** All descendant ids of `rootId`, breadth-first, cycle-safe. */
export function collectDescendantIds(nodes: readonly SupplierNode[], rootId: number): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const bucket = childrenByParent.get(node.parentId);
    if (bucket) bucket.push(node.id);
    else childrenByParent.set(node.parentId, [node.id]);
  }

  const out: number[] = [];
  const seen = new Set<number>([rootId]);
  const queue = [...(childrenByParent.get(rootId) ?? [])];
  while (queue.length) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    queue.push(...(childrenByParent.get(next) ?? []));
  }
  return out;
}

/**
 * Suppliers affected by a parent-level correction: the parent itself plus every
 * descendant (recursively, cycle-safe).
 */
export function collectCorrectionScope(nodes: readonly SupplierNode[], parentId: number): number[] {
  return [parentId, ...collectDescendantIds(nodes, parentId)];
}

/** True when `candidateParentId` is inside the subtree rooted at `supplierId`. */
export function wouldCreateCycle(
  nodes: readonly SupplierNode[],
  supplierId: number,
  candidateParentId: number,
): boolean {
  if (supplierId === candidateParentId) return true;
  return collectDescendantIds(nodes, supplierId).includes(candidateParentId);
}

/** Serialisable dashboard roll-up: one row per parent cluster. */
export type ParentRollup = {
  clusterKey: string;
  parentId: number | null;
  parentName: string;
  parentDomain: string | null;
  isVirtualRoot: boolean;
  supplierCount: number;
  subsidiaryCount: number;
  totalAmount: number;
  unspscCode: string | null;
  confidence: number | null;
  staleCount: number;
  lowConfidenceCount: number;
};

export type RollupSupplierInput = SupplierNode & {
  classification?: {
    unspscCode: string;
    confidence: number;
    inheritedFromParent: boolean;
    reviewed: boolean;
  } | null;
  effectiveCode?: string | null;
};

/** Roll spend and classification up to the parent company. */
export function rollupByParent(
  nodes: readonly RollupSupplierInput[],
  lowConfidenceThreshold = 0.7,
): ParentRollup[] {
  const tree = buildHierarchy(nodes);
  const byId = new Map(nodes.map((node) => [node.id, node]));

  return tree.clusters.map((cluster) => {
    const rootNode = cluster.rootId !== null ? byId.get(cluster.rootId) : undefined;
    let totalAmount = 0;
    let staleCount = 0;
    let lowConfidenceCount = 0;
    const codes = new Map<string, number>();
    let confidenceSum = 0;
    let confidenceCount = 0;

    for (const member of cluster.members) {
      totalAmount += readAmount(member.supplier as unknown as Record<string, unknown>);
      if (member.supplier.stale) staleCount += 1;
      // `buildHierarchy` only reads the hierarchy columns, so the classification
      // enrichment on the input nodes is retrieved from the original list.
      const enriched = byId.get(member.supplier.id);
      const code = enriched?.effectiveCode ?? enriched?.classification?.unspscCode ?? null;
      if (code) codes.set(code, (codes.get(code) ?? 0) + 1);
      const confidence = enriched?.classification?.confidence;
      if (typeof confidence === 'number' && Number.isFinite(confidence)) {
        confidenceSum += confidence;
        confidenceCount += 1;
        if (confidence < lowConfidenceThreshold && !enriched?.classification?.reviewed) lowConfidenceCount += 1;
      }
    }

    // Dominant code = most members, tie-broken by the root's own code.
    let dominantCode: string | null = null;
    let bestCount = -1;
    for (const [code, codeCount] of codes) {
      if (codeCount > bestCount) {
        bestCount = codeCount;
        dominantCode = code;
      }
    }
    const rootCode = rootNode?.effectiveCode ?? rootNode?.classification?.unspscCode ?? null;
    if (rootCode) dominantCode = rootCode;
    return {
      clusterKey: cluster.key,
      parentId: cluster.rootId,
      parentName: cluster.rootName,
      parentDomain: cluster.rootDomain,
      isVirtualRoot: cluster.isVirtualRoot,
      supplierCount: cluster.members.length,
      subsidiaryCount: cluster.subsidiaryCount,
      totalAmount,
      unspscCode: dominantCode,
      confidence: confidenceCount ? confidenceSum / confidenceCount : null,
      staleCount,
      lowConfidenceCount,
    };
  });
}

/**
 * Human-readable tree lines used by the PDF hierarchy table and the CLI debug
 * output.
 */
export function flattenHierarchyForDisplay(tree: HierarchyTree): Array<{
  indent: number;
  name: string;
  supplierId: number | null;
  parentName: string;
  role: 'parent' | 'subsidiary';
}> {
  const rows: Array<{
    indent: number;
    name: string;
    supplierId: number | null;
    parentName: string;
    role: 'parent' | 'subsidiary';
  }> = [];

  for (const cluster of tree.clusters) {
    rows.push({
      indent: 0,
      name: cluster.rootName,
      supplierId: cluster.rootId,
      parentName: cluster.rootName,
      role: 'parent',
    });
    for (const member of cluster.members) {
      if (member.isRoot) continue;
      rows.push({
        indent: 1,
        name: member.supplier.name,
        supplierId: member.supplier.id,
        parentName: cluster.rootName,
        role: 'subsidiary',
      });
    }
  }
  return rows;
}
