import type { z } from 'zod';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** One structured-output generation. Every field here is part of the response cache key. */
export interface GenerateRequest<T> {
  model: string;
  system: string;
  prompt: string;
  /** Output must validate against this schema; it is also sent as the JSON schema. */
  schema: z.ZodType<T>;
  /** Stable name for the schema, for logs and cache keys. Bump it when the schema changes. */
  schemaName: string;
  maxOutputTokens: number;
  effort?: Effort | undefined;
  /**
   * Models to try, in order, when `model` is overloaded, unavailable or out of quota
   * (Gemini). The model that answered is reported as `servedModel`.
   */
  fallbackModels?: readonly string[] | undefined;
  /** Let the provider re-run a policy-declined request on a fallback model. */
  refusalFallback?: boolean | undefined;
  /** Extra cache-key material, e.g. the run index when an eval repeats a config. */
  cacheSalt?: string | undefined;
  /** Per-attempt timeout; overrides the client default. Not part of the cache key. */
  timeoutMs?: number | undefined;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** What a provider returns for one successful call. */
export interface ProviderResponse<T> {
  output: T;
  usage: TokenUsage;
  /** Model that produced the output; differs from the requested one after a fallback. */
  servedModel: string;
  fallbackUsed: boolean;
  stopReason: string | null;
  requestId?: string | undefined;
}

export interface LLMProvider {
  readonly name: string;
  generate<T>(request: GenerateRequest<T>, signal: AbortSignal): Promise<ProviderResponse<T>>;
}

export interface GenerateResult<T> extends ProviderResponse<T> {
  provider: string;
  requestedModel: string;
  /**
   * Cost of producing this output, in USD. For cache hits this is the cost of the original
   * call (so eval cost metrics reflect a fresh run); check `cached` for what was spent now.
   * Null when the model has no pricing entry.
   */
  costUsd: number | null;
  /** Wall-clock time of this call, including retries. Near zero for cache hits. */
  latencyMs: number;
  cached: boolean;
  attempts: number;
  cacheKey: string;
}

/** Emitted once per generate() call, success or failure, for logging and metrics. */
export interface LLMCallRecord {
  provider: string;
  requestedModel: string;
  servedModel?: string | undefined;
  schemaName: string;
  cacheKey: string;
  cached: boolean;
  attempts: number;
  latencyMs: number;
  usage?: TokenUsage | undefined;
  costUsd?: number | null | undefined;
  stopReason?: string | null | undefined;
  fallbackUsed?: boolean | undefined;
  error?: { kind: string; message: string } | undefined;
}
