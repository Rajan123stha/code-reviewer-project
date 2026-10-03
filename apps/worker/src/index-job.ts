import {
  buildChunks,
  buildRepoGraph,
  extractConventions,
  isFixCommit,
  summarizeCommit,
  type Convention,
  type FixCommit,
  type ParseCache,
  type RepoFileEntry,
  type RepoGraph,
} from '@reviewlens/context-engine';
import type { ChunkRow, PersistIndexResult } from '@reviewlens/db';
import {
  fetchCommitFiles,
  githubSnapshot,
  listCommits,
  type GitHubClient,
} from '@reviewlens/github';
import type { EmbeddingClient } from '@reviewlens/llm';
import { sha256, withSpan, type IndexJobData, type Logger } from '@reviewlens/shared';

/** New fix commits whose file lists are fetched per index run (one API call each). */
export const MAX_NEW_FIX_COMMITS = 50;

export interface IndexDeps {
  getClient(installationId: number): Promise<GitHubClient>;
  parseCache: ParseCache;
  upsertRepository(ctx: {
    installation: { githubId: number; account: string };
    repository: { githubId: number; fullName: string };
  }): Promise<number>;
  persistIndex(args: {
    repositoryId: number;
    sha: string;
    graph: RepoGraph;
    entries: readonly RepoFileEntry[];
  }): Promise<PersistIndexResult>;
  replaceConventions(repositoryId: number, conventions: Convention[]): Promise<void>;
  knownFixCommits(repositoryId: number): Promise<Set<string>>;
  addFixCommits(repositoryId: number, fixes: FixCommit[]): Promise<number>;
  /**
   * When set, every indexed symbol is embedded and stored in the pgvector chunks table.
   * Off by default: on free-tier quotas a whole repository takes minutes to embed.
   */
  chunkEmbeddings?: {
    client: EmbeddingClient;
    model: string;
    dimensions: number;
    persistChunks: (args: {
      repositoryId: number;
      model: string;
      chunks: ChunkRow[];
    }) => Promise<number>;
  };
  logger: Logger;
}

/**
 * Index a repository's default branch at one commit: the symbol graph (parsing only blobs
 * the cache has not seen), its stated conventions, and new bug-fix commits in its history.
 */
export async function processIndexJob(job: IndexJobData, deps: IndexDeps) {
  const repo = { owner: job.owner, repo: job.repo };
  const log = deps.logger.child({ ...repo, sha: job.sha, deliveryId: job.deliveryId });
  return withSpan(
    'index.process',
    { 'github.repository': `${job.owner}/${job.repo}` },
    async () => {
      const client = await deps.getClient(job.installationId);
      const snapshot = githubSnapshot(client, repo, job.sha, {
        onTruncatedTree: () => log.warn('GitHub truncated the file tree; the index is partial'),
      });
      const entries = await snapshot.listFiles();
      const { graph, stats } = await buildRepoGraph(
        { listFiles: () => Promise.resolve(entries), readFile: (p) => snapshot.readFile(p) },
        deps.parseCache,
      );
      const repositoryId = await deps.upsertRepository({
        installation: { githubId: job.installationId, account: job.owner },
        repository: { githubId: job.repositoryId, fullName: `${job.owner}/${job.repo}` },
      });
      const persisted = await deps.persistIndex({ repositoryId, sha: job.sha, graph, entries });

      const conventions = await extractConventions((p) => snapshot.readFile(p));
      await deps.replaceConventions(repositoryId, conventions);

      // Fix commits: only ones not stored yet need their file list fetched.
      const known = await deps.knownFixCommits(repositoryId);
      const candidates = (await listCommits(client, repo, job.sha)).filter(
        (c) => !c.isMerge && !known.has(c.sha) && isFixCommit(c.message),
      );
      const fixes: FixCommit[] = [];
      for (const c of candidates.slice(0, MAX_NEW_FIX_COMMITS)) {
        fixes.push({
          sha: c.sha,
          committedAt: c.committedAt,
          summary: summarizeCommit(c.message),
          files: await fetchCommitFiles(client, repo, c.sha),
        });
      }
      const fixCommitsAdded = await deps.addFixCommits(repositoryId, fixes);

      let chunksEmbedded: number | undefined;
      if (deps.chunkEmbeddings) {
        const { client: embeddings, model, dimensions, persistChunks } = deps.chunkEmbeddings;
        const chunks = await buildChunks(graph, (p) => snapshot.readFile(p));
        const { vectors } = await embeddings.embed({
          model,
          dimensions,
          kind: 'document',
          texts: chunks.map((c) => c.text),
        });
        chunksEmbedded = await persistChunks({
          repositoryId,
          model,
          chunks: chunks.map((c, i) => ({
            path: c.path,
            localIndex: graph.symbols[c.gid]!.id,
            textHash: sha256(c.text),
            vector: vectors[i]!,
          })),
        });
      }

      const result = {
        stats,
        persisted,
        conventions: conventions.length,
        fixCommitsAdded,
        fixCommitsPending: Math.max(0, candidates.length - MAX_NEW_FIX_COMMITS),
        chunksEmbedded,
      };
      log.info({ ...result, graph: graph.stats }, 'repository indexed');
      return result;
    },
  );
}
