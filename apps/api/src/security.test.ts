import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type AppDeps } from './app.js';
import type { EnqueueFeedback, EnqueueIndex, EnqueueReview } from './queue.js';
import { signGitHubPayload } from './signature.js';

// Malicious and malformed webhook input. Every request here is correctly signed unless the
// test says otherwise: these are replays or forged-header variations an attacker who has seen
// one delivery (or a compromised proxy) could send. The signature covers the body only.

const SECRET = 'test-secret-0123456789';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const DELIVERY = '72d3162e-cc78-11e3-81ab-4c9367dc0958';

function pr(overrides: Record<string, unknown> = {}, prOverrides: Record<string, unknown> = {}) {
  return {
    action: 'opened',
    installation: { id: 100 },
    repository: { id: 200, name: 'hello', owner: { login: 'octo' } },
    pull_request: { number: 5, head: { sha: HEAD }, base: { sha: BASE }, ...prOverrides },
    ...overrides,
  };
}

let apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

function setup(extra: Partial<AppDeps> = {}) {
  const enqueueReview = vi.fn<EnqueueReview>(async () => ({ jobId: 'job-1' }));
  const enqueueIndex = vi.fn<EnqueueIndex>(async () => ({ jobId: 'index-1' }));
  const enqueueFeedback = vi.fn<EnqueueFeedback>(async () => ({ jobId: 'feedback-1' }));
  const app = buildApp({
    webhookSecret: SECRET,
    enqueueReview,
    enqueueIndex,
    enqueueFeedback,
    ...extra,
  });
  apps.push(app);
  const send = (
    body: unknown,
    options: { event?: string; delivery?: string; signature?: string; ip?: string } = {},
  ) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    return app.inject({
      method: 'POST',
      url: '/webhooks/github',
      remoteAddress: options.ip ?? '203.0.113.7',
      headers: {
        'content-type': 'application/json',
        'x-github-event': options.event ?? 'pull_request',
        'x-github-delivery': options.delivery ?? DELIVERY,
        'x-hub-signature-256': options.signature ?? signGitHubPayload(SECRET, raw),
      },
      payload: raw,
    });
  };
  return { app, send, enqueueReview, enqueueIndex, enqueueFeedback };
}

describe('webhook input validation', () => {
  it('accepts an ordinary pull request event', async () => {
    const t = setup();
    expect((await t.send(pr())).statusCode).toBe(202);
    expect(t.enqueueReview).toHaveBeenCalledOnce();
  });

  it.each([
    ['a non-hex head sha', pr({}, { head: { sha: '../../../etc/passwd' } })],
    ['a short sha', pr({}, { base: { sha: 'abc123' } })],
    ['a negative PR number', pr({}, { number: -5 })],
    ['a fractional PR number', pr({}, { number: 1.5 })],
    ['a huge installation id', pr({ installation: { id: Number.MAX_SAFE_INTEGER + 2 } })],
    [
      'an owner with a slash',
      pr({ repository: { id: 200, name: 'hello', owner: { login: 'octo/../x' } } }),
    ],
    [
      'a repository name with spaces',
      pr({ repository: { id: 200, name: 'he llo', owner: { login: 'octo' } } }),
    ],
    [
      'a 10 kB repository name',
      pr({ repository: { id: 200, name: 'x'.repeat(10_000), owner: { login: 'octo' } } }),
    ],
  ])('rejects %s before anything is queued', async (_name, payload) => {
    const t = setup();
    const res = await t.send(payload);
    expect(res.statusCode).toBe(400);
    expect(t.enqueueReview).not.toHaveBeenCalled();
  });

  it.each([
    ['a colon (breaks BullMQ job ids)', 'abc:def'],
    ['a newline', 'abc\ndef'],
    ['200 characters', 'a'.repeat(200)],
  ])('rejects a delivery id with %s', async (_name, delivery) => {
    const t = setup();
    // Header values with a newline cannot be sent over HTTP; inject passes them through.
    const res = await t.send(pr({ action: 'synchronize' }), { delivery });
    expect(res.statusCode).toBe(400);
    expect(t.enqueueFeedback).not.toHaveBeenCalled();
    expect(t.enqueueReview).not.toHaveBeenCalled();
  });

  it('accepts the boundary values GitHub can send', async () => {
    const t = setup();
    const name = 'a'.repeat(100); // GitHub's maximum repository name length
    const owner = 'o'.repeat(39); // and login length
    const res = await t.send(
      pr({
        repository: { id: 2 ** 31 + 7, name: `${name.slice(0, 98)}.-`, owner: { login: owner } },
      }),
    );
    expect(res.statusCode).toBe(202);
  });

  it('does not let __proto__ in a payload pollute objects', async () => {
    const t = setup();
    const raw = JSON.stringify(pr()).replace('{', '{"__proto__":{"polluted":true},');
    const res = await t.send(raw);
    expect(res.statusCode).toBe(202);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(t.enqueueReview.mock.calls[0]![0]).not.toHaveProperty('polluted');
  });
});

describe('webhook errors', () => {
  it('reports internal failures without internal details', async () => {
    const t = setup();
    t.enqueueReview.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 10.0.0.5:6379 at redis.internal'),
    );
    const res = await t.send(pr());
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('10.0.0.5');
    expect(res.body).not.toContain('ECONNREFUSED');
    expect(res.json()).toEqual({ error: 'internal error' });
  });
});

describe('webhook rate limiting', () => {
  it('blocks a client after repeated bad signatures, without affecting others', async () => {
    const t = setup({ limits: { signatureFailures: { max: 3, windowMs: 60_000 } } });
    for (let i = 0; i < 3; i++) {
      expect((await t.send(pr(), { signature: 'sha256=' + '0'.repeat(64) })).statusCode).toBe(401);
    }
    // Now even a correctly signed request from that address is refused for a while...
    const blocked = await t.send(pr());
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    // ...but GitHub's other delivery addresses are not.
    expect((await t.send(pr(), { ip: '198.51.100.20' })).statusCode).toBe(202);
  });

  it('caps the request rate per client', async () => {
    const t = setup({ limits: { requests: { max: 5, windowMs: 60_000 } } });
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await t.send(pr())).statusCode);
    expect(codes).toEqual([202, 202, 202, 202, 202, 429, 429]);
    // The health check is never limited, so orchestration probes keep working.
    expect((await t.app.inject({ url: '/healthz', remoteAddress: '203.0.113.7' })).statusCode).toBe(
      200,
    );
  });
});
