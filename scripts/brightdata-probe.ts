/**
 * Bright Data dataset probe.
 *
 * Answers the one question the integration cannot answer on its own: **what does
 * this dataset actually return?** Bright Data serves hundreds of datasets, each with
 * its own record shape, so the field mapping in `normalizeBrightDataPayload` is a set
 * of aliases rather than a fixed schema. This script shows you whether that mapping
 * lines up with the dataset you configured, and exactly which keys went unmapped.
 *
 * It calls the API once per input and prints, for each:
 *
 *   - the URL actually sent (the most common cause of a 400 is the wrong URL shape —
 *     a dataset keyed on LinkedIn wants a LinkedIn URL, not the company's own site);
 *   - the HTTP status and, on failure, Bright Data's verbatim error body;
 *   - every top-level key the record contains, with the full JSON;
 *   - the mapped result field by field, marking anything that came back null.
 *
 * Usage (from the repo root):
 *
 *   npx tsx scripts/brightdata-probe.ts --domain dell.com --name "Dell Technologies"
 *   npx tsx scripts/brightdata-probe.ts --domain siemens.com --domain grainger.com
 *   npx tsx scripts/brightdata-probe.ts --first 3        # pull suppliers from the DB
 *
 * Nothing is written: no cache rows, no supplier updates.
 */
import '@/lib/env-node';
import { getEnv, isEnrichmentConfigured } from '@/lib/env';
import { callBrightData, normalizeBrightDataPayload, brightDataInputUrl } from '@/services/enrichment';
import { closeDb, getDb } from '@/db/client';
import { suppliers as suppliersTable } from '@/db/schema';
import { isNotNull } from 'drizzle-orm';

type Target = { name: string; domain: string | null };

function parseArgs(argv: string[]): { domains: string[]; name: string | null; first: number | null } {
  const domains: string[] = [];
  let name: string | null = null;
  let first: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--domain' && next) {
      domains.push(next);
      index += 1;
    } else if (arg === '--name' && next) {
      name = next;
      index += 1;
    } else if (arg === '--first' && next) {
      first = Number(next);
      index += 1;
    }
  }

  return { domains, name, first };
}

async function targetsFromDatabase(limit: number): Promise<Target[]> {
  try {
    const rows = await getDb()
      .select({ name: suppliersTable.name, domain: suppliersTable.domain })
      .from(suppliersTable)
      .where(isNotNull(suppliersTable.domain))
      .limit(limit);
    return rows.map((row) => ({ name: row.name, domain: row.domain }));
  } catch (error) {
    console.error(`Could not read suppliers from the database: ${error instanceof Error ? error.message : error}`);
    console.error('Pass --domain instead, e.g. --domain dell.com --name "Dell Technologies".');
    return [];
  }
}

/** Print each mapped field, flagging the nulls that indicate a mapping gap. */
function reportMapping(record: unknown): void {
  const mapped = normalizeBrightDataPayload(record);
  const fields: Array<[string, string | null]> = [
    ['domain', mapped.domain],
    ['industry', mapped.industry],
    ['naics', mapped.naics],
    ['sic', mapped.sic],
    ['description', mapped.description],
    ['country', mapped.country],
    ['parentName', mapped.parentName ?? null],
    ['parentDomain', mapped.parentDomain ?? null],
  ];

  console.log('  mapped result:');
  for (const [field, value] of fields) {
    const shown = value === null ? '— not found' : `"${value.length > 90 ? `${value.slice(0, 89)}…` : value}"`;
    console.log(`    ${field.padEnd(14)} ${shown}`);
  }

  const missing = fields.filter(([, value]) => value === null).map(([field]) => field);
  if (missing.length) {
    console.log('');
    console.log(`  ⚠ unmapped: ${missing.join(', ')}`);
    console.log('    Copy the key list above into the alias arrays in');
    console.log('    normalizeBrightDataPayload (services/enrichment.ts) for whichever of these');
    console.log('    the dataset does provide.');
  }
}

async function main(): Promise<void> {
  const env = getEnv();
  const { domains, name, first } = parseArgs(process.argv.slice(2));

  console.log('Bright Data probe');
  console.log(`  ENRICH_PROVIDER            ${env.ENRICH_PROVIDER}`);
  console.log(`  ENRICH_DATASET_ID          ${env.ENRICH_DATASET_ID ?? '(not set)'}`);
  console.log(`  ENRICH_API_KEY             ${env.ENRICH_API_KEY ? `set (…${env.ENRICH_API_KEY.slice(-4)})` : '(not set)'}`);
  console.log(`  ENRICH_INPUT_URL_TEMPLATE  ${env.ENRICH_INPUT_URL_TEMPLATE ?? '(not set — sending https://<domain>)'}`);
  console.log(`  configured                 ${isEnrichmentConfigured()}`);

  if (!env.ENRICH_API_KEY || !env.ENRICH_DATASET_ID) {
    console.log('');
    console.log('Set ENRICH_API_KEY and ENRICH_DATASET_ID (in .env.local) before probing.');
    console.log('The dataset id is on the dataset page in the Bright Data Control Panel; the API');
    console.log('key is at https://brightdata.com/cp/setting/users.');
    return;
  }

  const targets: Target[] = [];
  if (domains.length) {
    for (const domain of domains) targets.push({ name: name ?? domain, domain });
  } else if (first !== null) {
    targets.push(...(await targetsFromDatabase(first)));
  } else {
    console.log('');
    console.log('No targets given. Try:');
    console.log('  npx tsx scripts/brightdata-probe.ts --domain dell.com --name "Dell Technologies"');
    return;
  }

  if (!targets.length) {
    console.log('No targets to probe.');
    return;
  }

  for (const target of targets) {
    console.log('');
    console.log('='.repeat(78));
    const sent = brightDataInputUrl(target, env.ENRICH_INPUT_URL_TEMPLATE);
    console.log(`${target.name}`);
    console.log(`  input url sent: ${sent ?? '(none — this supplier has no domain)'}`);

    const started = Date.now();
    const response = await callBrightData(target, {
      apiKey: env.ENRICH_API_KEY,
      datasetId: env.ENRICH_DATASET_ID,
      baseUrl: env.ENRICH_BASE_URL,
      urlTemplate: env.ENRICH_INPUT_URL_TEMPLATE,
    });
    console.log(`  status: ${response.status}   ok: ${response.ok}   credits: ${response.creditsUsed}   ${Date.now() - started}ms`);

    if (response.error) console.log(`  error: ${response.error}`);

    if (!response.data) {
      if (response.status === 422) {
        console.log('  This supplier has no domain, and a URL-keyed dataset needs one.');
        console.log('  Either supply domains in the CSV, or set ENRICH_INPUT_URL_TEMPLATE.');
      }
      if (response.status === 400) {
        console.log('  A 400 means the input failed the dataset\'s own validation. The message above');
        console.log('  names the field and reason; the usual cause is a URL shape the dataset does');
        console.log('  not accept. Set ENRICH_INPUT_URL_TEMPLATE to match it, for example:');
        console.log('    ENRICH_INPUT_URL_TEMPLATE="https://www.linkedin.com/company/{domain-slug}"');
      }
      continue;
    }

    const record = response.data as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    console.log('');
    console.log(`  record keys (${keys.length}): ${keys.join(', ')}`);
    console.log('');
    console.log('  full record:');
    console.log(
      JSON.stringify(record, null, 2)
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n'),
    );
    console.log('');
    reportMapping(record);
  }

  console.log('');
  console.log('Nothing was written: no cache rows and no supplier updates.');
}

void main()
  .catch((error) => {
    console.error('probe failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb().catch(() => undefined));
