import {
  DEFAULT_FALLBACK_MODELS,
  DEFAULT_MODELS,
  PROVIDER_NAMES,
  type ProviderName,
} from '@reviewlens/llm';
import { hashOf } from '@reviewlens/shared';
import { z } from 'zod';

/**
 * Context strategies from the spec (S2 and S5 arrive with embeddings and conventions):
 * - S0: diff only
 * - S1: diff + full changed files
 * - S3: diff + changed symbols' bodies + definitions they call (AST context)
 * - S4: S3 + callers and callees out to `graphDepth` hops (call-graph context)
 */
export const STRATEGY_IDS = ['S0', 'S1', 'S3', 'S4'] as const;
export type StrategyId = (typeof STRATEGY_IDS)[number];

/**
 * Everything that determines a review's output besides the PR itself. It is the unit of
 * comparison in the ablations, so every field is explicit (no hidden defaults downstream)
 * and the whole object is hashed and stored with each review.
 */
export const strategyConfigSchema = z.object({
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
   * Call-graph hops for S4 (callers and callees). S3 is fixed at 1 hop of callees.
   * 0 for strategies that do not use the graph.
   */
  graphDepth: z.number().int().min(0).max(5),
  /** Symbol bodies estimated above this many tokens are shown as signatures (S3/S4). */
  maxSymbolTokens: z.number().int().positive(),
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
  promptVersion: 'review/v2',
  contextTokenBudget: 16_000,
  maxOutputTokens: 16_000,
  maxComments: 10,
  graphDepth: 0,
  maxSymbolTokens: 1_500,
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
  S3: { ...BASE, strategy: 'S3', graphDepth: 1 },
  S4: { ...BASE, strategy: 'S4', graphDepth: 2 },
};

/** Strategies that need the repository symbol graph. */
export function usesGraph(strategy: StrategyId): boolean {
  return strategy === 'S3' || strategy === 'S4';
}
