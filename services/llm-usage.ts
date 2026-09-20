/**
 * Durable LLM usage accounting.
 *
 * The free tier is the binding constraint (1k requests/day on Llama 3.3 70B), so
 * every Groq call is counted per model per UTC day in `llm_usage`. The worker
 * consults this before it starts a batch and stops early rather than burning the
 * reserve that interactive dashboard actions need.
 */
import { and, eq, sql } from 'drizzle-orm';
import { llmUsage, type LlmUsageRow } from '@/db/schema';
import { getDb, type DbLike } from '@/db/client';
import { getEnv } from '@/lib/env';
import { usageDay } from '@/lib/rate-limit';

export type LlmUsageSnapshot = {
  model: string;
  day: string;
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  failureCount: number;
  dailyLimit: number;
  remaining: number;
};

/** Free-tier daily request limits, keyed by the configured model name. */
export function dailyLimitForModel(model: string): number {
  const env = getEnv();
  if (model === env.GROQ_MODEL_ACCURATE) return env.LLM_MAX_REQUESTS_PER_DAY_70B;
  if (model === env.GROQ_MODEL_BULK) return env.LLM_MAX_REQUESTS_PER_DAY_8B;
  // Unknown/optional models: assume the conservative 70B-style budget.
  return env.LLM_MAX_REQUESTS_PER_DAY_70B;
}

/** Record usage for one model/day bucket. Never throws. */
export async function recordLlmUsage(
  entry: {
    model: string;
    requests?: number;
    promptTokens?: number;
    completionTokens?: number;
    failures?: number;
    day?: string;
  },
  db: DbLike = getDb(),
): Promise<void> {
  const day = entry.day ?? usageDay();
  try {
    await db
      .insert(llmUsage)
      .values({
        model: entry.model,
        usageDay: day,
        requestCount: entry.requests ?? 1,
        promptTokens: entry.promptTokens ?? 0,
        completionTokens: entry.completionTokens ?? 0,
        failureCount: entry.failures ?? 0,
      })
      .onConflictDoUpdate({
        target: [llmUsage.model, llmUsage.usageDay],
        set: {
          requestCount: sql`${llmUsage.requestCount} + ${entry.requests ?? 1}`,
          promptTokens: sql`${llmUsage.promptTokens} + ${entry.promptTokens ?? 0}`,
          completionTokens: sql`${llmUsage.completionTokens} + ${entry.completionTokens ?? 0}`,
          failureCount: sql`${llmUsage.failureCount} + ${entry.failures ?? 0}`,
          updatedAt: new Date(),
        },
      });
  } catch (error) {
    console.error('[llm-usage] failed to record usage', { entry, error });
  }
}

/** Read today's usage rows. */
export async function getLlmUsage(day: string = usageDay(), db: DbLike = getDb()): Promise<LlmUsageRow[]> {
  return db.select().from(llmUsage).where(eq(llmUsage.usageDay, day));
}

/** Usage for one model, defaulting to zero when nothing is recorded yet. */
export async function getModelUsage(
  model: string,
  day: string = usageDay(),
  db: DbLike = getDb(),
): Promise<LlmUsageSnapshot> {
  const rows = await db
    .select()
    .from(llmUsage)
    .where(and(eq(llmUsage.model, model), eq(llmUsage.usageDay, day)))
    .limit(1);
  const row = rows[0];
  const dailyLimit = dailyLimitForModel(model);
  const requestCount = row?.requestCount ?? 0;
  return {
    model,
    day,
    requestCount,
    promptTokens: row?.promptTokens ?? 0,
    completionTokens: row?.completionTokens ?? 0,
    failureCount: row?.failureCount ?? 0,
    dailyLimit,
    remaining: Math.max(0, dailyLimit - requestCount),
  };
}

/** Snapshots for both configured models, plus the reserve kept for the UI. */
export async function getLlmUsageOverview(
  db: DbLike = getDb(),
): Promise<{ day: string; reserve: number; models: LlmUsageSnapshot[] }> {
  const env = getEnv();
  const day = usageDay();
  const models = await Promise.all([
    getModelUsage(env.GROQ_MODEL_ACCURATE, day, db),
    getModelUsage(env.GROQ_MODEL_BULK, day, db),
  ]);
  return { day, reserve: env.LLM_DAILY_BUDGET_RESERVE, models };
}

/**
 * Remaining worker budget for a model: the daily limit minus what is already
 * spent, minus the reserve held back for interactive requests.
 */
export async function remainingWorkerBudget(
  model: string,
  db: DbLike = getDb(),
): Promise<number> {
  const env = getEnv();
  const usage = await getModelUsage(model, usageDay(), db);
  return Math.max(0, usage.dailyLimit - env.LLM_DAILY_BUDGET_RESERVE - usage.requestCount);
}

/** Rolling 7-day usage for the settings page. */
export async function getUsageHistory(days = 7, db: DbLike = getDb()): Promise<LlmUsageRow[]> {
  const since = usageDay(Date.now() - (days - 1) * 86_400_000);
  return db
    .select()
    .from(llmUsage)
    .where(sql`${llmUsage.usageDay} >= ${since}`)
    .orderBy(sql`${llmUsage.usageDay} asc`);
}
