import type { GitHubClient } from './app.js';

interface RepoRef {
  owner: string;
  repo: string;
}

export interface CommitSummary {
  sha: string;
  message: string;
  /** ISO 8601 committer date. */
  committedAt: string;
  /** More than one parent: a merge commit. */
  isMerge: boolean;
}

/** Committer date of a commit, as ISO 8601. */
export async function fetchCommitDate(
  client: GitHubClient,
  repo: RepoRef,
  sha: string,
): Promise<string> {
  const { data } = await client.request('GET /repos/{owner}/{repo}/commits/{ref}', {
    owner: repo.owner,
    repo: repo.repo,
    ref: sha,
  });
  const date = data.commit.committer?.date ?? data.commit.author?.date;
  if (!date) throw new Error(`commit ${sha} has no date`);
  return date;
}

/** Commits reachable from `sha`, newest first, up to `maxPages` pages of 100. */
export async function listCommits(
  client: GitHubClient,
  repo: RepoRef,
  sha: string,
  maxPages = 3,
): Promise<CommitSummary[]> {
  const commits: CommitSummary[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await client.request('GET /repos/{owner}/{repo}/commits', {
      owner: repo.owner,
      repo: repo.repo,
      sha,
      per_page: 100,
      page,
    });
    for (const c of data) {
      const committedAt = c.commit.committer?.date ?? c.commit.author?.date;
      if (!committedAt) continue;
      commits.push({
        sha: c.sha,
        message: c.commit.message,
        committedAt,
        isMerge: c.parents.length > 1,
      });
    }
    if (data.length < 100) break;
  }
  return commits;
}

/** Paths a commit touched (GitHub returns at most 300 per commit here). */
export async function fetchCommitFiles(
  client: GitHubClient,
  repo: RepoRef,
  sha: string,
): Promise<string[]> {
  const { data } = await client.request('GET /repos/{owner}/{repo}/commits/{ref}', {
    owner: repo.owner,
    repo: repo.repo,
    ref: sha,
  });
  return (data.files ?? []).map((f) => f.filename);
}
