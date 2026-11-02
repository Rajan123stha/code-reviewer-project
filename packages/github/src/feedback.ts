import type { GitHubClient } from './app.js';
import type { PullRequestRef } from './pulls.js';

type Repo = { owner: string; repo: string };

export interface PostedReviewComment {
  id: number;
  path: string;
  body: string;
}

/** The inline comments GitHub created for one review (first 100; reviews post far fewer). */
export async function listReviewComments(
  client: GitHubClient,
  pr: PullRequestRef,
  reviewId: number,
): Promise<PostedReviewComment[]> {
  const { data } = await client.request(
    'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments',
    {
      owner: pr.owner,
      repo: pr.repo,
      pull_number: pr.pullNumber,
      review_id: reviewId,
      per_page: 100,
    },
  );
  return data.map((c) => ({ id: Number(c.id), path: c.path, body: c.body }));
}

export type CompareStatus = 'ahead' | 'behind' | 'diverged' | 'identical';

/**
 * How `head` relates to `base`. Only `ahead` means head contains base, i.e. the diff
 * base...head starts exactly at base; after a force-push it would start at an older
 * merge base and line numbers from `base` would not apply.
 */
export async function fetchCompareStatus(
  client: GitHubClient,
  repo: Repo,
  baseSha: string,
  headSha: string,
): Promise<CompareStatus> {
  const { data } = await client.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
    owner: repo.owner,
    repo: repo.repo,
    basehead: `${baseSha}...${headSha}`,
    per_page: 1,
  });
  return data.status;
}

export interface ReactionCounts {
  thumbsUp: number;
  thumbsDown: number;
}

/**
 * +1 and -1 reactions on a review comment, counting only the given user (the pull request's
 * author, whom the comment addresses). Reactions become training labels for the filter; on a
 * public repository anyone can react, so counting everyone would let strangers decide them.
 * Without a user, nothing is counted.
 */
export async function fetchCommentReactions(
  client: GitHubClient,
  repo: Repo,
  commentId: number,
  onlyFrom: string | undefined,
): Promise<ReactionCounts> {
  if (!onlyFrom) return { thumbsUp: 0, thumbsDown: 0 };
  const { data } = await client.request(
    'GET /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions',
    { owner: repo.owner, repo: repo.repo, comment_id: commentId, per_page: 100 },
  );
  const author = onlyFrom.toLowerCase();
  const human = data.filter(
    (r) => r.user?.type !== 'Bot' && r.user?.login?.toLowerCase() === author,
  );
  return {
    thumbsUp: human.filter((r) => r.content === '+1').length,
    thumbsDown: human.filter((r) => r.content === '-1').length,
  };
}
