/**
 * Parent/subsidiary propagation tests.
 *
 * These cover the core promise of the feature: classify the parent once, then
 * propagate the code to every subsidiary — including nested chains — while
 * refusing to create cycles.
 */
import { describe, expect, it } from 'vitest';
import {
  buildHierarchy,
  collectCorrectionScope,
  collectDescendantIds,
  enrichmentScore,
  flattenHierarchyForDisplay,
  pickRepresentative,
  planClassification,
  readAmount,
  rollupByParent,
  wouldCreateCycle,
  type SupplierNode,
} from '@/services/hierarchy';

function node(partial: Partial<SupplierNode> & { id: number; name: string }): SupplierNode {
  return {
    parentId: null,
    parentName: null,
    isParent: false,
    ...partial,
  };
}

const suppliers: SupplierNode[] = [
  node({ id: 1, name: 'Dell Technologies', isParent: true, domain: 'dell.com', industry: 'Computer manufacturing', naics: '334111', totalAmount: '1250000.00' }),
  node({ id: 2, name: 'EMC Corporation', parentId: 1, parentName: 'Dell Technologies', domain: 'emc.com', industry: 'Computer storage', totalAmount: '184500.50' }),
  node({ id: 3, name: 'VMware', parentId: 1, parentName: 'Dell Technologies', domain: 'vmware.com', totalAmount: '96500.00' }),
  node({ id: 4, name: 'Grainger', domain: 'grainger.com', industry: 'Industrial supplies', naics: '423840', totalAmount: '52300.00' }),
  node({ id: 5, name: 'Microsoft', isParent: true, domain: 'microsoft.com', industry: 'Software publishing', naics: '511210', totalAmount: '875000.00' }),
  node({ id: 6, name: 'LinkedIn', parentId: 5, parentName: 'Microsoft', totalAmount: '42000.00' }),
  node({ id: 7, name: 'Independent Traders', totalAmount: '1000.00' }),
];

describe('buildHierarchy', () => {
  it('groups subsidiaries under their parent', () => {
    const tree = buildHierarchy(suppliers);
    const dell = tree.clusters.find((cluster) => cluster.rootId === 1);
    expect(dell).toBeDefined();
    expect(dell?.members).toHaveLength(3);
    expect(dell?.subsidiaryCount).toBe(2);
    expect(dell?.members[0]?.isRoot).toBe(true);
    expect(dell?.members[0]?.supplier.name).toBe('Dell Technologies');
  });

  it('sums cluster spend', () => {
    const tree = buildHierarchy(suppliers);
    const dell = tree.clusters.find((cluster) => cluster.rootId === 1);
    expect(dell?.totalAmount).toBeCloseTo(1_250_000 + 184_500.5 + 96_500, 2);
  });

  it('keeps independent suppliers in single-member clusters', () => {
    const tree = buildHierarchy(suppliers);
    const grainger = tree.clusters.find((cluster) => cluster.rootId === 4);
    expect(grainger?.members).toHaveLength(1);
    expect(grainger?.subsidiaryCount).toBe(0);
  });

  it('collapses a multi-level chain into one cluster rooted at the top company', () => {
    const chain = [
      node({ id: 10, name: 'Top Co', isParent: true }),
      node({ id: 11, name: 'Middle Co', parentId: 10, parentName: 'Top Co', isParent: true }),
      node({ id: 12, name: 'Bottom Co', parentId: 11, parentName: 'Middle Co' }),
    ];
    const tree = buildHierarchy(chain);
    expect(tree.clusters).toHaveLength(1);
    expect(tree.clusters[0]?.rootId).toBe(10);
    expect(tree.clusters[0]?.members).toHaveLength(3);
    // Depth is preserved for display.
    const bottom = tree.clusters[0]?.members.find((member) => member.supplier.id === 12);
    expect(bottom?.depth).toBeGreaterThanOrEqual(1);
  });

  it('breaks cycles instead of hanging', () => {
    const cycle = [
      node({ id: 20, name: 'A', parentId: 21, parentName: 'B' }),
      node({ id: 21, name: 'B', parentId: 20, parentName: 'A' }),
    ];
    const tree = buildHierarchy(cycle);
    expect(tree.hadCycle).toBe(true);
    expect(tree.clusters.length).toBeGreaterThan(0);
    expect(tree.clusters.reduce((sum, cluster) => sum + cluster.members.length, 0)).toBe(2);
  });

  it('groups suppliers that name an external parent not present in the registry', () => {
    const virtual = [
      node({ id: 30, name: 'Siemens Healthineers', parentName: 'Siemens AG', parentDomain: 'siemens.com' }),
      node({ id: 31, name: 'Mentor Graphics', parentName: 'Siemens AG' }),
    ];
    const tree = buildHierarchy(virtual);
    const cluster = tree.clusters.find((item) => item.rootName === 'Siemens AG');
    expect(cluster?.isVirtualRoot).toBe(true);
    expect(cluster?.members).toHaveLength(2);
    expect(cluster?.subsidiaryCount).toBe(2);
  });

  it('treats a dangling parent id as an orphan root', () => {
    const dangling = [node({ id: 40, name: 'Orphan Co', parentId: 999, parentName: 'Ghost Co' })];
    const tree = buildHierarchy(dangling);
    expect(tree.clusters).toHaveLength(1);
    expect(tree.clusters[0]?.rootId).toBe(40);
    // A dangling FK is reported as an orphan and is NOT also attached to a
    // virtual cluster for "Ghost Co" (which would double-count its spend).
    expect(tree.orphans.map((item) => item.id)).toContain(40);
    expect(tree.clusters.some((cluster) => cluster.isVirtualRoot)).toBe(false);
  });
});

describe('collectDescendantIds', () => {
  it('returns nested descendants breadth-first', () => {
    const chain = [
      node({ id: 1, name: 'Root' }),
      node({ id: 2, name: 'Child A', parentId: 1 }),
      node({ id: 3, name: 'Child B', parentId: 1 }),
      node({ id: 4, name: 'Grandchild', parentId: 2 }),
    ];
    expect(collectDescendantIds(chain, 1).sort()).toEqual([2, 3, 4]);
    expect(collectDescendantIds(chain, 3)).toEqual([]);
  });

  it('is safe with cycles', () => {
    const cycle = [
      node({ id: 1, name: 'A', parentId: 2 }),
      node({ id: 2, name: 'B', parentId: 1 }),
    ];
    expect(collectDescendantIds(cycle, 1)).toEqual([2]);
  });
});

describe('collectCorrectionScope', () => {
  it('includes the parent and every descendant', () => {
    const chain = [
      node({ id: 1, name: 'Root' }),
      node({ id: 2, name: 'Child', parentId: 1 }),
      node({ id: 3, name: 'Grandchild', parentId: 2 }),
      node({ id: 9, name: 'Unrelated' }),
    ];
    expect(collectCorrectionScope(chain, 1).sort()).toEqual([1, 2, 3]);
  });
});

describe('wouldCreateCycle', () => {
  it('detects self-links and ancestor links', () => {
    const chain = [
      node({ id: 1, name: 'Root' }),
      node({ id: 2, name: 'Child', parentId: 1 }),
    ];
    expect(wouldCreateCycle(chain, 1, 1)).toBe(true);
    expect(wouldCreateCycle(chain, 1, 2)).toBe(true);
    expect(wouldCreateCycle(chain, 2, 1)).toBe(false);
  });
});

describe('enrichmentScore and pickRepresentative', () => {
  it('prefers the member with the richest enrichment data', () => {
    const members = [
      { supplier: node({ id: 1, name: 'Bare' }), isRoot: false, depth: 1 },
      {
        supplier: node({
          id: 2,
          name: 'Rich',
          domain: 'rich.com',
          industry: 'Software',
          naics: '511210',
          sic: '7372',
          description: 'A long description about the specific products this company sells to enterprises.',
        }),
        isRoot: false,
        depth: 1,
      },
    ];
    expect(enrichmentScore(members[1]!.supplier)).toBeGreaterThan(enrichmentScore(members[0]!.supplier));
    expect(pickRepresentative(members)?.id).toBe(2);
  });

  it('falls back to spend when both members are equally enriched', () => {
    const members = [
      { supplier: node({ id: 1, name: 'Small', domain: 'a.com', totalAmount: '10' }), isRoot: false, depth: 1 },
      { supplier: node({ id: 2, name: 'Big', domain: 'b.com', totalAmount: '900000' }), isRoot: false, depth: 1 },
    ];
    expect(pickRepresentative(members)?.id).toBe(2);
  });
});

describe('planClassification', () => {
  it('classifies the parent first and marks subsidiaries to inherit', () => {
    const plan = planClassification(suppliers);

    const dell = plan.parentItems.find((item) => item.representative.id === 1);
    expect(dell).toBeDefined();
    expect(dell?.inheritTargets.map((target) => target.id).sort()).toEqual([2, 3]);

    expect(plan.assignments.get(1)).toEqual({ supplierId: 1, mode: 'parent', parentName: null });
    expect(plan.assignments.get(2)).toEqual({ supplierId: 2, mode: 'inherit', inheritFromSupplierId: 1 });
    expect(plan.assignments.get(3)).toEqual({ supplierId: 3, mode: 'inherit', inheritFromSupplierId: 1 });
  });

  it('classifies independent suppliers directly', () => {
    const plan = planClassification(suppliers);
    expect(plan.assignments.get(4)?.mode).toBe('direct');
    expect(plan.standalone.map((item) => item.id).sort()).toEqual([4, 7]);
  });

  it('uses one representative for a virtual parent cluster', () => {
    // Both suppliers name an external parent that is not in the registry, so the
    // cluster has a virtual root and one member is chosen as the representative.
    const virtual = [
      node({ id: 30, name: 'Siemens Healthineers', parentName: 'Siemens AG', parentDomain: 'siemens.com', domain: 'siemens-healthineers.com', industry: 'Medical devices' }),
      node({ id: 31, name: 'Mentor Graphics', parentName: 'Siemens AG' }),
    ];
    const plan = planClassification(virtual);
    expect(plan.parentItems).toHaveLength(1);
    const item = plan.parentItems[0]!;
    expect(item.isVirtualRoot).toBe(true);
    expect(item.rootName).toBe('Siemens AG');
    // The representative is the better-enriched member.
    expect(item.representative.id).toBe(30);
    expect(item.inheritTargets.map((target) => target.id)).toEqual([31]);
    expect(plan.assignments.get(30)).toEqual({ supplierId: 30, mode: 'parent', parentName: 'Siemens AG' });
    expect(plan.assignments.get(31)?.mode).toBe('inherit');
    // The virtual parent is not a real supplier row, so nothing is billed twice.
    expect(plan.standalone.some((supplier) => supplier.id === 30 || supplier.id === 31)).toBe(false);
  });

  it('produces one plan entry per corporate family', () => {
    const plan = planClassification(suppliers);
    expect(plan.parentItems).toHaveLength(2);
    expect(plan.parentItems.map((item) => item.clusterKey).sort()).toEqual(['s:1', 's:5']);
  });

  it('always assigns every supplier', () => {
    const plan = planClassification(suppliers);
    expect(plan.assignments.size).toBe(suppliers.length);
  });
});

describe('rollupByParent', () => {
  it('rolls spend and the dominant code up to the parent', () => {
    const rows = suppliers.map((supplier) => ({
      ...supplier,
      classification: { unspscCode: '43211500', confidence: 0.9, inheritedFromParent: false, reviewed: false },
      effectiveCode: '43211500',
    }));
    const rollups = rollupByParent(rows, 0.7);
    const dell = rollups.find((rollup) => rollup.parentId === 1);
    expect(dell?.supplierCount).toBe(3);
    expect(dell?.subsidiaryCount).toBe(2);
    expect(dell?.unspscCode).toBe('43211500');
    expect(dell?.totalAmount).toBeCloseTo(1_531_000.5, 2);
  });

  it('counts stale and low-confidence suppliers per family', () => {
    const rows = [
      {
        ...suppliers[0]!,
        stale: true,
        classification: { unspscCode: '43211500', confidence: 0.95, inheritedFromParent: false, reviewed: false },
        effectiveCode: '43211500',
      },
      {
        ...suppliers[1]!,
        classification: { unspscCode: '43211500', confidence: 0.4, inheritedFromParent: true, reviewed: false },
        effectiveCode: '43211500',
      },
      {
        ...suppliers[2]!,
        classification: { unspscCode: '43211500', confidence: 0.3, inheritedFromParent: true, reviewed: true },
        effectiveCode: '43211500',
      },
    ];
    const rollup = rollupByParent(rows, 0.7).find((item) => item.parentId === 1);
    expect(rollup?.staleCount).toBe(1);
    // The reviewed row is excluded even though its confidence is below threshold.
    expect(rollup?.lowConfidenceCount).toBe(1);
  });
});

describe('formatting helpers', () => {
  it('coerces numeric strings returned by postgres.js', () => {
    expect(readAmount({ totalAmount: '1234.50' })).toBe(1234.5);
    expect(readAmount({ amount: 10 })).toBe(10);
    expect(readAmount({ total_amount: '5' })).toBe(5);
    expect(readAmount({})).toBe(0);
    expect(readAmount({ totalAmount: null })).toBe(0);
  });

  it('flattens the tree with indentation for display', () => {
    const tree = buildHierarchy(suppliers);
    const rows = flattenHierarchyForDisplay(tree);
    expect(rows[0]).toMatchObject({ indent: 0, role: 'parent' });
    expect(rows.some((row) => row.role === 'subsidiary' && row.indent === 1)).toBe(true);
  });
});
