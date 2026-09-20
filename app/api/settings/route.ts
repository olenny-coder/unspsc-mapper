/**
 * /api/settings
 *
 *  GET   — current settings with env-effective values and masked secrets
 *  PATCH — update thresholds, models, sync schedule, parent detection, etc.
 *
 * Secrets are never written to the database; only a masked fingerprint is stored
 * so the UI can show whether a key is configured.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { dynamic, jsonHandler, readJsonBody } from '@/lib/api';
import { requireAuth } from '@/lib/auth';
import { getEnv } from '@/lib/env';
import { ValidationError } from '@/lib/errors';
import { settingsUpdateSchema } from '@/lib/validation';
import { diffSettings, getEffectiveSettings, isValidCron, updateSettings } from '@/services/settings';
import { getLlmUsageOverview, getUsageHistory } from '@/services/llm-usage';
import { GROQ_MODEL_CHOICES } from '@/services/groq';
import { taxonomySize } from '@/services/classification';

export { dynamic };

export const GET = jsonHandler(async () => {

  const env = getEnv();
  const [settings, usage, history, codes] = await Promise.all([
    getEffectiveSettings(),
    getLlmUsageOverview(),
    getUsageHistory(7),
    taxonomySize(),
  ]);

  return NextResponse.json({
    ok: true,
    data: {
      settings,
      usage,
      usageHistory: history.map((row) => ({
        day: row.usageDay,
        model: row.model,
        requests: row.requestCount,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        failures: row.failureCount,
      })),
      modelChoices: GROQ_MODEL_CHOICES,
      taxonomyCodes: codes,
      limits: {
        llmRequestsPerDayAccurate: env.LLM_MAX_REQUESTS_PER_DAY_70B,
        llmRequestsPerDayBulk: env.LLM_MAX_REQUESTS_PER_DAY_8B,
        llmRequestsPerMinute: env.LLM_MAX_REQUESTS_PER_MINUTE,
        llmBatchSize: env.LLM_BATCH_SIZE,
        enrichmentCreditsPerMonth: env.ENRICH_MONTHLY_CREDIT_LIMIT,
      },
    },
  });
});

export const PATCH = jsonHandler(async (request: NextRequest) => {
  await requireAuth(request);

  const body = await readJsonBody(request, settingsUpdateSchema);

  if (body.syncCron && !isValidCron(body.syncCron)) {
    throw new ValidationError('syncCron must be a 5-field cron expression, e.g. "0 3 * * *".', {
      received: body.syncCron,
    });
  }
  if (body.weeklyReportCron && !isValidCron(body.weeklyReportCron)) {
    throw new ValidationError('weeklyReportCron must be a 5-field cron expression, e.g. "0 6 * * 1".', {
      received: body.weeklyReportCron,
    });
  }

  const before = await getEffectiveSettings();
  const after = await updateSettings(body);
  const settings = await getEffectiveSettings();

  return NextResponse.json({
    ok: true,
    data: {
      settings,
      saved: after.id,
      changes: diffSettings(before, body),
      notes: [
        'Confidence threshold and parent-detection changes apply to the next classification run.',
        'Model ids, stale-days, batch size and cron schedule are read from environment variables at runtime; update the Vercel/Render env vars to change them durably.',
        'API keys are stored as masked fingerprints only and are never persisted in cleartext.',
      ],
    },
  });
});
