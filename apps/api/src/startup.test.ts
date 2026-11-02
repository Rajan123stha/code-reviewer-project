import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { apiEnvSchema } from './env.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

/** Start the real API entry point with only the given variables. */
function start(env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', '--conditions=source', 'apps/api/src/main.ts'],
    {
      cwd: root,
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...env },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
}

describe('API startup', { timeout: 90_000 }, () => {
  it('exits before opening a port when the webhook secret is missing or weak, without echoing it', () => {
    const missing = start({ PORT: '0' });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('GITHUB_WEBHOOK_SECRET: is required');

    const weak = 'weak-secret-1';
    const short = start({ PORT: '0', GITHUB_WEBHOOK_SECRET: weak });
    expect(short.status).not.toBe(0);
    expect(short.stderr).toContain('GITHUB_WEBHOOK_SECRET: must be at least 16 characters');
    expect(short.stderr + short.stdout).not.toContain(weak);
  });

  it('accepts a strong secret', () => {
    expect(apiEnvSchema.safeParse({ GITHUB_WEBHOOK_SECRET: 'f'.repeat(64) }).success).toBe(true);
  });
});
