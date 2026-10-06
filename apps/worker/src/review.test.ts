import type { ReviewStore, StartReviewResult } from '@reviewlens/db';
import type { GitHubClient } from '@reviewlens/github';
import { FakeProvider, LLMClient, LLMError } from '@reviewlens/llm';
import { PRESETS, type ReviewRun } from '@reviewlens/review-core';
import { createLogger, type ReviewJobData } from '@reviewlens/shared';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { processReviewJob } from './review.js';

const HEAD = 'f'.repeat(40);
const BASE = 'e'.repeat(40);

const job: ReviewJobData = {
  deliveryId: 'd1',
  installationId: 9,
  repositoryId: 8,
  owner: 'octo',
  repo: 'hello',
  pullNumber: 4,
  headSha: HEAD,
  baseSha: BASE,
};

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -3,2 +3,3 @@ function a() {
 const x = 1;
+const y = x / 0;
 return x;
`;
const FILE = 'function a() {\n\nconst x = 1;\nconst y = x / 0;\nreturn x;\n';

const GOOD_COMMENT = {
  file: 'src/a.ts',
  line: 4,
  category: 'bug',
  severity: 'high',
  claim: 'Division by zero yields Infinity.',
  evidence: 'const y = x / 0;',
  suggested_fix: null,
  confidence: 0.9,
};

const logger = createLogger('test', { level: 'silent' });

function fakeGitHub(
  opts: {
    headSha?: string;
    state?: string;
    postError?: Error;
    policy?: string;
    diff?: string;
  } = {},
) {
  const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
    if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
      return {
        data: {
          title: 'Add y',
          body: 'adds y',
          state: opts.state ?? 'open',
          draft: false,
          head: { sha: opts.headSha ?? HEAD },
          base: { sha: BASE },
        },
      };
    }
    if (route === 'GET /repos/{owner}/{repo}/compare/{basehead}') {
      return { data: opts.diff ?? DIFF };
    }
    if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
      if (params.path !== '.reviewlens.yml') return { data: FILE };
      if (opts.policy === undefined) throw Object.assign(new Error('Not Found'), { status: 404 });
      return { data: opts.policy };
    }
    if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments') {
      // GitHub echoes back the comments of the review that was just posted.
      const post = request.mock.calls.find(([r]) => r.startsWith('POST'))![1] as {
        comments: { path: string; body: string }[];
      };
      return { data: post.comments.map((c, i) => ({ id: 900 + i, path: c.path, body: c.body })) };
    }
    if (opts.postError) throw opts.postError;
    return { data: { id: 77, html_url: 'https://github.com/x' }, params };
  });
  return { client: { request } as unknown as GitHubClient, request };
}

function fakeStore(start: StartReviewResult = { reviewId: 1, alreadyPosted: false }) {
  const runs: ReviewRun[] = [];
  const store = {
    upsertPullRequest: vi.fn(async () => 5),
    startReview: vi.fn(async () => start),
    completeReview: vi.fn(async (_id: number, run: ReviewRun) => void runs.push(run)),
    markPosted: vi.fn(async () => {}),
    markFailed: vi.fn(async () => {}),
    fixCommitsBefore: vi.fn(async () => []),
  } satisfies ReviewStore;
  return { store, runs };
}

function deps(comments: unknown[] | Error, gh = fakeGitHub(), store = fakeStore()) {
  const provider = new FakeProvider(() => (comments instanceof Error ? comments : { comments }));
  return {
    gh,
    store,
    provider,
    deps: {
      getClient: vi.fn(async () => gh.client),
      llm: new LLMClient({ provider, sleep: () => Promise.resolve() }),
      store: store.store,
      config: PRESETS.S1,
      logger,
    },
  };
}

describe('processReviewJob', () => {
  it('reviews the pinned commit range, persists the run, and posts selected comments', async () => {
    const t = deps([GOOD_COMMENT, { ...GOOD_COMMENT, line: 1, claim: 'bogus line' }]);
    const result = await processReviewJob(job, t.deps);

    expect(result).toMatchObject({
      status: 'posted',
      reviewId: 1,
      githubReviewId: 77,
      comments: 1,
    });
    expect(t.gh.request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/compare/{basehead}',
      expect.objectContaining({ basehead: `${BASE}...${HEAD}` }),
    );
    const post = t.gh.request.mock.calls.find(([r]) => r.startsWith('POST'))!;
    expect(post[1]).toMatchObject({
      commit_id: HEAD,
      event: 'COMMENT',
      comments: [
        {
          path: 'src/a.ts',
          line: 4,
          side: 'RIGHT',
          body: expect.stringContaining('Division by zero') as unknown,
        },
      ],
    });
    expect(t.store.store.upsertPullRequest).toHaveBeenCalledWith({
      installation: { githubId: 9, account: 'octo' },
      repository: { githubId: 8, fullName: 'octo/hello' },
      pullRequest: { number: 4, title: 'Add y', headSha: HEAD, baseSha: BASE },
    });
    expect(t.store.runs[0]!.candidates.map((c) => c.status)).toEqual(['selected', 'invalid']);
    expect(t.store.store.markPosted).toHaveBeenCalledWith(1, 77);
    // S1 read the head file through the contents API, at the head commit.
    expect(t.gh.request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/contents/{path}',
      expect.objectContaining({ path: 'src/a.ts', ref: HEAD }),
    );
  });

  it('reads the repository policy from the base commit and applies it', async () => {
    const t = deps([GOOD_COMMENT], fakeGitHub({ policy: 'min_severity: critical\n' }));
    const result = await processReviewJob(job, t.deps);
    expect(result).toMatchObject({ status: 'posted', comments: 0 });
    expect(t.store.runs[0]!.candidates.map((c) => c.status)).toEqual(['suppressed']);
    expect(t.gh.request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/contents/{path}',
      expect.objectContaining({ path: '.reviewlens.yml', ref: BASE }),
    );
  });

  it('skips repositories that switched reviews off', async () => {
    const t = deps([GOOD_COMMENT], fakeGitHub({ policy: 'enabled: false\n' }));
    expect(await processReviewJob(job, t.deps)).toEqual({ status: 'skipped', reason: 'disabled' });
    expect(t.provider.requests).toHaveLength(0);
    expect(t.store.store.startReview).not.toHaveBeenCalled();
  });

  it('reviews with defaults when the policy file is invalid', async () => {
    const t = deps([GOOD_COMMENT], fakeGitHub({ policy: 'enabled: maybe\n' }));
    expect(await processReviewJob(job, t.deps)).toMatchObject({ status: 'posted', comments: 1 });
  });

  function feedbackStore(reviews = 0, costUsd = 0) {
    return {
      setCommentIds: vi.fn(async () => {}),
      usageSince: vi.fn(async () => ({
        repository: { reviews, costUsd },
        installation: { reviews, costUsd },
      })),
    };
  }
  const limits = {
    maxReviewsPerRepoPerDay: 10,
    maxCostUsdPerInstallationPerDay: 2,
    maxChangedLines: 100,
    maxChangedFiles: 10,
  };

  it('records which GitHub comment each posted candidate became', async () => {
    const t = deps([GOOD_COMMENT, { ...GOOD_COMMENT, line: 1, claim: 'bogus line' }]);
    const feedback = feedbackStore();
    await processReviewJob(job, { ...t.deps, feedback, limits });
    expect(feedback.setCommentIds).toHaveBeenCalledExactlyOnceWith(1, [
      { index: 0, githubCommentId: 900 },
    ]);
  });

  it.each([
    ['rate_limited', 10, 0],
    ['budget_exceeded', 1, 2],
  ] as const)('skips with %s when recent usage is at the limit', async (reason, reviews, cost) => {
    const t = deps([GOOD_COMMENT]);
    const feedback = feedbackStore(reviews, cost);
    expect(await processReviewJob(job, { ...t.deps, feedback, limits })).toEqual({
      status: 'skipped',
      reason,
    });
    expect(t.provider.requests).toHaveLength(0);
    expect(t.store.store.startReview).not.toHaveBeenCalled();
  });

  it('skips pull requests over the size limit before any LLM call', async () => {
    const big = DIFF.replace('+const y = x / 0;\n', '+const y = x / 0;\n'.repeat(101));
    const t = deps([GOOD_COMMENT], fakeGitHub({ diff: big }));
    const result = await processReviewJob(job, { ...t.deps, feedback: feedbackStore(), limits });
    expect(result).toEqual({ status: 'skipped', reason: 'too_large' });
    expect(t.provider.requests).toHaveLength(0);
  });

  it('posts nothing when no comment survives, but still finalizes the review', async () => {
    const t = deps([]);
    const result = await processReviewJob(job, t.deps);
    expect(result).toMatchObject({ status: 'posted', githubReviewId: null, comments: 0 });
    expect(t.gh.request.mock.calls.some(([r]) => r.startsWith('POST'))).toBe(false);
    expect(t.store.store.markPosted).toHaveBeenCalledWith(1, null);
  });

  it('skips a commit that is no longer the PR head', async () => {
    const t = deps([GOOD_COMMENT], fakeGitHub({ headSha: '0'.repeat(40) }));
    expect(await processReviewJob(job, t.deps)).toEqual({
      status: 'skipped',
      reason: 'superseded',
    });
    expect(t.provider.requests).toHaveLength(0);
    expect(t.store.store.startReview).not.toHaveBeenCalled();
  });

  it('skips closed pull requests', async () => {
    const t = deps([GOOD_COMMENT], fakeGitHub({ state: 'closed' }));
    expect(await processReviewJob(job, t.deps)).toEqual({ status: 'skipped', reason: 'closed' });
  });

  it('does not call the LLM or post again when the review was already posted', async () => {
    const t = deps(
      [GOOD_COMMENT],
      fakeGitHub(),
      fakeStore({ reviewId: 3, alreadyPosted: true, githubReviewId: 77n }),
    );
    expect(await processReviewJob(job, t.deps)).toEqual({ status: 'already_posted', reviewId: 3 });
    expect(t.provider.requests).toHaveLength(0);
  });

  it('marks the review failed and stops retrying on a GitHub 422', async () => {
    const err = Object.assign(new Error('Unprocessable Entity'), { status: 422 });
    const t = deps([GOOD_COMMENT], fakeGitHub({ postError: err }));
    await expect(processReviewJob(job, t.deps)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(t.store.store.markFailed).toHaveBeenCalledWith(1, err);
    expect(t.store.store.markPosted).not.toHaveBeenCalled();
  });

  it('stops retrying on a refusal but lets transient LLM errors retry', async () => {
    const refusal = deps(new LLMError('refusal', 'declined'));
    await expect(processReviewJob(job, refusal.deps)).rejects.toBeInstanceOf(UnrecoverableError);

    const transient = deps(new LLMError('server', 'overloaded'));
    await expect(processReviewJob(job, transient.deps)).rejects.toMatchObject({ kind: 'server' });
    expect(transient.store.store.markFailed).toHaveBeenCalled();
  });
});
