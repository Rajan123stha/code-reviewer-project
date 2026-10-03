import { ApiError } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { LLMClient } from '../client.js';
import { createLLMFromEnv } from '../factory.js';
import {
  describeGeminiError,
  GeminiProvider,
  msUntilPacificMidnight,
  thinkingFor,
  toGeminiJsonSchema,
  type GeminiKeyEvent,
  type GeminiModelsClient,
} from './gemini.js';
import { ApiKeyPool, parseKeyList } from './key-pool.js';

const schema = z.object({ ok: z.boolean(), n: z.number().int() });
const request = {
  model: 'gemini-3.8-flash',
  system: 'sys',
  prompt: 'p',
  schema,
  schemaName: 's/v1',
  maxOutputTokens: 1_000,
  effort: 'high' as const,
};
const signal = new AbortController().signal;

function rateLimit(quotaId: string, retryDelay?: string) {
  const body = {
    error: {
      code: 429,
      message: 'You exceeded your current quota.',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] },
        ...(retryDelay
          ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }]
          : []),
      ],
    },
  };
  return new ApiError({ status: 429, message: JSON.stringify(body) });
}

const invalidKey = () =>
  new ApiError({
    status: 400,
    message: JSON.stringify({
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' },
        ],
      },
    }),
  });

function okResponse(overrides: Record<string, unknown> = {}) {
  return {
    text: JSON.stringify({ ok: true, n: 3 }),
    candidates: [{ finishReason: 'STOP' }],
    usageMetadata: {
      promptTokenCount: 1_200,
      cachedContentTokenCount: 200,
      candidatesTokenCount: 50,
      thoughtsTokenCount: 300,
    },
    modelVersion: 'gemini-3.8-flash-001',
    responseId: 'resp-1',
    ...overrides,
  };
}

/** Keys map to scripted behaviors; records which key served each call. */
function setup(script: Record<string, (() => unknown)[]>, now = () => 1_000_000) {
  const used: string[] = [];
  const events: GeminiKeyEvent[] = [];
  const clientFor = (apiKey: string): GeminiModelsClient => ({
    models: {
      generateContent: vi.fn(async (params: unknown) => {
        used.push(apiKey);
        const next = script[apiKey]!.shift();
        if (!next) throw new Error(`no scripted reply left for ${apiKey}`);
        const out = next();
        if (out instanceof Error) throw out;
        return { ...(out as object), params } as never;
      }),
    },
  });
  const provider = new GeminiProvider({
    apiKeys: Object.keys(script),
    clientFor,
    now,
    onKeyEvent: (e) => events.push(e),
  });
  return { provider, used, events };
}

describe('GeminiProvider', () => {
  it('maps a structured response and usage (thinking billed as output)', async () => {
    const { provider } = setup({ k1: [() => okResponse()] });
    const res = await provider.generate(request, signal);
    expect(res).toEqual({
      output: { ok: true, n: 3 },
      usage: {
        inputTokens: 1_000,
        outputTokens: 350,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 0,
      },
      servedModel: 'gemini-3.8-flash-001',
      fallbackUsed: false,
      stopReason: 'STOP',
      requestId: 'resp-1',
    });
  });

  it('sends system prompt, JSON schema, token cap and thinking level', async () => {
    let seen: Record<string, unknown> = {};
    const provider = new GeminiProvider({
      apiKeys: ['k1'],
      clientFor: () => ({
        models: {
          generateContent: vi.fn(async (params: unknown) => {
            seen = params as Record<string, unknown>;
            return okResponse() as never;
          }),
        },
      }),
    });
    await provider.generate(request, signal);
    expect(seen).toMatchObject({
      model: 'gemini-3.8-flash',
      contents: [{ role: 'user', parts: [{ text: 'p' }] }],
      config: {
        systemInstruction: 'sys',
        maxOutputTokens: 1_000,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingLevel: 'HIGH' },
        abortSignal: signal,
      },
    });
    const config = seen.config as { responseJsonSchema: Record<string, unknown> };
    expect(config.responseJsonSchema).not.toHaveProperty('$schema');
    expect(JSON.stringify(config.responseJsonSchema)).not.toContain('9007199254740991');
  });

  it('switches to the next key on a per-minute 429 and cools the first one', async () => {
    const { provider, used, events } = setup({
      k1: [() => rateLimit('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '39s')],
      k2: [() => okResponse()],
    });
    await provider.generate(request, signal);
    expect(used).toEqual(['k1', 'k2']);
    expect(events).toEqual([
      {
        key: 'key#1',
        event: 'rate_limited',
        reason: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
        cooldownMs: 39_000,
      },
    ]);
    expect(provider.poolFor(request.model).status()[0]).toMatchObject({
      state: 'cooling',
      availableInMs: 39_000,
    });
  });

  it('parks a key until the Pacific-midnight reset on a daily quota', async () => {
    const now = () => Date.UTC(2026, 9, 1, 20, 0, 0); // 13:00 PDT
    const { provider, events } = setup(
      {
        k1: [() => rateLimit('GenerateRequestsPerDayPerProjectPerModel-FreeTier')],
        k2: [() => okResponse()],
      },
      now,
    );
    await provider.generate(request, signal);
    expect(events[0]!.cooldownMs).toBe(11 * 3600 * 1000);
  });

  it('disables a rejected key and carries on with the rest', async () => {
    const { provider, used, events } = setup({
      k1: [invalidKey],
      k2: [() => okResponse(), () => okResponse()],
    });
    await provider.generate(request, signal);
    await provider.generate(request, signal);
    expect(used).toEqual(['k1', 'k2', 'k2']);
    expect(events[0]).toMatchObject({ key: 'key#1', event: 'disabled' });
  });

  it('round-robins across healthy keys', async () => {
    const { provider, used } = setup({
      k1: [() => okResponse()],
      k2: [() => okResponse()],
      k3: [() => okResponse()],
    });
    for (let i = 0; i < 3; i++) await provider.generate(request, signal);
    expect(used).toEqual(['k1', 'k2', 'k3']);
  });

  it('fails as rate_limit with the shortest wait when every key is cooling', async () => {
    const { provider } = setup({
      k1: [() => rateLimit('PerMinute', '30s')],
      k2: [() => rateLimit('PerMinute', '10s')],
    });
    await expect(provider.generate(request, signal)).rejects.toMatchObject({
      kind: 'rate_limit',
      retryAfterMs: 10_000,
    });
  });

  it('fails as auth when every key is rejected', async () => {
    const { provider } = setup({ k1: [invalidKey], k2: [invalidKey] });
    await expect(provider.generate(request, signal)).rejects.toMatchObject({
      kind: 'auth',
      retryable: false,
    });
  });

  it('works end to end with LLMClient: waits out the cooldown, then retries', async () => {
    let clock = 0;
    const { provider, used } = setup(
      { k1: [() => rateLimit('PerMinute', '5s'), () => okResponse()] },
      () => clock,
    );
    const sleeps: number[] = [];
    const llm = new LLMClient({
      provider,
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    const res = await llm.generate(request);
    expect(res.output).toEqual({ ok: true, n: 3 });
    expect(sleeps).toEqual([5_000]);
    expect(used).toEqual(['k1', 'k1']);
  });

  it('LLMClient gives up at once when the wait exceeds maxRetryAfterMs', async () => {
    const { provider } = setup({
      k1: [() => rateLimit('GenerateRequestsPerDayPerProjectPerModel-FreeTier')],
    });
    const sleep = vi.fn(async () => {});
    const llm = new LLMClient({ provider, sleep });
    await expect(llm.generate(request)).rejects.toMatchObject({ kind: 'rate_limit' });
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    [{ candidates: [{ finishReason: 'MAX_TOKENS' }] }, 'max_tokens'],
    [{ candidates: [{ finishReason: 'SAFETY' }] }, 'refusal'],
    [{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }, 'refusal'],
    [{ text: 'not json' }, 'invalid_output'],
    [{ text: JSON.stringify({ ok: 'yes' }) }, 'invalid_output'],
    [{ text: undefined }, 'invalid_output'],
  ])('maps %o to %s', async (overrides, kind) => {
    const { provider } = setup({ k1: [() => okResponse(overrides)] });
    await expect(provider.generate(request, signal)).rejects.toMatchObject({ kind });
  });

  it('treats 5xx as a retryable server error without rotating keys', async () => {
    const { provider, used } = setup({
      k1: [
        () =>
          new ApiError({ status: 503, message: '{"error":{"code":503,"message":"overloaded"}}' }),
      ],
      k2: [() => okResponse()],
    });
    await expect(provider.generate(request, signal)).rejects.toMatchObject({
      kind: 'server',
      retryable: true,
    });
    expect(used).toEqual(['k1']);
  });
});

describe('helpers', () => {
  it('describeGeminiError reads RetryInfo and the quota id', () => {
    expect(
      describeGeminiError(rateLimit('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '1.5s')),
    ).toMatchObject({
      status: 429,
      retryDelayMs: 1_500,
      daily: true,
      keyRejected: false,
    });
    expect(describeGeminiError(invalidKey())).toMatchObject({ keyRejected: true });
  });

  it('thinkingFor uses budgets on 2.5 and levels on newer models', () => {
    expect(thinkingFor('gemini-2.5-flash', 'low')).toEqual({ thinkingBudget: 1_024 });
    expect(thinkingFor('gemini-3.8-flash', 'medium')).toEqual({ thinkingLevel: 'MEDIUM' });
  });

  it('toGeminiJsonSchema keeps structure and drops noise', () => {
    expect(toGeminiJsonSchema(schema)).toEqual({
      type: 'object',
      properties: { ok: { type: 'boolean' }, n: { type: 'integer' } },
      required: ['ok', 'n'],
      additionalProperties: false,
    });
  });

  it('msUntilPacificMidnight is never zero', () => {
    expect(msUntilPacificMidnight(Date.UTC(2026, 9, 2, 6, 59, 59))).toBe(60_000); // 23:59:59 PDT
  });

  it('parseKeyList splits on commas and whitespace and the pool dedupes', () => {
    const keys = parseKeyList('a, b;c\n d', 'a');
    expect(keys).toEqual(['a', 'b', 'c', 'd', 'a']);
    expect(new ApiKeyPool(keys).size).toBe(4);
    expect(() => new ApiKeyPool([' '])).toThrow('at least one');
  });

  it('createLLMFromEnv builds a free-tier Gemini client with zero cost', async () => {
    const { llm, provider } = createLLMFromEnv({ GEMINI_API_KEYS: 'a,b' });
    expect(provider).toBe('gemini');
    expect(llm.providerName).toBe('gemini');
    expect(() => createLLMFromEnv({})).toThrow('GEMINI_API_KEYS');
    expect(() => createLLMFromEnv({ LLM_PROVIDER: 'anthropic' })).toThrow('ANTHROPIC_API_KEY');
  });
});
