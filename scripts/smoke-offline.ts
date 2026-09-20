/**
 * Offline smoke test for the pure pipeline: no database, no network.
 *
 * It exercises the exact code paths a real upload takes — CSV parse, dedupe,
 * hierarchy build, parent-first planning, prompt construction and report
 * rendering — and fails loudly if any of them regress. This is what CI runs when
 * no Neon instance is available.
 *
 *   npx tsx scripts/smoke-offline.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSupplierCsv } from '@/lib/csv';
import { normalizeSupplierName } from '@/lib/normalize';
import { mapCsvRecordToSupplier, toNode, type SupplierListRow } from '@/services/suppliers';
import { buildHierarchy, planClassification, rollupByParent } from '@/services/hierarchy';
import { buildClassificationUserPrompt } from '@/services/prompts';
import { sanitizePdfText } from '@/services/reporting/pdf';
import { parseReportFilters, describeFilters } from '@/lib/validation';

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function assert(condition: unknown, message: string): void {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`ok: ${message}`);
}

function main(): void {
  section('1. CSV parsing');
  const raw = readFileSync(resolve(process.cwd(), 'samples/suppliers.csv'), 'utf8');
  const parsed = parseSupplierCsv(raw, { comment: '#' });
  console.log(`rows=${parsed.records.length} columns=${parsed.headers.join(',')}`);
  assert(parsed.records.length > 100, 'sample file parses into 100+ records');
  assert(parsed.detectedDelimiter === ',', 'comma delimiter detected');

  section('2. Dedupe + normalisation');
  const inputs = parsed.records
    .map((record) => mapCsvRecordToSupplier(record))
    .filter((value): value is NonNullable<typeof value> => value !== null);

  const byKey = new Map<string, { names: Set<string>; total: number }>();
  for (const input of inputs) {
    const key = normalizeSupplierName(input.name);
    const bucket = byKey.get(key) ?? { names: new Set<string>(), total: 0 };
    bucket.names.add(input.name);
    bucket.total += input.amount ?? 0;
    byKey.set(key, bucket);
  }
  console.log(`unique suppliers after dedupe: ${byKey.size} (from ${inputs.length} rows)`);
  assert(byKey.size < inputs.length, 'the file contains duplicates that fold together');

  const acme = byKey.get('acme');
  assert(acme !== undefined, 'ACME spellings collapse to one key');
  if (acme) {
    console.log(`acme names folded: ${[...acme.names].join(' | ')} total=${acme.total.toFixed(2)}`);
    assert(acme.names.size === 2, 'both ACME spellings merged');
  }

  const grainger = byKey.get('grainger');
  assert(grainger !== undefined, 'Grainger resolves to a single parent key');
  // Regional entities keep distinct keys but point at the shared parent.
  assert(byKey.has('w w grainger canada') && byKey.has('w w grainger mexico'), 'regional Grainger entities stay distinct');
  const graingerSubs = inputs.filter((input) => normalizeSupplierName(input.parentName ?? '') === 'grainger');
  assert(graingerSubs.length === 2, 'two Grainger entities declare Grainger as their parent');

  section('3. Hierarchy from the real sample');
  // Build nodes as the API would after enrichment+classification, using the
  // parent column from the CSV so the hierarchy logic runs for real.
  let nextId = 1;
  const idByName = new Map<string, number>();
  for (const input of inputs) {
    const key = normalizeSupplierName(input.name);
    if (!idByName.has(key)) idByName.set(key, nextId++);
  }

  const nodes = [...byKey.entries()].map(([key, bucket]) => {
    const first = inputs.find((input) => normalizeSupplierName(input.name) === key)!;
    const parentKey = first.parentName ? normalizeSupplierName(first.parentName) : null;
    const parentId = parentKey ? idByName.get(parentKey) ?? null : null;
    return {
      id: idByName.get(key)!,
      name: first.name,
      parentId,
      parentName: first.parentName ?? null,
      isParent: parentId === null && inputs.some((input) => input.parentName && normalizeSupplierName(input.parentName) === key),
      domain: first.domain ?? null,
      industry: first.industry ?? null,
      naics: first.naics ?? null,
      totalAmount: bucket.total,
    };
  });

  const tree = buildHierarchy(nodes);
  const families = tree.clusters.filter((cluster) => cluster.subsidiaryCount > 0);
  console.log(`clusters=${tree.clusters.length} families=${families.length} orphans=${tree.orphans.length} cycle=${tree.hadCycle}`);
  assert(!tree.hadCycle, 'no cycles detected in the sample');
  assert(tree.orphans.length === 0, 'every parent link resolves to a real supplier row');
  assert(families.length >= 5, 'at least five corporate families detected');

  const dell = families.find((cluster) => cluster.rootName.startsWith('Dell'));
  if (dell) {
    console.log(`Dell family: ${dell.members.map((member) => member.supplier.name).join(', ')}`);
    assert(dell.subsidiaryCount === 2, 'Dell has 2 subsidiaries (EMC, VMware)');
  } else {
    assert(false, 'Dell family found');
  }

  section('4. Parent-first classification plan');
  const plan = planClassification(nodes);
  console.log(
    `parent clusters=${plan.parentItems.length} standalone=${plan.standalone.length} assignments=${plan.assignments.size}`,
  );
  assert(plan.assignments.size === nodes.length, 'every supplier has an assignment');
  assert(
    plan.parentItems.every((item) => item.inheritTargets.length > 0),
    'every planned parent cluster has at least one inheriting subsidiary',
  );
  const inherited = [...plan.assignments.values()].filter((assignment) => assignment.mode === 'inherit');
  console.log(`subsidiaries inheriting a parent code: ${inherited.length}`);
  assert(inherited.length >= 8, 'at least eight subsidiaries inherit from a parent');

  // Batching: one request per 10 representatives.
  const estimatedRequests =
    Math.ceil(plan.parentItems.length / 10) + Math.ceil(plan.standalone.length / 10);
  console.log(`estimated Groq requests for the whole file: ${estimatedRequests} (vs ${nodes.length} without grouping)`);
  assert(estimatedRequests < nodes.length, 'batching saves requests versus one call per supplier');

  section('5. Prompt construction');
  const representative = plan.parentItems[0]!;
  const prompt = buildClassificationUserPrompt({
    supplier_name: representative.representative.name,
    domain: representative.representative.domain,
    industry: representative.representative.industry,
    naics: representative.representative.naics,
    known_subsidiaries: representative.inheritTargets.map((target) => target.name),
  });
  assert(prompt.includes('unspsc_code'), 'prompt states the JSON contract');
  assert(prompt.includes('Dell Technologies'), 'few-shot examples present');
  assert(prompt.includes(representative.representative.name), 'subject supplier present');
  console.log(`prompt length: ${prompt.length} chars`);

  section('6. Report roll-up');
  const rollupInputs = nodes.map((node) => ({
    ...node,
    classification: {
      unspscCode: '43211500',
      confidence: 0.9,
      inheritedFromParent: false,
      reviewed: false,
    },
    effectiveCode: '43211500',
  }));
  const rollups = rollupByParent(rollupInputs, 0.7);
  const top = [...rollups].sort((a, b) => b.totalAmount - a.totalAmount)[0];
  console.log(`top parent by spend: ${top?.parentName} = ${top?.totalAmount.toFixed(2)} (${top?.subsidiaryCount} subs)`);
  assert(rollups.length === tree.clusters.length, 'one roll-up row per cluster');
  assert((top?.totalAmount ?? 0) > 0, 'roll-up aggregates spend');

  section('7. Export filters + PDF text safety');
  const filters = parseReportFilters(
    new URLSearchParams({ minConfidence: '0.7', segment: '43', rollup: 'parent', onlyStale: 'true' }),
  );
  console.log(describeFilters(filters).join(' | '));
  assert(filters.rollup === 'parent', 'rollup parsed');
  assert(filters.onlyStale === true, 'boolean filter parsed');
  assert(sanitizePdfText('Café “Dell’s” — Ltd… ☕') === 'Café "Dell\'s" - Ltd...', 'PDF text sanitised');

  section('8. List-row node conversion');
  const sampleRow: SupplierListRow = {
    id: 1,
    name: 'Dell Technologies',
    normalizedName: 'dell technologies',
    domain: 'dell.com',
    industry: 'Computer manufacturing',
    naics: '334111',
    sic: '3571',
    description: null,
    country: 'US',
    totalAmount: 1250000,
    transactionCount: 3,
    currency: 'USD',
    parentId: null,
    parentName: null,
    parentDomain: null,
    isParent: true,
    parentSource: null,
    parentConfidence: null,
    enrichedAt: '2024-06-01T00:00:00.000Z',
    enrichedAtAgeDays: 1,
    lastEnrichError: null,
    stale: false,
    staleReason: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-06-01T00:00:00.000Z',
    subsidiaryCount: 2,
    classification: {
      id: 1,
      unspscCode: '43211500',
      effectiveCode: '43211500',
      confidence: 0.95,
      reasoning: null,
      llmModel: 'llama-3.3-70b-versatile',
      inheritedFromParent: false,
      reviewed: false,
      correctedCode: null,
      correctedBy: null,
      segment: 'Information Technology',
      segmentCode: '43',
      family: 'Computer accessories',
      className: 'Computers',
      commodity: 'Computers',
      codeDescription: null,
    },
  };
  const node = toNode(sampleRow);
  assert(node.id === 1 && node.effectiveCode === '43211500', 'list row converts to a hierarchy node');

  console.log('\n' + (process.exitCode ? 'SMOKE TEST FAILED' : 'SMOKE TEST PASSED'));
}

main();
