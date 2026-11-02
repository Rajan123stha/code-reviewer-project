// `pnpm label`: the dashboard's labeling pages on this machine, with no database. Labels go
// to the same files the Python tools write (see labels.ts), so commit them like any result.
import { fileURLToPath } from 'node:url';
import { createLogger } from '@reviewlens/shared';
import { buildDashboard } from './app.js';
import { allowedHosts } from './env.js';
import { fileExperiments } from './experiments.js';
import { defaultReposDir } from './labels.js';

const root = new URL('../../../../', import.meta.url);
const path = (relative: string) => fileURLToPath(new URL(relative, root));

const port = Number(process.env.DASHBOARD_PORT ?? 4000);
const app = buildDashboard({
  store: null,
  experiments: fileExperiments(path('eval/results')),
  clientDir: fileURLToPath(new URL('../../dist/client', import.meta.url)),
  labels: {
    manifest: path('eval/benchmark/manifests/benchmark-a.v1.json'),
    sample: path('eval/benchmark/validation/sample-seed20261003-n100.json'),
    verdicts: path('eval/benchmark/validation/verdicts.jsonl'),
    results: path('eval/results'),
    repos: defaultReposDir(),
  },
  allowedHosts: allowedHosts(port),
  logger: createLogger('dashboard', { level: 'warn' }),
});
// Loopback only: labeling writes files and asks for no password.
await app.listen({ host: '127.0.0.1', port });
console.log(`labeling on http://127.0.0.1:${port}/#/labels`);
