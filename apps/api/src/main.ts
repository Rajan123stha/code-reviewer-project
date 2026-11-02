import {
  createLogger,
  parseEnv,
  FEEDBACK_QUEUE,
  INDEX_QUEUE,
  REVIEW_QUEUE,
  RedisRateLimiter,
  shutdownTracing,
} from '@reviewlens/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { BullMQOtel } from 'bullmq-otel';
import { buildApp } from './app.js';
import { apiEnvSchema } from './env.js';
import { createEnqueueFeedback, createEnqueueIndex, createEnqueueReview } from './queue.js';

const env = parseEnv(apiEnvSchema);

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

const limiterRedis = new Redis(env.REDIS_URL, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});
limiterRedis.on('error', (err) => logger.error({ err }, 'rate limiter redis error'));

const app = buildApp({
  webhookSecret: env.GITHUB_WEBHOOK_SECRET,
  enqueueReview: createEnqueueReview(queue),
  enqueueIndex: createEnqueueIndex(indexQueue),
  enqueueFeedback: createEnqueueFeedback(feedbackQueue),
  trustProxy: env.TRUST_PROXY,
  // Counters live in Redis, so the limits hold across several API processes.
  limiters: {
    requests: new RedisRateLimiter(
      limiterRedis,
      { max: env.RATE_LIMIT_PER_MINUTE, windowMs: 60_000 },
      'reviewlens:ratelimit:requests',
    ),
    signatureFailures: new RedisRateLimiter(
      limiterRedis,
      { max: env.SIGNATURE_FAILURES_PER_10_MIN, windowMs: 10 * 60_000 },
      'reviewlens:ratelimit:signature-failures',
    ),
  },
  logger,
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  await app.close();
  await queue.close();
  await indexQueue.close();
  await feedbackQueue.close();
  limiterRedis.disconnect();
  await shutdownTracing();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: env.PORT, host: env.HOST });
