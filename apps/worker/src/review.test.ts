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

function fakeGitHub(opts: { headSha?: string; state?: string; postError?: Error } = {}) {
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
    if (route === 'GET /repos/{owner}/{repo}/compare/{basehead}') return { data: DIFF };
    if (route === 'GET /repos/{owner}/{repo}/contents/{path}') return { data: FILE };
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
