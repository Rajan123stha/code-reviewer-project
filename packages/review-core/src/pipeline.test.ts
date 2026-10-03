import { FakeProvider, LLMClient, LLMError, MemoryCache } from '@reviewlens/llm';
import { describe, expect, it } from 'vitest';
import { PRESETS, type StrategyConfig } from './config.js';
import { comment, sampleInput } from './fixtures.js';
import { memorySnapshot } from './input.js';
import { runReview } from './pipeline.js';

function setup(comments: unknown[], config: StrategyConfig = PRESETS.S0) {
  const provider = new FakeProvider(() => ({ comments }));
  const llm = new LLMClient({ provider, sleep: () => Promise.resolve() });
  return { provider, llm, config };
}

describe('runReview', () => {
  it('validates, dedupes, ranks and caps model comments', async () => {
    const { llm } = setup([
      comment({
        severity: 'medium',
        line: 15,
        claim: 'Discount no longer divides by 100.',
        evidence: 'return sum - sum * pct;',
        category: 'bug',
        confidence: 0.7,
      }),
      comment(), // off-by-one, high
      comment({
        line: 8,
        claim: 'Loop runs one past the end of items, so .price throws.',
        confidence: 0.6,
      }), // duplicate
      comment({ line: 3, evidence: 'qty: number;' }), // line 3 is not in the diff
      comment({ file: 'src/other.ts' }), // file not in diff
      comment({ line: 9, evidence: 'items[i].cost' }), // evidence not in code
      comment({ file: 'pnpm-lock.yaml', line: 1, evidence: "lockfileVersion: '9.1'" }), // ignored file
    ]);

    const run = await runReview(sampleInput(), { ...PRESETS.S0, maxComments: 1 }, { llm });

    expect(run.candidates.map((c) => [c.index, c.status, c.rejectReason, c.rank])).toEqual([
      [0, 'over_cap', null, 2],
      [1, 'selected', null, 1],
      [2, 'duplicate', null, null],
      [3, 'invalid', 'line_not_in_diff', null],
      [4, 'invalid', 'file_not_in_diff', null],
      [5, 'invalid', 'evidence_not_found', null],
      [6, 'invalid', 'file_not_in_diff', null],
    ]);
    expect(run.candidates[2]!.duplicateOf).toBe(1);
    expect(run.selected.map((c) => c.index)).toEqual([1]);
    expect(run.selected[0]!.body).toContain('**Bug (high)**');
  });

  it('records config, prompt version, context stats and LLM usage', async () => {
    const { llm } = setup([]);
    const run = await runReview(sampleInput(), PRESETS.S0, { llm });

    expect(run.configHash).toMatch(/^[0-9a-f]{16}$/);
    expect(run.prompt).toEqual({
      version: PRESETS.S0.promptVersion,
      contentHash: expect.stringMatching(/^[0-9a-f]{12}$/) as unknown,
    });
    expect(run.schemaName).toBe('review-comments/v1');
    expect(run.context.diffFiles).toEqual({ included: ['src/cart.ts'], omitted: [] });
    expect(run.llm).toMatchObject({
      provider: 'fake',
      requestedModel: PRESETS.S0.model,
      cached: false,
    });
    // The fake provider echoes the requested model, which has no list price.
    expect(run.llm!.costUsd).toBeNull();
    expect(run.selected).toEqual([]);
  });

  it('sends S0 only the labeled diff, and S1 the diff plus full files', async () => {
    const s0 = setup([]);
    await runReview(sampleInput(), PRESETS.S0, { llm: s0.llm });
    const s1 = setup([]);
    await runReview(sampleInput(), PRESETS.S1, { llm: s1.llm });

    const p0 = s0.provider.requests[0]!.prompt;
    const p1 = s1.provider.requests[0]!.prompt;
    expect(p0).toContain('    R8 +  for (let i = 0; i <= items.length; i++) {');
    expect(p0).not.toContain('<file path=');
    expect(p0).not.toContain('pnpm-lock.yaml');
    expect(p1).toContain('<file path="src/cart.ts" ref="head">');
    expect(p1).toContain(' 1| export interface Item {');
    expect(s0.provider.requests[0]!.effort).toBe('high');
  });

  it('is deterministic: the same input and config produce the same prompt', async () => {
    const a = setup([]);
    const b = setup([]);
    await runReview(sampleInput(), PRESETS.S1, { llm: a.llm });
    await runReview(sampleInput(), PRESETS.S1, { llm: b.llm });
    expect(a.provider.requests[0]!.prompt).toBe(b.provider.requests[0]!.prompt);
  });

  it('scrubs secrets from the diff, files and PR text before the LLM sees them', async () => {
    const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    const diff = `diff --git a/cfg.ts b/cfg.ts
--- a/cfg.ts
+++ b/cfg.ts
@@ -1 +1 @@
-export const k = '';
+export const k = '${key}';
`;
    const { provider, llm } = setup([]);
    const run = await runReview(
      sampleInput({
        diff,
        head: memorySnapshot('x', { 'cfg.ts': `export const k = '${key}';\n` }),
        pr: { ...sampleInput().pr, body: `uses ${key}` },
      }),
      PRESETS.S1,
      { llm },
    );
    expect(provider.requests[0]!.prompt).not.toContain(key);
    expect(provider.requests[0]!.prompt).toContain('[REDACTED:aws-access-key]');
    expect(run.redactions['aws-access-key']).toBe(3);
  });

  it('skips the LLM when nothing is reviewable', async () => {
    const { provider, llm } = setup([]);
    const lockOnly = sampleInput().diff.slice(sampleInput().diff.indexOf('diff --git a/pnpm-lock'));
    const run = await runReview(sampleInput({ diff: lockOnly }), PRESETS.S0, { llm });
    expect(provider.requests).toHaveLength(0);
    expect(run.llm).toBeNull();
  });

  it('omits diffs that do not fit the budget and tells the model', async () => {
    const { provider, llm } = setup([]);
    const run = await runReview(sampleInput(), { ...PRESETS.S0, contextTokenBudget: 10 }, { llm });
    expect(run.context.diffFiles.omitted).toEqual(['src/cart.ts']);
    expect(provider.requests).toHaveLength(0);
  });

  it('uses the cache salt so repeated eval runs are separate samples', async () => {
    const provider = new FakeProvider(() => ({ comments: [] }));
    const llm = new LLMClient({ provider, cache: new MemoryCache() });
    await runReview(sampleInput(), PRESETS.S0, { llm, cacheSalt: 'run-1' });
    await runReview(sampleInput(), PRESETS.S0, { llm, cacheSalt: 'run-1' });
    await runReview(sampleInput(), PRESETS.S0, { llm, cacheSalt: 'run-2' });
    expect(provider.requests).toHaveLength(2);
  });

  it('propagates LLM refusals', async () => {
    const provider = new FakeProvider(() => new LLMError('refusal', 'declined'));
    const llm = new LLMClient({ provider });
    await expect(runReview(sampleInput(), PRESETS.S0, { llm })).rejects.toMatchObject({
      kind: 'refusal',
    });
  });

  it('rejects an invalid config before doing any work', async () => {
    const { llm } = setup([]);
    await expect(
      runReview(sampleInput(), { ...PRESETS.S0, contextTokenBudget: -1 }, { llm }),
    ).rejects.toThrow();
  });
});
