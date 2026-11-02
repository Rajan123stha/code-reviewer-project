import {
  createDb,
  addFixCommits,
  createFeedbackStore,
  createReviewStore,
  DbEmbeddingCache,
  DbParseCache,
  knownFixCommits,
  persistChunks,
  persistRepoIndex,
  replaceConventions,
  upsertRepository,
} from '@reviewlens/db';
import { createGitHubApp, loadPrivateKey } from '@reviewlens/github';
import { createLLMFromEnv, FileCache } from '@reviewlens/llm';
import { HttpCommentScorer, presetFor, type StrategyConfig } from '@reviewlens/review-core';
import {
  createLogger,
  parseEnv,
  FEEDBACK_QUEUE,
  feedbackJobSchema,
  INDEX_QUEUE,
  indexJobSchema,
  REVIEW_QUEUE,
  reviewJobSchema,
  type FeedbackJobData,
  type IndexJobData,
  shutdownTracing,
  type ReviewJobData,
} from '@reviewlens/shared';
import { Worker } from 'bullmq';
import { BullMQOtel } from 'bullmq-otel';
import { workerEnvSchema } from './env.js';
import { processFeedbackJob } from './feedback.js';
import { processIndexJob } from './index-job.js';
import { processReviewJob, type ReviewJobResult } from './review.js';

const env = parseEnv(workerEnvSchema);

const logger = createLogger('worker', { level: env.LOG_LEVEL });
const config: StrategyConfig = {
  ...presetFor(env.REVIEW_STRATEGY, {
    provider: env.LLM_PROVIDER,
    ...(env.REVIEW_MODEL ? { model: env.REVIEW_MODEL } : {}),
    ...(env.REVIEW_FALLBACK_MODELS !== undefined
      ? {
          fallbackModels: env.REVIEW_FALLBACK_MODELS.split(',')
            .map((m) => m.trim())
            .filter(Boolean),
        }
      : {}),
  }),
  filterThreshold: env.REVIEW_FILTER_THRESHOLD ?? null,
};
const scorer = env.FILTER_URL ? new HttpCommentScorer({ url: env.FILTER_URL }) : undefined;
const github = createGitHubApp({
  appId: env.GITHUB_APP_ID,
  privateKey: loadPrivateKey({
    inline: env.GITHUB_APP_PRIVATE_KEY,
    path: env.GITHUB_APP_PRIVATE_KEY_PATH,
  }),
});
const db = createDb(env.DATABASE_URL);
const store = createReviewStore(db);
const feedback = createFeedbackStore(db);
const limits = {
  maxReviewsPerRepoPerDay: env.MAX_REVIEWS_PER_REPO_PER_DAY || null,
  maxCostUsdPerInstallationPerDay: env.MAX_COST_USD_PER_INSTALLATION_PER_DAY || null,
  maxChangedLines: env.MAX_PR_CHANGED_LINES || null,
  maxChangedFiles: env.MAX_PR_CHANGED_FILES || null,
  maxDiffBytes: env.MAX_PR_DIFF_BYTES || null,
};
const parseCache = new DbParseCache(db);
// API keys are read here and never logged; key rotation events name keys as key#N.
const { llm, embeddings } = createLLMFromEnv(process.env, {
  embeddingCache: new DbEmbeddingCache(db),
  provider: config.provider,
  cache: env.LLM_CACHE_DIR ? new FileCache(env.LLM_CACHE_DIR) : undefined,
  onCall: (call) => logger.info({ llmCall: call }, 'llm call'),
  onKeyEvent: (event) => logger.warn({ keyEvent: event }, 'llm api key rotated out'),
  onModelEvent: (event) => logger.warn({ modelEvent: event }, 'llm model skipped; using fallback'),
});

const worker = new Worker<ReviewJobData, ReviewJobResult>(
  REVIEW_QUEUE,
  (job) =>
    processReviewJob(reviewJobSchema.parse(job.data), {
      getClient: (id) => github.forInstallation(id),
      llm,
      store,
      parseCache,
      embeddings,
      scorer,
      feedback,
      limits,
      config,
      logger: logger.child({ jobId: job.id, attempt: job.attemptsMade + 1 }),
    }),
  {
    connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
    concurrency: env.WORKER_CONCURRENCY,
    telemetry: new BullMQOtel({ tracerName: 'reviewlens-worker' }),
    // LLM calls take minutes; renew the job lock well inside that so it is not re-delivered.
    lockDuration: 120_000,
  },
);

// Indexing is CPU-bound parsing; one at a time keeps it from starving reviews.
const indexWorker = new Worker<IndexJobData>(
  INDEX_QUEUE,
  (job) =>
    processIndexJob(indexJobSchema.parse(job.data), {
      getClient: (id) => github.forInstallation(id),
      parseCache,
      upsertRepository: (ctx) => upsertRepository(db, ctx),
      persistIndex: (args) => persistRepoIndex(db, args),
      replaceConventions: (id, conventions) => replaceConventions(db, id, conventions),
      knownFixCommits: (id) => knownFixCommits(db, id),
      addFixCommits: (id, fixes) => addFixCommits(db, id, fixes),
      ...(env.INDEX_EMBEDDINGS && embeddings
        ? {
            chunkEmbeddings: {
              client: embeddings,
              model: config.embeddingModel,
              dimensions: config.embeddingDimensions,
              persistChunks: (args) => persistChunks(db, args),
            },
          }
        : {}),
      logger: logger.child({ jobId: job.id }),
    }),
  {
    connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
    concurrency: 1,
    telemetry: new BullMQOtel({ tracerName: 'reviewlens-worker' }),
    lockDuration: 300_000,
  },
);
// Feedback jobs are a few API calls and database writes.
const feedbackWorker = new Worker<FeedbackJobData>(
  FEEDBACK_QUEUE,
  (job) =>
    processFeedbackJob(feedbackJobSchema.parse(job.data), {
      getClient: (id) => github.forInstallation(id),
      store: feedback,
      logger: logger.child({ jobId: job.id }),
    }),
  {
    connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
    concurrency: 2,
    telemetry: new BullMQOtel({ tracerName: 'reviewlens-worker' }),
  },
);
feedbackWorker.on('failed', (job, err) =>
  logger.error({ jobId: job?.id, err }, 'feedback job failed'),
);
feedbackWorker.on('error', (err) => logger.error({ err }, 'feedback worker error'));

indexWorker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'index job failed'));
indexWorker.on('error', (err) => logger.error({ err }, 'index worker error'));

worker.on('failed', (job, err) =>
  logger.error({ jobId: job?.id, attempts: job?.attemptsMade, err }, 'review job failed'),
);
worker.on('error', (err) => logger.error({ err }, 'worker error'));
logger.info(
  {
    queue: REVIEW_QUEUE,
    concurrency: env.WORKER_CONCURRENCY,
    strategy: config.strategy,
    model: config.model,
  },
  'worker started',
);

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down; waiting for active jobs');
  await worker.close();
  await indexWorker.close();
  await feedbackWorker.close();
  await db.$disconnect();
  await shutdownTracing();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
