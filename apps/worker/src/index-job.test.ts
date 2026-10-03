import { gitBlobSha, MemoryParseCache, type FixCommit } from '@reviewlens/context-engine';
import type { GitHubClient } from '@reviewlens/github';
import { EmbeddingClient, FakeEmbeddingProvider } from '@reviewlens/llm';
import { createLogger, type IndexJobData } from '@reviewlens/shared';
import { describe, expect, it, vi } from 'vitest';
import { processIndexJob, type IndexDeps } from './index-job.js';

const FILES: Record<string, string> = {
  'src/a.ts': "import { b } from './b';\nexport const a = () => b();\n",
  'src/b.ts': 'export function b() {\n  return 1;\n}\n',
  'README.md': '# hi\n',
  'CONTRIBUTING.md': '# Contributing\n- Always add tests for new behavior.\n',
};
const SHA = 'a'.repeat(40);
const job: IndexJobData = {
  deliveryId: 'd',
  installationId: 1,
  repositoryId: 2,
  owner: 'o',
  repo: 'r',
  sha: SHA,
};

const COMMITS = [
  { sha: 'f1', message: 'Fix crash on empty input', date: '2026-09-02T00:00:00Z', parents: 1 },
  { sha: 'n1', message: 'Add feature', date: '2026-09-01T00:00:00Z', parents: 1 },
  { sha: 'm1', message: 'Merge fix branch', date: '2026-08-31T00:00:00Z', parents: 2 },
  { sha: 'f2', message: 'fix: wrong total', date: '2026-08-30T00:00:00Z', parents: 1 },
];

function fakeGitHub() {
  const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
    if (route.startsWith('GET /repos/{owner}/{repo}/git/trees')) {
      return {
        data: {
          truncated: false,
          tree: Object.entries(FILES).map(([path, c]) => ({
            path,
            type: 'blob',
            mode: '100644',
            sha: gitBlobSha(c),
            size: c.length,
          })),
        },
      };
    }
    if (route.startsWith('GET /repos/{owner}/{repo}/contents')) {
      const content = FILES[params.path as string];
      if (content === undefined) throw Object.assign(new Error('Not Found'), { status: 404 });
      return { data: content };
    }
    if (route === 'GET /repos/{owner}/{repo}/commits') {
      return {
        data: COMMITS.map((c) => ({
          sha: c.sha,
          commit: { message: c.message, committer: { date: c.date } },
          parents: Array.from({ length: c.parents }, () => ({})),
        })),
      };
    }
    if (route === 'GET /repos/{owner}/{repo}/commits/{ref}') {
      return { data: { files: [{ filename: `src/${String(params.ref)}.ts` }] } };
    }
    throw new Error(`unexpected ${route}`);
  });
  return { client: { request } as unknown as GitHubClient, request };
}

function setup(extra: Partial<IndexDeps> = {}) {
  const gh = fakeGitHub();
  const stored: FixCommit[] = [];
  const persistIndex = vi.fn<IndexDeps['persistIndex']>(async ({ graph }) => ({
    filesKept: 0,
    filesWritten: graph.paths.length,
    filesDeleted: 0,
    symbolsWritten: graph.symbols.length,
    edges: graph.edges.length,
  }));
  const replaceConventions = vi.fn<IndexDeps['replaceConventions']>(async () => {});
  const deps: IndexDeps = {
    getClient: async () => gh.client,
    parseCache: new MemoryParseCache(),
    upsertRepository: vi.fn(async () => 7),
    persistIndex,
    replaceConventions,
    knownFixCommits: async () => new Set(stored.map((f) => f.sha)),
    addFixCommits: async (_id, fixes) => {
      stored.push(...fixes);
      return fixes.length;
    },
    logger: createLogger('test', { level: 'silent' }),
    ...extra,
  };
  const reads = (part: string) => gh.request.mock.calls.filter(([r]) => r.includes(part)).length;
  return { gh, deps, stored, persistIndex, replaceConventions, reads };
}

describe('processIndexJob', () => {
  it('indexes the commit, reads only uncached source files, and persists the graph', async () => {
    const t = setup();
    const first = await processIndexJob(job, t.deps);
    expect(first.stats).toMatchObject({ filesIndexed: 2, parsed: 2 });
    expect(t.persistIndex.mock.calls[0]![0]).toMatchObject({ repositoryId: 7, sha: SHA });
    expect(t.persistIndex.mock.calls[0]![0].graph.edges.map((e) => e.kind).sort()).toEqual([
      'calls',
      'imports',
    ]);

    const second = await processIndexJob(job, t.deps);
    expect(second.stats).toMatchObject({ parsed: 0, fromCache: 2 });
  });

  it('stores the conventions it finds', async () => {
    const t = setup();
    const result = await processIndexJob(job, t.deps);
    expect(result.conventions).toBe(1);
    expect(t.replaceConventions).toHaveBeenCalledWith(7, [
      expect.objectContaining({
        ruleText: 'Always add tests for new behavior.',
        source: 'CONTRIBUTING.md',
      }),
    ]);
  });

  it('mines new fix commits once, skipping merges and non-fixes', async () => {
    const t = setup();
    const first = await processIndexJob(job, t.deps);
    expect(first.fixCommitsAdded).toBe(2);
    expect(t.stored).toEqual([
      {
        sha: 'f1',
        committedAt: '2026-09-02T00:00:00Z',
        summary: 'Fix crash on empty input',
        files: ['src/f1.ts'],
      },
      {
        sha: 'f2',
        committedAt: '2026-08-30T00:00:00Z',
        summary: 'fix: wrong total',
        files: ['src/f2.ts'],
      },
    ]);
    const fileCalls = t.reads('/commits/{ref}');

    const second = await processIndexJob(job, t.deps);
    expect(second.fixCommitsAdded).toBe(0);
    expect(t.reads('/commits/{ref}')).toBe(fileCalls); // no refetch for known fixes
  });

  it('embeds chunks into pgvector only when enabled', async () => {
    const off = setup();
    expect((await processIndexJob(job, off.deps)).chunksEmbedded).toBeUndefined();

    const persistChunks = vi.fn(async ({ chunks }: { chunks: unknown[] }) => chunks.length);
    const on = setup({
      chunkEmbeddings: {
        client: new EmbeddingClient({ provider: new FakeEmbeddingProvider() }),
        model: 'm',
        dimensions: 8,
        persistChunks,
      },
    });
    const result = await processIndexJob(job, on.deps);
    expect(result.chunksEmbedded).toBe(1);
    expect(persistChunks.mock.calls[0]![0]).toMatchObject({
      repositoryId: 7,
      model: 'm',
      chunks: [{ path: 'src/b.ts', textHash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown }],
    });
  });
});
