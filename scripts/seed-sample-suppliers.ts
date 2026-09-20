/**
 * Seed the sample suppliers (`samples/suppliers.csv`) and run the full pipeline
 * once, in the same order the app does:
 *
 *   1. upsert suppliers (dedupe on normalised name)
 *   2. enrich (cache-first; skipped entirely when no provider is configured)
 *   3. resolve parent/subsidiary links
 *   4. classify parent-first, propagating codes to subsidiaries
 *   5. print a summary and the resulting hierarchy
 *
 * Usage:
 *   npm run db:seed:sample                       # uses samples/suppliers.csv
 *   npm run db:seed:sample -- --file=samples/transactions.csv
 *   npm run db:seed:sample -- --skip-enrich      # classification only
 */
import { config as loadEnv } from 'dotenv';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Papa from 'papaparse';
import { getEnv } from '@/lib/env';
import { closeDb, getDb } from '@/db/client';
import {
  bulkUpsertSuppliers,
  extractCsvDate,
  getSupplierStats,
  listSuppliers,
  mapCsvRecordToSupplier,
  toNode,
} from '@/services/suppliers';
import { enrichSuppliers, resolveParentLinks } from '@/services/enrichment';
import { classifySuppliers } from '@/services/classification';
import { buildHierarchy, flattenHierarchyForDisplay } from '@/services/hierarchy';
import { generateReport } from '@/services/reporting/store';
import { reportFilename } from '@/services/reporting/csv';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Add it to .env.local and run `npm run db:migrate` first.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const fileArg = args.find((arg) => arg.startsWith('--file='))?.split('=')[1];
  const skipEnrich = args.includes('--skip-enrich');
  const skipClassify = args.includes('--skip-classify');
  const filePath = resolve(root, fileArg ?? 'samples/suppliers.csv');

  console.log(`Seeding sample suppliers from ${filePath}`);

  const csv = readFileSync(filePath, 'utf8');
  const parsed = Papa.parse<Record<string, unknown>>(csv.replace(/^\uFEFF/, ''), {
    header: true,
    skipEmptyLines: 'greedy',
    comments: '#',
    transformHeader: (header) => header.replace(/^\uFEFF/, '').trim(),
  });

  const inputs = (parsed.data ?? [])
    .map((record) => {
      const mapped = mapCsvRecordToSupplier(record);
      if (!mapped) return null;
      const date = extractCsvDate(record);
      if (date) mapped.description = mapped.description ?? `Latest transaction date: ${date}`;
      return mapped;
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);

  if (!inputs.length) {
    console.error('No usable rows found. Check that the CSV has a supplier name column.');
    process.exit(1);
  }

  const upsert = await bulkUpsertSuppliers(inputs, { actor: 'seed-script' });
  console.log(
    `Upsert: ${upsert.created} created, ${upsert.updated} updated, ${upsert.unchanged} unchanged, ` +
      `${upsert.duplicateRowsInFile} duplicate row(s) folded, ${upsert.errors.length} error(s).`,
  );

  const env = getEnv();
  const enrichmentConfigured = env.ENRICH_PROVIDER !== 'none' && Boolean(env.ENRICH_API_KEY);

  if (!skipEnrich) {
    if (enrichmentConfigured) {
      const enrichment = await enrichSuppliers(upsert.supplierIds, { actor: 'seed-script', detectParent: true });
      console.log(
        `Enrichment: ${enrichment.enriched} enriched, ${enrichment.cached} cached, ${enrichment.failed} failed, ` +
          `${enrichment.creditsUsed} credit(s), ${enrichment.llmParentCalls} LLM parent call(s).`,
      );
    } else {
      console.log('Enrichment skipped: ENRICH_PROVIDER/ENRICH_API_KEY are not configured.');
    }
  }

  const links = await resolveParentLinks({ supplierIds: upsert.supplierIds, actor: 'seed-script' });
  console.log(`Parent links: ${links.linked} linked, ${links.parentsCreated} parent row(s) created, ${links.skipped} skipped.`);

  if (!skipClassify) {
    if (!env.GROQ_API_KEY) {
      console.log('Classification skipped: GROQ_API_KEY is not configured.');
    } else {
      const classification = await classifySuppliers({ actor: 'seed-script', limit: 200 });
      console.log(
        `Classification: ${classification.classified} classified, ${classification.inherited} inherited from a parent, ` +
          `${classification.failed} failed, ${classification.lowConfidence} below the confidence threshold, ` +
          `${classification.llmRequests} Groq request(s).`,
      );
      if (classification.errors.length) {
        console.log('Classification warnings:');
        for (const warning of classification.errors.slice(0, 5)) console.log(`  - ${warning}`);
      }
    }
  }

  // ---- report -------------------------------------------------------------
  const stats = await getSupplierStats();
  console.log('');
  console.log('Resulting dataset:');
  console.log(`  suppliers:        ${stats.totalSuppliers}`);
  console.log(`  total spend:      ${stats.totalSpend.toFixed(2)}`);
  console.log(`  classified:       ${stats.classified} (${stats.percentClassified.toFixed(1)}%)`);
  console.log(`  low confidence:   ${stats.lowConfidence} (${stats.percentLowConfidence.toFixed(1)}%)`);
  console.log(`  parents:          ${stats.parents}`);
  console.log(`  subsidiaries:     ${stats.subsidiaries}`);
  console.log(`  inherited codes:  ${stats.inherited}`);
  console.log(`  stale:            ${stats.stale}`);

  const page = await listSuppliers({ all: true, filters: {} as never, sort: 'name', dir: 'asc' });
  const tree = buildHierarchy(page.rows.map((row) => toNode(row)));
  const display = flattenHierarchyForDisplay(tree);

  console.log('');
  console.log(`Hierarchy (${tree.clusters.length} cluster(s)):`);
  for (const row of display.slice(0, 40)) {
    const indent = '  '.repeat(row.indent + 1);
    const supplierId = row.supplierId === null ? '—' : `#${row.supplierId}`;
    console.log(`${indent}${row.name} ${supplierId === '—' ? '' : `(${supplierId})`}`);
  }
  if (display.length > 40) console.log(`  ... ${display.length - 40} more row(s)`);

  // ---- artefacts ----------------------------------------------------------
  const db = getDb();
  const csvReport = await generateReport({
    name: 'Sample seed report',
    format: 'csv',
    filters: { rollup: 'parent' } as never,
    generatedBy: 'seed-script',
    store: false,
    db,
  });
  const pdfReport = await generateReport({
    name: 'Sample seed report',
    format: 'pdf',
    filters: { rollup: 'parent' } as never,
    generatedBy: 'seed-script',
    store: false,
    db,
  });

  console.log('');
  console.log('Rendered artefacts:');
  console.log(`  ${reportFilename('sample-seed-report', 'csv')}: ${(csvReport.bytes.byteLength / 1024).toFixed(1)} KB`);
  console.log(`  ${pdfReport.filename}: ${(pdfReport.bytes.byteLength / 1024).toFixed(1)} KB`);
  console.log('');
  console.log('Next: open the dashboard (`npm run dev`), or export with');
  console.log('  GET /api/export?format=pdf&rollup=parent');
}

void main()
  .catch((error) => {
    console.error('Sample seed failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb().catch(() => undefined));
