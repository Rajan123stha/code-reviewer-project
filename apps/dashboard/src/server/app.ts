import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { DashboardStore } from '@reviewlens/db';
import {
  createLogger,
  MemoryRateLimiter,
  retryAfterSeconds,
  type Logger,
  type WindowLimit,
} from '@reviewlens/shared';
import Fastify, { type FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ExperimentSource } from './experiments.js';
import { labelRoutes, type LabelPaths } from './labels.js';

export interface DashboardDeps {
  /** Review data. Null in labeling mode, which needs no database; its pages then say so. */
  store: DashboardStore | null;
  experiments: ExperimentSource;
  /** Built client (`vite build` output). Without it only the API is served. */
  clientDir?: string | undefined;
  /** When set, every request needs HTTP basic auth with this password (any user name). */
  password?: string | undefined;
  /** Shown as a banner in the client, so synthetic data is never mistaken for real. */
  demo?: boolean;
  /** Enables the labeling pages, which append to label files in the repository. */
  labels?: LabelPaths | undefined;
  logger?: Logger;
  /**
   * Host header values this dashboard answers to, such as "127.0.0.1:4000". Anything else is
   * refused with 421, which stops DNS rebinding: a web page that points its own name at
   * 127.0.0.1 still sends its own name as Host. Unset: no check (tests only).
   */
  allowedHosts?: readonly string[] | undefined;
  limits?: DashboardLimits;
  /** Proxies whose X-Forwarded-For to trust for per-client limits (e.g. "loopback"). */
  trustProxy?: boolean | string | undefined;
}

export interface DashboardLimits {
  /** Requests per client per window, all routes except /healthz. */
  requests?: WindowLimit;
  /** Wrong passwords per client per window before it is locked out. */
  authFailures?: WindowLimit;
}

export const DEFAULT_DASHBOARD_LIMITS: Required<DashboardLimits> = {
  requests: { max: 300, windowMs: 60_000 },
  authFailures: { max: 10, windowMs: 15 * 60_000 },
};

/** Lower-case, without a trailing dot: how DNS compares names. */
function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/\.(?=:\d+$)|\.$/, '');
}

const reviewQuerySchema = z.object({
  repo: z.coerce.number().int().positive().optional(),
  status: z.enum(['running', 'completed', 'posted', 'failed']).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function passwordMatches(header: string | undefined, password: string): boolean {
  if (!header?.startsWith('Basic ') || header.length > 4096) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return false;
  // Compare digests: equal length, so the comparison leaks neither content nor length.
  const digest = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(decoded.slice(colon + 1)), digest(password));
}

export function buildDashboard(deps: DashboardDeps) {
  const app = Fastify({
    loggerInstance: deps.logger ?? createLogger('dashboard', { level: 'silent' }),
    trustProxy: deps.trustProxy ?? false,
    // Label verdicts are the only request bodies; they are a few hundred bytes.
    bodyLimit: 64 * 1024,
  });
  const limits = { ...DEFAULT_DASHBOARD_LIMITS, ...deps.limits };
  const requests = new MemoryRateLimiter(limits.requests);
  const authFailures = new MemoryRateLimiter(limits.authFailures);
  const allowedHosts = deps.allowedHosts && new Set(deps.allowedHosts.map(normalizeHost));

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header(
      'content-security-policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    );
    if (req.url === '/healthz') return;
    if (allowedHosts && !allowedHosts.has(normalizeHost(req.headers.host ?? ''))) {
      return reply.code(421).send({ error: 'this dashboard does not serve that host name' });
    }
    const rate = await requests.hit(req.ip);
    if (!rate.allowed) {
      reply.header('retry-after', retryAfterSeconds(rate));
      return reply.code(429).send({ error: 'too many requests' });
    }
    if (deps.password) {
      // Locked out after repeated wrong passwords, even when the next one is right.
      const failures = await authFailures.blocked(req.ip);
      if (!failures.allowed) {
        reply.header('retry-after', retryAfterSeconds(failures));
        return reply.code(429).send({ error: 'too many failed sign-in attempts' });
      }
      if (!passwordMatches(req.headers.authorization, deps.password)) {
        if (req.headers.authorization) await authFailures.hit(req.ip);
        reply.header('www-authenticate', 'Basic realm="Reviewlens", charset="UTF-8"');
        return reply.code(401).send({ error: 'authentication required' });
      }
    }
  });

  // Client errors say what was wrong with the request; server errors say nothing about the
  // server (database errors name hosts and queries). Details go to the log only.
  app.setErrorHandler((error: Error & { statusCode?: number }, req, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err: error }, 'request failed');
      return reply.code(500).send({ error: 'internal error' });
    }
    const message =
      status === 413
        ? 'payload too large'
        : status === 415
          ? 'unsupported media type'
          : 'bad request';
    return reply.code(status).send({ error: message });
  });

  app.get('/healthz', () => ({ status: 'ok' }));
  app.get('/api/meta', () => ({
    demo: deps.demo ?? false,
    labeling: deps.labels !== undefined,
    database: deps.store !== null,
  }));
  if (deps.labels) void app.register(labelRoutes, deps.labels);

  if (deps.store) void app.register(storeRoutes, { store: deps.store });
  else {
    for (const path of [
      '/api/overview',
      '/api/repositories',
      '/api/reviews',
      '/api/reviews/:id',
      '/api/feedback',
    ]) {
      app.get(path, (_req, reply) =>
        reply.code(503).send({ error: 'no database: this dashboard runs in labeling mode only' }),
      );
    }
  }

  app.get('/api/experiments', () => deps.experiments.list());
  app.get<{ Params: { name: string; hash: string } }>(
    '/api/experiments/:name/:hash',
    async (req, reply) => {
      const summary = await deps.experiments.read(req.params.name, req.params.hash);
      return summary ?? reply.code(404).send({ error: 'experiment not found' });
    },
  );
  app.get('/api/*', (_req, reply) => reply.code(404).send({ error: 'not found' }));

  // The client: real files by path, everything else is the single page (it routes by hash).
  const clientDir = deps.clientDir;
  app.get('/*', async (req, reply) => {
    if (!clientDir) return reply.code(404).send({ error: 'client not built; run `pnpm build`' });
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = normalize(join(clientDir, path));
    const inside = file.startsWith(normalize(clientDir) + sep);
    const target = inside && extname(file) ? file : join(clientDir, 'index.html');
    try {
      const body = await readFile(target);
      const type = CONTENT_TYPES[extname(target)] ?? 'application/octet-stream';
      // Built assets carry a content hash in their names; the page itself must stay fresh.
      reply.header(
        'cache-control',
        target.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
      return reply.type(type).send(body);
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
  });

  return app;
}

const storeRoutes: FastifyPluginAsync<{ store: DashboardStore }> = async (app, { store }) => {
  app.get('/api/overview', () => store.overview());
  app.get('/api/repositories', () => store.repositories());

  app.get('/api/reviews', async (req, reply) => {
    const parsed = reviewQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid query' });
    const { repo, status, q, limit, offset } = parsed.data;
    return store.reviews({ repositoryId: repo, status, search: q, limit, offset });
  });

  app.get<{ Params: { id: string } }>('/api/reviews/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid id' });
    const review = await store.review(id);
    return review ?? reply.code(404).send({ error: 'review not found' });
  });

  app.get('/api/feedback', () => store.feedback());
};
