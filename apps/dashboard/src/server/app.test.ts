import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DashboardStore } from '@reviewlens/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildDashboard } from './app.js';
import { fileExperiments, type ExperimentSource } from './experiments.js';

const reviewsSpy = () => vi.fn(async () => ({ items: [], total: 0 }));

function fakeStore(reviews = reviewsSpy()): DashboardStore {
  return {
    overview: vi.fn(async () => ({ repositories: 1 }) as never),
    repositories: vi.fn(async () => []),
    reviews,
    review: vi.fn(async (id: number) => (id === 7 ? ({ id: 7 } as never) : null)),
    feedback: vi.fn(async () => ({ byCategory: [], bySeverity: [], recent: [] })),
  };
}

const noExperiments: ExperimentSource = { list: async () => [], read: async () => null };

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dashboard-'));
  await mkdir(join(dir, 'client', 'assets'), { recursive: true });
  await writeFile(join(dir, 'client', 'index.html'), '<!doctype html><div id="root"></div>');
  await writeFile(join(dir, 'client', 'assets', 'app-abc.js'), 'console.log(1)');
  await writeFile(join(dir, 'secret.txt'), 'outside the client directory');
  await mkdir(join(dir, 'results', 'E1', 'abc123'), { recursive: true });
  await mkdir(join(dir, 'results', 'F1', 'unscored'), { recursive: true });
  await writeFile(
    join(dir, 'results', 'E1', 'abc123', 'summary.json'),
    JSON.stringify({
      description: 'strategies',
      scored_at: '2026-10-03T10:00:00Z',
      runs: 3,
      cases_complete_in_all_arms: 60,
      arms: [{ arm: 'S0' }, { arm: 'S4' }],
    }),
  );
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('dashboard API', { timeout: 20_000 }, () => {
  it('serves the store through JSON endpoints', async () => {
    const store = fakeStore();
    const app = buildDashboard({ store, experiments: noExperiments, demo: true });
    expect((await app.inject('/api/meta')).json()).toEqual({ demo: true });
    expect((await app.inject('/api/overview')).json()).toEqual({ repositories: 1 });
    expect((await app.inject('/api/reviews/7')).json()).toEqual({ id: 7 });
    expect((await app.inject('/api/reviews/8')).statusCode).toBe(404);
    expect((await app.inject('/api/reviews/abc')).statusCode).toBe(400);
    expect((await app.inject('/api/nope')).statusCode).toBe(404);
  });

  it('validates review list parameters before querying', async () => {
    const reviews = reviewsSpy();
    const app = buildDashboard({ store: fakeStore(reviews), experiments: noExperiments });
    await app.inject('/api/reviews?repo=3&status=failed&q=cart&limit=10&offset=20');
    expect(reviews).toHaveBeenCalledWith({
      repositoryId: 3,
      status: 'failed',
      search: 'cart',
      limit: 10,
      offset: 20,
    });
    expect((await app.inject('/api/reviews?limit=1000')).statusCode).toBe(400);
    expect((await app.inject('/api/reviews?status=deleted')).statusCode).toBe(400);
  });

  it('requires the password when one is set', async () => {
    const app = buildDashboard({
      store: fakeStore(),
      experiments: noExperiments,
      password: 'correct horse battery',
    });
    const basic = (password: string) => `Basic ${Buffer.from(`me:${password}`).toString('base64')}`;
    const denied = await app.inject('/api/overview');
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['www-authenticate']).toContain('Basic');
    expect(
      (await app.inject({ url: '/api/overview', headers: { authorization: basic('wrong') } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: '/api/overview',
          headers: { authorization: basic('correct horse battery') },
        })
      ).statusCode,
    ).toBe(200);
    // Liveness checks stay open.
    expect((await app.inject('/healthz')).statusCode).toBe(200);
  });

  it('serves the client, falls back to the page, and never leaves the client directory', async () => {
    const app = buildDashboard({
      store: fakeStore(),
      experiments: noExperiments,
      clientDir: join(dir, 'client'),
    });
    const page = await app.inject('/');
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['content-security-policy']).toContain("default-src 'self'");
    expect(page.headers['cache-control']).toBe('no-cache');
    const asset = await app.inject('/assets/app-abc.js');
    expect(asset.headers['content-type']).toContain('javascript');
    expect(asset.headers['cache-control']).toContain('immutable');
    expect((await app.inject('/reviews/12')).body).toContain('id="root"');
    for (const url of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt']) {
      expect((await app.inject(url)).body).not.toContain('outside the client');
    }
  });
});

describe('experiment results', () => {
  it('lists scored experiments and reads their summaries', async () => {
    const source = fileExperiments(join(dir, 'results'));
    expect(await source.list()).toEqual([
      {
        name: 'E1',
        hash: 'abc123',
        description: 'strategies',
        scoredAt: '2026-10-03T10:00:00Z',
        arms: ['S0', 'S4'],
        cases: 60,
        runs: 3,
      },
    ]);
    expect(await source.read('E1', 'abc123')).toMatchObject({ runs: 3 });
    expect(await source.read('F1', 'unscored')).toBeNull();
    expect(await source.read('..', 'abc123')).toBeNull();
    expect(await source.read('E1', '../../etc')).toBeNull();
    expect(await fileExperiments(join(dir, 'missing')).list()).toEqual([]);
  });
});
