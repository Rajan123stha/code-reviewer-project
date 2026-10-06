import { gitBlobSha, type FixCommit, type RepoFileEntry } from '@reviewlens/context-engine';
import type { RepoPolicy } from './policy.js';

export type { FixCommit, RepoFileEntry };

export interface PullRequestMeta {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string | null;
  baseSha: string;
  headSha: string;
}

/**
 * Read-only view of the repository at one commit. Production reads through the GitHub
 * API; the eval harness reads a local checkout. Never executes anything.
 */
export interface RepoSnapshot {
  readonly sha: string;
  /** File contents at this commit, or null if the path does not exist or is not text. */
  readFile(path: string): Promise<string | null>;
  /**
   * Every file at this commit with its git blob id. Required by graph strategies (S3, S4),
   * which index the whole repository.
   */
  listFiles?(): Promise<RepoFileEntry[]>;
}

/** The pipeline's whole input besides the strategy config. */
export interface ReviewInput {
  pr: PullRequestMeta;
  /** Unified diff of base...head, as GitHub returns it. */
  diff: string;
  /** Snapshot at the PR head commit. */
  head: RepoSnapshot;
  /**
   * Bug-fix commits in the history before this change: only commits reachable from the
   * base commit, so retrieval can never see the fix for the change under review. Needed
   * by strategies with `usePastBugs`; without it they retrieve nothing.
   */
  fixCommits?: () => Promise<FixCommit[]>;
  /**
   * The repository's own settings (`.reviewlens.yml`), read from the base commit so a pull
   * request cannot loosen the rules it is reviewed under. Absent: defaults.
   */
  policy?: RepoPolicy;
}

/** In-memory snapshot, for tests and for callers that already hold the files. */
export function memorySnapshot(sha: string, files: Record<string, string>): RepoSnapshot {
  return {
    sha,
    readFile: (path) => Promise.resolve(files[path] ?? null),
    listFiles: () =>
      Promise.resolve(
        Object.entries(files).map(([path, content]) => ({
          path,
          blobSha: gitBlobSha(content),
          size: Buffer.byteLength(content),
        })),
      ),
  };
}
