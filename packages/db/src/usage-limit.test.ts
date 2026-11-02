import { PRESETS, configHash } from '@reviewlens/review-core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './client.js';
import { startReview, upsertPullRequest } from './reviews.js';
import { useTestDb } from './test-db.js';

const getDb = useTestDb();
let db: Db;
beforeEach(() => {
  db = getDb();
});

const REPO = 4242;
const since = () => new Date(Date.now() - 86_400_000);

async function pr(number: number, repo = REPO) {
  return upsertPullRequest(db, {
    installation: { githubId: 7, account: 'octo' },
    repository: { githubId: repo, fullName: `octo/r${repo}` },
    pullRequest: { number, title: 't', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
  });
}

function start(
  pullRequestId: number,
  limits: { maxReviewsPerRepo: number | null; maxCostUsd?: number | null },
) {
  return startReview(db, {
    pullRequestId,
    headSha: 'a'.repeat(40),
    config: PRESETS.S1,
    configHash: configHash(PRESETS.S1),
    limits: {
      githubRepoId: REPO,
      since: since(),
      maxReviewsPerRepo: limits.maxReviewsPerRepo,
      maxCostUsdPerInstallation: limits.maxCostUsd ?? null,
    },
  });
}

describe('usage limits are enforced atomically', () => {
  it('admits exactly the cap when reviews start concurrently', async () => {
    const prs = await Promise.all([1, 2, 3, 4, 5].map((n) => pr(n)));
    const results = await Promise.all(prs.map((id) => start(id, { maxReviewsPerRepo: 2 })));
    const started = results.filter((r) => 'reviewId' in r);
    const limited = results.filter((r) => 'limited' in r);
    expect(started).toHaveLength(2);
    expect(limited).toEqual([
      { limited: 'rate_limited' },
      { limited: 'rate_limited' },
      { limited: 'rate_limited' },
    ]);
    expect(await db.review.count()).toBe(2);
  });

  it('lets a retry of an already started review through at the cap', async () => {
    const first = await pr(1);
    const a = await start(first, { maxReviewsPerRepo: 1 });
    expect('reviewId' in a).toBe(true);
    // The same PR, head and config again (a retried job): not a new review.
    const again = await start(first, { maxReviewsPerRepo: 1 });
    expect(again).toMatchObject({ reviewId: (a as { reviewId: number }).reviewId });
    expect('limited' in (await start(await pr(2), { maxReviewsPerRepo: 1 }))).toBe(true);
  });

  it('enforces the installation cost cap', async () => {
    const id = await pr(1);
    const r = await start(id, { maxReviewsPerRepo: null, maxCostUsd: 1 });
    await db.review.update({
      where: { id: (r as { reviewId: number }).reviewId },
      data: { costUsd: 1.5 },
    });
    expect(await start(await pr(2), { maxReviewsPerRepo: null, maxCostUsd: 1 })).toEqual({
      limited: 'budget_exceeded',
    });
  });

  it('starts reviews normally without limits', async () => {
    const r = await startReview(db, {
      pullRequestId: await pr(1),
      headSha: 'a'.repeat(40),
      config: PRESETS.S1,
      configHash: configHash(PRESETS.S1),
    });
    expect(r).toMatchObject({ alreadyPosted: false });
  });
});
