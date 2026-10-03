import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '@reviewlens/shared';
import { RepoGraph } from './graph.js';
import { languageFor, parseSource } from './parse.js';
import { PARSER_VERSION, type FileParse, type Language } from './types.js';

export interface RepoFileEntry {
  path: string;
  /** Git blob SHA-1 of the contents: the content address for the parse cache. */
  blobSha: string;
  size?: number | undefined;
}

/** What the indexer needs from a repository snapshot. */
export interface IndexSource {
  listFiles(): Promise<RepoFileEntry[]>;
  readFile(path: string): Promise<string | null>;
}

/** Content-addressed cache of per-file parses. */
export interface ParseCache {
  get(key: string): Promise<FileParse | undefined>;
  set(key: string, parse: FileParse): Promise<void>;
}

export function parseCacheKey(language: Language, blobSha: string): string {
  return `v${PARSER_VERSION}-${language}-${blobSha}`;
}

export class MemoryParseCache implements ParseCache {
  private readonly entries = new Map<string, FileParse>();
  get size() {
    return this.entries.size;
  }
  async get(key: string) {
    return this.entries.get(key);
  }
  async set(key: string, parse: FileParse) {
    this.entries.set(key, parse);
  }
}

/** One JSON file per parse; for the CLI and eval runs over many commits of one repo. */
export class FileParseCache implements ParseCache {
  constructor(private readonly dir: string) {}
  private path(key: string) {
    if (!/^[\w-]+$/.test(key)) throw new Error(`invalid parse cache key: ${key}`);
    return join(this.dir, `${key}.json`);
  }
  async get(key: string) {
    try {
      return JSON.parse(await readFile(this.path(key), 'utf8')) as FileParse;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async set(key: string, parse: FileParse) {
    await writeFileAtomic(this.path(key), JSON.stringify(parse));
  }
}

/** Git's blob id for some contents: sha1("blob <bytes>\0<contents>"). */
export function gitBlobSha(content: string | Buffer): string {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

export const MAX_INDEX_FILE_BYTES = 512_000;

const SKIP_DIRS = /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.git|\.next|\.turbo)\//;

/** Whether v1 indexes this path: TS/JS source, not generated, minified or vendored. */
export function isIndexable(entry: RepoFileEntry): boolean {
  if (SKIP_DIRS.test(entry.path) || /\.min\.[cm]?js$/.test(entry.path)) return false;
  if (entry.size !== undefined && entry.size > MAX_INDEX_FILE_BYTES) return false;
  return languageFor(entry.path) !== null;
}

export interface IndexStats {
  filesListed: number;
  filesIndexed: number;
  parsed: number;
  fromCache: number;
  unreadable: number;
  durationMs: number;
}

export interface IndexOptions {
  concurrency?: number;
}

/**
 * Build the symbol graph for a snapshot. Only files whose blob has not been parsed
 * before (under the current parser version) are read and parsed, so re-indexing after a
 * change costs as much as the change.
 */
export async function buildRepoGraph(
  source: IndexSource,
  cache: ParseCache,
  options: IndexOptions = {},
): Promise<{ graph: RepoGraph; stats: IndexStats }> {
  const started = performance.now();
  const listed = await source.listFiles();
  const entries = listed.filter(isIndexable).sort((a, b) => (a.path < b.path ? -1 : 1));
  const parses = new Map<string, FileParse>();
  const stats: IndexStats = {
    filesListed: listed.length,
    filesIndexed: 0,
    parsed: 0,
    fromCache: 0,
    unreadable: 0,
    durationMs: 0,
  };

  await forEachLimit(entries, options.concurrency ?? 8, async (entry) => {
    const language = languageFor(entry.path)!;
    const key = parseCacheKey(language, entry.blobSha);
    let parse = await cache.get(key);
    if (parse) {
      stats.fromCache++;
    } else {
      const content = await source.readFile(entry.path);
      if (content === null || content.length > MAX_INDEX_FILE_BYTES) {
        stats.unreadable++;
        return;
      }
      parse = await parseSource(content, language);
      await cache.set(key, parse);
      stats.parsed++;
    }
    parses.set(entry.path, parse);
  });

  stats.filesIndexed = parses.size;
  const graph = new RepoGraph(parses);
  stats.durationMs = Math.round(performance.now() - started);
  return { graph, stats };
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}
