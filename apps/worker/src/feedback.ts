import type { FeedbackStore, PostedComment } from '@reviewlens/db';
import {
  fetchCommentReactions,
  fetchCompareDiff,
  fetchCompareStatus,
  parseUnifiedDiff,
  type GitHubClient,
} from '@reviewlens/github';
import { changedNear } from '@reviewlens/review-core';
import { withSpan, type FeedbackJobData, type Logger } from '@reviewlens/shared';

/** Earlier reviews compared against a new push; older ones are left as they are. */
const MAX_REVIEWS_PER_PUSH = 5;
/** Comments whose reactions are read when a pull request closes. */
const MAX_COMMENTS_PER_CLOSE = 50;

export interface FeedbackDeps {
  getClient(installationId: number): Promise<GitHubClient>;
  store: FeedbackStore;
  logger: Logger;
}

export interface FeedbackJobResult {
  kind: FeedbackJobData['kind'];
  /** Observations written by this job, by outcome. */
  recorded: Record<string, number>;
}

/**
 * Record what happened to the comments posted on a pull request.
 *
 * - push: the author pushed again. A comment whose lines changed between the commit it
 *   was made on and the new head is `resolved_with_change`.
 * - thread_resolved: someone resolved the comment's thread. Without a change to its lines,
 *   that is `dismissed`.
 * - closed: the pull request was merged or closed. Reactions become `thumbs_up` /
 *   `thumbs_down`, and a comment nobody reacted to or acted on is `ignored`.
 *
 * Each observation is idempotent, so a redelivered event or a retried job changes nothing.
 */
export async function processFeedbackJob(
  job: FeedbackJobData,
  deps: FeedbackDeps,
): Promise<FeedbackJobResult> {
  const pr = { githubRepoId: job.repositoryId, pullNumber: job.pullNumber };
  const repo = { owner: job.owner, repo: job.repo };
  const log = deps.logger.child({ ...repo, pullNumber: job.pullNumber, kind: job.kind });
  const recorded: Record<string, number> = {};
  const count = (outcome: string) => (recorded[outcome] = (recorded[outcome] ?? 0) + 1);

  return withSpan(
    'feedback.process',
    { 'github.repository': `${job.owner}/${job.repo}`, 'feedback.kind': job.kind },
    async () => {
      const comments = await deps.store.postedComments(pr);
      if (job.kind === 'closed') {
        await deps.store.setPullRequestStatus(pr, job.merged ? 'merged' : 'closed');
      }
      if (comments.length === 0) return { kind: job.kind, recorded };

      if (job.kind === 'push') {
        const open = comments.filter(
          (c) => c.reviewHeadSha !== job.headSha && !c.outcomes.includes('resolved_with_change'),
        );
        // Each earlier review has its own line numbers, so each is compared from its own commit.
        const heads = [...new Set(open.map((c) => c.reviewHeadSha))].slice(-MAX_REVIEWS_PER_PUSH);
        if (heads.length === 0) return { kind: job.kind, recorded };
        const client = await deps.getClient(job.installationId);
        for (const head of heads) {
          const status = await fetchCompareStatus(client, repo, head, job.headSha);
          if (status !== 'ahead') {
            // Force-push or rebase: the old commit is not an ancestor, so its line numbers
            // cannot be mapped onto the new diff. Record nothing rather than guess.
            log.info({ from: head, status }, 'history rewritten; skipping resolution check');
            continue;
          }
          const later = parseUnifiedDiff(await fetchCompareDiff(client, repo, head, job.headSha));
          for (const comment of open.filter((c) => c.reviewHeadSha === head)) {
            if (changedNear(later, { file: comment.filePath, line: comment.line })) {
              await deps.store.addFeedback(comment.id, 'resolved_with_change', 'push', {
                fromSha: head,
                toSha: job.headSha,
              });
              count('resolved_with_change');
            }
          }
        }
      } else if (job.kind === 'thread_resolved') {
        const ids = new Set(job.commentIds);
        for (const comment of comments) {
          if (comment.githubCommentId === null || !ids.has(comment.githubCommentId)) continue;
          if (comment.outcomes.includes('resolved_with_change')) continue;
          await deps.store.addFeedback(comment.id, 'dismissed', 'thread');
          count('dismissed');
        }
      } else {
        await recordClose(job, comments, deps, count);
      }
      log.info({ recorded }, 'feedback recorded');
      return { kind: job.kind, recorded };
    },
  );
}

async function recordClose(
  job: FeedbackJobData,
  comments: PostedComment[],
  deps: FeedbackDeps,
  count: (outcome: string) => void,
) {
  const repo = { owner: job.owner, repo: job.repo };
  const client = await deps.getClient(job.installationId);
  for (const comment of comments.slice(-MAX_COMMENTS_PER_CLOSE)) {
    let reacted = false;
    if (comment.githubCommentId !== null) {
      const reactions = await fetchCommentReactions(client, repo, comment.githubCommentId).catch(
        (error: unknown) => {
          // A deleted comment has no reactions to read.
          if ((error as { status?: number }).status === 404) return null;
          throw error;
        },
      );
      if (reactions && reactions.thumbsUp > 0) {
        await deps.store.addFeedback(comment.id, 'thumbs_up', 'reactions', {
          count: reactions.thumbsUp,
        });
        count('thumbs_up');
        reacted = true;
      }
      if (reactions && reactions.thumbsDown > 0) {
        await deps.store.addFeedback(comment.id, 'thumbs_down', 'reactions', {
          count: reactions.thumbsDown,
        });
        count('thumbs_down');
        reacted = true;
      }
    }
    if (!reacted && comment.outcomes.length === 0) {
      await deps.store.addFeedback(comment.id, 'ignored', 'close');
      count('ignored');
    }
  }
}
