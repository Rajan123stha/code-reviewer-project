import {
  ApiError,
  FinishReason,
  GoogleGenAI,
  ThinkingLevel,
  type ThinkingConfig,
} from '@google/genai';
import { z } from 'zod';
import { LLMError } from '../errors.js';
import type { Effort, GenerateRequest, LLMProvider, ProviderResponse } from '../types.js';
import { ApiKeyPool, type PoolKey } from './key-pool.js';

/**
 * Pinned rather than the `gemini-flash-latest` alias, so results do not drift when Google
 * moves the alias. The version that answered is recorded per call as `servedModel`.
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

/** Tried in order when the primary model is overloaded, unavailable or out of quota. */
export const DEFAULT_GEMINI_FALLBACK_MODELS: readonly string[] = ['gemini-3.5-flash'];

/** Fallback wait when a 429 carries no RetryInfo. Free-tier limits are per minute. */
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;

/** The slice of the SDK this provider uses; tests pass a fake. */
export interface GeminiModelsClient {
  models: Pick<GoogleGenAI['models'], 'generateContent'> &
    Partial<Pick<GoogleGenAI['models'], 'embedContent'>>;
}

export interface GeminiKeyEvent {
  key: string;
  event: 'rate_limited' | 'disabled';
  reason: string;
  cooldownMs?: number;
}

export interface GeminiModelEvent {
  model: string;
  next: string;
  reason: string;
}

export interface GeminiKeyOptions {
  apiKeys: readonly string[];
  /** Notified when a key is rotated out; never receives the key itself. */
  onKeyEvent?: (event: GeminiKeyEvent) => void;
  /** Injectable for tests. */
  clientFor?: (apiKey: string) => GeminiModelsClient;
  now?: () => number;
}

export interface GeminiProviderOptions extends GeminiKeyOptions {
  /** Notified when a model is skipped in favor of the next fallback model. */
  onModelEvent?: (event: GeminiModelEvent) => void;
  /** Share one key runner (and its cooldown state) with other Gemini providers. */
  keyRunner?: GeminiKeyRunner;
}

/**
 * Gemini via the Google GenAI SDK with JSON-schema structured output.
 *
 * Holds a pool of API keys. On a 429 the current key cools down (for the server's
 * RetryInfo delay, or until the daily reset for daily quotas) and the same request is
 * retried immediately on the next key. Keys the API rejects are disabled. Only when every
 * key is unavailable does the call fail, as a rate_limit error carrying the wait until the
 * first key frees up, which LLMClient's retry loop honors.
 *
 * SDK-level retries are disabled; LLMClient owns the retry policy.
 */
export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';
  private readonly keys: GeminiKeyRunner;
  private readonly onModelEvent: ((event: GeminiModelEvent) => void) | undefined;

  constructor(options: GeminiProviderOptions) {
    this.keys = options.keyRunner ?? new GeminiKeyRunner(options);
    this.onModelEvent = options.onModelEvent;
  }

  /**
   * Try the requested model, then each fallback model in order. A model is skipped when it
   * is overloaded (5xx), unavailable to this account, or every key is rate-limited for it
   * (free-tier quotas are per model). Other errors are not retried on another model.
   */
  async generate<T>(
    request: GenerateRequest<T>,
    signal: AbortSignal,
  ): Promise<ProviderResponse<T>> {
    const models = [...new Set([request.model, ...(request.fallbackModels ?? [])])];
    let lastError: LLMError | undefined;
    let shortestWait: number | undefined;
    for (const [i, model] of models.entries()) {
      try {
        const response = await this.generateWith(model, request, signal);
        return i === 0 ? response : { ...response, fallbackUsed: true };
      } catch (error) {
        if (!(error instanceof LLMError) || !isModelSkippable(error)) throw error;
        lastError = error;
        if (error.kind === 'rate_limit' && error.retryAfterMs !== undefined) {
          shortestWait = Math.min(shortestWait ?? Infinity, error.retryAfterMs);
        }
        if (i < models.length - 1) {
          this.onModelEvent?.({ model, next: models[i + 1]!, reason: error.message });
        }
      }
    }
    // Every model failed. If any was only rate-limited, report the shortest wait so the
    // client's retry loop comes back when the first key frees up.
    if (lastError!.kind !== 'rate_limit' && shortestWait !== undefined) {
      throw new LLMError('rate_limit', lastError!.message, {
        status: 429,
        retryAfterMs: shortestWait,
      });
    }
    throw lastError!;
  }

  private async generateWith<T>(
    model: string,
    request: GenerateRequest<T>,
    signal: AbortSignal,
  ): Promise<ProviderResponse<T>> {
    const responseJsonSchema = toGeminiJsonSchema(request.schema);
    {
      const response = await this.keys.run(model, signal, (client) =>
        client.models.generateContent({
          model,
          contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
          config: {
            systemInstruction: request.system,
            maxOutputTokens: request.maxOutputTokens,
            responseMimeType: 'application/json',
            responseJsonSchema,
            ...(request.effort ? { thinkingConfig: thinkingFor(model, request.effort) } : {}),
            abortSignal: signal,
          },
        }),
      );

      const blocked = response.promptFeedback?.blockReason;
      if (blocked) throw new LLMError('refusal', `Gemini blocked the prompt (${blocked})`);
      const finish = response.candidates?.[0]?.finishReason;
      if (finish === FinishReason.MAX_TOKENS) {
        throw new LLMError(
          'max_tokens',
          `output hit maxOutputTokens=${request.maxOutputTokens} before the JSON was complete`,
        );
      }
      if (finish && REFUSAL_FINISH.has(finish)) {
        throw new LLMError('refusal', `Gemini stopped generation (finishReason ${finish})`);
      }

      const output = parseOutput(response.text, request.schema);
      const usage = response.usageMetadata ?? {};
      const cached = usage.cachedContentTokenCount ?? 0;
      return {
        output,
        usage: {
          inputTokens: Math.max(0, (usage.promptTokenCount ?? 0) - cached),
          // Thinking tokens are billed as output.
          outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
          cacheReadInputTokens: cached,
          cacheCreationInputTokens: 0,
        },
        servedModel: response.modelVersion ?? model,
        fallbackUsed: false,
        stopReason: finish ?? null,
        requestId: response.responseId,
      };
    }
  }

  /** Key pool for one model (see GeminiKeyRunner). */
  poolFor(model: string): ApiKeyPool {
    return this.keys.poolFor(model);
  }
}

/**
 * Runs Gemini API calls over a rotating pool of API keys, shared by the chat and
 * embedding providers. On a 429 the key cools down (for the server's RetryInfo delay, or
 * until the daily reset) and the call moves to the next key; rejected keys are disabled.
 * When no key is usable it throws rate_limit with the wait until the first key frees up.
 * Cooldowns are tracked per model, because free-tier quotas are counted per model.
 */
export class GeminiKeyRunner {
  private readonly apiKeys: readonly string[];
  private readonly pools = new Map<string, ApiKeyPool>();
  private readonly clients = new Map<string, GeminiModelsClient>();
  private readonly clientFor: (apiKey: string) => GeminiModelsClient;
  private readonly onKeyEvent: ((event: GeminiKeyEvent) => void) | undefined;
  private readonly now: () => number;

  constructor(options: GeminiKeyOptions) {
    this.now = options.now ?? Date.now;
    this.apiKeys = options.apiKeys;
    new ApiKeyPool(options.apiKeys); // validates that there is at least one key
    this.onKeyEvent = options.onKeyEvent;
    this.clientFor =
      options.clientFor ??
      ((apiKey) => new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } }));
  }

  poolFor(model: string): ApiKeyPool {
    let pool = this.pools.get(model);
    if (!pool) {
      pool = new ApiKeyPool(this.apiKeys, this.now);
      this.pools.set(model, pool);
    }
    return pool;
  }

  async run<R>(
    model: string,
    signal: AbortSignal,
    call: (client: GeminiModelsClient) => Promise<R>,
  ): Promise<R> {
    const pool = this.poolFor(model);
    for (;;) {
      const key = pool.acquire();
      if (!key) throw this.exhaustedError(pool, model);
      try {
        return await call(this.client(key));
      } catch (error) {
        if (signal.aborted) {
          throw new LLMError('timeout', 'Gemini request aborted', { cause: error });
        }
        const info = describeGeminiError(error);
        if (info.status === 429) {
          const cooldownMs = info.daily
            ? msUntilPacificMidnight(this.now())
            : (info.retryDelayMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS);
          pool.cooldown(key, cooldownMs, info.quotaId ?? 'rate limited');
          this.onKeyEvent?.({
            key: key.label,
            event: 'rate_limited',
            reason: info.quotaId ?? info.message,
            cooldownMs,
          });
          continue;
        }
        if (info.keyRejected) {
          pool.disable(key, info.message);
          this.onKeyEvent?.({ key: key.label, event: 'disabled', reason: info.message });
          continue;
        }
        throw toLLMError(error, info);
      }
    }
  }

  private client(key: PoolKey): GeminiModelsClient {
    let client = this.clients.get(key.label);
    if (!client) {
      client = this.clientFor(key.secret);
      this.clients.set(key.label, client);
    }
    return client;
  }

  private exhaustedError(pool: ApiKeyPool, model: string): LLMError {
    const wait = pool.msUntilAvailable();
    if (wait === undefined) {
      return new LLMError('auth', `all ${pool.size} Gemini API keys were rejected by the API`);
    }
    return new LLMError(
      'rate_limit',
      `all ${pool.size} Gemini API keys are rate-limited for ${model}; next available in ${Math.ceil(wait / 1000)} s`,
      { status: 429, retryAfterMs: wait },
    );
  }
}

/** Errors that say "this model cannot serve now", as opposed to "this request is bad". */
function isModelSkippable(error: LLMError): boolean {
  if (error.kind === 'server' || error.kind === 'rate_limit') return true;
  return (
    error.kind === 'bad_request' &&
    (error.status === 404 ||
      /no longer available|is not found|not supported for/i.test(error.message))
  );
}

const REFUSAL_FINISH = new Set<string>([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
]);

function parseOutput<T>(text: string | undefined, schema: z.ZodType<T>): T {
  if (!text) throw new LLMError('invalid_output', 'Gemini returned no text');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new LLMError('invalid_output', 'Gemini returned invalid JSON', { cause: error });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new LLMError(
      'invalid_output',
      `Gemini output does not match the schema: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * JSON Schema for Gemini's responseJsonSchema. Drops `$schema` and the ±2^53 bounds zod
 * adds to integers, which carry no meaning and some schema validators reject.
 */
export function toGeminiJsonSchema(schema: z.ZodType): unknown {
  return JSON.parse(JSON.stringify(z.toJSONSchema(schema)), (key, value: unknown) => {
    if (key === '$schema') return undefined;
    if (
      (key === 'minimum' || key === 'maximum') &&
      Math.abs(value as number) === Number.MAX_SAFE_INTEGER
    ) {
      return undefined;
    }
    return value;
  });
}

/** Map our effort levels to Gemini thinking controls (levels on 3.x, token budgets on 2.5). */
export function thinkingFor(model: string, effort: Effort): ThinkingConfig {
  if (/gemini-2\.5/.test(model)) {
    const budget = { low: 1_024, medium: 4_096, high: 16_384, xhigh: -1, max: -1 }[effort];
    return { thinkingBudget: budget };
  }
  const level = {
    low: ThinkingLevel.LOW,
    medium: ThinkingLevel.MEDIUM,
    high: ThinkingLevel.HIGH,
    xhigh: ThinkingLevel.HIGH,
    max: ThinkingLevel.HIGH,
  }[effort];
  return { thinkingLevel: level };
}

interface GeminiErrorInfo {
  status: number | undefined;
  message: string;
  retryDelayMs: number | undefined;
  quotaId: string | undefined;
  daily: boolean;
  keyRejected: boolean;
}

/**
 * Pull status, RetryInfo and the violated quota out of an SDK error. The SDK puts the
 * JSON error body in the message, e.g. {"error":{"code":429,"status":"RESOURCE_EXHAUSTED",
 * "details":[{QuotaFailure...},{"retryDelay":"39s"}]}}.
 */
export function describeGeminiError(error: unknown): GeminiErrorInfo {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof ApiError ? error.status : (error as { status?: number }).status;
  let body: { error?: { status?: string; message?: string; details?: Record<string, unknown>[] } } =
    {};
  const start = message.indexOf('{');
  if (start >= 0) {
    try {
      body = JSON.parse(message.slice(start)) as typeof body;
    } catch {
      // Not JSON; fall back to the plain message.
    }
  }
  const details = body.error?.details ?? [];
  let retryDelayMs: number | undefined;
  let quotaId: string | undefined;
  let keyRejected = false;
  for (const d of details) {
    if (typeof d.retryDelay === 'string') {
      const seconds = Number.parseFloat(d.retryDelay);
      if (Number.isFinite(seconds)) retryDelayMs = Math.ceil(seconds * 1000);
    }
    const violations = d.violations as { quotaId?: string }[] | undefined;
    if (Array.isArray(violations)) quotaId ??= violations.find((v) => v.quotaId)?.quotaId;
    if (d.reason === 'API_KEY_INVALID' || d.reason === 'API_KEY_SERVICE_BLOCKED')
      keyRejected = true;
  }
  if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID/i.test(message)) {
    keyRejected = true;
  }
  return {
    status,
    message: body.error?.message ?? message,
    retryDelayMs,
    quotaId,
    daily: /PerDay/i.test(quotaId ?? ''),
    keyRejected,
  };
}

function toLLMError(error: unknown, info: GeminiErrorInfo): LLMError {
  const opts = { cause: error, ...(info.status !== undefined ? { status: info.status } : {}) };
  if (info.status === undefined) return new LLMError('connection', info.message, opts);
  if (info.status === 408 || info.status === 504)
    return new LLMError('timeout', info.message, opts);
  if (info.status >= 500) return new LLMError('server', info.message, opts);
  return new LLMError('bad_request', info.message, opts);
}

/** Gemini daily quotas reset at midnight Pacific time. */
export function msUntilPacificMidnight(now: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const elapsed = (get('hour') * 3600 + get('minute') * 60 + get('second')) * 1000;
  return Math.max(60_000, 24 * 3600 * 1000 - elapsed);
}
