import {
  FEEDBACK_JOB_NAME,
  feedbackJobId,
  INDEX_JOB_NAME,
  indexJobId,
  REVIEW_JOB_NAME,
  reviewJobId,
  type FeedbackJobData,
  type IndexJobData,
  type ReviewJobData,
} from '@reviewlens/shared';
import type { JobsOptions } from 'bullmq';

/** The slice of a BullMQ Queue the API needs; lets tests pass a fake. */
export interface JobQueue<T> {
  add(name: string, data: T, opts: JobsOptions): Promise<{ id?: string | undefined }>;
}
export type ReviewQueue = JobQueue<ReviewJobData>;
export type IndexQueue = JobQueue<IndexJobData>;

export type EnqueueReview = (data: ReviewJobData) => Promise<{ jobId: string }>;
export type EnqueueIndex = (data: IndexJobData) => Promise<{ jobId: string }>;
export type FeedbackQueue = JobQueue<FeedbackJobData>;
export type EnqueueFeedback = (data: FeedbackJobData) => Promise<{ jobId: string }>;

export const FEEDBACK_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { count: 5_000 },
} satisfies JobsOptions;

export const REVIEW_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { count: 5_000 },
} satisfies JobsOptions;

export const INDEX_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 1_000 },
} satisfies JobsOptions;

/**
 * GitHub abandons a delivery after 10 s. If Redis is unreachable, BullMQ waits for the
 * connection indefinitely, so bound the wait and fail the request well inside that window.
 */
export const DEFAULT_ENQUEUE_TIMEOUT_MS = 5_000;

function enqueuer<T>(
  queue: JobQueue<T>,
  name: string,
  idOf: (data: T) => string,
  options: JobsOptions,
  timeoutMs: number,
) {
  return async (data: T) => {
    const jobId = idOf(data);
    // BullMQ ignores an add() whose jobId already exists, which deduplicates redeliveries.
    const added = queue.add(name, data, { ...options, jobId });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`enqueue timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
    });
    try {
      await Promise.race([added, timeout]);
    } finally {
      clearTimeout(timer);
    }
    return { jobId };
  };
}

export function createEnqueueReview(
  queue: ReviewQueue,
  timeoutMs = DEFAULT_ENQUEUE_TIMEOUT_MS,
): EnqueueReview {
  return enqueuer(queue, REVIEW_JOB_NAME, reviewJobId, REVIEW_JOB_OPTIONS, timeoutMs);
}

export function createEnqueueIndex(
  queue: IndexQueue,
  timeoutMs = DEFAULT_ENQUEUE_TIMEOUT_MS,
): EnqueueIndex {
  return enqueuer(queue, INDEX_JOB_NAME, indexJobId, INDEX_JOB_OPTIONS, timeoutMs);
}

export function createEnqueueFeedback(
  queue: FeedbackQueue,
  timeoutMs = DEFAULT_ENQUEUE_TIMEOUT_MS,
): EnqueueFeedback {
  return enqueuer(queue, FEEDBACK_JOB_NAME, feedbackJobId, FEEDBACK_JOB_OPTIONS, timeoutMs);
}
