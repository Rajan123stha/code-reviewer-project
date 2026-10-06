import type { Db } from './client.js';
import type { Prisma } from './generated/prisma/client.js';

/** What happened to a posted comment (spec: `comment_feedback.outcome`). */
export const FEEDBACK_OUTCOMES = [
  'resolved_with_change',
  'dismissed',
  'thumbs_up',
  'thumbs_down',
  'ignored',
] as const;
export type FeedbackOutcome = (typeof FEEDBACK_OUTCOMES)[number];

/** Where an observation came from: a later push, a resolved thread, reactions, PR close. */
export type FeedbackSource = 'push' | 'thread' | 'reactions' | 'close';

export interface PostedComment {
  id: number;
  reviewId: number;
  /** Commit the comment's line number refers to. */
  reviewHeadSha: string;
  filePath: string;
  line: number;
  githubCommentId: number | null;
  outcomes: FeedbackOutcome[];
}

interface PullRequestKey {
  githubRepoId: number;
  pullNumber: number;
}

/** Remember which GitHub comment each posted candidate became. */
export async function setCommentIds(
  db: Db,
  reviewId: number,
  ids: readonly { index: number; githubCommentId: number }[],
): Promise<void> {
  await db.$transaction(
    ids.map((c) =>
      db.candidateComment.update({
        where: { reviewId_index: { reviewId, index: c.index } },
        data: { githubCommentId: BigInt(c.githubCommentId) },
      }),
    ),
  );
}

/** Every comment posted on a pull request, across its reviews, with the feedback so far. */
export async function postedComments(db: Db, pr: PullRequestKey): Promise<PostedComment[]> {
  const rows = await db.candidateComment.findMany({
    where: {
      posted: true,
      review: {
        pullRequest: {
          number: pr.pullNumber,
          repository: { githubRepoId: BigInt(pr.githubRepoId) },
        },
      },
    },
    include: { review: { select: { headSha: true } }, feedback: { select: { outcome: true } } },
    orderBy: [{ reviewId: 'asc' }, { index: 'asc' }],
  });
  return rows.map((r) => ({
    id: r.id,
    reviewId: r.reviewId,
    reviewHeadSha: r.review.headSha,
    filePath: r.filePath,
    line: r.line,
    githubCommentId: r.githubCommentId === null ? null : Number(r.githubCommentId),
    outcomes: r.feedback.map((f) => f.outcome as FeedbackOutcome),
  }));
}

/** Record one observation. Repeating it (a redelivered webhook) changes nothing. */
export async function addFeedback(
  db: Db,
  candidateCommentId: number,
  outcome: FeedbackOutcome,
  source: FeedbackSource,
  detail?: Record<string, unknown>,
): Promise<void> {
  await db.commentFeedback.upsert({
    where: {
      candidateCommentId_outcome_source: { candidateCommentId, outcome, source },
    },
    create: {
      candidateCommentId,
      outcome,
      source,
      ...(detail ? { detail: detail as Prisma.InputJsonValue } : {}),
    },
    update: {},
  });
}

export async function setPullRequestStatus(
  db: Db,
  pr: PullRequestKey,
  status: 'open' | 'closed' | 'merged',
): Promise<void> {
  await db.pullRequest.updateMany({
    where: { number: pr.pullNumber, repository: { githubRepoId: BigInt(pr.githubRepoId) } },
    data: { status },
  });
}

/**
 * One usefulness label per comment from its observations, or null while nothing is known.
 * An explicit reaction outranks what we infer from pushes and threads; a thumbs-down
 * outranks a thumbs-up, so a contested comment is not counted as useful.
 */
export function feedbackLabel(outcomes: readonly FeedbackOutcome[]): 0 | 1 | null {
  if (outcomes.includes('thumbs_down')) return 0;
  if (outcomes.includes('thumbs_up')) return 1;
  if (outcomes.includes('resolved_with_change')) return 1;
  if (outcomes.includes('dismissed') || outcomes.includes('ignored')) return 0;
  return null;
}

export interface FeedbackRow {
  id: string;
  repo: string;
  review: string;
  status: string;
  label: 0 | 1;
  label_source: 'feedback';
  features_version: string | null;
  outcomes: FeedbackOutcome[];
  features: unknown;
}

/**
 * Posted comments that have a label, in the shape of the filter's training rows
 * (`services/filter`: `rlfilter dataset --feedback`).
 */
export async function feedbackRows(db: Db): Promise<FeedbackRow[]> {
  const rows = await db.candidateComment.findMany({
    where: { posted: true, feedback: { some: {} } },
    include: {
      feedback: { select: { outcome: true } },
      review: {
        select: {
          id: true,
          featuresVersion: true,
          pullRequest: { select: { number: true, repository: { select: { fullName: true } } } },
        },
      },
    },
    orderBy: { id: 'asc' },
  });
  const out: FeedbackRow[] = [];
  for (const r of rows) {
    const outcomes = r.feedback.map((f) => f.outcome as FeedbackOutcome);
    const label = feedbackLabel(outcomes);
    if (label === null || r.features === null) continue;
    const repo = r.review.pullRequest.repository.fullName;
    out.push({
      id: `feedback-${r.id}`,
      repo,
      review: `feedback/${repo}#${r.review.pullRequest.number}/${r.review.id}`,
      status: r.status,
      label,
      label_source: 'feedback',
      features_version: r.review.featuresVersion,
      outcomes,
      features: r.features,
    });
  }
  return out;
}

export interface Usage {
  reviews: number;
  costUsd: number;
}

/** Reviews started and LLM cost recorded since a moment, for one repository and its installation. */
export async function usageSince(
  db: Db,
  githubRepoId: number,
  since: Date,
): Promise<{ repository: Usage; installation: Usage }> {
  const repository = await db.repository.findUnique({
    where: { githubRepoId: BigInt(githubRepoId) },
    select: { id: true, installationId: true },
  });
  if (!repository) {
    return { repository: { reviews: 0, costUsd: 0 }, installation: { reviews: 0, costUsd: 0 } };
  }
  const usage = async (where: Prisma.ReviewWhereInput): Promise<Usage> => {
    const result = await db.review.aggregate({
      where: { startedAt: { gte: since }, ...where },
      _count: true,
      _sum: { costUsd: true },
    });
    return { reviews: result._count, costUsd: Number(result._sum.costUsd ?? 0) };
  };
  return {
    repository: await usage({ pullRequest: { repositoryId: repository.id } }),
    installation: await usage({
      pullRequest: { repository: { installationId: repository.installationId } },
    }),
  };
}

/** The persistence operations of the feedback loop and the usage limits. */
export interface FeedbackStore {
  setCommentIds(
    reviewId: number,
    ids: readonly { index: number; githubCommentId: number }[],
  ): Promise<void>;
  postedComments(pr: PullRequestKey): Promise<PostedComment[]>;
  addFeedback(
    candidateCommentId: number,
    outcome: FeedbackOutcome,
    source: FeedbackSource,
    detail?: Record<string, unknown>,
  ): Promise<void>;
  setPullRequestStatus(pr: PullRequestKey, status: 'open' | 'closed' | 'merged'): Promise<void>;
  usageSince(
    githubRepoId: number,
    since: Date,
  ): Promise<{ repository: Usage; installation: Usage }>;
}

export function createFeedbackStore(db: Db): FeedbackStore {
  return {
    setCommentIds: (reviewId, ids) => setCommentIds(db, reviewId, ids),
    postedComments: (pr) => postedComments(db, pr),
    addFeedback: (id, outcome, source, detail) => addFeedback(db, id, outcome, source, detail),
    setPullRequestStatus: (pr, status) => setPullRequestStatus(db, pr, status),
    usageSince: (repoId, since) => usageSince(db, repoId, since),
  };
}
