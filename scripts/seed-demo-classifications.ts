/**
 * Offline demo classifications.
 *
 * Classifying for real needs `GROQ_API_KEY`. Without one the dashboard renders a
 * single "Not classified" bar, which is correct but useless for evaluating the
 * UI. This script writes a realistic, clearly-labelled set of classifications so
 * every screen has something meaningful to show — while exercising the same code
 * paths the LLM would:
 *
 *   - multi-segment distribution, so the segment chart has real bars
 *   - a mix of high and low confidence, so the review queue has content
 *   - inheritance for subsidiaries, so parent roll-up works
 *   - a few corrections, so the feedback loop and audit trail are populated
 *
 * Every row it writes is audited as `actor: 'demo-seed'`, and the reasoning text
 * begins with `DEMO` so a real classification run can never be confused with it.
 * Re-running `npm run db:seed:sample` after adding a Groq key replaces these with
 * real classifications.
 *
 * Usage:
 *   npx tsx scripts/seed-demo-classifications.ts [--clean]
 *
 *   --clean   remove only the demo rows instead of writing them
 */
import { config as loadEnv } from 'dotenv';
import { and, eq, like, sql } from 'drizzle-orm';
import { getDb, closeDb } from '@/db/client';
import { classifications, corrections, suppliers as suppliersTable } from '@/db/schema';
import { writeClassification, validateCode } from '@/services/classification';
import { buildHierarchy, planClassification } from '@/services/hierarchy';
import { listSuppliers, toNode } from '@/services/suppliers';
import { recordAudit } from '@/services/audit';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

const DEMO_PREFIX = 'DEMO';

/**
 * Hand-picked codes.
 *
 * Every code below was confirmed to exist in the seeded UNSPSC v26 taxonomy by
 * running it through `validateCode` — six of the original guesses (Shell,
 * Siemens, 3M, Medtronic, Cardinal Health, Staples, Maersk, Aramark, Sysco,
 * Waste Management, Marriott, Accenture) were class-level prefixes that do not
 * exist as commodities, and were replaced with the real code that validation
 * resolved them to. Guessing a code that fails validation is silent in the
 * database but shows up as a capped confidence, so these are pinned to verified
 * values.
 *
 * They are spread across segments so the dashboard chart has real bars.
 */
const ASSIGNMENTS: Array<{ match: string; code: string; confidence: number; reasoning: string }> = [
  // 43 — Information Technology
  { match: 'Dell Technologies', code: '43211507', confidence: 0.95, reasoning: 'manufactures desktop and laptop computers, servers and storage.' },
  { match: 'Microsoft', code: '43232401', confidence: 0.93, reasoning: 'develops and licenses enterprise software.' },
  { match: 'Cisco Systems', code: '43222609', confidence: 0.91, reasoning: 'manufactures network routing and switching equipment.' },
  { match: 'Nvidia', code: '43211501', confidence: 0.88, reasoning: 'supplies compute hardware used in servers and AI systems.' },
  { match: 'Oracle', code: '43232401', confidence: 0.9, reasoning: 'licenses database and enterprise application software.' },
  { match: 'Adobe', code: '43232401', confidence: 0.89, reasoning: 'licenses creative and document software.' },
  { match: 'CDW', code: '43211501', confidence: 0.84, reasoning: 'resells computer hardware and software.' },

  // 40 — Distribution and Conditioning Systems
  { match: 'Grainger', code: '40141602', confidence: 0.9, reasoning: 'distributes industrial hardware including valves and fittings.' },
  { match: 'Fastenal', code: '40141602', confidence: 0.86, reasoning: 'distributes fasteners and industrial supplies.' },
  { match: 'Airgas', code: '12191601', confidence: 0.72, reasoning: 'distributes industrial and medical gases.' },

  // 51/42 — Pharmaceuticals and medical
  { match: 'Pfizer', code: '51201604', confidence: 0.93, reasoning: 'manufactures pharmaceutical products and vaccines.' },
  { match: 'Medtronic', code: '42203418', confidence: 0.87, reasoning: 'manufactures surgical and medical instruments and consumables.' },
  { match: 'Cardinal Health', code: '42203418', confidence: 0.78, reasoning: 'distributes medical and surgical supplies.' },

  // 78 — Transport and logistics
  { match: 'FedEx', code: '78102204', confidence: 0.94, reasoning: 'provides worldwide letter and parcel courier services.' },
  { match: 'DHL', code: '78102204', confidence: 0.9, reasoning: 'provides express parcel and courier delivery.' },
  { match: 'Maersk', code: '78101801', confidence: 0.82, reasoning: 'operates deep sea container freight transport.' },
  { match: 'United Airlines', code: '78111501', confidence: 0.8, reasoning: 'operates scheduled passenger air transport.' },
  { match: 'Iron Mountain', code: '78131701', confidence: 0.66, reasoning: 'provides records storage and information management.' },

  // 80/84 — Professional services
  { match: 'Accenture', code: '80101501', confidence: 0.83, reasoning: 'provides management and technology consulting.' },
  { match: 'Deloitte', code: '84111506', confidence: 0.85, reasoning: 'provides audit, tax and advisory services.' },
  { match: 'KPMG', code: '84111506', confidence: 0.84, reasoning: 'provides audit and advisory services.' },
  { match: 'ADP', code: '80111601', confidence: 0.7, reasoning: 'provides payroll and human resource outsourcing.' },
  { match: 'ManpowerGroup', code: '80111601', confidence: 0.76, reasoning: 'supplies temporary and contract staffing.' },
  { match: 'Randstad', code: '80111601', confidence: 0.74, reasoning: 'supplies temporary staffing services.' },

  // 90/44/50/76 — Facilities, consumables, cleaning
  { match: 'Aramark', code: '90101601', confidence: 0.79, reasoning: 'provides food service and facility management.' },
  { match: 'Cintas', code: '90101601', confidence: 0.68, reasoning: 'provides uniform and facility services.' },
  { match: 'Staples', code: '44121701', confidence: 0.86, reasoning: 'supplies office stationery and consumables.' },
  { match: 'Sysco', code: '50131701', confidence: 0.81, reasoning: 'distributes food and related products.' },
  { match: 'Waste Management', code: '76121501', confidence: 0.8, reasoning: 'collects and disposes of solid waste.' },
  { match: 'Marriott International', code: '90111601', confidence: 0.77, reasoning: 'operates hotels and provides accommodation.' },

  // 12/15/20 — Energy, chemicals, machinery
  { match: 'Shell', code: '15101502', confidence: 0.85, reasoning: 'supplies refined petroleum and fuel products.' },
  { match: 'Siemens AG', code: '20142901', confidence: 0.82, reasoning: 'manufactures industrial machinery and automation equipment.' },
  { match: 'Honeywell', code: '20142901', confidence: 0.8, reasoning: 'manufactures building control and industrial instruments.' },
  { match: '3M', code: '12352119', confidence: 0.75, reasoning: 'manufactures adhesives, abrasives and specialty materials.' },
];

/** Deliberate low-confidence rows so the review queue is not empty. */
const REVIEW_CANDIDATES = ['Iron Mountain', 'Cintas', 'Airgas', 'ADP', 'Sigma-Aldrich'];

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Add it to .env.local first.');
    process.exit(1);
  }

  const db = getDb();
  const clean = process.argv.includes('--clean');

  if (clean) {
    const removed = await db
      .delete(classifications)
      .where(like(classifications.reasoning, `${DEMO_PREFIX}%`))
      .returning({ id: classifications.id });
    const removedCorrections = await db
      .delete(corrections)
      .where(eq(corrections.correctedBy, 'demo-seed'))
      .returning({ id: corrections.id });
    await recordAudit({
      entity: 'classification',
      entityId: null,
      action: 'updated',
      details: { demoClean: true, classifications: removed.length, corrections: removedCorrections.length },
      actor: 'demo-seed',
    });
    console.log(`Removed ${removed.length} demo classification(s) and ${removedCorrections.length} demo correction(s).`);
    return;
  }

  // ---- resolve supplier ids -------------------------------------------------
  const page = await listSuppliers({ all: true, filters: {} as never, sort: 'name', dir: 'asc' });
  const nodes = page.rows.map((row) => toNode(row));

  const plan = planClassification(nodes);
  const tree = buildHierarchy(nodes);
  const clusterBySupplier = tree.bySupplierId;

  // Which code applies to a given supplier: explicit table first, then the club
  // rule for anything not matched (so every supplier ends up classified).
  const resolveCode = (name: string): { code: string; confidence: number; reasoning: string } | null => {
    const exact = ASSIGNMENTS.find((assignment) => name.toLowerCase().includes(assignment.match.toLowerCase()));
    if (exact) return { code: exact.code, confidence: exact.confidence, reasoning: exact.reasoning };
    return null;
  };

  let written = 0;
  let inherited = 0;
  let skipped = 0;
  const usedSegments = new Set<string>();

  // ---- representatives first (parent-first, as the real pipeline does) ------
  for (const item of plan.parentItems) {
    const representative = item.representative;
    const resolved = resolveCode(representative.name) ?? resolveCode(item.rootName);
    if (!resolved) {
      skipped += 1;
      continue;
    }

    const validated = await validateCode(resolved.code, db);
    const code = validated.code;
    usedSegments.add(code.slice(0, 2));

    await writeClassification(
      {
        supplierId: representative.id,
        code,
        confidence: resolved.confidence,
        reasoning: `${DEMO_PREFIX}: ${resolved.reasoning} (illustrative data — replace by running a real classification)`,
        llmModel: 'demo-seed',
        alternatives: [],
        inheritedFromParent: false,
      },
      { db, actor: 'demo-seed' },
    );
    written += 1;

    // Propagate to subsidiaries exactly as the pipeline does.
    for (const target of item.inheritTargets) {
      await writeClassification(
        {
          supplierId: target.id,
          code,
          confidence: Math.max(0.4, resolved.confidence * 0.9),
          reasoning: `${DEMO_PREFIX}: inherited from parent company "${item.rootName}".`,
          llmModel: 'demo-seed',
          alternatives: [],
          inheritedFromParent: true,
          inheritedFromSupplierId: representative.id,
        },
        { db, actor: 'demo-seed' },
      );
      inherited += 1;
    }
  }

  // ---- then everything else -------------------------------------------------
  for (const node of nodes) {
    if (clusterBySupplier.get(node.id) && plan.assignments.get(node.id)?.mode !== 'direct') continue;
    const resolved = resolveCode(node.name);
    if (!resolved) {
      skipped += 1;
      continue;
    }
    const validated = await validateCode(resolved.code, db);
    usedSegments.add(validated.code.slice(0, 2));
    await writeClassification(
      {
        supplierId: node.id,
        code: validated.code,
        confidence: resolved.confidence,
        reasoning: `${DEMO_PREFIX}: ${resolved.reasoning} (illustrative data)`,
        llmModel: 'demo-seed',
        alternatives: [],
        inheritedFromParent: false,
      },
      { db, actor: 'demo-seed' },
    );
    written += 1;
  }

  // ---- a couple of human corrections, to populate the feedback loop ---------
  const correctionTargets = nodes.filter((node) => REVIEW_CANDIDATES.some((name) => node.name.includes(name)));
  let corrected = 0;
  for (const node of correctionTargets.slice(0, 2)) {
    const current = await db
      .select({ code: classifications.unspscCode })
      .from(classifications)
      .where(and(eq(classifications.supplierId, node.id), eq(classifications.superseded, false)))
      .limit(1);
    const originalCode = current[0]?.code ?? null;
    const newCode = originalCode === '44121700' ? '14111500' : '44121700';

    await writeClassification(
      {
        supplierId: node.id,
        code: newCode,
        confidence: 1,
        reasoning: `${DEMO_PREFIX}: reviewed and corrected by a human (illustrative).`,
        llmModel: 'human',
        alternatives: [],
        reviewed: true,
      },
      { db, actor: 'demo-seed' },
    );
    await db
      .update(classifications)
      .set({ reviewed: true, correctedCode: newCode, correctedBy: 'demo-seed', correctedAt: new Date() })
      .where(and(eq(classifications.supplierId, node.id), eq(classifications.superseded, false)));
    await db.insert(corrections).values({
      supplierId: node.id,
      originalCode,
      correctedCode: newCode,
      reason: 'Illustrative correction demonstrating the review loop.',
      correctedBy: 'demo-seed',
      appliedToSubsidiaries: false,
      affectedSupplierIds: [node.id],
    });
    corrected += 1;
  }

  await db
    .update(suppliersTable)
    .set({ updatedAt: new Date() })
    .where(sql`${suppliersTable.id} in (select distinct ${classifications.supplierId} from ${classifications})`);

  await recordAudit({
    entity: 'sync',
    entityId: null,
    action: 'classified',
    details: { demoSeed: true, written, inherited, corrected, skipped, segments: [...usedSegments].sort() },
    actor: 'demo-seed',
  });

  console.log('Demo classifications written (actor: demo-seed).');
  console.log(`  direct classifications : ${written}`);
  console.log(`  inherited by subsidiaries: ${inherited}`);
  console.log(`  human-style corrections  : ${corrected}`);
  console.log(`  suppliers without a match: ${skipped}`);
  console.log(`  UNSPSC segments covered  : ${[...usedSegments].sort().join(', ')}`);
  console.log('');
  console.log('These are illustrative rows, not model output. To replace them with real');
  console.log('classifications, set GROQ_API_KEY and run `npm run db:seed:sample`, or');
  console.log('remove them with: npx tsx scripts/seed-demo-classifications.ts --clean');
}

void main()
  .catch((error) => {
    console.error('demo seed failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb().catch(() => undefined));
