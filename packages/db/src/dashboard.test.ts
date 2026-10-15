import { PRESETS, configHash, type ReviewRun } from '@reviewlens/review-core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './client.js';
import {
  feedbackSummary,
  listRepositories,
  listReviews,
  overviewStats,
  reviewDetail,
} from './dashboard.js';
import { addFeedback, postedComments } from './feedback.js';
import {
  completeReview,
  markFailed,
  markPosted,
  startReview,
  upsertPullRequest,
} from './reviews.js';
import { useTestDb } from './test-db.js';

const getDb = useTestDb();
let db: Db;
beforeEach(() => {
  db = getDb();
});

function run(latencyMs: number, costUsd: number): ReviewRun {
  const candidate = (
    index: number,
    status: 'selected' | 'invalid',
    category: 'bug' | 'testing',
  ) => ({
    file: 'src/cart.ts',
    line: 8 + index,
    category,
    severity: 'high' as const,
    claim: `problem ${index}`,
    evidence: 'x',
    suggested_fix: null,
    confidence: 0.8,
    index,
    status,
    rejectReason: status === 'invalid' ? ('line_not_in_diff' as const) : null,
    duplicateOf: null,
    rank: status === 'selected' ? index + 1 : null,
    features: null,
    filterScore: null,
    body: `body ${index}`,
  });
  const candidates = [
    candidate(0, 'selected', 'bug'),
    candidate(1, 'selected', 'testing'),
    candidate(2, 'invalid', 'bug'),
  ];
  return {
    config: PRESETS.S1,
    configHash: configHash(PRESETS.S1),
    prompt: { version: 'review/v3', contentHash: 'abc123abc123' },
    schemaName: 'review-comments/v1',
    context: {
      strategy: 'S1',
      budget: 16_000,
      estimatedTokens: 900,
      diffFiles: { included: ['src/cart.ts'], omitted: [] },
      fullFiles: { included: [], omitted: [] },
    },
    redactions: {},
    featuresVersion: 'features/v1',
    policy: { enabled: true, maxComments: null, minSeverity: 'low', categories: null, ignore: [] },
    filter: null,
    llm: {
      provider: 'gemini',
      requestedModel: 'gemini-3.5-flash',
      servedModel: 'gemini-3.5-flash',
      fallbackUsed: false,
      usage: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      costUsd,
      latencyMs,
      attempts: 1,
      cached: false,
      requestId: null,
    },
    candidates,
    selected: candidates.slice(0, 2),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
}

async function review(
  repo: string,
  githubId: number,
  number: number,
  title: string,
  latencyMs: number,
) {
  const pullRequestId = await upsertPullRequest(db, {
    installation: { githubId: 100, account: 'octo' },
    repository: { githubId, fullName: repo },
    pullRequest: { number, title, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
  });
  const { reviewId } = await startReview(db, {
    pullRequestId,
    headSha: 'a'.repeat(40),
    config: PRESETS.S1,
    configHash: configHash(PRESETS.S1),
  });
  await completeReview(db, reviewId, run(latencyMs, 0.01));
  await markPosted(db, reviewId, 77);
  return reviewId;
}

describe('dashboard queries', () => {
  it('summarizes reviews, comments, feedback, cost and latency', async () => {
    await review('octo/shop', 1, 1, 'Fix cart', 1000);
    await review('octo/shop', 1, 2, 'Add coupons', 3000);
    await review('octo/api', 2, 1, 'Retry on 503', 2000);
    const comments = await postedComments(db, { githubRepoId: 1, pullNumber: 1 });
    await addFeedback(db, comments[0]!.id, 'resolved_with_change', 'push');
    await addFeedback(db, comments[1]!.id, 'ignored', 'close');
    // A failed review has a row but no LLM latency.
    const failedPr = await upsertPullRequest(db, {
      installation: { githubId: 100, account: 'octo' },
      repository: { githubId: 2, fullName: 'octo/api' },
      pullRequest: { number: 2, title: 'Broken', headSha: 'c'.repeat(40), baseSha: 'b'.repeat(40) },
    });
    const failed = await startReview(db, {
      pullRequestId: failedPr,
      headSha: 'c'.repeat(40),
      config: PRESETS.S1,
      configHash: configHash(PRESETS.S1),
    });
    await markFailed(db, failed.reviewId, new Error('model overloaded'));

    const stats = await overviewStats(db, 7);
    expect(stats.repositories).toBe(2);
    expect(stats.pullRequests).toBe(4);
    expect(stats.reviews).toEqual({ total: 4, posted: 3, failed: 1, running: 0 });
    expect(stats.comments).toEqual({ candidates: 9, posted: 6 });
    expect(stats.feedback.labeled).toBe(2);
    expect(stats.feedback.useful).toBe(1);
    expect(stats.feedback.outcomes).toMatchObject({
      resolved_with_change: 1,
      ignored: 1,
      dismissed: 0,
    });
    expect(stats.costUsd).toBeCloseTo(0.03);
    expect(stats.tokensIn).toBe(3000);
    expect(stats.latencyMs).toEqual({ p50: 2000, p95: 2900 });
    expect(stats.daily).toHaveLength(7);
    expect(stats.daily.at(-1)).toMatchObject({ reviews: 4, comments: 6 });
    expect(stats.daily[0]).toMatchObject({ reviews: 0, comments: 0 });
  });

  it('lists repositories with their acceptance so far', async () => {
    await review('octo/shop', 1, 1, 'Fix cart', 1000);
    await review('octo/api', 2, 1, 'Retry on 503', 2000);
    const [first] = await postedComments(db, { githubRepoId: 1, pullNumber: 1 });
    await addFeedback(db, first!.id, 'thumbs_up', 'reactions');

    const repos = await listRepositories(db);
    expect(
      repos.map((r) => [r.fullName, r.reviews, r.postedComments, r.labeled, r.useful]),
    ).toEqual([
      ['octo/api', 1, 2, 0, 0],
      ['octo/shop', 1, 2, 1, 1],
    ]);
    expect(repos[0]!.lastReviewAt).toMatch(/^\d{4}-/);
  });

  it('pages, filters and searches reviews, newest first', async () => {
    await review('octo/shop', 1, 1, 'Fix cart', 1000);
    await review('octo/shop', 1, 2, 'Add coupons', 1000);
    await review('octo/api', 2, 1, 'Retry on 503', 1000);

    const all = await listReviews(db, { limit: 2 });
    expect(all.total).toBe(3);
    expect(all.items.map((r) => r.pullTitle)).toEqual(['Retry on 503', 'Add coupons']);
    expect(all.items[0]).toMatchObject({
      candidates: 3,
      posted: 2,
      status: 'posted',
      repository: 'octo/api',
    });
    expect((await listReviews(db, { limit: 2, offset: 2 })).items.map((r) => r.pullTitle)).toEqual([
      'Fix cart',
    ]);
    expect((await listReviews(db, { search: 'COUPON' })).items.map((r) => r.pullNumber)).toEqual([
      2,
    ]);
    expect((await listReviews(db, { search: 'octo/api' })).total).toBe(1);
    expect((await listReviews(db, { status: 'failed' })).total).toBe(0);
    const [repo] = await listRepositories(db);
    expect((await listReviews(db, { repositoryId: repo!.id })).total).toBe(1);
  });

  it('returns one review with every candidate and its feedback', async () => {
    const id = await review('octo/shop', 1, 1, 'Fix cart', 1000);
    const [first] = await postedComments(db, { githubRepoId: 1, pullNumber: 1 });
    await addFeedback(db, first!.id, 'resolved_with_change', 'push');

    const detail = await reviewDetail(db, id);
    expect(detail).toMatchObject({
      id,
      pullTitle: 'Fix cart',
      promptVersion: 'review/v3',
      githubReviewId: 77,
    });
    expect(
      detail!.candidateList.map((c) => [c.index, c.status, c.posted, c.outcomes, c.label]),
    ).toEqual([
      [0, 'selected', true, ['resolved_with_change'], 1],
      [1, 'selected', true, [], null],
      [2, 'invalid', false, [], null],
    ]);
    expect(await reviewDetail(db, 999)).toBeNull();
  });

  it('groups acceptance by category and lists recent feedback', async () => {
    await review('octo/shop', 1, 1, 'Fix cart', 1000);
    const [bug, testing] = await postedComments(db, { githubRepoId: 1, pullNumber: 1 });
    await addFeedback(db, bug!.id, 'thumbs_up', 'reactions');
    await addFeedback(db, testing!.id, 'dismissed', 'thread');

    const summary = await feedbackSummary(db);
    expect(summary.byCategory).toEqual([
      { key: 'bug', posted: 1, labeled: 1, useful: 1 },
      { key: 'testing', posted: 1, labeled: 1, useful: 0 },
    ]);
    expect(summary.bySeverity).toEqual([{ key: 'high', posted: 2, labeled: 2, useful: 1 }]);
    expect(summary.recent.map((f) => [f.outcome, f.category, f.repository])).toEqual([
      ['dismissed', 'testing', 'octo/shop'],
      ['thumbs_up', 'bug', 'octo/shop'],
    ]);
  });
});
