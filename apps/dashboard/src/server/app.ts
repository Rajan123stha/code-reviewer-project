import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { DashboardStore } from '@reviewlens/db';
import { createLogger, type Logger } from '@reviewlens/shared';
import Fastify from 'fastify';
import { z } from 'zod';
import type { ExperimentSource } from './experiments.js';

export interface DashboardDeps {
  store: DashboardStore;
  experiments: ExperimentSource;
  /** Built client (`vite build` output). Without it only the API is served. */
  clientDir?: string | undefined;
  /** When set, every request needs HTTP basic auth with this password (any user name). */
  password?: string | undefined;
  /** Shown as a banner in the client, so synthetic data is never mistaken for real. */
  demo?: boolean;
  logger?: Logger;
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
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const given = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
  const expected = Buffer.from(password);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function buildDashboard(deps: DashboardDeps) {
  const app = Fastify({
    loggerInstance: deps.logger ?? createLogger('dashboard', { level: 'silent' }),
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header(
      'content-security-policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    );
    if (req.url === '/healthz') return;
    if (deps.password && !passwordMatches(req.headers.authorization, deps.password)) {
      reply.header('www-authenticate', 'Basic realm="Reviewlens", charset="UTF-8"');
      return reply.code(401).send({ error: 'authentication required' });
    }
  });

  app.get('/healthz', () => ({ status: 'ok' }));
  app.get('/api/meta', () => ({ demo: deps.demo ?? false }));
  app.get('/api/overview', () => deps.store.overview());
  app.get('/api/repositories', () => deps.store.repositories());

  app.get('/api/reviews', async (req, reply) => {
    const parsed = reviewQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid query' });
    const { repo, status, q, limit, offset } = parsed.data;
    return deps.store.reviews({ repositoryId: repo, status, search: q, limit, offset });
  });

  app.get<{ Params: { id: string } }>('/api/reviews/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid id' });
    const review = await deps.store.review(id);
    return review ?? reply.code(404).send({ error: 'review not found' });
  });

  app.get('/api/feedback', () => deps.store.feedback());
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
