import { z } from 'zod';

/** Queue and job contract shared by the API (producer) and the worker (consumer). */
export const REVIEW_QUEUE = 'review';
export const REVIEW_JOB_NAME = 'review-pull-request';

export const reviewJobSchema = z.object({
  deliveryId: z.string().min(1),
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  owner: z.string().min(1),
  repo: z.string().min(1),
  pullNumber: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
});

export type ReviewJobData = z.infer<typeof reviewJobSchema>;

/**
 * Deterministic job id: one review per (repository, PR, head commit).
 * GitHub redeliveries and duplicate events for the same commit collapse into one job.
 */
export function reviewJobId(data: Pick<ReviewJobData, 'repositoryId' | 'pullNumber' | 'headSha'>) {
  return `pr-${data.repositoryId}-${data.pullNumber}-${data.headSha}`;
}

/** Indexing of a repository's default branch, triggered by pushes. */
export const INDEX_QUEUE = 'index';
export const INDEX_JOB_NAME = 'index-repository';

export const indexJobSchema = z.object({
  deliveryId: z.string().min(1),
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  owner: z.string().min(1),
  repo: z.string().min(1),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
});

export type IndexJobData = z.infer<typeof indexJobSchema>;

/** One index job per (repository, commit). */
export function indexJobId(data: Pick<IndexJobData, 'repositoryId' | 'sha'>) {
  return `index-${data.repositoryId}-${data.sha}`;
}

/** Feedback on posted comments: later pushes, resolved threads, PR close. */
export const FEEDBACK_QUEUE = 'feedback';
export const FEEDBACK_JOB_NAME = 'record-feedback';

const feedbackBase = {
  deliveryId: z.string().min(1),
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  owner: z.string().min(1),
  repo: z.string().min(1),
  pullNumber: z.number().int().positive(),
};

export const feedbackJobSchema = z.discriminatedUnion('kind', [
  z.object({
    ...feedbackBase,
    kind: z.literal('push'),
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
  }),
  z.object({
    ...feedbackBase,
    kind: z.literal('thread_resolved'),
    /** GitHub ids of the review comments in the resolved thread. */
    commentIds: z.array(z.number().int().positive()).min(1),
  }),
  z.object({ ...feedbackBase, kind: z.literal('closed'), merged: z.boolean() }),
]);

export type FeedbackJobData = z.infer<typeof feedbackJobSchema>;

/** One feedback job per webhook delivery; a redelivery has the same id and is dropped. */
export function feedbackJobId(data: Pick<FeedbackJobData, 'kind' | 'deliveryId'>) {
  return `feedback-${data.kind}-${data.deliveryId}`;
}
