/**
 * UNSPSC taxonomy seeder.
 *
 * Loads the official UNSPSC code list into `unspsc_codes`. The classification
 * prompt injects candidate codes retrieved from this table and every model
 * answer is validated against it, so an empty table means low accuracy.
 *
 * Data source resolution (first match wins):
 *   1. `--file=<path>` argument
 *   2. `UNSPSC_SEED_CSV` environment variable
 *   3. `samples/unspsc-v26-en.csv.gz` (bundled, UNSPSC v26.0801, 149,849 codes)
 *   4. `samples/unspsc-v26-en.csv` (uncompressed, if present)
 *
 * Usage:
 *   npm run db:seed                 # full v26 taxonomy
 *   npm run db:seed -- --limit=5000 # quick smoke test
 *   npm run db:seed -- --file=./my-unspsc.csv
 */
import { config as loadEnv } from 'dotenv';
import { createReadStream, existsSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Papa from 'papaparse';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { hierarchyFromCode, mapSeedRecord, type UnspscSeedRow } from '@/lib/unspsc-seed';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

export type SeedSummary = {
  read: number;
  inserted: number;
  skipped: number;
  source: string;
  version: string;
};

export { hierarchyFromCode, mapSeedRecord };

async function resolveSource(explicit?: string): Promise<{ path: string; gzip: boolean } | null> {
  const candidates = [
    explicit,
    process.env.UNSPSC_SEED_CSV,
    resolve(root, 'samples', 'unspsc-v26-en.csv.gz'),
    resolve(root, 'samples', 'unspsc-v26-en.csv'),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const path = resolve(candidate);
    if (existsSync(path)) return { path, gzip: path.endsWith('.gz') };
  }
  return null;
}

/**
 * Read the CSV row by row. Streaming a 3.8 MB gzip / 73 MB plain file keeps the
 * process inside the Render/Vercel memory limits.
 */
async function parseCsv(
  path: string,
  gzip: boolean,
  onRow: (record: Record<string, unknown>) => void,
): Promise<{ errors: string[] }> {
  const errors: string[] = [];
  return new Promise((resolvePromise, reject) => {
    const stream = gzip ? createReadStream(path).pipe(createGunzip()) : createReadStream(path);
    Papa.parse(stream as unknown as NodeJS.ReadableStream, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (header) => header.replace(/^\uFEFF/, '').trim(),
      step: (results) => {
        if (results.errors?.length) {
          for (const error of results.errors.slice(0, 3)) errors.push(error.message);
          return;
        }
        onRow(results.data as Record<string, unknown>);
      },
      complete: () => resolvePromise({ errors }),
      error: (error: Error) => reject(error),
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fileArg = args.find((arg) => arg.startsWith('--file='))?.split('=')[1];
  const limitArg = args.find((arg) => arg.startsWith('--limit='))?.split('=')[1];
  const limit = limitArg ? Number(limitArg) : undefined;
  const version = process.env.UNSPSC_VERSION ?? 'v26.0801';
  const truncate = args.includes('--truncate');

  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Add it to .env.local, then re-run.');
    process.exit(1);
  }

  const source = await resolveSource(fileArg);
  if (!source) {
    console.error(
      [
        'No UNSPSC seed file found.',
        '',
        'Expected one of:',
        '  samples/unspsc-v26-en.csv.gz   (bundled in this repo)',
        '  samples/unspsc-v26-en.csv',
        '',
        'Or pass --file=<path> / set UNSPSC_SEED_CSV. Expected columns:',
        '  code,segment,family,class,commodity,description',
      ].join('\n'),
    );
    process.exit(1);
  }

  console.log(`Seeding UNSPSC ${version} from ${source.path}${limit ? ` (limit ${limit})` : ''}`);

  const batch: Array<UnspscSeedRow | null> = [];
  let read = 0;
  let skipped = 0;

  const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  const db = drizzle(client, { schema });

  const flush = async (): Promise<void> => {
    const rows = batch.filter((row): row is NonNullable<typeof row> => row !== null);
    batch.length = 0;
    if (!rows.length) return;

    // 20,000 rows x 12 columns = 240k bind parameters, comfortably below
    // Postgres' 65,535 limit per statement because drizzle chunks internally.
    const chunkSize = 2_000;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const slice = rows.slice(i, i + chunkSize);
      await db
        .insert(schema.unspscCodes)
        .values(slice)
        .onConflictDoUpdate({
          target: schema.unspscCodes.code,
          set: {
            segment: sql`excluded.segment`,
            segmentCode: sql`excluded.segment_code`,
            family: sql`excluded.family`,
            familyCode: sql`excluded.family_code`,
            class: sql`excluded.class`,
            classCode: sql`excluded.class_code`,
            commodity: sql`excluded.commodity`,
            description: sql`excluded.description`,
            searchText: sql`excluded.search_text`,
            version: sql`excluded.version`,
          },
        });
    }
  };

  try {
    if (truncate) {
      console.log('--truncate: clearing unspsc_codes first');
      await db.execute(sql`truncate table ${schema.unspscCodes}`);
    }

    await parseCsv(source.path, source.gzip, (record) => {
      if (limit !== undefined && read >= limit) return;
      read += 1;
      const mapped = mapSeedRecord(record, version);
      if (!mapped) {
        skipped += 1;
        return;
      }
      batch.push(mapped);
    });

    await flush();

    const counted = await client<Array<{ count: string }>>`select count(*)::text as count from unspsc_codes`;
    const total = Number(counted[0]?.count ?? 0);

    const segments = await client<Array<{ segment_code: string | null; segment: string | null; count: string }>>`
      select segment_code, min(segment) as segment, count(*)::text as count
      from unspsc_codes
      group by segment_code
      order by segment_code
      limit 60
    `;

    const summary: SeedSummary = {
      read,
      inserted: read - skipped,
      skipped,
      source: source.path,
      version,
    };

    console.log('');
    console.log(`Read ${summary.read} rows, ${summary.skipped} skipped as malformed.`);
    console.log(`unspsc_codes now holds ${total.toLocaleString()} codes across ${segments.length} segments.`);
    console.log('');
    console.log('Sample segments:');
    for (const segment of segments.slice(0, 12)) {
      console.log(`  ${segment.segment_code ?? '??'}  ${(segment.segment ?? 'unknown').slice(0, 60).padEnd(62)} ${segment.count}`);
    }

    if (total === 0) {
      console.error('\nNo codes were inserted — check the seed file format.');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('Seeding failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await client.end({ timeout: 10 });
  }
}

// Run the seeder. The pure helpers above are re-exported for unit tests; the
// database work only starts when this module is executed as a script.
void main();

export { resolveSource };
