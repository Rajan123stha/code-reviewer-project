import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '@reviewlens/shared';
import { LLMError } from './errors.js';
import type { GeminiKeyRunner } from './providers/gemini.js';

/** Documents are what gets retrieved; queries are what is searched with. */
export type EmbeddingKind = 'document' | 'query';

export interface EmbedRequest {
  model: string;
  /** Output vector length. */
  dimensions: number;
  kind: EmbeddingKind;
  texts: readonly string[];
}

export interface EmbeddingProvider {
  readonly name: string;
  /** One unit-length vector per text, in order. */
  embed(request: EmbedRequest, signal: AbortSignal): Promise<number[][]>;
}

/** Content-addressed store of vectors: the same text is never embedded twice. */
export interface EmbeddingCache {
  getMany(keys: readonly string[]): Promise<Map<string, number[]>>;
  setMany(entries: readonly (readonly [string, number[]])[]): Promise<void>;
}

export class MemoryEmbeddingCache implements EmbeddingCache {
  private readonly entries = new Map<string, number[]>();
  async getMany(keys: readonly string[]) {
    const found = new Map<string, number[]>();
    for (const k of keys) {
      const v = this.entries.get(k);
      if (v) found.set(k, v);
    }
    return found;
  }
  async setMany(entries: readonly (readonly [string, number[]])[]) {
    for (const [k, v] of entries) this.entries.set(k, v);
  }
}

/** One JSON file of vectors per key prefix; for the CLI and eval runs. */
export class FileEmbeddingCache implements EmbeddingCache {
  private readonly shards = new Map<string, Promise<Record<string, number[]>>>();
  constructor(private readonly dir: string) {}

  private shard(prefix: string) {
    let loaded = this.shards.get(prefix);
    if (!loaded) {
      loaded = readFile(join(this.dir, `${prefix}.json`), 'utf8').then(
        (text) => JSON.parse(text) as Record<string, number[]>,
        () => ({}),
      );
      this.shards.set(prefix, loaded);
    }
    return loaded;
  }

  async getMany(keys: readonly string[]) {
    const found = new Map<string, number[]>();
    for (const k of keys) {
      const v = (await this.shard(k.slice(0, 2)))[k];
      if (v) found.set(k, v);
    }
    return found;
  }

  async setMany(entries: readonly (readonly [string, number[]])[]) {
    const touched = new Set<string>();
    for (const [k, v] of entries) {
      const prefix = k.slice(0, 2);
      (await this.shard(prefix))[k] = v;
      touched.add(prefix);
    }
    await mkdir(this.dir, { recursive: true });
    for (const prefix of touched) {
      const path = join(this.dir, `${prefix}.json`);
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(await this.shard(prefix)));
      await rename(tmp, path);
    }
  }
}

export interface EmbedStats {
  texts: number;
  fromCache: number;
  embedded: number;
  requests: number;
  durationMs: number;
}

export interface EmbeddingClientOptions {
  provider: EmbeddingProvider;
  cache?: EmbeddingCache | undefined;
  /** Texts per provider request. */
  batchSize?: number;
  maxAttempts?: number;
  /** Longest server-requested wait worth sleeping through (see LLMClient). */
  maxRetryAfterMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Embeds texts through a provider, with a content-addressed cache, batching and retries.
 * Texts already in the cache (for the same provider, model, size and kind) cost nothing.
 */
export class EmbeddingClient {
  private readonly provider: EmbeddingProvider;
  private readonly cache: EmbeddingCache;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly maxRetryAfterMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EmbeddingClientOptions) {
    this.provider = options.provider;
    this.cache = options.cache ?? new MemoryEmbeddingCache();
    this.batchSize = options.batchSize ?? 50;
    this.maxAttempts = options.maxAttempts ?? 4;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 5 * 60 * 1_000;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get providerName() {
    return this.provider.name;
  }

  cacheKey(request: Omit<EmbedRequest, 'texts'>, text: string): string {
    return sha256(
      `${this.provider.name}\0${request.model}\0${request.dimensions}\0${request.kind}\0${text}`,
    );
  }

  async embed(request: EmbedRequest): Promise<{ vectors: number[][]; stats: EmbedStats }> {
    const started = performance.now();
    const keys = request.texts.map((t) => this.cacheKey(request, t));
    const known = await this.cache.getMany([...new Set(keys)]);
    const stats: EmbedStats = {
      texts: keys.length,
      fromCache: keys.filter((k) => known.has(k)).length,
      embedded: 0,
      requests: 0,
      durationMs: 0,
    };

    // Unique missing texts, in first-seen order.
    const missing = new Map<string, string>();
    keys.forEach((k, i) => {
      if (!known.has(k) && !missing.has(k)) missing.set(k, request.texts[i]!);
    });
    const todo = [...missing.entries()];
    for (let i = 0; i < todo.length; i += this.batchSize) {
      const batch = todo.slice(i, i + this.batchSize);
      const vectors = await this.embedBatch({ ...request, texts: batch.map(([, t]) => t) });
      stats.requests++;
      stats.embedded += batch.length;
      const entries = batch.map(([k], j) => [k, vectors[j]!] as const);
      await this.cache.setMany(entries);
      for (const [k, v] of entries) known.set(k, v);
    }

    stats.durationMs = Math.round(performance.now() - started);
    return { vectors: keys.map((k) => known.get(k)!), stats };
  }

  private async embedBatch(request: EmbedRequest): Promise<number[][]> {
    for (let attempt = 1; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const vectors = await this.provider.embed(request, controller.signal);
        if (vectors.length !== request.texts.length) {
          throw new LLMError('invalid_output', 'embedding count does not match input count');
        }
        return vectors.map(normalize);
      } catch (error) {
        const e =
          error instanceof LLMError
            ? error
            : new LLMError('server', (error as Error).message ?? String(error), { cause: error });
        const waitTooLong = (e.retryAfterMs ?? 0) > this.maxRetryAfterMs;
        if (!e.retryable || waitTooLong || attempt >= this.maxAttempts) throw e;
        await this.sleep(Math.max(e.retryAfterMs ?? 0, 1_000 * 2 ** (attempt - 1)));
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

/** Scale to unit length, so cosine similarity is a plain dot product. */
export function normalize(vector: readonly number[]): number[] {
  const norm = Math.hypot(...vector);
  return norm === 0 ? [...vector] : vector.map((x) => x / norm);
}

export function dot(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

export const DEFAULT_GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001';
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;

/** Gemini embeddings over the shared key runner (rotation and cooldowns as for chat). */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'gemini';
  constructor(private readonly keys: GeminiKeyRunner) {}

  async embed(request: EmbedRequest, signal: AbortSignal): Promise<number[][]> {
    const response = await this.keys.run(request.model, signal, (client) => {
      if (!client.models.embedContent) throw new Error('client does not support embeddings');
      return client.models.embedContent({
        model: request.model,
        contents: [...request.texts],
        config: {
          outputDimensionality: request.dimensions,
          taskType: request.kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
          abortSignal: signal,
        },
      });
    });
    return (response.embeddings ?? []).map((e) => e.values ?? []);
  }
}

/**
 * Deterministic offline embeddings for tests and dry runs: a hashed bag of identifier
 * tokens. Texts sharing identifiers get similar vectors; nothing leaves the machine.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'fake';
  readonly requests: EmbedRequest[] = [];

  async embed(request: EmbedRequest): Promise<number[][]> {
    this.requests.push(request);
    return request.texts.map((text) => {
      const v = new Array<number>(request.dimensions).fill(0);
      for (const token of text.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? []) {
        const h = Number.parseInt(sha256(token).slice(0, 8), 16);
        v[h % request.dimensions]! += 1;
      }
      return v;
    });
  }
}
