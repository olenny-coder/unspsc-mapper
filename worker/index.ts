/**
 * UNSPSC Spend Categorizer — Render background worker.
 *
 * Responsibilities
 *  - keep the supplier database current: poll for unenriched/unclassified
 *    suppliers and process them in bounded batches;
 *  - re-enrich suppliers whose `enriched_at` is older than `SYNC_STALE_DAYS`
 *    (30 by default);
 *  - mark enrichment failures as stale and trigger reclassification when
 *    enrichment data changes materially;
 *  - resolve parent/subsidiary links so classification runs parent-first;
 *  - generate the weekly PDF report and store it in Neon;
 *  - expose `/health` for uptime pings and `/status` for operations.
 *
 * Render free tier notes
 *  - the service spins down after 15 minutes idle, so `WorkerScheduler.catchUp()`
 *    runs a missed slot on wake-up;
 *  - a single process handles both HTTP and the scheduler.
 */
import { getEnv } from '@/lib/env';
import { serializeError } from '@/lib/errors';
import { closeDb, getDb } from '@/db/client';
import { sql } from 'drizzle-orm';
import { WorkerScheduler } from '@/worker/scheduler';
import { createWorkerHttpServer, type WorkerHttpServer } from '@/worker/http';
import { runSync } from '@/services/sync';

let httpServer: WorkerHttpServer | null = null;
let scheduler: WorkerScheduler | null = null;
let shuttingDown = false;

function log(message: string, meta?: Record<string, unknown>): void {
  const stamp = new Date().toISOString();
  console.log(`[worker ${stamp}] ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`);
}

async function verifyDatabase(): Promise<void> {
  const db = getDb();
  const result = await db.execute(sql`select 1 as ok`);
  void result;
}

/** Optional one-shot mode: `node worker/index.js --once[=enrich|classify|report]`. */
async function runOnceMode(arg: string): Promise<void> {
  const mode = arg.includes('=') ? arg.split('=')[1] : 'full';
  log(`one-shot mode: ${mode}`);
  if (mode === 'report') {
    const { generateWeeklyReport, pruneOldReports } = await import('@/services/reporting/store');
    const report = await generateWeeklyReport();
    const pruned = await pruneOldReports(30, { actor: 'worker' });
    log('weekly report generated', { reportId: report.storedId, rows: report.rowCount, bytes: report.bytes.byteLength, pruned });
    return;
  }
  const summary = await runSync({
    mode: mode === 'enrich' || mode === 'classify' || mode === 'report' ? mode : 'full',
    actor: 'worker',
  });
  log('sync complete', {
    candidatesFound: summary.candidatesFound,
    enriched: summary.enriched,
    classified: summary.classified,
    inherited: summary.inherited,
    staleMarked: summary.staleMarked,
    llmRequests: summary.llmRequests,
    stoppedReason: summary.stoppedReason,
    durationMs: summary.durationMs,
  });
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`received ${signal}; shutting down`);
  scheduler?.stop();
  try {
    await httpServer?.close();
  } catch (error) {
    log('error closing HTTP server', { error: String(error) });
  }
  try {
    await closeDb();
  } catch (error) {
    log('error closing database pool', { error: String(error) });
  }
  process.exit(0);
}

async function main(): Promise<void> {
  const env = getEnv();
  log('starting UNSPSC spend categorizer worker', {
    environment: env.NODE_ENV,
    cronSync: env.CRON_SYNC,
    cronReport: env.CRON_REPORT,
    staleAfterDays: env.SYNC_STALE_DAYS,
    batchSize: env.SYNC_BATCH_SIZE,
    maxBatchesPerRun: env.SYNC_MAX_BATCHES_PER_RUN,
    enrichmentProvider: env.ENRICH_PROVIDER,
    groqConfigured: Boolean(env.GROQ_API_KEY),
    databaseConfigured: Boolean(env.DATABASE_URL),
  });

  const onceArg = process.argv.find((arg) => arg.startsWith('--once'));
  if (onceArg) {
    await runOnceMode(onceArg);
    await closeDb();
    return;
  }

  try {
    await verifyDatabase();
    log('database connection verified');
  } catch (error) {
    // Do not exit: Render would restart-loop. The HTTP server still needs to
    // answer health checks, and the scheduler retries on the next tick.
    log('database is not reachable yet; the scheduler will retry', { error: serializeError(error).message });
  }

  scheduler = new WorkerScheduler({ intervalMs: 30_000, catchUpOnStart: true, onLog: log });
  httpServer = createWorkerHttpServer({ scheduler, port: env.PORT, onLog: log });

  await new Promise<void>((resolve) => {
    httpServer!.server.listen(env.PORT, '0.0.0.0', () => {
      log(`health server listening on port ${env.PORT}`, { url: httpServer!.url() });
      resolve();
    });
  });

  await scheduler.start();
  log('scheduler started', { jobs: scheduler.status().jobs.map((job) => ({ name: job.name, next: job.nextRunAt })) });

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log('unhandled promise rejection', { error: serializeError(reason).message });
  });
  process.on('uncaughtException', (error) => {
    log('uncaught exception', { error: serializeError(error).message, stack: error.stack });
  });
}

void main().catch(async (error) => {
  log('fatal startup error', { error: serializeError(error) });
  await closeDb().catch(() => undefined);
  process.exit(1);
});
