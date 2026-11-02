import { PROVIDER_NAMES } from '@reviewlens/llm';
import { STRATEGY_IDS } from '@reviewlens/review-core';
import { logEnv, postgresUrl, redisEnv } from '@reviewlens/shared';
import { z } from 'zod';

/** The worker's configuration, validated at startup before it connects to anything. */
export const workerEnvSchema = z
  .object({
    ...redisEnv,
    ...logEnv,
    GITHUB_APP_ID: z.string().regex(/^\d+$/, 'must be the numeric App ID'),
    GITHUB_APP_PRIVATE_KEY: z.string().optional(),
    GITHUB_APP_PRIVATE_KEY_PATH: z.string().optional(),
    DATABASE_URL: postgresUrl,
    LLM_PROVIDER: z.enum(PROVIDER_NAMES).default('gemini'),
    REVIEW_STRATEGY: z.enum(STRATEGY_IDS).default('S1'),
    /** Overrides the provider's default model, e.g. a pinned Gemini version. */
    REVIEW_MODEL: z.string().optional(),
    /** Comma-separated; overrides the provider's default fallback models. Empty = none. */
    REVIEW_FALLBACK_MODELS: z.string().optional(),
    /** Optional on-disk LLM response cache; useful when replaying the same PRs locally. */
    LLM_CACHE_DIR: z.string().optional(),
    /** Embed every indexed symbol into pgvector at index time. Slow on free-tier keys. */
    INDEX_EMBEDDINGS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    /** Filter service base URL. With REVIEW_FILTER_THRESHOLD, turns the learned filter on. */
    FILTER_URL: z.string().url().optional(),
    /** Drop comments the filter scores below this (0 to 1). Unset: filter off. */
    REVIEW_FILTER_THRESHOLD: z.coerce.number().min(0).max(1).optional(),
    /** Usage limits; set a value to 0 to switch that limit off. */
    MAX_REVIEWS_PER_REPO_PER_DAY: z.coerce.number().int().min(0).default(100),
    MAX_COST_USD_PER_INSTALLATION_PER_DAY: z.coerce.number().min(0).default(0),
    MAX_PR_CHANGED_LINES: z.coerce.number().int().min(0).default(5000),
    MAX_PR_CHANGED_FILES: z.coerce.number().int().min(0).default(200),
    // Model keys are read by the LLM factory; declared here so a missing key fails at startup.
    GEMINI_API_KEYS: z.string().optional(),
    GEMINI_API_KEY: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  })
  .superRefine((env, ctx) => {
    if (!env.GITHUB_APP_PRIVATE_KEY && !env.GITHUB_APP_PRIVATE_KEY_PATH) {
      ctx.addIssue({
        code: 'custom',
        path: ['GITHUB_APP_PRIVATE_KEY_PATH'],
        message: 'set GITHUB_APP_PRIVATE_KEY_PATH (or GITHUB_APP_PRIVATE_KEY)',
      });
    }
    if (
      env.LLM_PROVIDER === 'gemini' &&
      !env.GEMINI_API_KEYS?.trim() &&
      !env.GEMINI_API_KEY?.trim()
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['GEMINI_API_KEYS'],
        message: 'is required when LLM_PROVIDER is gemini',
      });
    }
    if (env.LLM_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_API_KEY'],
        message: 'is required when LLM_PROVIDER is anthropic',
      });
    }
    if (env.REVIEW_FILTER_THRESHOLD !== undefined && !env.FILTER_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['FILTER_URL'],
        message: 'is required when REVIEW_FILTER_THRESHOLD is set',
      });
    }
  });
