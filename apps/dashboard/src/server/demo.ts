// `pnpm --filter @reviewlens/dashboard demo`: the dashboard over synthetic data in an
// in-memory Postgres (PGlite). Touches no real database. The client shows a demo banner.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createDashboardStore, createDb } from '@reviewlens/db';
import { createLogger } from '@reviewlens/shared';
import { buildDashboard } from './app.js';
import { seedDemo } from './demo-data.js';
import { fileExperiments } from './experiments.js';

const root = new URL('../../../../', import.meta.url);
const migrations = new URL('packages/db/prisma/migrations/', root);

const pglite = await PGlite.create({ extensions: { vector } });
for (const dir of (await readdir(migrations, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()) {
  await pglite.exec(await readFile(new URL(`${dir}/migration.sql`, migrations), 'utf8'));
}
const dbPort = 55_000 + Math.floor(Math.random() * 1_000);
const socket = new PGLiteSocketServer({ db: pglite, port: dbPort, host: '127.0.0.1' });
await socket.start();
const db = createDb(`postgresql://postgres@127.0.0.1:${dbPort}/postgres?sslmode=disable`, {
  maxConnections: 1,
});
await seedDemo(db);

const port = Number(process.env.DASHBOARD_PORT ?? 4000);
const app = buildDashboard({
  store: createDashboardStore(db),
  // Experiment results are real files, not demo data.
  experiments: fileExperiments(fileURLToPath(new URL('eval/results', root))),
  clientDir: fileURLToPath(new URL('../../dist/client', import.meta.url)),
  demo: true,
  logger: createLogger('dashboard', { level: 'warn' }),
});
await app.listen({ host: '127.0.0.1', port });
console.log(`demo dashboard (synthetic data) on http://127.0.0.1:${port}`);
