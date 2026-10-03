import { sha256, stableStringify } from '@reviewlens/shared';
import { z } from 'zod';
import type { ResponseCache } from './cache.js';
import { LLMError } from './errors.js';
import { computeCostUsd } from './pricing.js';
import type {
  GenerateRequest,
  GenerateResult,
  LLMCallRecord,
  LLMProvider,
  ProviderResponse,
  TokenUsage,
} from './types.js';

export interface RetryPolicy {
  /** Total attempts, including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * Longest server-requested wait (retry-after) worth sleeping through. Beyond it the
   * error is surfaced at once, e.g. when every key has used up its daily quota.
   */
  maxRetryAfterMs: number;
}

export interface LLMClientOptions {
  provider: LLMProvider;
  cache?: ResponseCache | undefined;
  retry?: Partial<RetryPolicy>;
  /** Per-attempt timeout when the request does not set one. */
  defaultTimeoutMs?: number;
  onCall?: (record: LLMCallRecord) => void;
  /**
   * Replaces the list-price cost calculation, e.g. `() => 0` on a free tier. Return null
   * when the cost is unknown.
   */
  costFn?: (model: string, usage: TokenUsage) => number | null;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 5 * 60 * 1_000,
};
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * Provider-agnostic entry point for every LLM call in the system. Adds, on top of a
 * provider: response caching, retries with exponential backoff and jitter, a per-attempt
 * timeout, cost accounting and one call record per request.
 */
export class LLMClient {
  private readonly provider: LLMProvider;
  private readonly cache: ResponseCache | undefined;
  private readonly retry: RetryPolicy;
  private readonly defaultTimeoutMs: number;
  private readonly onCall: ((record: LLMCallRecord) => void) | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly costFn: (model: string, usage: TokenUsage) => number | null;

  constructor(options: LLMClientOptions) {
    this.provider = options.provider;
    this.cache = options.cache;
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onCall = options.onCall;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.costFn = options.costFn ?? computeCostUsd;
  }

  get providerName() {
    return this.provider.name;
  }

  /** Deterministic key over everything that can change the output. */
  cacheKey(request: GenerateRequest<unknown>): string {
    return sha256(
      stableStringify({
        provider: this.provider.name,
        model: request.model,
        system: request.system,
        prompt: request.prompt,
        schemaName: request.schemaName,
        schema: z.toJSONSchema(request.schema),
        maxOutputTokens: request.maxOutputTokens,
        effort: request.effort ?? null,
        refusalFallback: request.refusalFallback ?? false,
        fallbackModels: request.fallbackModels ?? [],
        cacheSalt: request.cacheSalt ?? null,
      }),
    );
  }

  async generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const started = performance.now();
    const cacheKey = this.cacheKey(request);
    const base = {
      provider: this.provider.name,
      requestedModel: request.model,
      schemaName: request.schemaName,
      cacheKey,
    };

    const hit = await this.cache?.get(cacheKey);
    if (hit) {
      const parsed = request.schema.safeParse(hit.output);
      if (parsed.success) {
        const result: GenerateResult<T> = {
          ...hit,
          ...base,
          output: parsed.data,
          cached: true,
          attempts: 0,
          latencyMs: performance.now() - started,
        };
        this.emit(result, request.schemaName);
        return result;
      }
      // Stale entry from an older schema; fall through and regenerate.
    }

    let attempts = 0;
    for (;;) {
      attempts++;
      try {
        const response = await this.attempt(request);
        const costUsd = this.costFn(response.servedModel, response.usage);
        await this.cache?.set(cacheKey, { ...response, costUsd });
        const result: GenerateResult<T> = {
          ...response,
          ...base,
          costUsd,
          cached: false,
          attempts,
          latencyMs: performance.now() - started,
        };
        this.emit(result, request.schemaName);
        return result;
      } catch (error) {
        const llmError =
          error instanceof LLMError
            ? error
            : new LLMError('server', (error as Error).message ?? String(error), { cause: error });
        const waitTooLong = (llmError.retryAfterMs ?? 0) > this.retry.maxRetryAfterMs;
        if (!llmError.retryable || waitTooLong || attempts >= this.retry.maxAttempts) {
          this.onCall?.({
            ...base,
            cached: false,
            attempts,
            latencyMs: performance.now() - started,
            error: { kind: llmError.kind, message: llmError.message },
          });
          throw llmError;
        }
        await this.sleep(this.backoffMs(attempts, llmError.retryAfterMs));
      }
    }
  }

  private async attempt<T>(request: GenerateRequest<T>): Promise<ProviderResponse<T>> {
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new LLMError('timeout', `LLM call timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([this.provider.generate(request, controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Full-jitter exponential backoff; a server-provided retry-after wins when longer. */
  private backoffMs(attempt: number, retryAfterMs: number | undefined) {
    const ceiling = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** (attempt - 1));
    return Math.max(retryAfterMs ?? 0, Math.floor(this.random() * ceiling));
  }

  private emit(result: GenerateResult<unknown>, schemaName: string) {
    this.onCall?.({
      provider: result.provider,
      requestedModel: result.requestedModel,
      servedModel: result.servedModel,
      schemaName,
      cacheKey: result.cacheKey,
      cached: result.cached,
      attempts: result.attempts,
      latencyMs: result.latencyMs,
      usage: result.usage,
      costUsd: result.costUsd,
      stopReason: result.stopReason,
      fallbackUsed: result.fallbackUsed,
    });
  }
}
