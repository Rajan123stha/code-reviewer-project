import type { FeedbackOutcome, FeedbackStore, PostedComment } from '@reviewlens/db';
import type { GitHubClient } from '@reviewlens/github';
import { createLogger, type FeedbackJobData } from '@reviewlens/shared';
import { describe, expect, it, vi } from 'vitest';
import { processFeedbackJob } from './feedback.js';
import { tooLarge, usageLimitReached, NO_LIMITS } from './limits.js';

const OLD = 'a'.repeat(40);
const NEW = 'c'.repeat(40);
const base = {
  deliveryId: 'd1',
  installationId: 9,
  repositoryId: 8,
  owner: 'octo',
  repo: 'hello',
  pullNumber: 4,
};
const logger = createLogger('test', { level: 'silent' });

// The push rewrites line 8 of src/a.ts.
const LATER_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -7,3 +7,3 @@
 const a = 1;
-const y = x / 0;
+const y = x / 1;
 return y;
`;

function comment(id: number, line: number, extra: Partial<PostedComment> = {}): PostedComment {
  return {
    id,
    reviewId: 1,
    reviewHeadSha: OLD,
    filePath: 'src/a.ts',
    line,
    githubCommentId: 1000 + id,
    outcomes: [],
    ...extra,
  };
}

function setup(
  comments: PostedComment[],
  github: {
    status?: string;
    reactions?: Record<number, { content: string; user: { type: string } }[]>;
  } = {},
) {
  const recorded: [number, FeedbackOutcome, string][] = [];
  const store = {
    setCommentIds: vi.fn(async () => {}),
    postedComments: vi.fn(async () => comments),
    addFeedback: vi.fn(async (id: number, outcome: FeedbackOutcome, source: string) => {
      recorded.push([id, outcome, source]);
    }),
    setPullRequestStatus: vi.fn(async () => {}),
    usageSince: vi.fn(async () => ({
      repository: { reviews: 0, costUsd: 0 },
      installation: { reviews: 0, costUsd: 0 },
    })),
  } satisfies FeedbackStore;
  const request = vi.fn(async (route: string, params: Record<string, unknown>) => {
    if (route === 'GET /repos/{owner}/{repo}/compare/{basehead}') {
      return params.mediaType
        ? { data: LATER_DIFF }
        : { data: { status: github.status ?? 'ahead' } };
    }
    if (route === 'GET /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions') {
      const reactions = github.reactions?.[params.comment_id as number];
      if (!reactions) throw Object.assign(new Error('Not Found'), { status: 404 });
      return { data: reactions };
    }
    throw new Error(`unexpected request ${route}`);
  });
  const deps = {
    getClient: vi.fn(async () => ({ request }) as unknown as GitHubClient),
    store,
    logger,
  };
  return { deps, store, recorded, request };
}

describe('processFeedbackJob', () => {
  it('marks comments resolved when a later push changes their lines', async () => {
    const t = setup([comment(1, 8), comment(2, 40), comment(3, 8, { reviewHeadSha: NEW })]);
    const job: FeedbackJobData = { ...base, kind: 'push', headSha: NEW };

    const result = await processFeedbackJob(job, t.deps);

    // Comment 2 is far from the change; comment 3 was made on the new commit itself.
    expect(t.recorded).toEqual([[1, 'resolved_with_change', 'push']]);
    expect(result.recorded).toEqual({ resolved_with_change: 1 });
    expect(t.request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/compare/{basehead}',
      expect.objectContaining({ basehead: `${OLD}...${NEW}` }),
    );
  });

  it('records nothing after a force-push, when old line numbers no longer apply', async () => {
    const t = setup([comment(1, 8)], { status: 'diverged' });
    await processFeedbackJob({ ...base, kind: 'push', headSha: NEW }, t.deps);
    expect(t.recorded).toEqual([]);
  });

  it('does not ask GitHub when there is nothing left to resolve', async () => {
    const t = setup([comment(1, 8, { outcomes: ['resolved_with_change'] })]);
    await processFeedbackJob({ ...base, kind: 'push', headSha: NEW }, t.deps);
    expect(t.deps.getClient).not.toHaveBeenCalled();
  });

  it('treats a resolved thread as dismissal unless the code changed', async () => {
    const t = setup([
      comment(1, 8),
      comment(2, 9, { outcomes: ['resolved_with_change'] }),
      comment(3, 10),
    ]);
    await processFeedbackJob(
      { ...base, kind: 'thread_resolved', commentIds: [1001, 1002, 9999] },
      t.deps,
    );
    expect(t.recorded).toEqual([[1, 'dismissed', 'thread']]);
  });

  it('on close reads reactions and marks untouched comments ignored', async () => {
    const t = setup(
      [
        comment(1, 8),
        comment(2, 9),
        comment(3, 10),
        comment(4, 11, { outcomes: ['dismissed'] }),
        comment(5, 12, { githubCommentId: null }),
      ],
      {
        reactions: {
          1001: [
            { content: '+1', user: { type: 'User' } },
            { content: '+1', user: { type: 'Bot' } },
            { content: 'heart', user: { type: 'User' } },
          ],
          1002: [{ content: '-1', user: { type: 'User' } }],
          1003: [{ content: '+1', user: { type: 'Bot' } }],
          // 1004 was deleted on GitHub: the reactions request returns 404.
        },
      },
    );

    const result = await processFeedbackJob({ ...base, kind: 'closed', merged: true }, t.deps);

    expect(t.recorded).toEqual([
      [1, 'thumbs_up', 'reactions'],
      [2, 'thumbs_down', 'reactions'],
      [3, 'ignored', 'close'], // only a bot reacted
      [5, 'ignored', 'close'],
    ]);
    expect(result.recorded).toEqual({ thumbs_up: 1, thumbs_down: 1, ignored: 2 });
    expect(t.store.setPullRequestStatus).toHaveBeenCalledWith(
      { githubRepoId: 8, pullNumber: 4 },
      'merged',
    );
  });

  it('records the close of a pull request that has no posted comments', async () => {
    const t = setup([]);
    await processFeedbackJob({ ...base, kind: 'closed', merged: false }, t.deps);
    expect(t.store.setPullRequestStatus).toHaveBeenCalledWith(expect.anything(), 'closed');
    expect(t.deps.getClient).not.toHaveBeenCalled();
  });
});

describe('limits', () => {
  const none = { reviews: 0, costUsd: 0 };

  it('reports the first limit reached', () => {
    const limits = {
      ...NO_LIMITS,
      maxReviewsPerRepoPerDay: 10,
      maxCostUsdPerInstallationPerDay: 5,
    };
    const usage = (reviews: number, costUsd: number) => ({
      repository: { reviews, costUsd: 0 },
      installation: { reviews, costUsd },
    });
    expect(usageLimitReached(limits, usage(9, 4.99))).toBeNull();
    expect(usageLimitReached(limits, usage(10, 0))).toBe('rate_limited');
    expect(usageLimitReached(limits, usage(0, 5))).toBe('budget_exceeded');
    expect(usageLimitReached(NO_LIMITS, usage(1e6, 1e6))).toBeNull();
    expect(usageLimitReached(limits, { repository: none, installation: none })).toBeNull();
  });

  it('judges size by files and by changed lines', () => {
    const limits = { ...NO_LIMITS, maxChangedLines: 100, maxChangedFiles: 5 };
    expect(tooLarge(limits, { files: 5, lines: 100 })).toBe(false);
    expect(tooLarge(limits, { files: 6, lines: 1 })).toBe(true);
    expect(tooLarge(limits, { files: 1, lines: 101 })).toBe(true);
    expect(tooLarge(NO_LIMITS, { files: 1e6, lines: 1e6 })).toBe(false);
  });
});
