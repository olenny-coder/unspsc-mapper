/**
 * Application settings (singleton row in `app_settings`).
 *
 * Secrets are NEVER stored in this table. Only a masked fingerprint of the
 * configured key is kept so the settings page can show whether a key is present;
 * the real value always comes from the environment (Vercel/Render env vars).
 */
import { eq } from 'drizzle-orm';
import { appSettings, type AppSettings } from '@/db/schema';
import { getDb, type DbLike } from '@/db/client';
import { getEnv, isEnrichmentConfigured, isGroqConfigured } from '@/lib/env';
import { recordAudit } from '@/services/audit';
import type { z } from 'zod';
import type { settingsUpdateSchema } from '@/lib/validation';

export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

export type EffectiveSettings = AppSettings & {
  /** Values actually in force after env overrides are applied. */
  effective: {
    confidenceThreshold: number;
    accurateModel: string;
    bulkModel: string;
    modelStrategy: 'tiered' | 'accurate' | 'bulk';
    staleAfterDays: number;
    batchSize: number;
    syncCron: string;
    weeklyReportCron: string;
    parentDetectionEnabled: boolean;
    enrichmentEnabled: boolean;
    enrichProvider: string;
    syncEnabled: boolean;
    weeklyReportEnabled: boolean;
  };
  secrets: {
    groqConfigured: boolean;
    groqMasked: string | null;
    enrichConfigured: boolean;
    enrichMasked: string | null;
    workerSecretConfigured: boolean;
  };
  /** Keys the runtime reads from env and cannot change from the UI. */
  envManaged: string[];
};

/** `sk-abc...wxyz` style mask that never reveals the full secret. */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length <= 8) return '*'.repeat(trimmed.length);
  return `${trimmed.slice(0, 4)}${'*'.repeat(Math.max(4, trimmed.length - 8))}${trimmed.slice(-4)}`;
}

/** Create the singleton row on first read. */
export async function ensureSettings(db: DbLike = getDb()): Promise<AppSettings> {
  const rows = await db.select().from(appSettings).where(eq(appSettings.id, 1)).limit(1);
  if (rows[0]) return rows[0];
  const inserted = await db.insert(appSettings).values({ id: 1 }).onConflictDoNothing().returning();
  if (inserted[0]) return inserted[0];
  const fallback = await db.select().from(appSettings).where(eq(appSettings.id, 1)).limit(1);
  if (!fallback[0]) throw new Error('app_settings singleton row could not be created');
  return fallback[0];
}

/** Settings merged with the env values that win at runtime. */
export async function getEffectiveSettings(db: DbLike = getDb()): Promise<EffectiveSettings> {
  const env = getEnv();
  const row = await ensureSettings(db);

  return {
    ...row,
    effective: {
      confidenceThreshold: Number(row.confidenceThreshold),
      // Env always wins for the model ids so a deployment stays reproducible.
      accurateModel: env.GROQ_MODEL_ACCURATE || row.accurateModel,
      bulkModel: env.GROQ_MODEL_BULK || row.bulkModel,
      modelStrategy: (env.CLASSIFY_MODEL_STRATEGY || row.modelStrategy) as 'tiered' | 'accurate' | 'bulk',
      staleAfterDays: env.SYNC_STALE_DAYS || row.staleAfterDays,
      batchSize: env.SYNC_BATCH_SIZE || row.batchSize,
      syncCron: env.CRON_SYNC || row.syncCron,
      weeklyReportCron: env.CRON_REPORT || row.weeklyReportCron,
      parentDetectionEnabled: row.parentDetectionEnabled,
      enrichmentEnabled: row.enrichmentEnabled && env.ENRICH_PROVIDER !== 'none',
      enrichProvider: env.ENRICH_PROVIDER || row.enrichProvider,
      syncEnabled: row.syncEnabled,
      weeklyReportEnabled: row.weeklyReportEnabled && env.WEEKLY_REPORT_ENABLED,
    },
    secrets: {
      groqConfigured: isGroqConfigured(),
      groqMasked: row.groqApiKeyMasked ?? maskSecret(env.GROQ_API_KEY),
      enrichConfigured: isEnrichmentConfigured(),
      enrichMasked: row.enrichApiKeyMasked ?? maskSecret(env.ENRICH_API_KEY),
      workerSecretConfigured: Boolean(env.WORKER_SECRET),
    },
    envManaged: [
      'GROQ_API_KEY',
      'ENRICH_API_KEY',
      'DATABASE_URL',
      'WORKER_SECRET',
      'GROQ_MODEL_ACCURATE',
      'GROQ_MODEL_BULK',
      'SYNC_STALE_DAYS',
      'SYNC_BATCH_SIZE',
      'CRON_SYNC',
      'CRON_REPORT',
      'WEEKLY_REPORT_ENABLED',
    ],
  };
}

/**
 * Persist a settings change. Only columns present in the payload are touched.
 * API-key fields are recorded as masked values for display, never in cleartext.
 */
export async function updateSettings(update: SettingsUpdate, db: DbLike = getDb()): Promise<AppSettings> {
  const existing = await ensureSettings(db);

  const values: Partial<AppSettings> = { updatedAt: new Date(), updatedBy: update.actor ?? 'dashboard' };

  if (update.confidenceThreshold !== undefined) values.confidenceThreshold = update.confidenceThreshold.toFixed(2);
  if (update.modelStrategy) values.modelStrategy = update.modelStrategy;
  if (update.accurateModel) values.accurateModel = update.accurateModel;
  if (update.bulkModel) values.bulkModel = update.bulkModel;
  if (update.parentDetectionEnabled !== undefined) values.parentDetectionEnabled = update.parentDetectionEnabled;
  if (update.enrichmentEnabled !== undefined) values.enrichmentEnabled = update.enrichmentEnabled;
  if (update.enrichProvider) values.enrichProvider = update.enrichProvider;
  if (update.syncEnabled !== undefined) values.syncEnabled = update.syncEnabled;
  if (update.syncCron) values.syncCron = update.syncCron;
  if (update.staleAfterDays !== undefined) values.staleAfterDays = update.staleAfterDays;
  if (update.batchSize !== undefined) values.batchSize = update.batchSize;
  if (update.weeklyReportEnabled !== undefined) values.weeklyReportEnabled = update.weeklyReportEnabled;
  if (update.weeklyReportCron) values.weeklyReportCron = update.weeklyReportCron;
  if (update.reportRecipients !== undefined) values.reportRecipients = update.reportRecipients ?? null;
  if (update.groqApiKey) values.groqApiKeyMasked = maskSecret(update.groqApiKey);
  if (update.enrichApiKey) values.enrichApiKeyMasked = maskSecret(update.enrichApiKey);

  const updated = await db.update(appSettings).set(values).where(eq(appSettings.id, existing.id)).returning();
  const row = updated[0] ?? existing;

  await recordAudit(
    {
      entity: 'settings',
      entityId: row.id,
      action: 'settings_updated',
      details: {
        changed: Object.keys(values).filter((key) => key !== 'updatedAt' && key !== 'updatedBy'),
        note: 'Secret values are never persisted; only masked fingerprints.',
      },
      actor: update.actor ?? 'dashboard',
    },
    db,
  );

  return row;
}

/**
 * Validate a cron string for the scheduler. Five fields, standard syntax; we
 * accept the subset node-cron supports and reject anything malformed so the
 * worker cannot be configured into a crash loop.
 */
export function isValidCron(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const field = /^(\*|\d{1,2}|\*\/\d{1,2}|\d{1,2}-\d{1,2}(,\d{1,2})*)$/;
  return parts.every((part) => field.test(part));
}

export type SettingsDiff = { key: string; from: unknown; to: unknown }[];

/** Human-readable diff for the settings confirmation toast. */
export function diffSettings(before: EffectiveSettings, update: SettingsUpdate): SettingsDiff {
  const diff: SettingsDiff = [];
  const push = (key: string, from: unknown, to: unknown) => {
    if (to === undefined || to === null) return;
    if (String(from) === String(to)) return;
    diff.push({ key, from, to });
  };
  push('confidenceThreshold', before.effective.confidenceThreshold, update.confidenceThreshold);
  push('modelStrategy', before.effective.modelStrategy, update.modelStrategy);
  push('accurateModel', before.effective.accurateModel, update.accurateModel);
  push('bulkModel', before.effective.bulkModel, update.bulkModel);
  push('parentDetectionEnabled', before.parentDetectionEnabled, update.parentDetectionEnabled);
  push('enrichmentEnabled', before.enrichmentEnabled, update.enrichmentEnabled);
  push('syncEnabled', before.syncEnabled, update.syncEnabled);
  push('syncCron', before.syncCron, update.syncCron);
  push('staleAfterDays', before.effective.staleAfterDays, update.staleAfterDays);
  push('batchSize', before.effective.batchSize, update.batchSize);
  push('weeklyReportEnabled', before.weeklyReportEnabled, update.weeklyReportEnabled);
  push('weeklyReportCron', before.weeklyReportCron, update.weeklyReportCron);
  return diff;
}
