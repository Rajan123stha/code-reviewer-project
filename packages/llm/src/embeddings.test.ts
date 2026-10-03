import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  dot,
  EmbeddingClient,
  FakeEmbeddingProvider,
  FileEmbeddingCache,
  GeminiEmbeddingProvider,
  normalize,
  type EmbeddingProvider,
} from './embeddings.js';
import { LLMError } from './errors.js';
import { GeminiKeyRunner } from './providers/gemini.js';

const base = { model: 'm', dimensions: 64, kind: 'document' as const };

describe('EmbeddingClient', () => {
  it('returns unit vectors in input order and caches by content', async () => {
    const provider = new FakeEmbeddingProvider();
    const client = new EmbeddingClient({ provider });
    const first = await client.embed({
      ...base,
      texts: ['alpha beta', 'gamma delta', 'alpha beta'],
    });

    expect(first.vectors).toHaveLength(3);
    expect(first.vectors[0]).toEqual(first.vectors[2]);
    expect(Math.hypot(...first.vectors[0]!)).toBeCloseTo(1, 10);
    // The duplicate text is embedded once.
    expect(first.stats).toMatchObject({ texts: 3, fromCache: 0, embedded: 2, requests: 1 });

    const second = await client.embed({ ...base, texts: ['gamma delta', 'epsilon zeta'] });
    expect(second.stats).toMatchObject({ fromCache: 1, embedded: 1, requests: 1 });
    expect(provider.requests[1]!.texts).toEqual(['epsilon zeta']);
  });

  it('keeps documents and queries, models and sizes in separate cache entries', async () => {
    const client = new EmbeddingClient({ provider: new FakeEmbeddingProvider() });
    const key = client.cacheKey(base, 'x');
    expect(client.cacheKey({ ...base, kind: 'query' }, 'x')).not.toBe(key);
    expect(client.cacheKey({ ...base, model: 'm2' }, 'x')).not.toBe(key);
    expect(client.cacheKey({ ...base, dimensions: 32 }, 'x')).not.toBe(key);
  });

  it('splits into batches', async () => {
    const provider = new FakeEmbeddingProvider();
    const client = new EmbeddingClient({ provider, batchSize: 2 });
    const { stats } = await client.embed({ ...base, texts: ['a1a', 'b2b', 'c3c', 'd4d', 'e5e'] });
    expect(stats.requests).toBe(3);
    expect(provider.requests.map((r) => r.texts.length)).toEqual([2, 2, 1]);
  });

  it('retries retryable errors and gives up on others', async () => {
    let calls = 0;
    const flaky: EmbeddingProvider = {
      name: 'flaky',
      embed: async (req) => {
        if (++calls === 1) throw new LLMError('server', 'overloaded');
        return req.texts.map(() => [1, 0]);
      },
    };
    const sleep = vi.fn(async () => {});
    const ok = await new EmbeddingClient({ provider: flaky, sleep }).embed({
      ...base,
      texts: ['abc'],
    });
    expect(ok.vectors).toEqual([[1, 0]]);
    expect(sleep).toHaveBeenCalledTimes(1);

    const bad: EmbeddingProvider = {
      name: 'bad',
      embed: async () => {
        throw new LLMError('bad_request', 'nope');
      },
    };
    await expect(
      new EmbeddingClient({ provider: bad, sleep }).embed({ ...base, texts: ['abc'] }),
    ).rejects.toMatchObject({
      kind: 'bad_request',
    });
  });

  it('fake embeddings rank related text above unrelated text', async () => {
    const client = new EmbeddingClient({ provider: new FakeEmbeddingProvider() });
    const { vectors } = await client.embed({
      ...base,
      dimensions: 256,
      texts: [
        'function applyCoupon(sum, coupon) { return sum - coupon.pct }',
        'function validateCoupon(coupon) { return coupon.expiresAt > now }',
        'export class HttpServer { listen(port) {} }',
      ],
    });
    expect(dot(vectors[0]!, vectors[1]!)).toBeGreaterThan(dot(vectors[0]!, vectors[2]!));
  });
});

describe('FileEmbeddingCache', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('persists vectors across instances', async () => {
    dir = await mkdtemp(join(tmpdir(), 'emb-cache-'));
    await new FileEmbeddingCache(dir).setMany([
      ['aa11', [1, 2]],
      ['bb22', [3, 4]],
    ]);
    const found = await new FileEmbeddingCache(dir).getMany(['aa11', 'bb22', 'cc33']);
    expect([...found.entries()]).toEqual([
      ['aa11', [1, 2]],
      ['bb22', [3, 4]],
    ]);
  });
});

describe('GeminiEmbeddingProvider', () => {
  it('sends task type and size, and uses the shared key runner', async () => {
    const embedContent = vi.fn(async (_params: unknown) => ({
      embeddings: [{ values: [3, 4] }, { values: [0, 2] }],
    }));
    const keys = new GeminiKeyRunner({
      apiKeys: ['k1'],
      clientFor: () => ({ models: { generateContent: vi.fn(), embedContent } }) as never,
    });
    const provider = new GeminiEmbeddingProvider(keys);
    const client = new EmbeddingClient({ provider });
    const { vectors } = await client.embed({
      model: 'gemini-embedding-001',
      dimensions: 2,
      kind: 'query',
      texts: ['a', 'b'],
    });

    expect(embedContent.mock.calls[0]![0]).toMatchObject({
      model: 'gemini-embedding-001',
      contents: ['a', 'b'],
      config: { outputDimensionality: 2, taskType: 'RETRIEVAL_QUERY' },
    });
    expect(vectors).toEqual([normalize([3, 4]), [0, 1]]);
  });
});
