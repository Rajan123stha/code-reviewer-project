import { fileURLToPath } from 'node:url';
import { createDashboardStore, createDb } from '@reviewlens/db';
import { createLogger, parseEnv } from '@reviewlens/shared';
import { buildDashboard } from './app.js';
import { allowedHosts, dashboardEnvSchema } from './env.js';
import { fileExperiments } from './experiments.js';

const env = parseEnv(dashboardEnvSchema);

const logger = createLogger('dashboard', { level: env.LOG_LEVEL });
const db = createDb(env.DATABASE_URL);
const app = buildDashboard({
  store: createDashboardStore(db),
  experiments: fileExperiments(
    env.RESULTS_DIR ?? fileURLToPath(new URL('../../../../eval/results', import.meta.url)),
  ),
  clientDir: fileURLToPath(new URL('../client', import.meta.url)),
  password: env.DASHBOARD_PASSWORD,
  allowedHosts: allowedHosts(env.DASHBOARD_PORT, env.DASHBOARD_ALLOWED_HOSTS),
  trustProxy: env.TRUST_PROXY,
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
