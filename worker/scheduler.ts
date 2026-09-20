/**
 * Worker scheduler.
 *
 * Runs the daily sync and the weekly PDF report. Because the Render free tier
 * spins down after 15 minutes of inactivity, correctness cannot depend on the
 * process being alive at the exact scheduled minute:
 *
 *   1. Every tick (default 30s) we test the cron expressions for a match.
 *   2. At startup, and again after every wake-up, we check whether a slot was
 *      missed while the process slept (`didMissSchedule`) and run it once.
 *   3. `lastSyncAt` / `lastReportAt` are persisted, so restarts do not
 *      re-trigger work that already happened.
 */
import { Cron } from 'croner';
import { cronMatches, describeCron, didMissSchedule, isValidCronExpression, nextRunAfter } from '@/worker/cron';
import { getEnv } from '@/lib/env';
import { getDb } from '@/db/client';
import { auditLog } from '@/db/schema';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { runSync, type SyncSummary } from '@/services/sync';
import { generateWeeklyReport, pruneOldReports } from '@/services/reporting/store';

export type JobName = 'sync' | 'report';

export type JobState = {
  name: JobName;
  cron: string;
  description: string;
  enabled: boolean;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastDurationMs: number | null;
  lastStatus: 'success' | 'error' | 'skipped' | null;
  lastError: string | null;
  runCount: number;
  failureCount: number;
  nextRunAt: string | null;
};

export type SchedulerOptions = {
  /** Tick interval in ms. */
  intervalMs?: number;
  /** Run a catch-up pass immediately on start when a slot was missed. */
  catchUpOnStart?: boolean;
  onLog?: (message: string, meta?: Record<string, unknown>) => void;
};

export class WorkerScheduler {
  private readonly jobs = new Map<JobName, JobState>();
  private readonly timers: Cron[] = [];
  private ticker: NodeJS.Timeout | null = null;
  private running = new Set<JobName>();
  private lastFiredMinute = new Map<JobName, string>();
  private readonly options: Required<Pick<SchedulerOptions, 'intervalMs' | 'catchUpOnStart'>> & SchedulerOptions;

  constructor(options: SchedulerOptions = {}) {
    this.options = {
      intervalMs: options.intervalMs ?? 30_000,
      catchUpOnStart: options.catchUpOnStart ?? true,
      ...options,
    };

    const env = getEnv();
    this.jobs.set('sync', {
      name: 'sync',
      cron: env.CRON_SYNC,
      description: enrichCronDescription(env.CRON_SYNC),
      enabled: isValidCronExpression(env.CRON_SYNC),
      lastStartedAt: null,
      lastFinishedAt: null,
      lastDurationMs: null,
      lastStatus: null,
      lastError: null,
      runCount: 0,
      failureCount: 0,
      nextRunAt: null,
    });
    this.jobs.set('report', {
      name: 'report',
      cron: env.CRON_REPORT,
      description: enrichCronDescription(env.CRON_REPORT),
      enabled: env.WEEKLY_REPORT_ENABLED && isValidCronExpression(env.CRON_REPORT),
      lastStartedAt: null,
      lastFinishedAt: null,
      lastDurationMs: null,
      lastStatus: null,
      lastError: null,
      runCount: 0,
      failureCount: 0,
      nextRunAt: null,
    });
  }

  private log(message: string, meta?: Record<string, unknown>): void {
    if (this.options.onLog) this.options.onLog(message, meta);
    else console.log(`[worker] ${message}`, meta ?? '');
  }

  /** Read the last successful run time for a job from the audit log. */
  private async lastRunAt(name: JobName): Promise<Date | null> {
    try {
      const db = getDb();
      if (name === 'sync') {
        const rows = await db
          .select({ createdAt: auditLog.createdAt })
          .from(auditLog)
          .where(eq(auditLog.action, 'synced'))
          .orderBy(desc(auditLog.createdAt))
          .limit(1);
        return rows[0]?.createdAt ?? null;
      }
      const rows = await db
        .select({ createdAt: auditLog.createdAt })
        .from(auditLog)
        .where(and(eq(auditLog.action, 'report_generated'), sql`${auditLog.details}->>'schedule' = 'weekly'`))
        .orderBy(desc(auditLog.createdAt))
        .limit(1);
      return rows[0]?.createdAt ?? null;
    } catch (error) {
      this.log('could not read last run time', { job: name, error: String(error) });
      return null;
    }
  }

  private async execute(name: JobName): Promise<void> {
    if (this.running.has(name)) {
      this.log(`job ${name} is still running; skipping this tick`);
      return;
    }

    const state = this.jobs.get(name);
    if (!state) return;

    this.running.add(name);
    state.lastStartedAt = new Date().toISOString();
    state.lastStatus = null;
    const started = Date.now();
    this.log(`job ${name} starting`);

    try {
      if (name === 'sync') {
        const summary: SyncSummary = await runSync({ mode: 'full', actor: 'worker' });
        state.lastStatus = summary.stoppedReason === 'error' ? 'error' : 'success';
        state.lastError = summary.errors.length ? summary.errors.join('; ').slice(0, 500) : null;
        if (state.lastStatus === 'error') state.failureCount += 1;
        this.log('sync finished', {
          enriched: summary.enriched,
          classified: summary.classified,
          inherited: summary.inherited,
          staleMarked: summary.staleMarked,
          llmRequests: summary.llmRequests,
          stoppedReason: summary.stoppedReason,
          durationMs: summary.durationMs,
        });
      } else {
        const report = await generateWeeklyReport();
        const pruned = await pruneOldReports(30, { actor: 'worker' });
        state.lastStatus = 'success';
        this.log('weekly report generated', {
          reportId: report.storedId,
          rows: report.rowCount,
          bytes: report.bytes.byteLength,
          pruned: pruned.deleted,
        });
      }
      state.runCount += 1;
    } catch (error) {
      state.lastStatus = 'error';
      state.lastError = error instanceof Error ? error.message : String(error);
      state.failureCount += 1;
      this.log(`job ${name} failed`, { error: state.lastError });
    } finally {
      state.lastFinishedAt = new Date().toISOString();
      state.lastDurationMs = Date.now() - started;
      state.nextRunAt = nextRunAfter(state.cron)?.toISOString() ?? null;
      this.running.delete(name);
    }
  }

  /** Manually trigger a job outside its schedule (used by the HTTP API). */
  async trigger(name: JobName): Promise<void> {
    await this.execute(name);
  }

  /**
   * Run a catch-up pass: if a scheduled slot passed while the process was
   * asleep, run the job once now.
   *
   * A brand-new deployment never runs in catch-up mode: the first scheduled slot
   * after install is honoured instead. Otherwise every fresh worker boot would
   * fire an immediate sync against a database that may not be migrated yet.
   */
  async catchUp(): Promise<{ sync: boolean; report: boolean }> {
    const result = { sync: false, report: false };
    const hasHistory = await this.hasRunHistory();
    if (!hasHistory) {
      this.log('no previous run recorded; skipping catch-up (first deployment)');
      return result;
    }

    for (const name of ['sync', 'report'] as const) {
      const state = this.jobs.get(name);
      if (!state?.enabled) continue;
      const since = await this.lastRunAt(name);
      const missed = didMissSchedule(state.cron, since, new Date());
      if (!missed) continue;
      this.log(`catching up missed ${name} run`, { since: since?.toISOString() ?? 'never' });
      result[name] = true;
      await this.execute(name);
    }

    return result;
  }

  /** True when this database has ever recorded a sync or weekly report. */
  private async hasRunHistory(): Promise<boolean> {
    try {
      const db = getDb();
      const rows = await db
        .select({ value: sql<number>`count(*)` })
        .from(auditLog)
        .where(
          or(
            eq(auditLog.action, 'synced'),
            and(eq(auditLog.action, 'report_generated'), sql`${auditLog.details}->>'schedule' = 'weekly'`),
          ),
        );
      return Number(rows[0]?.value ?? 0) > 0;
    } catch (error) {
      // An unreachable or unmigrated database must not block start-up.
      this.log('could not determine run history; skipping catch-up', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** Start the scheduler: an internal ticker plus per-job cron objects. */
  async start(): Promise<void> {
    if (this.ticker) return;

    for (const [name, state] of this.jobs) {
      if (!state.enabled) {
        this.log(`job ${name} disabled (invalid cron or disabled by configuration)`, { cron: state.cron });
        continue;
      }
      state.nextRunAt = nextRunAfter(state.cron)?.toISOString() ?? null;

      // croner gives precise firing while the process is awake; it also
      // supports `protect` so overlapping runs cannot pile up.
      const timer = new Cron(state.cron, { timezone: 'UTC', protect: true, name }, async () => {
        await this.execute(name);
      });
      this.timers.push(timer);
      this.log(`job ${name} scheduled`, { cron: state.cron, next: state.nextRunAt, description: state.description });
    }

    // The ticker is a safety net: it re-evaluates matches and refreshes the
    // reported `nextRunAt` even if croner was briefly starved by a long job.
    this.ticker = setInterval(() => {
      const now = new Date();
      for (const [name, state] of this.jobs) {
        if (!state.enabled) continue;
        state.nextRunAt = nextRunAfter(state.cron, now)?.toISOString() ?? null;
        const key = now.toISOString().slice(0, 16);
        if (this.lastFiredMinute.get(name) === key) continue;
        if (cronMatches(state.cron, now)) {
          this.lastFiredMinute.set(name, key);
          // croner already handles this; the ticker only records the minute so a
          // restart inside the same minute cannot double-run.
        }
      }
    }, this.options.intervalMs);
    if (typeof this.ticker.unref === 'function') this.ticker.unref();

    if (this.options.catchUpOnStart) {
      await this.catchUp();
    }
  }

  stop(): void {
    for (const timer of this.timers) timer.stop();
    this.timers.length = 0;
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  /** Snapshot for the worker's `/health` and `/status` endpoints. */
  status(): { jobs: JobState[]; running: string[] } {
    const jobs = [...this.jobs.values()].map((state) => ({
      ...state,
      nextRunAt: state.enabled ? state.nextRunAt ?? nextRunAfter(state.cron)?.toISOString() ?? null : null,
    }));
    return { jobs, running: [...this.running] };
  }
}

function enrichCronDescription(expression: string): string {
  if (!isValidCronExpression(expression)) return `invalid cron expression: "${expression}"`;
  return describeCron(expression);
}
