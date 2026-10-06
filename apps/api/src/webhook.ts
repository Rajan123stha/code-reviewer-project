import { withSpan } from '@reviewlens/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { EnqueueFeedback, EnqueueIndex, EnqueueReview } from './queue.js';
import { verifyGitHubSignature } from './signature.js';

/** pull_request actions that trigger a review. */
export const REVIEW_ACTIONS = new Set(['opened', 'synchronize']);

/** GitHub caps webhook payloads at 25 MB. */
const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;

const pullRequestEventSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() }),
  repository: z.object({
    id: z.number(),
    name: z.string(),
    owner: z.object({ login: z.string() }),
  }),
  pull_request: z.object({
    number: z.number(),
    head: z.object({ sha: z.string() }),
    base: z.object({ sha: z.string() }),
    merged: z.boolean().nullish(),
  }),
});

const reviewThreadEventSchema = z.object({
  action: z.string(),
  installation: z.object({ id: z.number() }),
  repository: z.object({
    id: z.number(),
    name: z.string(),
    owner: z.object({ login: z.string() }),
  }),
  pull_request: z.object({ number: z.number() }),
  thread: z.object({ comments: z.array(z.object({ id: z.number() })).min(1) }),
});

export interface WebhookOptions {
  secret: string;
  enqueueReview: EnqueueReview;
  enqueueIndex: EnqueueIndex;
  enqueueFeedback: EnqueueFeedback;
}

const pushEventSchema = z.object({
  ref: z.string(),
  after: z.string(),
  deleted: z.boolean().optional(),
  installation: z.object({ id: z.number() }),
  repository: z.object({
    id: z.number(),
    name: z.string(),
    default_branch: z.string(),
    owner: z.object({ login: z.string() }),
  }),
});

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export const webhookRoutes: FastifyPluginAsync<WebhookOptions> = async (app, opts) => {
  // Keep the body as raw bytes in this plugin scope: the HMAC must be computed over
  // exactly what GitHub sent, and we only parse JSON after the signature checks out.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: MAX_PAYLOAD_BYTES },
    (_req, body, done) => done(null, body),
  );

  app.post('/webhooks/github', async (req, reply) => {
    const rawBody = req.body as Buffer;
    const signature = header(req.headers['x-hub-signature-256']);
    if (!verifyGitHubSignature(opts.secret, rawBody, signature)) {
      req.log.warn('webhook signature verification failed');
      return reply.code(401).send({ error: 'invalid signature' });
    }

    const event = header(req.headers['x-github-event']);
    const deliveryId = header(req.headers['x-github-delivery']) ?? 'unknown';
    const log = req.log.child({ event, deliveryId });

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return reply.code(400).send({ error: 'invalid JSON' });
    }

    if (event === 'ping') return reply.code(200).send({ status: 'pong' });
    if (event === 'push') {
      // Pushes to the default branch refresh the repository's symbol index.
      const push = pushEventSchema.safeParse(payload);
      if (!push.success) return reply.code(400).send({ error: 'malformed push payload' });
      const { ref, after, deleted, installation, repository } = push.data;
      if (deleted || ref !== `refs/heads/${repository.default_branch}` || /^0+$/.test(after)) {
        return reply.code(200).send({ status: 'ignored' });
      }
      const { jobId } = await opts.enqueueIndex({
        deliveryId,
        installationId: installation.id,
        repositoryId: repository.id,
        owner: repository.owner.login,
        repo: repository.name,
        sha: after,
      });
      log.info({ jobId, sha: after }, 'index job enqueued');
      return reply.code(202).send({ status: 'queued', jobId });
    }
    if (event === 'pull_request_review_thread') {
      // A resolved thread is feedback on the comment that started it.
      const thread = reviewThreadEventSchema.safeParse(payload);
      if (!thread.success) return reply.code(400).send({ error: 'malformed thread payload' });
      const { action, installation, repository, pull_request: pr } = thread.data;
      if (action !== 'resolved') return reply.code(200).send({ status: 'ignored', action });
      const { jobId } = await opts.enqueueFeedback({
        kind: 'thread_resolved',
        deliveryId,
        installationId: installation.id,
        repositoryId: repository.id,
        owner: repository.owner.login,
        repo: repository.name,
        pullNumber: pr.number,
        commentIds: thread.data.thread.comments.map((c) => c.id),
      });
      return reply.code(202).send({ status: 'queued', jobId });
    }
    if (event !== 'pull_request') {
      log.debug('ignoring event');
      return reply.code(200).send({ status: 'ignored' });
    }

    const parsed = pullRequestEventSchema.safeParse(payload);
    if (!parsed.success) {
      log.warn({ issues: parsed.error.issues }, 'malformed pull_request payload');
      return reply.code(400).send({ error: 'malformed pull_request payload' });
    }
    const { action, installation, repository, pull_request: pr } = parsed.data;
    const target = {
      deliveryId,
      installationId: installation.id,
      repositoryId: repository.id,
      owner: repository.owner.login,
      repo: repository.name,
      pullNumber: pr.number,
    };
    if (action === 'closed') {
      const { jobId } = await opts.enqueueFeedback({
        ...target,
        kind: 'closed',
        merged: pr.merged ?? false,
      });
      return reply.code(202).send({ status: 'queued', jobId });
    }
    if (!REVIEW_ACTIONS.has(action)) {
      return reply.code(200).send({ status: 'ignored', action });
    }
    // A new push may have acted on comments from earlier reviews of this pull request.
    if (action === 'synchronize') {
      await opts.enqueueFeedback({ ...target, kind: 'push', headSha: pr.head.sha });
    }

    const { jobId } = await withSpan(
      'webhook.enqueue_review',
      {
        'github.repository': `${repository.owner.login}/${repository.name}`,
        'github.pr': pr.number,
      },
      () =>
        opts.enqueueReview({
          deliveryId,
          installationId: installation.id,
          repositoryId: repository.id,
          owner: repository.owner.login,
          repo: repository.name,
          pullNumber: pr.number,
          headSha: pr.head.sha,
          baseSha: pr.base.sha,
        }),
    );
    log.info({ jobId, action, pr: pr.number }, 'review job enqueued');
    return reply.code(202).send({ status: 'queued', jobId });
  });
};
