import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '@reviewlens/shared';
import type { ProviderResponse } from './types.js';

/** Stored form of a provider response. `output` is re-validated against the schema on read. */
export type CachedResponse = ProviderResponse<unknown> & { costUsd: number | null };

export interface ResponseCache {
  get(key: string): Promise<CachedResponse | undefined>;
  set(key: string, value: CachedResponse): Promise<void>;
}

export class MemoryCache implements ResponseCache {
  private readonly entries = new Map<string, CachedResponse>();

  async get(key: string) {
    return this.entries.get(key);
  }

  async set(key: string, value: CachedResponse) {
    this.entries.set(key, value);
  }
}

/**
 * One JSON file per key under `dir`. Meant for the eval harness and local runs, where
 * replaying a benchmark should not pay for the same call twice.
 */
export class FileCache implements ResponseCache {
  constructor(private readonly dir: string) {}

  private path(key: string) {
    if (!/^[0-9a-f]+$/.test(key)) throw new Error(`invalid cache key: ${key}`);
    return join(this.dir, key.slice(0, 2), `${key}.json`);
  }

  async get(key: string) {
    try {
      return JSON.parse(await readFile(this.path(key), 'utf8')) as CachedResponse;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async set(key: string, value: CachedResponse) {
    // Write then rename, so a crash never leaves a half-written entry behind.
    await writeFileAtomic(this.path(key), JSON.stringify(value));
  }
}
