import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_FALLBACK_MODELS,
  DEFAULT_GEMINI_EMBEDDING_MODEL,
  DEFAULT_MODELS,
  PROVIDER_NAMES,
  type ProviderName,
} from '@reviewlens/llm';
import { hashOf } from '@reviewlens/shared';
import { z } from 'zod';

/**
 * Context strategies from the spec:
 * - S0: diff only
 * - S1: diff + full changed files
 * - S2: diff + code most similar to the change by embedding (top-k symbol chunks)
 * - S3: diff + changed symbols' bodies + definitions they call (AST context)
 * - S4: S3 + callers and callees out to `graphDepth` hops (call-graph context)
 * - S5: S4 + repository conventions + similar past bug fixes
 */
export const STRATEGY_IDS = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];

/**
 * Everything that determines a review's output besides the PR itself. It is the unit of
 * comparison in the ablations, so every field is explicit (no hidden defaults downstream)
 * and the whole object is hashed and stored with each review.
 */
export const strategyConfigSchema = z.strictObject({
  strategy: z.enum(STRATEGY_IDS),
  /** LLM provider; must match the client the pipeline is given. */
  provider: z.enum(PROVIDER_NAMES),
  model: z.string().min(1),
  /**
   * Models tried in order when `model` is overloaded, unavailable or out of quota. Empty
   * for experiments that must be served by one model only.
   */
  fallbackModels: z.array(z.string().min(1)).readonly(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  promptVersion: z.string().regex(/^[a-z-]+\/v\d+$/),
  /** Estimated tokens available for repository context (diff + files), excluding the prompt. */
  contextTokenBudget: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  /** Upper bound on comments posted per review, after validation and dedupe. */
  maxComments: z.number().int().positive(),
  /**
   * Call-graph hops for S4/S5 (callers and callees). S3 is fixed at 1 hop of callees.
   * 0 for strategies that do not walk the graph.
   */
  graphDepth: z.number().int().min(0).max(5),
  /** Symbol bodies estimated above this many tokens are shown as signatures. */
  maxSymbolTokens: z.number().int().positive(),

  // Retrieval sources. Each is a separate switch so ablations can turn one off (E7).
  /** Add repository conventions (CONTRIBUTING, lint and compiler settings). */
  useConventions: z.boolean(),
  /** Token cap for the conventions section, taken from the context budget. */
  conventionsTokenCap: z.number().int().min(0),
  /** Add past bug fixes that touched the changed files. */
  usePastBugs: z.boolean(),
  pastBugsTopK: z.number().int().min(0),
  pastBugsTokenCap: z.number().int().min(0),
  /** Embedding retrieval (S2): model, vector size and how many chunks to consider. */
  embeddingModel: z.string().min(1),
  embeddingDimensions: z.number().int().positive(),
  embeddingTopK: z.number().int().min(0),

  /**
   * Learned usefulness filter. Null: off, and comments are ranked by severity and
   * confidence. A number: comments scoring below it are dropped and the rest are ranked
   * by score. 0 keeps every comment and only re-ranks.
   */
  filterThreshold: z.number().min(0).max(1).nullable(),
  /** Pin the filter model version; the review fails if another is served. Null: any. */
  filterModel: z.string().min(1).nullable(),

  /** Anthropic only: rerun policy-declined requests on a fallback model. */
  refusalFallback: z.boolean(),
});

export type StrategyConfig = z.infer<typeof strategyConfigSchema>;

export function configHash(config: StrategyConfig): string {
  return hashOf(strategyConfigSchema.parse(config));
}

const BASE = {
  provider: 'gemini',
  model: DEFAULT_MODELS.gemini,
  fallbackModels: [...DEFAULT_FALLBACK_MODELS.gemini],
  effort: 'high',
  promptVersion: 'review/v3',
  contextTokenBudget: 16_000,
  maxOutputTokens: 16_000,
  maxComments: 10,
  graphDepth: 0,
  maxSymbolTokens: 1_500,
  useConventions: false,
  conventionsTokenCap: 600,
  usePastBugs: false,
  pastBugsTopK: 5,
  pastBugsTokenCap: 600,
  embeddingModel: DEFAULT_GEMINI_EMBEDDING_MODEL,
  embeddingDimensions: DEFAULT_EMBEDDING_DIMENSIONS,
  embeddingTopK: 0,
  filterThreshold: null,
  filterModel: null,
  refusalFallback: false,
} as const;

/** Preset for a strategy, switched to another provider (with that provider's default model). */
export function presetFor(
  strategy: StrategyId,
  overrides: { provider?: ProviderName; model?: string; fallbackModels?: string[] } = {},
): StrategyConfig {
  const provider = overrides.provider ?? PRESETS[strategy].provider;
  return strategyConfigSchema.parse({
    ...PRESETS[strategy],
    provider,
    model: overrides.model ?? DEFAULT_MODELS[provider],
    fallbackModels: overrides.fallbackModels ?? [...DEFAULT_FALLBACK_MODELS[provider]],
    refusalFallback: provider === 'anthropic',
  });
}

export const PRESETS: Readonly<Record<StrategyId, StrategyConfig>> = {
  S0: { ...BASE, strategy: 'S0' },
  S1: { ...BASE, strategy: 'S1' },
  S2: { ...BASE, strategy: 'S2', embeddingTopK: 10 },
  S3: { ...BASE, strategy: 'S3', graphDepth: 1 },
  S4: { ...BASE, strategy: 'S4', graphDepth: 2 },
  S5: { ...BASE, strategy: 'S5', graphDepth: 2, useConventions: true, usePastBugs: true },
};

/** Strategies that need the repository symbol graph (S2 chunks by symbol). */
export function usesGraph(strategy: StrategyId): boolean {
  return strategy !== 'S0' && strategy !== 'S1';
}

/** Strategies that walk call edges from the changed symbols. */
export function usesCallGraph(strategy: StrategyId): boolean {
  return strategy === 'S3' || strategy === 'S4' || strategy === 'S5';
}

export function usesEmbeddings(strategy: StrategyId): boolean {
  return strategy === 'S2';
}
