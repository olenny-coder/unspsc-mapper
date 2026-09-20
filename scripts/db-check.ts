/**
 * Database readiness check.
 *
 * Replaces the `psql` snippets in the deployment runbook, because `psql` is not
 * part of a default Windows/macOS developer setup and the first thing anyone
 * does after pointing at Neon is confirm the migration and seed actually landed.
 *
 * Read-only: it never writes, so it is safe to run against production.
 *
 *   npm run db:check
 *   DATABASE_URL="postgresql://...neon.tech/neondb?sslmode=require" npm run db:check
 *
 * Exit code is 1 when the database is not ready, so it can gate a deploy step.
 */
import { config as loadEnv } from 'dotenv';
import postgres from 'postgres';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

/** Tables the application requires, with the reason each one matters. */
const REQUIRED_TABLES: Array<{ name: string; why: string }> = [
  { name: 'suppliers', why: 'core entity' },
  { name: 'unspsc_codes', why: 'taxonomy — classification is inaccurate without it' },
  { name: 'classifications', why: 'classification results' },
  { name: 'corrections', why: 'human review feedback loop' },
  { name: 'enrichment_cache', why: 'protects the 500 free provider credits' },
  { name: 'audit_log', why: 'traceability' },
  { name: 'reports', why: 'stored CSV/PDF output' },
  { name: 'app_settings', why: 'settings singleton' },
  { name: 'llm_usage', why: 'free-tier budget accounting' },
];

type Check = { label: string; ok: boolean; detail: string; hint?: string };

function line(label: string, check: Check): string {
  const mark = check.ok ? ' ok ' : 'FAIL';
  return `${mark}  ${label.padEnd(26)} ${check.detail}${check.hint && !check.ok ? `\n      -> ${check.hint}` : ''}`;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) {
    console.error(
      [
        'DATABASE_URL is not set.',
        '',
        'For a Neon check, either put it in .env.local:',
        '  DATABASE_URL="postgresql://...-pooler...neon.tech/neondb?sslmode=require"',
        '',
        'or pass it for this command only (PowerShell):',
        '  $env:DATABASE_URL="postgresql://..."; npm run db:check',
      ].join('\n'),
    );
    process.exit(1);
  }

  const isNeon = /neon\.tech/.test(url);
  const isPooled = /-pooler/.test(url);
  // Redact the password before printing anything.
  const safeUrl = url.replace(/:\/\/[^@]*@/, '://***@');
  console.log(`Target: ${safeUrl}`);
  console.log(`        ${isNeon ? 'Neon' : 'Postgres'}${isPooled ? ', pooled endpoint' : ', direct endpoint'}`);
  console.log('');

  const sql = postgres(url, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 15, onnotice: () => {} });
  const checks: Check[] = [];

  try {
    // ---- connectivity + version -------------------------------------------
    const versionRows = await sql<Array<{ version: string }>>`select version()`;
    const version = versionRows[0]?.version ?? 'unknown';
    const pgVersion = /PostgreSQL (\d+)/.exec(version)?.[1] ?? '?';
    checks.push({
      label: 'connection',
      ok: true,
      detail: `PostgreSQL ${pgVersion}`,
    });

    // ---- required tables ---------------------------------------------------
    const tables = await sql<Array<{ table_name: string }>>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
    `;
    const present = new Set(tables.map((row) => row.table_name));

    const missing = REQUIRED_TABLES.filter((table) => !present.has(table.name));
    checks.push({
      label: 'schema (9 tables)',
      ok: missing.length === 0,
      detail: missing.length === 0 ? 'all present' : `missing: ${missing.map((t) => t.name).join(', ')}`,
      hint: missing.length
        ? 'Run `npm run db:migrate` against this database, then re-run this check.'
        : undefined,
    });

    // ---- settings singleton ------------------------------------------------
    if (present.has('app_settings')) {
      const rows = await sql<Array<{ count: string }>>`select count(*)::text as count from app_settings where id = 1`;
      const count = Number(rows[0]?.count ?? 0);
      checks.push({
        label: 'settings singleton',
        ok: count === 1,
        detail: count === 1 ? 'row id=1 present' : `found ${count} row(s)`,
        hint: count === 1 ? undefined : 'Re-run `npm run db:migrate`; the migration inserts this row.',
      });
    }

    // ---- taxonomy ----------------------------------------------------------
    if (present.has('unspsc_codes')) {
      const rows = await sql<Array<{ codes: string; segments: string; version: string | null }>>`
        select count(*)::text as codes,
               count(distinct segment_code)::text as segments,
               max(version) as version
        from unspsc_codes
      `;
      const codes = Number(rows[0]?.codes ?? 0);
      const segments = Number(rows[0]?.segments ?? 0);
      checks.push({
        label: 'UNSPSC taxonomy',
        ok: codes > 100_000,
        detail: `${codes.toLocaleString()} codes across ${segments} segments${rows[0]?.version ? ` (${rows[0].version})` : ''}`,
        hint:
          codes > 100_000
            ? undefined
            : codes === 0
              ? 'Run `npm run db:seed`. Without the taxonomy, candidate-code injection and code validation are disabled and confidence is capped at 0.40.'
              : 'Partial seed. Re-run `npm run db:seed` to completion.',
      });

      // A real end-to-end taxonomy read, not just a count: proves the codes the
      // classifier relies on are actually resolvable.
      if (codes > 0) {
        const sample = await sql<Array<{ code: string; commodity: string }>>`
          select code, commodity from unspsc_codes where code = '43211507'
        `;
        checks.push({
          label: 'known code lookup',
          ok: sample.length === 1,
          detail: sample[0] ? `${sample[0].code} = ${sample[0].commodity}` : '43211507 not found',
          hint: sample.length ? undefined : 'Unexpected: the v26 codeset should contain 43211507.',
        });
      }
    }

    // ---- optional content --------------------------------------------------
    if (present.has('suppliers')) {
      const rows = await sql<Array<{ suppliers: string; parents: string; classified: string }>>`
        select
          (select count(*)::text from suppliers) as suppliers,
          (select count(*)::text from suppliers where is_parent) as parents,
          (select count(distinct supplier_id)::text from classifications where superseded = false) as classified
      `;
      const suppliers = Number(rows[0]?.suppliers ?? 0);
      checks.push({
        label: 'content (optional)',
        ok: true,
        detail:
          suppliers === 0
            ? 'empty — upload a CSV, or run `npm run db:seed:sample`'
            : `${suppliers} suppliers, ${Number(rows[0]?.parents ?? 0)} parents, ${Number(rows[0]?.classified ?? 0)} classified`,
      });
    }

    // ---- free-tier storage -------------------------------------------------
    const size = await sql<Array<{ bytes: string }>>`select pg_database_size(current_database())::text as bytes`;
    const bytes = Number(size[0]?.bytes ?? 0);
    const gb = bytes / 1024 ** 3;
    const share = (gb / 0.5) * 100;
    checks.push({
      label: 'storage',
      ok: share < 90,
      detail: `${(bytes / 1024 ** 2).toFixed(1)} MB used (${share.toFixed(1)}% of the 0.5 GB Neon free tier)`,
      hint: share < 90 ? undefined : 'Prune stored reports: `DELETE FROM reports WHERE created_at < now() - interval \'90 days\'`.',
    });

    // ---- report ------------------------------------------------------------
    console.log('Database readiness');
    console.log('');
    for (const check of checks) console.log(line(check.label, check));
    console.log('');

    const failed = checks.filter((check) => !check.ok);
    if (failed.length) {
      console.log(`${failed.length} check(s) failed — this database is not ready.`);
      process.exitCode = 1;
    } else {
      console.log('All checks passed. This database is ready for the app and the worker.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Connection failed: ${message}`);
    console.error('');
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
      console.error('The hostname did not resolve. Check the connection string for a typo.');
    } else if (/password|authentication/i.test(message)) {
      console.error('Authentication failed. Re-copy the connection string from the Neon dashboard.');
    } else if (/does not exist/i.test(message)) {
      console.error('The database name is wrong. Neon creates `neondb` by default.');
    } else if (/timeout|ETIMEDOUT/i.test(message)) {
      console.error(
        'Timed out. If your Neon project is idle it may need a moment to wake — retry once. ' +
          'Also confirm `?sslmode=require` is present.',
      );
    }
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

void main();
