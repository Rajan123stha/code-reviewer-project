import { retryAfterSeconds, withSpan, type RateLimiter } from '@reviewlens/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { EnqueueFeedback, EnqueueIndex, EnqueueReview } from './queue.js';
import { verifyGitHubSignature } from './signature.js';

/** pull_request actions that trigger a review. */
export const REVIEW_ACTIONS = new Set(['opened', 'synchronize', 'ready_for_review']);

/** GitHub caps webhook payloads at 25 MB. */
const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;

// Every field used downstream is validated here, at the trust boundary, to the shapes GitHub
// documents. Values flow into job ids, API paths and the database, so anything else is
// rejected rather than passed on. Unknown fields are ignored (zod strips them).

/** GitHub numeric ids: positive integers that survive JSON as exact numbers. */
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** A full commit SHA, as GitHub sends it. */
const sha = z.string().regex(/^[0-9a-f]{40}$/, 'must be a 40-character commit SHA');
/** User or organization login: letters, digits and hyphens, up to 39 characters. */
const login = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'must be a GitHub login');
/** Repository name: letters, digits, '.', '-' and '_', up to 100 characters. */
const repoName = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, 'must be a GitHub repository name');
const action = z.string().max(64);

const repository = z.object({ id, name: repoName, owner: z.object({ login }) });

const pullRequestEventSchema = z.object({
  action,
  installation: z.object({ id }),
  repository,
  pull_request: z.object({
    number: id,
    head: z.object({ sha }),
    base: z.object({ sha }),
    merged: z.boolean().nullish(),
    user: z.object({ login: z.string().max(64) }).nullish(),
  }),
});

const reviewThreadEventSchema = z.object({
  action,
  installation: z.object({ id }),
  repository,
  pull_request: z.object({ number: id }),
  thread: z.object({ comments: z.array(z.object({ id })).min(1).max(500) }),
});

/**
 * X-GitHub-Delivery is not covered by the signature, so it is untrusted even on a signed
 * request. GitHub sends a GUID; job ids are built from it, and BullMQ rejects ids with ':'.
 */
const DELIVERY_ID = /^[A-Za-z0-9-]{1,64}$/;
const EVENT_NAME = /^[a-z_]{1,64}$/;

export interface WebhookOptions {
  secret: string;
  enqueueReview: EnqueueReview;
  enqueueIndex: EnqueueIndex;
  enqueueFeedback: EnqueueFeedback;
  /** Counts failed signature checks per client; over the limit, the client is refused. */
  signatureFailures: RateLimiter;
}

const pushEventSchema = z.object({
  ref: z.string().max(255),
  // All zeros when a branch is deleted.
  after: sha,
  deleted: z.boolean().optional(),
  installation: z.object({ id }),
  repository: repository.extend({ default_branch: z.string().min(1).max(255) }),
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
    // A client that keeps failing the signature check is guessing: refuse it for a while,
    // even when it finally gets one right.
    const failures = await opts.signatureFailures.blocked(req.ip);
    if (!failures.allowed) {
      reply.header('retry-after', retryAfterSeconds(failures));
      return reply.code(429).send({ error: 'too many requests' });
    }
    const rawBody = req.body as Buffer;
    const signature = header(req.headers['x-hub-signature-256']);
    if (!verifyGitHubSignature(opts.secret, rawBody, signature)) {
      await opts.signatureFailures.hit(req.ip);
      req.log.warn('webhook signature verification failed');
      return reply.code(401).send({ error: 'invalid signature' });
    }

    const event = header(req.headers['x-github-event']) ?? '';
    const deliveryId = header(req.headers['x-github-delivery']) ?? '';
    if (!EVENT_NAME.test(event) || !DELIVERY_ID.test(deliveryId)) {
      return reply.code(400).send({ error: 'invalid X-GitHub-Event or X-GitHub-Delivery header' });
    }
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
        ...(pr.user && login.safeParse(pr.user.login).success
          ? { authorLogin: pr.user.login }
          : {}),
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
          ...(action === 'ready_for_review' ? { trigger: 'ready_for_review' as const } : {}),
        }),
    );
    log.info({ jobId, action, pr: pr.number }, 'review job enqueued');
    return reply.code(202).send({ status: 'queued', jobId });
  });
};
