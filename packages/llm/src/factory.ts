import { z } from 'zod';
import type { ResponseCache } from './cache.js';
import { LLMClient } from './client.js';
import { EmbeddingClient, GeminiEmbeddingProvider, type EmbeddingCache } from './embeddings.js';
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './providers/anthropic.js';
import {
  DEFAULT_GEMINI_FALLBACK_MODELS,
  DEFAULT_GEMINI_MODEL,
  GeminiKeyRunner,
  GeminiProvider,
  type GeminiKeyEvent,
  type GeminiModelEvent,
} from './providers/gemini.js';
import { parseKeyList } from './providers/key-pool.js';
import type { LLMCallRecord, LLMProvider } from './types.js';

export const PROVIDER_NAMES = ['gemini', 'anthropic'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export const DEFAULT_MODELS: Readonly<Record<ProviderName, string>> = {
  gemini: DEFAULT_GEMINI_MODEL,
  anthropic: DEFAULT_ANTHROPIC_MODEL,
};

export const DEFAULT_FALLBACK_MODELS: Readonly<Record<ProviderName, readonly string[]>> = {
  gemini: DEFAULT_GEMINI_FALLBACK_MODELS,
  anthropic: [],
};

const booleanish = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v === 'true' || v === '1'));

export const llmEnvSchema = z.object({
  LLM_PROVIDER: z.enum(PROVIDER_NAMES).default('gemini'),
  /** Several keys, separated by commas or whitespace; used in rotation. */
  GEMINI_API_KEYS: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  /** Free-tier keys are not billed, so recorded cost is 0. Default true. */
  GEMINI_FREE_TIER: booleanish,
  ANTHROPIC_API_KEY: z.string().optional(),
});
export type LLMEnv = z.infer<typeof llmEnvSchema>;

export interface LLMFromEnvOptions {
  cache?: ResponseCache | undefined;
  onCall?: (record: LLMCallRecord) => void;
  onKeyEvent?: (event: GeminiKeyEvent) => void;
  onModelEvent?: (event: GeminiModelEvent) => void;
  /** Override the provider chosen by LLM_PROVIDER (e.g. from a strategy config). */
  provider?: ProviderName;
  embeddingCache?: EmbeddingCache | undefined;
}

export interface LLMFromEnv {
  llm: LLMClient;
  provider: ProviderName;
  /**
   * Embedding client, when Gemini keys are configured. Embeddings always come from Gemini
   * (Anthropic has no embedding API), sharing the chat provider's key pool.
   */
  embeddings: EmbeddingClient | undefined;
}

/** Build the configured provider and clients. Fails fast when credentials are missing. */
export function createLLMFromEnv(
  source: Record<string, string | undefined>,
  options: LLMFromEnvOptions = {},
): LLMFromEnv {
  const env = llmEnvSchema.parse(source);
  const name = options.provider ?? env.LLM_PROVIDER;
  let provider: LLMProvider;
  let costFn: ((model: string) => number | null) | undefined;

  const geminiKeys = parseKeyList(env.GEMINI_API_KEYS, env.GEMINI_API_KEY);
  const keyRunner =
    geminiKeys.length > 0
      ? new GeminiKeyRunner({
          apiKeys: geminiKeys,
          ...(options.onKeyEvent ? { onKeyEvent: options.onKeyEvent } : {}),
        })
      : undefined;

  if (name === 'gemini') {
    if (!keyRunner) throw new Error('Set GEMINI_API_KEYS (comma-separated) or GEMINI_API_KEY');
    provider = new GeminiProvider({
      apiKeys: geminiKeys,
      keyRunner,
      ...(options.onModelEvent ? { onModelEvent: options.onModelEvent } : {}),
    });
    if (env.GEMINI_FREE_TIER ?? true) costFn = () => 0;
  } else {
    if (!env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY');
    provider = new AnthropicProvider();
  }

  const llm = new LLMClient({
    provider,
    cache: options.cache,
    ...(options.onCall ? { onCall: options.onCall } : {}),
    ...(costFn ? { costFn } : {}),
  });
  const embeddings = keyRunner
    ? new EmbeddingClient({
        provider: new GeminiEmbeddingProvider(keyRunner),
        cache: options.embeddingCache,
      })
    : undefined;
  return { llm, provider: name, embeddings };
}
