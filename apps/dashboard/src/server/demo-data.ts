// Synthetic reviews for looking at the dashboard without a real installation. Written
// through the same store functions the worker uses, into a throwaway database only.
import {
  addFeedback,
  completeReview,
  markFailed,
  markPosted,
  postedComments,
  setCommentIds,
  startReview,
  upsertPullRequest,
  type Db,
  type FeedbackOutcome,
} from '@reviewlens/db';
import {
  CATEGORIES,
  configHash,
  PRESETS,
  type Candidate,
  type Category,
  type ReviewRun,
  type Severity,
} from '@reviewlens/review-core';

/** Small deterministic generator (mulberry32), so the demo looks the same every time. */
function random(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REPOS = [
  { githubId: 9001, fullName: 'demo-org/checkout-service' },
  { githubId: 9002, fullName: 'demo-org/web-app' },
  { githubId: 9003, fullName: 'demo-org/shared-utils' },
];
const TITLES = [
  'Add retry with backoff to payment client',
  'Refactor cart totals into a pure function',
  'Cache product lookups per request',
  'Validate coupon expiry on apply',
  'Stream large CSV exports',
  'Move auth middleware to a plugin',
  'Fix timezone handling in order dates',
  'Batch inventory updates',
  'Debounce search input',
  'Upgrade HTTP client and adapt error handling',
];
const FILES = [
  'src/payments/client.ts',
  'src/cart/totals.ts',
  'src/catalog/lookup.ts',
  'src/coupons/apply.ts',
  'src/export/csv.ts',
  'src/auth/plugin.ts',
  'src/orders/dates.ts',
  'src/components/SearchBox.tsx',
];
const CLAIMS: Record<Category, string[]> = {
  bug: [
    'The loop runs one past the end of the array, so the last access reads undefined.',
    'The retry count is never decremented, so a failing request retries forever.',
  ],
  security: ['The redirect target comes from the query string without validation.'],
  performance: ['The lookup runs inside the loop, issuing one query per item.'],
  'error-handling': ['The rejected promise is not awaited, so the error is unhandled.'],
  concurrency: ['Two requests can read the same stock count before either writes it.'],
  'api-misuse': ['Date.parse treats this format as local time on some engines.'],
  maintainability: ['This duplicates the totals logic in src/cart/legacy.ts.'],
  testing: ['The new branch for expired coupons has no test.'],
};
const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];
const DEMO_FEATURES = { note: 'demo data' };

function sha(rand: () => number): string {
  return Array.from({ length: 40 }, () => Math.floor(rand() * 16).toString(16)).join('');
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

function demoRun(rand: () => number, strategy: 'S1' | 'S4'): ReviewRun {
  const config = PRESETS[strategy];
  const count = 1 + Math.floor(rand() * 6);
  const candidates: Candidate[] = [];
  let rank = 0;
  for (let index = 0; index < count; index++) {
    const category = rand() < 0.45 ? 'bug' : pick(rand, CATEGORIES);
    const roll = rand();
    const status =
      roll < 0.62 || index === 0
        ? 'selected'
        : roll < 0.72
          ? 'duplicate'
          : roll < 0.8
            ? 'suppressed'
            : 'invalid';
    const valid = status === 'selected';
    candidates.push({
      file: pick(rand, FILES),
      line: 10 + Math.floor(rand() * 180),
      category,
      severity: pick(rand, SEVERITIES),
      claim: pick(rand, CLAIMS[category]),
      evidence: 'for (let i = 0; i <= items.length; i++) {',
      suggested_fix: rand() < 0.6 ? 'Use `i < items.length`.' : null,
      confidence: Math.round((0.35 + rand() * 0.6) * 100) / 100,
      index,
      status,
      rejectReason:
        status === 'invalid'
          ? pick(rand, ['line_not_in_diff', 'evidence_not_found'] as const)
          : null,
      duplicateOf: status === 'duplicate' && index > 0 ? 0 : null,
      rank: valid ? ++rank : null,
      features: DEMO_FEATURES as never,
      filterScore: null,
      body: '(demo)',
    });
  }
  const selected = candidates.filter((c) => c.status === 'selected');
  const inputTokens = 3000 + Math.floor(rand() * 9000);
  return {
    config,
    configHash: configHash(config),
    prompt: { version: config.promptVersion, contentHash: 'demo00000000' },
    schemaName: 'review-comments/v1',
    context: {
      strategy,
      budget: config.contextTokenBudget,
      estimatedTokens: inputTokens - 1500,
      diffFiles: { included: [...new Set(candidates.map((c) => c.file))], omitted: [] },
      fullFiles: { included: [], omitted: [] },
    },
    redactions: rand() < 0.15 ? { github_token: 1 } : {},
    featuresVersion: 'features/v1',
    policy: { enabled: true, maxComments: null, minSeverity: 'low', categories: null, ignore: [] },
    filter: null,
    llm: {
      provider: 'gemini',
      requestedModel: config.model,
      servedModel: rand() < 0.1 ? 'gemini-3.5-flash' : config.model,
      fallbackUsed: false,
      usage: {
        inputTokens,
        outputTokens: 400 + Math.floor(rand() * 1500),
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      costUsd: 0,
      latencyMs: 8000 + Math.floor(rand() * 40000),
      attempts: rand() < 0.2 ? 2 : 1,
      cached: false,
      requestId: null,
    },
    candidates,
    selected,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
}

/** Fill an empty database with about 45 reviews spread over the last 30 days. */
export async function seedDemo(db: Db, now = new Date(), seed = 7): Promise<void> {
  const rand = random(seed);
  const day = 24 * 60 * 60 * 1000;
  let commentId = 5_000;
  for (let i = 0; i < 45; i++) {
    const repo = REPOS[i % 3 === 0 ? 0 : i % 5 === 0 ? 2 : 1]!;
    const number = 100 + i;
    const headSha = sha(rand);
    const pullRequestId = await upsertPullRequest(db, {
      installation: { githubId: 900, account: 'demo-org' },
      repository: repo,
      pullRequest: { number, title: TITLES[i % TITLES.length]!, headSha, baseSha: sha(rand) },
    });
    const strategy = rand() < 0.6 ? 'S4' : 'S1';
    const config = PRESETS[strategy];
    const { reviewId } = await startReview(db, {
      pullRequestId,
      headSha,
      config,
      configHash: configHash(config),
    });
    const startedAt = new Date(
      now.getTime() - Math.floor(rand() * 30) * day - Math.floor(rand() * day),
    );
    if (rand() < 0.07) {
      await markFailed(db, reviewId, new Error('LLMError: all Gemini API keys are rate-limited'));
    } else {
      const run = demoRun(rand, strategy);
      await completeReview(db, reviewId, run);
      await markPosted(db, reviewId, run.selected.length > 0 ? 70_000 + i : null);
      await setCommentIds(
        db,
        reviewId,
        run.selected.map((c) => ({ index: c.index, githubCommentId: commentId++ })),
      );
    }
    await db.review.update({
      where: { id: reviewId },
      data: { startedAt, finishedAt: new Date(startedAt.getTime() + 40_000) },
    });

    // Feedback arrives for older pull requests; recent ones are still open.
    const comments = await postedComments(db, { githubRepoId: repo.githubId, pullNumber: number });
    const age = (now.getTime() - startedAt.getTime()) / day;
    for (const comment of comments) {
      if (age < 3) continue;
      const roll = rand();
      const outcome: FeedbackOutcome =
        roll < 0.34
          ? 'resolved_with_change'
          : roll < 0.46
            ? 'thumbs_up'
            : roll < 0.58
              ? 'dismissed'
              : roll < 0.64
                ? 'thumbs_down'
                : 'ignored';
      const source = {
        resolved_with_change: 'push',
        thumbs_up: 'reactions',
        thumbs_down: 'reactions',
        dismissed: 'thread',
        ignored: 'close',
      } as const;
      await addFeedback(db, comment.id, outcome, source[outcome]);
    }
    await db.commentFeedback.updateMany({
      where: { candidateComment: { reviewId } },
      data: { observedAt: new Date(startedAt.getTime() + 2 * day) },
    });
  }
}
