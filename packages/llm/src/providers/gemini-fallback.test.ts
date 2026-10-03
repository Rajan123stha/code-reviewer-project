import { ApiError } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GeminiProvider } from './gemini.js';

const schema = z.object({ ok: z.boolean() });
const request = {
  model: 'gemini-3.8-flash',
  fallbackModels: ['gemini-3.5-flash'],
  system: 'sys',
  prompt: 'p',
  schema,
  schemaName: 's/v1',
  maxOutputTokens: 1_000,
};
const signal = new AbortController().signal;

const apiError = (status: number, message: string, details: unknown[] = []) =>
  new ApiError({ status, message: JSON.stringify({ error: { code: status, message, details } }) });
const overloaded = () => apiError(503, 'This model is currently experiencing high demand.');
const retired = () => apiError(404, 'This model is no longer available to new users.');
const dailyQuota = () =>
  apiError(429, 'quota', [
    { violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
  ]);
const ok = (model: string) => () => ({
  text: JSON.stringify({ ok: true }),
  candidates: [{ finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
  modelVersion: model,
});

/** Two keys; replies are scripted per model. */
function setup(script: Record<string, (() => unknown)[]>) {
  const used: string[] = [];
  const skipped: string[] = [];
  const provider = new GeminiProvider({
    apiKeys: ['k1', 'k2'],
    onModelEvent: (e) => skipped.push(`${e.model}->${e.next}`),
    clientFor: () => ({
      models: {
        generateContent: vi.fn(async (params: unknown) => {
          const model = (params as { model: string }).model;
          used.push(model);
          const next = script[model]?.shift();
          if (!next) throw new Error(`no scripted reply for ${model}`);
          const out = next();
          if (out instanceof Error) throw out;
          return out as never;
        }),
      },
    }),
  });
  return { provider, used, skipped };
}

describe('GeminiProvider model fallback', () => {
  it('moves to the next model when the first is overloaded, and flags the fallback', async () => {
    const t = setup({
      'gemini-3.8-flash': [overloaded],
      'gemini-3.5-flash': [ok('gemini-3.5-flash')],
    });
    const res = await t.provider.generate(request, signal);
    expect(t.used).toEqual(['gemini-3.8-flash', 'gemini-3.5-flash']);
    expect(res).toMatchObject({ servedModel: 'gemini-3.5-flash', fallbackUsed: true });
    expect(t.skipped).toEqual(['gemini-3.8-flash->gemini-3.5-flash']);
  });

  it('does not flag a fallback when the primary model answers', async () => {
    const t = setup({ 'gemini-3.8-flash': [ok('gemini-3.8-flash')] });
    const res = await t.provider.generate(request, signal);
    expect(res).toMatchObject({ servedModel: 'gemini-3.8-flash', fallbackUsed: false });
  });

  it('moves on when a model is unavailable to the account', async () => {
    const t = setup({
      'gemini-3.8-flash': [retired],
      'gemini-3.5-flash': [ok('gemini-3.5-flash')],
    });
    await expect(t.provider.generate(request, signal)).resolves.toMatchObject({
      fallbackUsed: true,
    });
  });

  it('tracks quota per model: an exhausted model does not block the fallback', async () => {
    const t = setup({
      'gemini-3.8-flash': [dailyQuota, dailyQuota],
      'gemini-3.5-flash': [ok('gemini-3.5-flash'), ok('gemini-3.5-flash')],
    });
    await t.provider.generate(request, signal);
    // Both keys were tried on the first model before falling back.
    expect(t.used).toEqual(['gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.5-flash']);
    expect(
      t.provider
        .poolFor('gemini-3.5-flash')
        .status()
        .map((k) => k.state),
    ).toEqual(['ready', 'ready']);

    // While the first model's keys cool down it is skipped without another request.
    await t.provider.generate(request, signal);
    expect(t.used.slice(3)).toEqual(['gemini-3.5-flash']);
  });

  it('does not fall back for a bad request', async () => {
    const t = setup({
      'gemini-3.8-flash': [() => apiError(400, 'Invalid JSON schema')],
      'gemini-3.5-flash': [ok('gemini-3.5-flash')],
    });
    await expect(t.provider.generate(request, signal)).rejects.toMatchObject({
      kind: 'bad_request',
    });
    expect(t.used).toEqual(['gemini-3.8-flash']);
  });

  it('fails as a retryable error when every model is overloaded', async () => {
    const t = setup({ 'gemini-3.8-flash': [overloaded], 'gemini-3.5-flash': [overloaded] });
    await expect(t.provider.generate(request, signal)).rejects.toMatchObject({
      kind: 'server',
      retryable: true,
    });
  });

  it('reports the wait when every model is out of quota', async () => {
    const t = setup({
      'gemini-3.8-flash': [dailyQuota, dailyQuota],
      'gemini-3.5-flash': [dailyQuota, dailyQuota],
    });
    const error = await t.provider.generate(request, signal).catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: 'rate_limit' });
    expect((error as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
  });
});
