import type { DashboardStore } from '@reviewlens/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDashboard, type DashboardDeps } from './app.js';

const noExperiments = { list: async () => [], read: async () => null };
const PASSWORD = 'correct horse battery staple';
const basic = (password: string) => `Basic ${Buffer.from(`me:${password}`).toString('base64')}`;

function store(overrides: Partial<DashboardStore> = {}): DashboardStore {
  return {
    overview: vi.fn(async () => ({ repositories: 1 }) as never),
    repositories: vi.fn(async () => []),
    reviews: vi.fn(async () => ({ items: [], total: 0 })),
    review: vi.fn(async () => null),
    feedback: vi.fn(async () => ({ byCategory: [], bySeverity: [], recent: [] })),
    ...overrides,
  };
}

let apps: ReturnType<typeof buildDashboard>[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});
const build = (deps: Partial<DashboardDeps>) => {
  const app = buildDashboard({ store: store(), experiments: noExperiments, ...deps });
  apps.push(app);
  return app;
};

describe('Host header (DNS rebinding)', () => {
  it('refuses requests addressed to a host it does not serve', async () => {
    // A page on attacker.example can rebind its name to 127.0.0.1 and read the loopback
    // dashboard as same-origin; the Host header still says attacker.example.
    const app = build({ allowedHosts: ['127.0.0.1:4000', 'localhost:4000'] });
    const rebound = await app.inject({
      url: '/api/overview',
      headers: { host: 'attacker.example:4000' },
    });
    expect(rebound.statusCode).toBe(421);
    expect(rebound.body).not.toContain('repositories');
    const missing = await app.inject({ url: '/api/overview', headers: { host: '' } });
    expect(missing.statusCode).toBe(421);
    const ok = await app.inject({ url: '/api/overview', headers: { host: 'localhost:4000' } });
    expect(ok.statusCode).toBe(200);
    // Case and a trailing dot do not matter to DNS, so they do not matter here.
    expect(
      (await app.inject({ url: '/healthz', headers: { host: 'LOCALHOST:4000' } })).statusCode,
    ).toBe(200);
  });
});

describe('password guessing', () => {
  it('locks out a client after repeated wrong passwords, even for the right one', async () => {
    const app = build({
      password: PASSWORD,
      limits: { authFailures: { max: 3, windowMs: 60_000 } },
    });
    const attempt = (password: string, ip = '203.0.113.9') =>
      app.inject({
        url: '/api/overview',
        remoteAddress: ip,
        headers: { authorization: basic(password) },
      });
    for (let i = 0; i < 3; i++) expect((await attempt(`guess-${i}`)).statusCode).toBe(401);
    const locked = await attempt(PASSWORD);
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['retry-after']).toBeDefined();
    // Another client is unaffected.
    expect((await attempt(PASSWORD, '198.51.100.3')).statusCode).toBe(200);
  });

  it('rejects malformed credentials without crashing', async () => {
    const app = build({ password: PASSWORD });
    for (const header of [
      'Basic',
      'Basic !!!not-base64',
      'Bearer x',
      `Basic ${'A'.repeat(20_000)}`,
    ]) {
      expect(
        (await app.inject({ url: '/api/overview', headers: { authorization: header } })).statusCode,
      ).toBe(401);
    }
  });
});

describe('request rate', () => {
  it('caps requests per client', async () => {
    const app = build({ limits: { requests: { max: 4, windowMs: 60_000 } } });
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await app.inject({ url: '/api/overview' })).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 429, 429]);
  });
});

describe('errors', () => {
  it('does not reveal internal details when the database fails', async () => {
    const app = build({
      store: store({
        overview: async () => {
          throw new Error(
            'Invalid `prisma.review.findMany()` invocation: connect to db.internal:5432 failed',
          );
        },
      }),
    });
    const res = await app.inject('/api/overview');
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal error' });
  });

  it('reports bad JSON and oversized bodies as client errors', async () => {
    const app = build({});
    const bad = await app.inject({
      method: 'POST',
      url: '/api/labels/benchmark/x',
      headers: { 'content-type': 'application/json' },
      payload: '{"verdict":',
    });
    expect([400, 404]).toContain(bad.statusCode);
    expect(bad.body).not.toMatch(/at .*\.js|node_modules/);
  });
});
