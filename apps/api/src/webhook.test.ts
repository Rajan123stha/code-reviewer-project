import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import type { EnqueueFeedback, EnqueueIndex, EnqueueReview } from './queue.js';
import { signGitHubPayload } from './signature.js';

const SECRET = 'test-secret';
const HEAD = '1'.repeat(40);
const BASE = '2'.repeat(40);

function pullRequestPayload(action: string) {
  return {
    action,
    installation: { id: 100 },
    repository: { id: 200, name: 'hello', full_name: 'octo/hello', owner: { login: 'octo' } },
    pull_request: { number: 5, head: { sha: HEAD }, base: { sha: BASE } },
  };
}

describe('POST /webhooks/github', () => {
  let enqueueReview: ReturnType<typeof vi.fn<EnqueueReview>>;
  let enqueueIndex: ReturnType<typeof vi.fn<EnqueueIndex>>;
  let enqueueFeedback: ReturnType<typeof vi.fn<EnqueueFeedback>>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    enqueueReview = vi.fn<EnqueueReview>(async () => ({ jobId: 'job-1' }));
    enqueueIndex = vi.fn<EnqueueIndex>(async () => ({ jobId: 'index-1' }));
    enqueueFeedback = vi.fn<EnqueueFeedback>(async () => ({ jobId: 'feedback-1' }));
    app = buildApp({ webhookSecret: SECRET, enqueueReview, enqueueIndex, enqueueFeedback });
  });
  afterEach(() => app.close());

  function send(event: string, body: unknown, options: { signature?: string } = {}) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    return app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': 'delivery-abc',
        'x-hub-signature-256': options.signature ?? signGitHubPayload(SECRET, raw),
      },
      payload: raw,
    });
  }

  it.each(['opened', 'synchronize'])('enqueues a review for pull_request.%s', async (action) => {
    const res = await send('pull_request', pullRequestPayload(action));

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'queued', jobId: 'job-1' });
    expect(enqueueReview).toHaveBeenCalledExactlyOnceWith({
      deliveryId: 'delivery-abc',
      installationId: 100,
      repositoryId: 200,
      owner: 'octo',
      repo: 'hello',
      pullNumber: 5,
      headSha: HEAD,
      baseSha: BASE,
    });
  });

  it('rejects a bad signature without enqueueing', async () => {
    const res = await send('pull_request', pullRequestPayload('opened'), {
      signature: signGitHubPayload('wrong-secret', 'x'),
    });
    expect(res.statusCode).toBe(401);
    expect(enqueueReview).not.toHaveBeenCalled();
  });

  it('verifies against the raw bytes, not re-serialized JSON', async () => {
    // Same JSON value, different bytes: whitespace must not be normalized away before HMAC.
    const raw = JSON.stringify(pullRequestPayload('opened'), null, 2);
    const signedCompact = signGitHubPayload(SECRET, JSON.stringify(JSON.parse(raw)));
    const res = await send('pull_request', raw, { signature: signedCompact });
    expect(res.statusCode).toBe(401);
  });

  it('also queues a feedback check when a pull request gets a new push', async () => {
    await send('pull_request', pullRequestPayload('synchronize'));
    expect(enqueueFeedback).toHaveBeenCalledExactlyOnceWith({
      kind: 'push',
      deliveryId: 'delivery-abc',
      installationId: 100,
      repositoryId: 200,
      owner: 'octo',
      repo: 'hello',
      pullNumber: 5,
      headSha: HEAD,
    });
    enqueueFeedback.mockClear();
    await send('pull_request', pullRequestPayload('opened'));
    expect(enqueueFeedback).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'queues feedback when a pull request closes (merged: %s)',
    async (merged) => {
      const payload = pullRequestPayload('closed');
      const res = await send('pull_request', {
        ...payload,
        pull_request: { ...payload.pull_request, merged },
      });
      expect(res.statusCode).toBe(202);
      expect(enqueueFeedback).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ kind: 'closed', merged, pullNumber: 5 }),
      );
      expect(enqueueReview).not.toHaveBeenCalled();
    },
  );

  it('queues feedback when a review thread is resolved, and ignores unresolved', async () => {
    const payload = {
      action: 'resolved',
      installation: { id: 100 },
      repository: { id: 200, name: 'hello', owner: { login: 'octo' } },
      pull_request: { number: 5 },
      thread: { comments: [{ id: 901 }, { id: 902 }] },
    };
    const res = await send('pull_request_review_thread', payload);
    expect(res.statusCode).toBe(202);
    expect(enqueueFeedback).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: 'thread_resolved', commentIds: [901, 902], pullNumber: 5 }),
    );
    enqueueFeedback.mockClear();
    const other = await send('pull_request_review_thread', { ...payload, action: 'unresolved' });
    expect(other.json()).toMatchObject({ status: 'ignored' });
    expect((await send('pull_request_review_thread', { action: 'resolved' })).statusCode).toBe(400);
    expect(enqueueFeedback).not.toHaveBeenCalled();
  });

  it.each(['edited', 'labeled'])('ignores pull_request.%s', async (action) => {
    const res = await send('pull_request', pullRequestPayload(action));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ignored' });
    expect(enqueueReview).not.toHaveBeenCalled();
  });

  function pushPayload(ref: string, after = '3'.repeat(40), deleted = false) {
    return {
      ref,
      after,
      deleted,
      installation: { id: 100 },
      repository: { id: 200, name: 'hello', default_branch: 'main', owner: { login: 'octo' } },
    };
  }

  it('enqueues an index job for pushes to the default branch', async () => {
    const res = await send('push', pushPayload('refs/heads/main'));
    expect(res.statusCode).toBe(202);
    expect(enqueueIndex).toHaveBeenCalledExactlyOnceWith({
      deliveryId: 'delivery-abc',
      installationId: 100,
      repositoryId: 200,
      owner: 'octo',
      repo: 'hello',
      sha: '3'.repeat(40),
    });
  });

  it.each([
    ['another branch', pushPayload('refs/heads/feature')],
    ['a tag', pushPayload('refs/tags/v1')],
    ['a branch deletion', pushPayload('refs/heads/main', '0'.repeat(40), true)],
  ])('ignores pushes to %s', async (_name, payload) => {
    const res = await send('push', payload);
    expect(res.statusCode).toBe(200);
    expect(enqueueIndex).not.toHaveBeenCalled();
  });

  it('ignores other events', async () => {
    const res = await send('issues', { action: 'opened' });
    expect(res.statusCode).toBe(200);
    expect(enqueueReview).not.toHaveBeenCalled();
  });

  it('answers ping', async () => {
    const res = await send('ping', { zen: 'Keep it logically awesome.' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'pong' });
  });

  it('returns 400 for a signed but malformed pull_request payload', async () => {
    const res = await send('pull_request', { action: 'opened', repository: {} });
    expect(res.statusCode).toBe(400);
    expect(enqueueReview).not.toHaveBeenCalled();
  });

  it('returns 400 for signed invalid JSON', async () => {
    const res = await send('pull_request', '{not json');
    expect(res.statusCode).toBe(400);
  });

  it('returns 500 when enqueueing fails, so GitHub records a failed delivery', async () => {
    enqueueReview.mockRejectedValueOnce(new Error('redis down'));
    const res = await send('pull_request', pullRequestPayload('opened'));
    expect(res.statusCode).toBe(500);
  });
});

describe('GET /healthz', () => {
  it('returns ok', async () => {
    const app = buildApp({
      webhookSecret: SECRET,
      enqueueReview: vi.fn(),
      enqueueIndex: vi.fn(),
      enqueueFeedback: vi.fn(),
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
