import { createLogger, type Logger } from '@reviewlens/shared';
import Fastify from 'fastify';
import type { EnqueueFeedback, EnqueueIndex, EnqueueReview } from './queue.js';
import { webhookRoutes } from './webhook.js';

export interface AppDeps {
  webhookSecret: string;
  enqueueReview: EnqueueReview;
  enqueueIndex: EnqueueIndex;
  enqueueFeedback: EnqueueFeedback;
  logger?: Logger;
}

export function buildApp(deps: AppDeps) {
  const app = Fastify({
    loggerInstance: deps.logger ?? createLogger('api', { level: 'silent' }),
  });

  app.get('/healthz', () => ({ status: 'ok' }));
  void app.register(webhookRoutes, {
    secret: deps.webhookSecret,
    enqueueReview: deps.enqueueReview,
    enqueueIndex: deps.enqueueIndex,
    enqueueFeedback: deps.enqueueFeedback,
  });

  return app;
}
