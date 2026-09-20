/**
 * Minimal HTTP server for the Render worker.
 *
 * Endpoints
 *   GET  /health   — cheap liveness probe, pings from cron-job.org every 5 min
 *                    to defeat the free tier's 15-minute spin-down.
 *   GET  /status   — scheduler state, free-tier budget, supplier stats.
 *   GET  /ready    — 200 only when the database answers (Render readiness).
 *   POST /run      — trigger a job now (`?job=sync|report|catchup`), needs CRON_SECRET.
 *   POST /sync     — alias of `?job=sync`.
 *
 * Authenticated routes accept the secret as `Authorization: Bearer <CRON_SECRET>`,
 * `x-cron-secret`, or `?secret=`. When CRON_SECRET is unset the routes are open
 * only in development.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { getEnv } from '@/lib/env';
import { closeDb, getDb } from '@/db/client';
import { sql } from 'drizzle-orm';
import { getSupplierStats } from '@/services/suppliers';
import { getLlmUsageOverview } from '@/services/llm-usage';
import { getSyncHealth } from '@/services/sync';
import { taxonomySize } from '@/services/classification';
import type { WorkerScheduler } from '@/worker/scheduler';

export type WorkerHttpOptions = {
  scheduler: WorkerScheduler;
  port?: number;
  onLog?: (message: string, meta?: Record<string, unknown>) => void;
};

export type WorkerHttpServer = {
  server: Server;
  close: () => Promise<void>;
  url: () => string;
};

const MAX_BODY_BYTES = 64 * 1024;

async function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

export function createWorkerHttpServer(options: WorkerHttpOptions): WorkerHttpServer {
  const env = getEnv();
  const port = options.port ?? env.PORT;
  const log = options.onLog ?? ((message: string, meta?: Record<string, unknown>) => console.log(`[worker] ${message}`, meta ?? ''));
  const startedAt = Date.now();

  const isAuthorized = (request: IncomingMessage, url: URL): boolean => {
    const secret = env.CRON_SECRET ?? env.WORKER_SECRET;
    if (!secret) return env.NODE_ENV !== 'production';

    const header = request.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const explicit = request.headers['x-cron-secret'];
    const query = url.searchParams.get('secret');
    const candidates = [bearer, typeof explicit === 'string' ? explicit : null, query].filter(Boolean);
    return candidates.includes(secret);
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (request.method === 'GET' && (path === '/health' || path === '/' || path === '/healthz')) {
        // Deliberately cheap: no database round-trip, so uptime pings are fast
        // and never hold a Neon connection open.
        sendJson(response, 200, {
          ok: true,
          service: 'unspsc-spend-categorizer-worker',
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          timestamp: new Date().toISOString(),
          jobs: options.scheduler.status().jobs.map((job) => ({
            name: job.name,
            cron: job.cron,
            description: job.description,
            enabled: job.enabled,
            lastStatus: job.lastStatus,
            lastFinishedAt: job.lastFinishedAt,
            nextRunAt: job.nextRunAt,
          })),
        });
        return;
      }

      if (request.method === 'GET' && (path === '/ready' || path === '/readyz')) {
        try {
          await getDb().execute(sql`select 1 as ok`);
          sendJson(response, 200, { ok: true, database: 'reachable' });
        } catch (error) {
          sendJson(response, 503, { ok: false, database: 'unreachable', error: String(error) });
        }
        return;
      }

      if (request.method === 'GET' && path === '/status') {
        if (!isAuthorized(request, url)) {
          sendJson(response, 401, { ok: false, error: 'unauthorized' });
          return;
        }
        const [stats, usage, taxonomy, health] = await Promise.all([
          getSupplierStats(),
          getLlmUsageOverview(),
          taxonomySize(),
          getSyncHealth(),
        ]);
        sendJson(response, 200, {
          ok: true,
          scheduler: options.scheduler.status(),
          stats,
          usage,
          taxonomyCodes: taxonomy,
          lastSync: health.lastSync,
        });
        return;
      }

      if (request.method === 'POST' && (path === '/run' || path === '/sync' || path === '/report')) {
        if (!isAuthorized(request, url)) {
          sendJson(response, 401, { ok: false, error: 'unauthorized' });
          return;
        }
        await readBody(request).catch(() => '');

        const requested = url.searchParams.get('job') ?? (path === '/sync' ? 'sync' : path === '/report' ? 'report' : 'sync');
        if (requested === 'catchup') {
          const result = await options.scheduler.catchUp();
          sendJson(response, 200, { ok: true, job: 'catchup', result });
          return;
        }
        if (requested !== 'sync' && requested !== 'report') {
          sendJson(response, 400, { ok: false, error: `unknown job "${requested}"` });
          return;
        }

        log(`manual trigger received for job ${requested}`);
        await options.scheduler.trigger(requested);
        const job = options.scheduler.status().jobs.find((candidate) => candidate.name === requested);
        sendJson(response, job?.lastStatus === 'error' ? 500 : 200, { ok: job?.lastStatus !== 'error', job });
        return;
      }

      sendJson(response, 404, { ok: false, error: `no route for ${request.method} ${path}` });
    } catch (error) {
      log('request failed', { path, error: error instanceof Error ? error.message : String(error) });
      sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return {
    server,
    url: () => `http://0.0.0.0:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export { closeDb };
