import { fileURLToPath } from 'node:url';
import { createDashboardStore, createDb } from '@reviewlens/db';
import { createLogger, logEnv, parseEnv } from '@reviewlens/shared';
import { z } from 'zod';
import { buildDashboard } from './app.js';
import { fileExperiments } from './experiments.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const env = parseEnv(
  z.object({
    ...logEnv,
    DATABASE_URL: z.string().min(1),
    DASHBOARD_HOST: z.string().default('127.0.0.1'),
    DASHBOARD_PORT: z.coerce.number().int().default(4000),
    /** Required unless the dashboard listens on loopback only. */
    DASHBOARD_PASSWORD: z.string().min(12).optional(),
    RESULTS_DIR: z.string().optional(),
  }),
);

// Review data includes code from the reviewed repositories: never expose it unauthenticated.
if (!LOOPBACK.has(env.DASHBOARD_HOST) && !env.DASHBOARD_PASSWORD) {
  throw new Error(
    `DASHBOARD_HOST is ${env.DASHBOARD_HOST}; set DASHBOARD_PASSWORD (12+ characters) to listen beyond loopback`,
  );
}

const logger = createLogger('dashboard', { level: env.LOG_LEVEL });
const db = createDb(env.DATABASE_URL);
const app = buildDashboard({
  store: createDashboardStore(db),
  experiments: fileExperiments(
    env.RESULTS_DIR ?? fileURLToPath(new URL('../../../../eval/results', import.meta.url)),
  ),
  clientDir: fileURLToPath(new URL('../client', import.meta.url)),
  password: env.DASHBOARD_PASSWORD,
  logger,
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  await app.close();
  await db.$disconnect();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: env.DASHBOARD_HOST, port: env.DASHBOARD_PORT });
