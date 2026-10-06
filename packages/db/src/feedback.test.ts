import { PRESETS, configHash, type ReviewRun } from '@reviewlens/review-core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './client.js';
import {
  addFeedback,
  feedbackLabel,
  feedbackRows,
  postedComments,
  setCommentIds,
  setPullRequestStatus,
  usageSince,
} from './feedback.js';
import { completeReview, markPosted, startReview, upsertPullRequest } from './reviews.js';
import { useTestDb } from './test-db.js';

const getDb = useTestDb();
let db: Db;
beforeEach(() => {
  db = getDb();
});

const REPO = 3_000_000_000;
const HEAD = 'a'.repeat(40);
const FEATURES = { category: 'bug', confidence: 0.9 };

function run(costUsd: number): ReviewRun {
  const candidate = (index: number, status: 'selected' | 'over_cap') => ({
    file: 'src/cart.ts',
    line: 8 + index,
    category: 'bug' as const,
    severity: 'high' as const,
    claim: `problem ${index}`,
    evidence: 'x',
    suggested_fix: null,
    confidence: 0.9,
    index,
    status,
    rejectReason: null,
    duplicateOf: null,
    rank: index + 1,
    features: FEATURES as never,
    filterScore: null,
    body: `body ${index}`,
  });
  const candidates = [candidate(0, 'selected'), candidate(1, 'selected'), candidate(2, 'over_cap')];
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
      requestedModel: 'm',
      servedModel: 'm',
      fallbackUsed: false,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      costUsd,
      latencyMs: 1,
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

async function postedReview(
  number: number,
  costUsd = 0.5,
  repo = { githubId: REPO, fullName: 'octo/shop' },
) {
  const pullRequestId = await upsertPullRequest(db, {
    installation: { githubId: 100, account: 'octo' },
    repository: repo,
    pullRequest: { number, title: 't', headSha: HEAD, baseSha: 'b'.repeat(40) },
  });
  const { reviewId } = await startReview(db, {
    pullRequestId,
    headSha: HEAD,
    config: PRESETS.S1,
    configHash: configHash(PRESETS.S1),
  });
  await completeReview(db, reviewId, run(costUsd));
  await markPosted(db, reviewId, 77);
  return reviewId;
}

describe('feedback persistence', () => {
  it('lists posted comments with their GitHub ids and outcomes', async () => {
    const reviewId = await postedReview(7);
    await setCommentIds(db, reviewId, [
      { index: 0, githubCommentId: 5_000_000_001 },
      { index: 1, githubCommentId: 5_000_000_002 },
    ]);
    const pr = { githubRepoId: REPO, pullNumber: 7 };
    const before = await postedComments(db, pr);
    // The over-cap candidate was never posted, so it is not listed.
    expect(before.map((c) => [c.line, c.githubCommentId, c.reviewHeadSha, c.outcomes])).toEqual([
      [8, 5_000_000_001, HEAD, []],
      [9, 5_000_000_002, HEAD, []],
    ]);

    await addFeedback(db, before[0]!.id, 'resolved_with_change', 'push', { toSha: 'c' });
    await addFeedback(db, before[0]!.id, 'resolved_with_change', 'push'); // redelivery
    await addFeedback(db, before[0]!.id, 'thumbs_up', 'reactions');
    const after = await postedComments(db, pr);
    expect(after[0]!.outcomes.sort()).toEqual(['resolved_with_change', 'thumbs_up']);
    expect(await db.commentFeedback.count()).toBe(2);
    expect(await postedComments(db, { githubRepoId: REPO, pullNumber: 8 })).toEqual([]);
  });

  it('records the pull request outcome', async () => {
    await postedReview(7);
    await setPullRequestStatus(db, { githubRepoId: REPO, pullNumber: 7 }, 'merged');
    expect((await db.pullRequest.findFirstOrThrow()).status).toBe('merged');
  });

  it('turns observations into one label, explicit reactions first', () => {
    expect(feedbackLabel([])).toBeNull();
    expect(feedbackLabel(['resolved_with_change'])).toBe(1);
    expect(feedbackLabel(['thumbs_up', 'dismissed'])).toBe(1);
    expect(feedbackLabel(['dismissed'])).toBe(0);
    expect(feedbackLabel(['ignored'])).toBe(0);
    expect(feedbackLabel(['dismissed', 'resolved_with_change'])).toBe(1);
    expect(feedbackLabel(['thumbs_down', 'resolved_with_change'])).toBe(0);
    expect(feedbackLabel(['thumbs_down', 'thumbs_up'])).toBe(0);
  });

  it('exports labeled comments as filter training rows', async () => {
    await postedReview(7);
    const [first, second] = await postedComments(db, { githubRepoId: REPO, pullNumber: 7 });
    await addFeedback(db, first!.id, 'resolved_with_change', 'push');
    await addFeedback(db, second!.id, 'ignored', 'close');
    const rows = await feedbackRows(db);
    expect(rows.map((r) => [r.repo, r.label, r.label_source, r.features])).toEqual([
      ['octo/shop', 1, 'feedback', FEATURES],
      ['octo/shop', 0, 'feedback', FEATURES],
    ]);
    expect(rows[0]!.review).toBe(rows[1]!.review);
    expect(rows[0]!.features_version).toBe('features/v1');
  });

  it('sums recent usage per repository and per installation', async () => {
    await postedReview(7, 0.5);
    await postedReview(8, 0.25);
    await postedReview(1, 1, { githubId: REPO + 1, fullName: 'octo/other' });
    const dayAgo = new Date(Date.now() - 86_400_000);

    const usage = await usageSince(db, REPO, dayAgo);
    expect(usage.repository).toEqual({ reviews: 2, costUsd: 0.75 });
    expect(usage.installation).toEqual({ reviews: 3, costUsd: 1.75 });
    expect((await usageSince(db, REPO, new Date(Date.now() + 1000))).repository.reviews).toBe(0);
    expect((await usageSince(db, 42, dayAgo)).installation).toEqual({ reviews: 0, costUsd: 0 });
  });
});
