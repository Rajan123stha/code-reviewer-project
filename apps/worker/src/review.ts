import type { ParseCache } from '@reviewlens/context-engine';
import type { FeedbackStore, ReviewStore } from '@reviewlens/db';
import {
  createReview,
  fetchCommitDate,
  fetchCompareDiff,
  fetchFileAtRef,
  fetchPullRequest,
  githubSnapshot,
  listReviewComments,
  parseUnifiedDiff,
  type GitHubClient,
} from '@reviewlens/github';
import { LLMError, type EmbeddingClient, type LLMClient } from '@reviewlens/llm';
import {
  configHash,
  formatReviewBody,
  parsePolicy,
  POLICY_FILE,
  runReview,
  type CommentScorer,
  type StrategyConfig,
} from '@reviewlens/review-core';
import { withSpan, type Logger, type ReviewJobData } from '@reviewlens/shared';
import { UnrecoverableError } from 'bullmq';
import {
  NO_LIMITS,
  tooLarge,
  usageLimitReached,
  USAGE_WINDOW_MS,
  type LimitReason,
  type ReviewLimits,
} from './limits.js';

/** GitHub statuses that will not succeed on retry (bad auth, missing PR, stale/invalid review). */
const NON_RETRYABLE_STATUSES = new Set([401, 404, 422]);

export interface ReviewDeps {
  getClient(installationId: number): Promise<GitHubClient>;
  llm: LLMClient;
  store: ReviewStore;
  /** Parse cache for graph strategies. */
  parseCache?: ParseCache | undefined;
  /** Embedding client for S2. */
  embeddings?: EmbeddingClient | undefined;
  /** Usefulness filter; required when the config sets a filter threshold. */
  scorer?: CommentScorer | undefined;
  config: StrategyConfig;
  /** Records which GitHub comment each posted candidate became, and reads recent usage. */
  feedback?: Pick<FeedbackStore, 'setCommentIds' | 'usageSince'> | undefined;
  limits?: ReviewLimits | undefined;
  logger: Logger;
}

export type ReviewJobResult =
  | {
      status: 'posted';
      reviewId: number;
      githubReviewId: number | null;
      comments: number;
      costUsd: number | null;
    }
  | { status: 'already_posted'; reviewId: number }
  | { status: 'skipped'; reason: 'superseded' | 'closed' | 'disabled' | LimitReason };

export async function processReviewJob(
  job: ReviewJobData,
  deps: ReviewDeps,
): Promise<ReviewJobResult> {
  const ref = { owner: job.owner, repo: job.repo, pullNumber: job.pullNumber };
  const repo = { owner: job.owner, repo: job.repo };
  const log = deps.logger.child({ ...ref, headSha: job.headSha, deliveryId: job.deliveryId });

  return withSpan(
    'review.process',
    {
      'github.repository': `${job.owner}/${job.repo}`,
      'github.pr': job.pullNumber,
      'review.strategy': deps.config.strategy,
    },
    async () => {
      let reviewId: number | undefined;
      try {
        const client = await deps.getClient(job.installationId);
        const pr = await fetchPullRequest(client, ref);
        // A newer push queued its own job; reviewing this commit would be wasted work.
        if (pr.headSha !== job.headSha) {
          log.info({ currentHead: pr.headSha }, 'skipping superseded commit');
          return { status: 'skipped', reason: 'superseded' };
        }
        if (pr.state !== 'open') {
          log.info({ state: pr.state }, 'skipping closed pull request');
          return { status: 'skipped', reason: 'closed' };
        }

        // The repository's settings come from the base commit: a pull request cannot
        // switch off or loosen its own review.
        const { policy, errors: policyErrors } = parsePolicy(
          await fetchFileAtRef(client, repo, POLICY_FILE, job.baseSha),
        );
        if (policyErrors.length > 0) log.warn({ policyErrors }, 'ignoring invalid policy file');
        if (!policy.enabled) {
          log.info('reviews are disabled by the repository policy');
          return { status: 'skipped', reason: 'disabled' };
        }

        const limits = deps.limits ?? NO_LIMITS;
        if (deps.feedback) {
          const usage = await deps.feedback.usageSince(
            job.repositoryId,
            new Date(Date.now() - USAGE_WINDOW_MS),
          );
          const reached = usageLimitReached(limits, usage);
          if (reached) {
            log.warn({ reached, usage }, 'usage limit reached; skipping review');
            return { status: 'skipped', reason: reached };
          }
        }
        const diff = await fetchCompareDiff(client, repo, job.baseSha, job.headSha);
        const changed = parseUnifiedDiff(diff);
        const size = {
          files: changed.length,
          lines: changed.reduce(
            (n, f) =>
              n +
              f.hunks.reduce((m, h) => m + h.lines.filter((l) => l.type !== 'context').length, 0),
            0,
          ),
        };
        if (tooLarge(limits, size)) {
          log.info({ size }, 'pull request too large to review');
          return { status: 'skipped', reason: 'too_large' };
        }

        const pullRequestId = await deps.store.upsertPullRequest({
          installation: { githubId: job.installationId, account: job.owner },
          repository: { githubId: job.repositoryId, fullName: `${job.owner}/${job.repo}` },
          pullRequest: {
            number: job.pullNumber,
            title: pr.title,
            headSha: job.headSha,
            baseSha: job.baseSha,
          },
        });
        const start = await deps.store.startReview({
          pullRequestId,
          headSha: job.headSha,
          config: deps.config,
          configHash: configHash(deps.config),
        });
        reviewId = start.reviewId;
        if (start.alreadyPosted) {
          log.info({ reviewId }, 'review already posted for this commit and config');
          return { status: 'already_posted', reviewId };
        }

        const run = await runReview(
          {
            pr: {
              ...ref,
              number: job.pullNumber,
              title: pr.title,
              body: pr.body,
              baseSha: job.baseSha,
              headSha: job.headSha,
            },
            diff,
            head: githubSnapshot(client, repo, job.headSha),
            policy,
            // Only fixes committed before the base commit: the review must not see the future.
            ...(deps.config.usePastBugs
              ? {
                  fixCommits: async () =>
                    deps.store.fixCommitsBefore(
                      job.repositoryId,
                      new Date(await fetchCommitDate(client, repo, job.baseSha)),
                    ),
                }
              : {}),
          },
          deps.config,
          {
            llm: deps.llm,
            parseCache: deps.parseCache,
            embeddings: deps.embeddings,
            scorer: deps.scorer,
          },
        );
        await deps.store.completeReview(reviewId, run);

        // Nothing to say: stay quiet rather than posting an empty review on every push.
        let githubReviewId: number | null = null;
        if (run.selected.length > 0) {
          const posted = await createReview(client, ref, {
            commitId: job.headSha,
            body: formatReviewBody(run.selected.length, {
              strategy: deps.config.strategy,
              model: run.llm?.servedModel ?? deps.config.model,
            }),
            comments: run.selected.map((c) => ({ path: c.file, line: c.line, body: c.body })),
          });
          githubReviewId = posted.reviewId;
        }
        await deps.store.markPosted(reviewId, githubReviewId);
        if (githubReviewId !== null && deps.feedback) {
          // Needed to attribute reactions and resolved threads later. The review is already
          // posted, so a failure here must not fail (and repost) the job.
          await linkComments(
            client,
            ref,
            githubReviewId,
            reviewId,
            run.selected,
            deps.feedback,
          ).catch((err: unknown) => log.warn({ err }, 'could not record GitHub comment ids'));
        }

        log.info(
          {
            reviewId,
            githubReviewId,
            candidates: run.candidates.length,
            posted: run.selected.length,
            costUsd: run.llm?.costUsd,
            context: run.context,
          },
          'review complete',
        );
        return {
          status: 'posted',
          reviewId,
          githubReviewId,
          comments: run.selected.length,
          costUsd: run.llm?.costUsd ?? null,
        };
      } catch (error) {
        if (reviewId !== undefined) {
          await deps.store
            .markFailed(reviewId, error)
            .catch((err: unknown) => log.error({ err }, 'could not record failure'));
        }
        throw classify(error, log);
      }
    },
  );
}

/** Errors that a retry cannot fix become UnrecoverableError, so BullMQ stops retrying. */
function classify(error: unknown, log: Logger): unknown {
  if (error instanceof LLMError) {
    if (error.retryable) return error;
    log.error({ err: error, kind: error.kind }, 'non-retryable LLM error');
    return new UnrecoverableError(`LLM ${error.kind}: ${error.message}`);
  }
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && NON_RETRYABLE_STATUSES.has(status)) {
    log.error({ err: error, status }, 'non-retryable GitHub error');
    return new UnrecoverableError(`GitHub returned ${status}: ${(error as Error).message}`);
  }
  return error;
}

/** Match the comments GitHub created to the candidates they came from, by path and body. */
async function linkComments(
  client: GitHubClient,
  ref: { owner: string; repo: string; pullNumber: number },
  githubReviewId: number,
  reviewId: number,
  selected: readonly { index: number; file: string; body: string }[],
  store: Pick<FeedbackStore, 'setCommentIds'>,
) {
  const posted = await listReviewComments(client, ref, githubReviewId);
  const unused = [...posted];
  const ids: { index: number; githubCommentId: number }[] = [];
  for (const candidate of selected) {
    const at = unused.findIndex((c) => c.path === candidate.file && c.body === candidate.body);
    if (at < 0) continue;
    ids.push({ index: candidate.index, githubCommentId: unused[at]!.id });
    unused.splice(at, 1);
  }
  await store.setCommentIds(reviewId, ids);
}
