import { PRESETS, configHash, type ReviewRun } from '@reviewlens/review-core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './client.js';
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

const ctx = {
  installation: { githubId: 100, account: 'octo' },
  repository: { githubId: 3_000_000_000, fullName: 'octo/shop' },
  pullRequest: { number: 7, title: 'Fix cart', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
};
const config = PRESETS.S1;
const hash = configHash(config);

function run(): ReviewRun {
  const candidate = {
    file: 'src/cart.ts',
    line: 8,
    category: 'bug' as const,
    severity: 'high' as const,
    claim: 'off by one',
    evidence: 'i <= items.length',
    suggested_fix: null,
    confidence: 0.9,
    index: 0,
    status: 'selected' as const,
    rejectReason: null,
    duplicateOf: null,
    rank: 1,
    features: null,
    filterScore: 0.82,
    body: '**Bug (high)**: off by one',
  };
  return {
    config,
    configHash: hash,
    prompt: { version: 'review/v1', contentHash: 'abc123abc123' },
    schemaName: 'review-comments/v1',
    context: {
      strategy: 'S1',
      budget: 16_000,
      estimatedTokens: 900,
      diffFiles: { included: ['src/cart.ts'], omitted: [] },
      fullFiles: { included: ['src/cart.ts'], omitted: [] },
    },
    redactions: {},
    featuresVersion: 'features/v1',
    filter: { modelVersion: 'lr-abc', threshold: 0.3, scored: 1, dropped: 0 },
    llm: {
      provider: 'anthropic',
      requestedModel: 'claude-opus-5-5',
      servedModel: 'claude-opus-5-5',
      fallbackUsed: false,
      usage: {
        inputTokens: 1200,
        outputTokens: 300,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      costUsd: 0.0108,
      latencyMs: 4210.7,
      attempts: 1,
      cached: false,
      requestId: 'req_1',
    },
    candidates: [
      candidate,
      {
        ...candidate,
        index: 1,
        line: 3,
        status: 'invalid',
        rejectReason: 'line_not_in_diff',
        rank: null,
      },
    ],
    selected: [candidate],
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
}

describe('review persistence', () => {
  it('upserts the PR chain idempotently, with 64-bit GitHub ids', async () => {
    const a = await upsertPullRequest(db, ctx);
    const b = await upsertPullRequest(db, {
      ...ctx,
      pullRequest: { ...ctx.pullRequest, title: 'Fix cart v2' },
    });
    expect(b).toBe(a);
    const pr = await db.pullRequest.findUniqueOrThrow({
      where: { id: a },
      include: { repository: true },
    });
    expect(pr.title).toBe('Fix cart v2');
    expect(pr.repository.githubRepoId).toBe(3_000_000_000n);
  });

  it('stores a full run and marks selected comments as posted', async () => {
    const prId = await upsertPullRequest(db, ctx);
    const start = await startReview(db, {
      pullRequestId: prId,
      headSha: ctx.pullRequest.headSha,
      config,
      configHash: hash,
    });
    expect(start.alreadyPosted).toBe(false);

    await completeReview(db, start.reviewId, run());
    await markPosted(db, start.reviewId, 555);

    const review = await db.review.findUniqueOrThrow({
      where: { id: start.reviewId },
      include: { candidates: { orderBy: { index: 'asc' } } },
    });
    expect(review).toMatchObject({
      status: 'posted',
      strategy: 'S1',
      model: config.model,
      servedModel: 'claude-opus-5-5',
      promptVersion: config.promptVersion,
      promptHash: 'abc123abc123',
      tokensIn: 1200,
      tokensOut: 300,
      latencyMs: 4211,
      githubReviewId: 555n,
    });
    expect(review.costUsd?.toString()).toBe('0.0108');
    expect(review.strategyConfig).toEqual(config);
    expect(review.candidates.map((c) => [c.index, c.status, c.rejectReason, c.posted])).toEqual([
      [0, 'selected', null, true],
      [1, 'invalid', 'line_not_in_diff', false],
    ]);
  });

  it('reports an already-posted review so a retry does not post twice', async () => {
    const prId = await upsertPullRequest(db, ctx);
    const args = {
      pullRequestId: prId,
      headSha: ctx.pullRequest.headSha,
      config,
      configHash: hash,
    };
    const first = await startReview(db, args);
    await completeReview(db, first.reviewId, run());
    await markPosted(db, first.reviewId, 555);

    expect(await startReview(db, args)).toEqual({
      reviewId: first.reviewId,
      alreadyPosted: true,
      githubReviewId: 555n,
    });
  });

  it('resets and reuses a failed review row on retry', async () => {
    const prId = await upsertPullRequest(db, ctx);
    const args = {
      pullRequestId: prId,
      headSha: ctx.pullRequest.headSha,
      config,
      configHash: hash,
    };
    const first = await startReview(db, args);
    await completeReview(db, first.reviewId, run());
    await markFailed(db, first.reviewId, new Error('GitHub 502'));

    const second = await startReview(db, args);
    expect(second).toEqual({ reviewId: first.reviewId, alreadyPosted: false });
    const row = await db.review.findUniqueOrThrow({
      where: { id: first.reviewId },
      include: { candidates: true },
    });
    expect(row.status).toBe('running');
    expect(row.error).toBeNull();
    expect(row.candidates).toHaveLength(0);
  });

  it('keeps separate rows per config on the same commit', async () => {
    const prId = await upsertPullRequest(db, ctx);
    const head = ctx.pullRequest.headSha;
    const s0 = await startReview(db, {
      pullRequestId: prId,
      headSha: head,
      config: PRESETS.S0,
      configHash: configHash(PRESETS.S0),
    });
    const s1 = await startReview(db, {
      pullRequestId: prId,
      headSha: head,
      config,
      configHash: hash,
    });
    expect(s0.reviewId).not.toBe(s1.reviewId);
  });
});
