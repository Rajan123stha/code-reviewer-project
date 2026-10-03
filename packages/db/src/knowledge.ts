import type { Convention, FixCommit } from '@reviewlens/context-engine';
import type { EmbeddingCache } from '@reviewlens/llm';
import type { Db } from './client.js';

/** Embedding cache in Postgres, shared by every repository (keys are content hashes). */
export class DbEmbeddingCache implements EmbeddingCache {
  constructor(private readonly db: Db) {}

  async getMany(keys: readonly string[]): Promise<Map<string, number[]>> {
    const found = new Map<string, number[]>();
    for (let i = 0; i < keys.length; i += 1_000) {
      const rows = await this.db.embeddingCacheEntry.findMany({
        where: { key: { in: keys.slice(i, i + 1_000) } },
        select: { key: true, vector: true },
      });
      for (const r of rows) found.set(r.key, r.vector);
    }
    return found;
  }

  async setMany(entries: readonly (readonly [string, number[]])[]): Promise<void> {
    if (entries.length === 0) return;
    await this.db.embeddingCacheEntry.createMany({
      data: entries.map(([key, vector]) => ({ key, vector })),
      skipDuplicates: true,
    });
  }
}

/** Replace a repository's stored conventions with the ones found at the indexed commit. */
export async function replaceConventions(
  db: Db,
  repositoryId: number,
  conventions: readonly Convention[],
): Promise<void> {
  await db.$transaction([
    db.convention.deleteMany({ where: { repositoryId } }),
    db.convention.createMany({
      data: conventions.map((c) => ({
        repositoryId,
        ruleText: c.ruleText,
        source: c.source,
        kind: c.kind,
        evidence: c.evidence,
      })),
    }),
  ]);
}

/** Fix-commit SHAs already stored for a repository, so the miner only fetches new ones. */
export async function knownFixCommits(db: Db, repositoryId: number): Promise<Set<string>> {
  const rows = await db.bugHistory.findMany({
    where: { repositoryId },
    select: { fixCommitSha: true },
  });
  return new Set(rows.map((r) => r.fixCommitSha));
}

export async function addFixCommits(
  db: Db,
  repositoryId: number,
  fixes: readonly FixCommit[],
): Promise<number> {
  if (fixes.length === 0) return 0;
  const result = await db.bugHistory.createMany({
    data: fixes.map((f) => ({
      repositoryId,
      fixCommitSha: f.sha,
      committedAt: new Date(f.committedAt),
      files: f.files,
      summary: f.summary,
    })),
    skipDuplicates: true,
  });
  return result.count;
}

/**
 * Stored fix commits of a repository committed strictly before `before`, newest first.
 * Reviews pass the base commit's date, so a change never sees fixes made after it.
 */
export async function fixCommitsBefore(
  db: Db,
  githubRepoId: number,
  before: Date,
): Promise<FixCommit[]> {
  const rows = await db.bugHistory.findMany({
    where: { repository: { githubRepoId: BigInt(githubRepoId) }, committedAt: { lt: before } },
    orderBy: [{ committedAt: 'desc' }, { fixCommitSha: 'asc' }],
  });
  return rows.map((r) => ({
    sha: r.fixCommitSha,
    committedAt: r.committedAt.toISOString(),
    summary: r.summary,
    files: r.files as string[],
  }));
}

export interface ChunkRow {
  path: string;
  /** Symbol id within its file (CodeSymbol.localIndex). */
  localIndex: number;
  textHash: string;
  vector: readonly number[];
}

/**
 * Store embeddings for a repository's indexed symbols in the pgvector `chunks` table,
 * replacing what was there. Symbols must already be persisted by persistRepoIndex.
 */
export async function persistChunks(
  db: Db,
  args: { repositoryId: number; model: string; chunks: readonly ChunkRow[] },
): Promise<number> {
  const symbols = await db.codeSymbol.findMany({
    where: { file: { repositoryId: args.repositoryId } },
    select: { id: true, localIndex: true, file: { select: { path: true } } },
  });
  const idOf = new Map(symbols.map((s) => [`${s.file.path}\0${s.localIndex}`, s.id]));
  const rows = args.chunks.flatMap((c) => {
    const symbolId = idOf.get(`${c.path}\0${c.localIndex}`);
    return symbolId ? [{ symbolId, textHash: c.textHash, vector: `[${c.vector.join(',')}]` }] : [];
  });

  await db.$transaction(async (tx) => {
    await tx.chunk.deleteMany({ where: { symbol: { file: { repositoryId: args.repositoryId } } } });
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      await tx.$executeRaw`
        INSERT INTO chunks (symbol_id, text_hash, model, embedding)
        SELECT v.symbol_id, v.text_hash, ${args.model}, v.embedding::vector
        FROM unnest(
          ${batch.map((r) => r.symbolId)}::int[],
          ${batch.map((r) => r.textHash)}::text[],
          ${batch.map((r) => r.vector)}::text[]
        ) AS v(symbol_id, text_hash, embedding)`;
    }
  });
  return rows.length;
}

/** Nearest indexed symbols to a query vector by cosine distance (pgvector `<=>`). */
export async function nearestChunks(
  db: Db,
  repositoryId: number,
  vector: readonly number[],
  limit: number,
): Promise<{ path: string; qualifiedName: string; distance: number }[]> {
  const literal = `[${vector.join(',')}]`;
  return db.$queryRaw`
    SELECT f.path, s.qualified_name AS "qualifiedName",
           (c.embedding <=> ${literal}::vector)::float8 AS distance
    FROM chunks c
    JOIN symbols s ON s.id = c.symbol_id
    JOIN files f ON f.id = s.file_id
    WHERE f.repo_id = ${repositoryId}
    ORDER BY c.embedding <=> ${literal}::vector, s.id
    LIMIT ${limit}`;
}
