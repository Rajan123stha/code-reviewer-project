import {
  createLogger,
  logEnv,
  parseEnv,
  redisEnv,
  FEEDBACK_QUEUE,
  INDEX_QUEUE,
  REVIEW_QUEUE,
  shutdownTracing,
} from '@reviewlens/shared';
import { Queue } from 'bullmq';
import { BullMQOtel } from 'bullmq-otel';
import { z } from 'zod';
import { buildApp } from './app.js';
import { createEnqueueFeedback, createEnqueueIndex, createEnqueueReview } from './queue.js';

const env = parseEnv(
  z.object({
    ...redisEnv,
    ...logEnv,
    GITHUB_WEBHOOK_SECRET: z.string().min(1),
    PORT: z.coerce.number().int().default(3000),
    HOST: z.string().default('0.0.0.0'),
  }),
);

const logger = createLogger('api', { level: env.LOG_LEVEL });
const queue = new Queue(REVIEW_QUEUE, {
  // Fail fast when Redis is down instead of buffering: the webhook then returns 500
  // within GitHub's 10 s delivery timeout, and the delivery can be redelivered later.
  connection: { url: env.REDIS_URL, enableOfflineQueue: false },
  telemetry: new BullMQOtel({ tracerName: 'reviewlens-api' }),
});
queue.on('error', (err) => logger.error({ err }, 'queue connection error'));
const indexQueue = new Queue(INDEX_QUEUE, {
  connection: { url: env.REDIS_URL, enableOfflineQueue: false },
  telemetry: new BullMQOtel({ tracerName: 'reviewlens-api' }),
});
indexQueue.on('error', (err) => logger.error({ err }, 'index queue connection error'));

const feedbackQueue = new Queue(FEEDBACK_QUEUE, {
  connection: { url: env.REDIS_URL, enableOfflineQueue: false },
  telemetry: new BullMQOtel({ tracerName: 'reviewlens-api' }),
});
feedbackQueue.on('error', (err) => logger.error({ err }, 'feedback queue connection error'));

const app = buildApp({
  webhookSecret: env.GITHUB_WEBHOOK_SECRET,
  enqueueReview: createEnqueueReview(queue),
  enqueueIndex: createEnqueueIndex(indexQueue),
  enqueueFeedback: createEnqueueFeedback(feedbackQueue),
  logger,
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  await app.close();
  await queue.close();
  await indexQueue.close();
  await feedbackQueue.close();
  await shutdownTracing();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: env.PORT, host: env.HOST });
