import { buildRepoGraph, gitBlobSha, MemoryParseCache } from '@reviewlens/context-engine';
import { describe, expect, it } from 'vitest';
import {
  addFixCommits,
  DbEmbeddingCache,
  fixCommitsBefore,
  knownFixCommits,
  nearestChunks,
  persistChunks,
  replaceConventions,
} from './knowledge.js';
import { persistRepoIndex } from './repo-index.js';
import { upsertRepository } from './reviews.js';
import { useTestDb } from './test-db.js';

const getDb = useTestDb();
const repo = () =>
  upsertRepository(getDb(), {
    installation: { githubId: 1, account: 'o' },
    repository: { githubId: 2, fullName: 'o/r' },
  });

describe('DbEmbeddingCache', () => {
  it('stores vectors once and returns only known keys', async () => {
    const cache = new DbEmbeddingCache(getDb());
    await cache.setMany([
      ['k1', [0.5, 0.25]],
      ['k2', [1, 0]],
    ]);
    await cache.setMany([['k1', [9, 9]]]); // first write wins
    const found = await cache.getMany(['k1', 'k2', 'missing']);
    expect([...found.entries()]).toEqual([
      ['k1', [0.5, 0.25]],
      ['k2', [1, 0]],
    ]);
  });
});

describe('conventions', () => {
  it('replaces the stored rules', async () => {
    const db = getDb();
    const id = await repo();
    const rule = (ruleText: string) => ({
      ruleText,
      source: 'CONTRIBUTING.md',
      kind: 'contributing' as const,
      evidence: { line: 1 },
    });
    await replaceConventions(db, id, [rule('a'), rule('b')]);
    await replaceConventions(db, id, [rule('c')]);
    const rows = await db.convention.findMany({ where: { repositoryId: id } });
    expect(rows.map((r) => r.ruleText)).toEqual(['c']);
  });
});

describe('bug history', () => {
  const fix = (sha: string, committedAt: string) => ({
    sha,
    committedAt,
    summary: `fix ${sha}`,
    files: ['src/a.ts'],
  });

  it('adds fixes once and serves only those before a date, newest first', async () => {
    const db = getDb();
    const id = await repo();
    const fixes = [
      fix('s1', '2026-01-01T00:00:00Z'),
      fix('s2', '2026-03-01T00:00:00Z'),
      fix('s3', '2026-05-01T00:00:00Z'),
    ];
    expect(await addFixCommits(db, id, fixes)).toBe(3);
    expect(await addFixCommits(db, id, fixes)).toBe(0);
    expect(await knownFixCommits(db, id)).toEqual(new Set(['s1', 's2', 's3']));

    const before = await fixCommitsBefore(db, 2, new Date('2026-03-01T00:00:00Z'));
    expect(before.map((f) => f.sha)).toEqual(['s1']);
    const all = await fixCommitsBefore(db, 2, new Date('2027-01-01T00:00:00Z'));
    expect(all.map((f) => f.sha)).toEqual(['s3', 's2', 's1']);
    expect(all[0]).toEqual({
      sha: 's3',
      committedAt: '2026-05-01T00:00:00.000Z',
      summary: 'fix s3',
      files: ['src/a.ts'],
    });
    expect(await fixCommitsBefore(db, 999, new Date('2027-01-01T00:00:00Z'))).toEqual([]);
  });
});

describe('chunks (pgvector)', () => {
  it('stores embeddings per symbol and finds nearest neighbors', async () => {
    const db = getDb();
    const id = await repo();
    const files: Record<string, string> = {
      'src/a.ts':
        'export function alpha() {\n  return 1;\n}\nexport function beta() {\n  return 2;\n}\n',
    };
    const entries = Object.entries(files).map(([path, c]) => ({ path, blobSha: gitBlobSha(c) }));
    const { graph } = await buildRepoGraph(
      { listFiles: async () => entries, readFile: async (p) => files[p] ?? null },
      new MemoryParseCache(),
    );
    await persistRepoIndex(db, { repositoryId: id, sha: 'h', graph, entries });

    const vec = (x: number, y: number) => [x, y, ...new Array<number>(766).fill(0)];
    const symbols = graph.symbolsIn('src/a.ts');
    const stored = await persistChunks(db, {
      repositoryId: id,
      model: 'm',
      chunks: [
        {
          path: 'src/a.ts',
          localIndex: symbols.find((s) => s.name === 'alpha')!.id,
          textHash: 'h1',
          vector: vec(1, 0),
        },
        {
          path: 'src/a.ts',
          localIndex: symbols.find((s) => s.name === 'beta')!.id,
          textHash: 'h2',
          vector: vec(0, 1),
        },
        { path: 'src/missing.ts', localIndex: 1, textHash: 'h3', vector: vec(1, 1) },
      ],
    });
    expect(stored).toBe(2);

    const nearest = await nearestChunks(db, id, vec(0.1, 0.9), 2);
    expect(nearest.map((n) => n.qualifiedName)).toEqual(['beta', 'alpha']);
    expect(nearest[0]!.distance).toBeLessThan(nearest[1]!.distance);

    // Re-persisting replaces the rows.
    expect(await persistChunks(db, { repositoryId: id, model: 'm', chunks: [] })).toBe(0);
    expect(await db.chunk.count()).toBe(0);
  });
});
