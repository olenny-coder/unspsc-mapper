/**
 * Dependency-free cron expression matcher.
 *
 * The Render worker must not pull in a scheduler library, and the free tier
 * spins down after 15 minutes idle — so instead of relying on the process being
 * alive at an exact minute, the worker combines this matcher with a
 * "did we miss a window?" catch-up check (see `worker/scheduler.ts`).
 *
 * Supported syntax (5 fields: minute hour day-of-month month day-of-week):
 *   *         any value
 *   5         exact value
 *   1-5       inclusive range
 *   1,3,5     list
 *   * / 15    step (also 0-30/10)
 */

export type CronFields = {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
};

/** Parse a 5-field cron expression; throws on anything malformed. */
export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron expression must have exactly 5 fields, received ${parts.length}: "${expression}"`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [string, string, string, string, string];
  validateField(minute, 0, 59, 'minute');
  validateField(hour, 0, 23, 'hour');
  validateField(dayOfMonth, 1, 31, 'day-of-month');
  validateField(month, 1, 12, 'month');
  validateField(dayOfWeek, 0, 6, 'day-of-week');
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

export function isValidCronExpression(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

function validateField(field: string, min: number, max: number, label: string): void {
  for (const part of field.split(',')) {
    const [range, stepRaw] = part.split('/');
    if (stepRaw !== undefined) {
      const step = Number(stepRaw);
      if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step in ${label} field: "${part}"`);
    }
    if (range === '*' || range === undefined) continue;
    if (range.includes('-')) {
      const [startRaw, endRaw] = range.split('-');
      const start = Number(startRaw);
      const end = Number(endRaw);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
        throw new Error(`Invalid range in ${label} field: "${part}"`);
      }
      continue;
    }
    const value = Number(range);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`Invalid value "${part}" in ${label} field (expected ${min}-${max})`);
    }
  }
}

/** Does a single field match a value? */
export function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  for (const part of field.split(',')) {
    const [rangeRaw, stepRaw] = part.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);

    let start: number;
    let end: number;

    if (rangeRaw === '*' || rangeRaw === undefined) {
      start = min;
      end = max;
    } else if (rangeRaw.includes('-')) {
      const [a, b] = rangeRaw.split('-');
      start = Number(a);
      end = Number(b);
    } else {
      start = Number(rangeRaw);
      end = stepRaw === undefined ? start : max;
    }

    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (value < start || value > end) continue;
    if (step > 1 && (value - start) % step !== 0) continue;
    return true;
  }
  return false;
}

/**
 * Does `date` match the expression? Evaluated in UTC.
 *
 * Standard cron semantics: when both day-of-month and day-of-week are
 * restricted (neither is `*`), a match on EITHER fires the job.
 */
export function cronMatches(expression: string, date: Date = new Date()): boolean {
  let fields: CronFields;
  try {
    fields = parseCron(expression);
  } catch {
    return false;
  }

  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dayOfMonth = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const dayOfWeek = date.getUTCDay();

  if (!fieldMatches(fields.minute, minute, 0, 59)) return false;
  if (!fieldMatches(fields.hour, hour, 0, 23)) return false;
  if (!fieldMatches(fields.month, month, 1, 12)) return false;

  const domRestricted = fields.dayOfMonth !== '*';
  const dowRestricted = fields.dayOfWeek !== '*';
  const domMatch = fieldMatches(fields.dayOfMonth, dayOfMonth, 1, 31);
  const dowMatch = fieldMatches(fields.dayOfWeek, dayOfWeek, 0, 6);

  if (domRestricted && dowRestricted) return domMatch || dowMatch;
  if (domRestricted) return domMatch;
  if (dowRestricted) return dowMatch;
  return true;
}

/** Stable per-minute bucket key, used to dedupe firings. */
export function minuteKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 16);
}

/**
 * Was a slot due between `since` and `now`? Used by the catch-up check so a
 * Render worker that was asleep at the scheduled minute still runs the job once
 * it wakes up.
 *
 * Scans minute-by-minute, capped at `maxLookbackMinutes` (7 days by default) so
 * the check stays cheap.
 */
export function didMissSchedule(
  expression: string,
  since: Date | null,
  now: Date = new Date(),
  maxLookbackMinutes = 7 * 24 * 60,
): boolean {
  if (!since) return true;
  const from = new Date(Math.max(since.getTime(), now.getTime() - maxLookbackMinutes * 60_000));
  // Start at the next whole minute after `since`.
  from.setUTCSeconds(0, 0);
  from.setUTCMinutes(from.getUTCMinutes() + 1);

  const cursor = new Date(from.getTime());
  let scanned = 0;
  while (cursor.getTime() <= now.getTime() && scanned < maxLookbackMinutes) {
    if (cronMatches(expression, cursor)) return true;
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    scanned += 1;
  }
  return false;
}

/** Next scheduled run after `from` (used by the UI/health output). */
export function nextRunAfter(expression: string, from: Date = new Date(), maxMinutes = 366 * 24 * 60): Date | null {
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  for (let i = 0; i < maxMinutes; i += 1) {
    if (cronMatches(expression, cursor)) return new Date(cursor.getTime());
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

/** Human-readable description of the common schedules. */
export function describeCron(expression: string): string {
  if (expression === '0 3 * * *') return 'daily at 03:00 UTC';
  if (expression === '0 6 * * 1') return 'Mondays at 06:00 UTC';
  if (expression === '0 * * * *') return 'hourly, on the hour';
  if (expression === '*/15 * * * *') return 'every 15 minutes';
  return expression;
}
