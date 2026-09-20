/**
 * Keep-alive + cron ping for the Render free tier.
 *
 * Render spins a free web service down after 15 minutes without traffic, which
 * would mean the worker's 03:00 sync never fires. cron-job.org (or any HTTP cron
 * service) calls this script every 5 minutes instead:
 *
 *   node scripts/ping-worker.mjs https://unspsc-spend-worker.onrender.com
 *
 * `GET /health` is deliberately cheap (no database round-trip), so waking the
 * service costs nothing on the Neon side.
 *
 * Options:
 *   --sync        also POST /run?job=sync     (needs CRON_SECRET)
 *   --report      also POST /run?job=report   (needs CRON_SECRET)
 *   --strict      exit non-zero when the service is not healthy
 *   --timeout=ms  request timeout, default 30000 (Render needs time to boot)
 *
 * Environment:
 *   WORKER_URL     base URL (alternative to the first argument)
 *   CRON_SECRET    secret for the trigger endpoints
 */

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--') && !arg.includes('=')));
const options = new Map(
  args
    .filter((arg) => arg.startsWith('--') && arg.includes('='))
    .map((arg) => {
      const [key, ...rest] = arg.split('=');
      return [key, rest.join('=')];
    }),
);

const baseUrl = (args.find((arg) => !arg.startsWith('--')) ?? process.env.WORKER_URL ?? '').replace(/\/+$/, '');
const timeoutMs = Number(options.get('--timeout') ?? 30_000);
const secret = process.env.CRON_SECRET ?? '';

if (!baseUrl) {
  console.error(
    [
      'Usage: node scripts/ping-worker.mjs <worker-base-url> [--sync] [--report] [--strict] [--timeout=ms]',
      '',
      'Example:',
      '  node scripts/ping-worker.mjs https://unspsc-spend-worker.onrender.com',
      '  CRON_SECRET=... node scripts/ping-worker.mjs $WORKER_URL --sync',
    ].join('\n'),
  );
  process.exit(2);
}

async function request(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl}${path}`, { ...init, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text.slice(0, 300);
    }
    return { ok: response.ok, status: response.status, ms: Date.now() - started, body };
  } catch (error) {
    return { ok: false, status: 0, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders() {
  return secret ? { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

async function main() {
  const stamp = new Date().toISOString();
  const started = Date.now();

  const health = await request('/health');
  if (!health.ok) {
    console.error(`[${stamp}] health ping FAILED (${health.status || 'no response'}, ${health.ms}ms)`, health.error ?? health.body);
    if (flags.has('--strict')) process.exit(1);
    return;
  }

  const jobs = Array.isArray(health.body?.jobs) ? health.body.jobs : [];
  console.log(
    `[${stamp}] health OK in ${health.ms}ms · uptime ${health.body?.uptimeSeconds ?? '?'}s · jobs: ${jobs
      .map((job) => `${job.name}${job.enabled ? '' : '(disabled)'} next=${job.nextRunAt ?? '?'}`)
      .join(', ')}`,
  );

  if (flags.has('--sync') || flags.has('--report')) {
    for (const job of ['sync', 'report']) {
      if (!flags.has(`--${job}`)) continue;
      if (!secret) {
        console.error(`--${job} requires CRON_SECRET to be set in the environment`);
        continue;
      }
      const result = await request(`/run?job=${job}`, { method: 'POST', headers: authHeaders(), body: '{}' });
      const summary = result.body?.job
        ? `status=${result.body.job.lastStatus} runCount=${result.body.job.runCount}`
        : JSON.stringify(result.body)?.slice(0, 200);
      console.log(`[${stamp}] ${job} trigger ${result.ok ? 'OK' : 'FAILED'} (${result.status}, ${result.ms}ms) ${summary}`);
      if (!result.ok && flags.has('--strict')) process.exit(1);
    }
  }

  console.log(`[${stamp}] done in ${Date.now() - started}ms`);
}

void main().catch((error) => {
  console.error('ping-worker failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
