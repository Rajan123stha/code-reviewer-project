import {
  createLogger,
  MemoryRateLimiter,
  retryAfterSeconds,
  type Logger,
  type RateLimiter,
  type WindowLimit,
} from '@reviewlens/shared';
import Fastify from 'fastify';
import type { EnqueueFeedback, EnqueueIndex, EnqueueReview } from './queue.js';
import { webhookRoutes } from './webhook.js';

export interface ApiLimits {
  /** Requests per client per window, all routes except /healthz. */
  requests?: WindowLimit;
  /** Failed signature checks per client per window before it is refused. */
  signatureFailures?: WindowLimit;
}

/**
 * GitHub sends deliveries from a handful of addresses, in bursts when many pull requests
 * change at once; 600 a minute per address leaves ample room. Twenty bad signatures in ten
 * minutes is no misconfiguration GitHub would produce.
 */
export const DEFAULT_LIMITS: Required<ApiLimits> = {
  requests: { max: 600, windowMs: 60_000 },
  signatureFailures: { max: 20, windowMs: 10 * 60_000 },
};

export interface AppDeps {
  webhookSecret: string;
  enqueueReview: EnqueueReview;
  enqueueIndex: EnqueueIndex;
  enqueueFeedback: EnqueueFeedback;
  logger?: Logger;
  limits?: ApiLimits;
  /** Shared limiters (Redis) when several API processes run; in-memory otherwise. */
  limiters?: { requests: RateLimiter; signatureFailures: RateLimiter };
  /**
   * Behind a reverse proxy, which proxies to trust for the client address (X-Forwarded-For):
   * addresses or CIDRs such as "loopback" or "10.0.0.0/8". Without it, every request appears
   * to come from the proxy and all clients share one limit. Never trust everything (true)
   * when the API is reachable directly: clients could then pick their own address.
   */
  trustProxy?: boolean | string;
}

export function buildApp(deps: AppDeps) {
  const app = Fastify({
    loggerInstance: deps.logger ?? createLogger('api', { level: 'silent' }),
    trustProxy: deps.trustProxy ?? false,
  });
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const limiters = deps.limiters ?? {
    requests: new MemoryRateLimiter(limits.requests),
    signatureFailures: new MemoryRateLimiter(limits.signatureFailures),
  };

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    const result = await limiters.requests.hit(req.ip);
    if (!result.allowed) {
      reply.header('retry-after', retryAfterSeconds(result));
      return reply.code(429).send({ error: 'too many requests' });
    }
  });

  // Client errors say what was wrong with the request; server errors say nothing about the
  // server. The details go to the log only.
  app.setErrorHandler((error: Error & { statusCode?: number }, req, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err: error }, 'request failed');
      return reply.code(500).send({ error: 'internal error' });
    }
    const message =
      status === 413
        ? 'payload too large'
        : status === 415
          ? 'unsupported media type'
          : 'bad request';
    return reply.code(status).send({ error: message });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not found' }));

  app.get('/healthz', () => ({ status: 'ok' }));
  void app.register(webhookRoutes, {
    secret: deps.webhookSecret,
    enqueueReview: deps.enqueueReview,
    enqueueIndex: deps.enqueueIndex,
    enqueueFeedback: deps.enqueueFeedback,
    signatureFailures: limiters.signatureFailures,
  });

  return app;
}
