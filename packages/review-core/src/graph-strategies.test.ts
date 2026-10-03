import { FakeProvider, LLMClient } from '@reviewlens/llm';
import { describe, expect, it } from 'vitest';
import { PRESETS } from './config.js';
import { memorySnapshot, type ReviewInput } from './input.js';
import { runReview } from './pipeline.js';

const FILES: Record<string, string> = {
  'src/math.ts': `export function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
`,
  'src/cart.ts': `import { round } from './math.js';

export function total(prices: number[]): number {
  let sum = 0;
  for (const p of prices) sum += p;
  return round(sum, 0);
}
`,
  'src/checkout.ts': `import { total } from './cart.js';

export function charge(prices: number[]) {
  return { amount: total(prices) };
}
`,
};

const DIFF = `diff --git a/src/cart.ts b/src/cart.ts
--- a/src/cart.ts
+++ b/src/cart.ts
@@ -4,4 +4,4 @@ export function total(prices: number[]): number {
   let sum = 0;
   for (const p of prices) sum += p;
-  return round(sum);
+  return round(sum, 0);
 }
`;

function input(files = FILES): ReviewInput {
  return {
    pr: {
      owner: 'o',
      repo: 'r',
      number: 1,
      title: 'Round totals',
      body: null,
      baseSha: 'b',
      headSha: 'h',
    },
    diff: DIFF,
    head: memorySnapshot('h', files),
  };
}

async function promptFor(strategy: 'S3' | 'S4') {
  const provider = new FakeProvider(() => ({ comments: [] }));
  const llm = new LLMClient({ provider });
  const run = await runReview(input(), PRESETS[strategy], { llm });
  return { prompt: provider.requests[0]!.prompt, run };
}

describe('graph strategies', () => {
  it('S3 adds the changed function and the definitions it calls, not its callers', async () => {
    const { prompt, run } = await promptFor('S3');
    expect(prompt).toContain('<diff path="src/cart.ts"');
    expect(prompt).toContain(
      '<symbol path="src/cart.ts" name="total" kind="function" lines="3-7" relation="changed in this diff">',
    );
    expect(prompt).toContain(
      '<symbol path="src/math.ts" name="round" kind="function" lines="1-4" relation="called by total">',
    );
    expect(prompt).not.toContain('src/checkout.ts');
    expect(run.context.graph).toMatchObject({
      changedSymbols: ['src/cart.ts:total'],
      index: { filesIndexed: 3, parsed: 3 },
    });
    expect(run.context.symbols!.included.map((s) => `${s.role}:${s.name}`)).toEqual([
      'enclosing:src/cart.ts:total',
      'callee:src/math.ts:round',
    ]);
  });

  it('S4 also adds callers', async () => {
    const { prompt, run } = await promptFor('S4');
    expect(prompt).toContain(
      '<symbol path="src/checkout.ts" name="charge" kind="function" lines="3-5" relation="calls total">',
    );
    expect(run.context.symbols!.included.map((s) => s.role)).toEqual([
      'enclosing',
      'callee',
      'caller',
    ]);
  });

  it('keeps the whole context within the configured budget', async () => {
    const provider = new FakeProvider(() => ({ comments: [] }));
    const run = await runReview(
      input(),
      { ...PRESETS.S4, contextTokenBudget: 200 },
      { llm: new LLMClient({ provider }) },
    );
    expect(run.context.estimatedTokens).toBeLessThanOrEqual(200);
    expect(run.context.diffFiles.included).toEqual(['src/cart.ts']);
  });

  it('requires a snapshot that can list files', async () => {
    const llm = new LLMClient({ provider: new FakeProvider(() => ({ comments: [] })) });
    const head = { sha: 'h', readFile: (p: string) => Promise.resolve(FILES[p] ?? null) };
    await expect(runReview({ ...input(), head }, PRESETS.S3, { llm })).rejects.toThrow(
      'list files',
    );
  });

  it('validates comments the same way for every strategy', async () => {
    const comment = {
      file: 'src/cart.ts',
      line: 6,
      category: 'bug',
      severity: 'medium',
      claim: 'Rounding to 0 places drops cents from the total.',
      evidence: 'return round(sum, 0);',
      suggested_fix: null,
      confidence: 0.8,
    };
    for (const strategy of ['S0', 'S1', 'S3', 'S4'] as const) {
      const llm = new LLMClient({
        provider: new FakeProvider(() => ({
          comments: [comment, { ...comment, evidence: 'Math.round(n * f)' }],
        })),
      });
      const run = await runReview(input(), PRESETS[strategy], { llm });
      // Evidence quoted from another file (math.ts) is rejected even when S3/S4 showed it.
      expect(run.candidates.map((c) => c.status)).toEqual(['selected', 'invalid']);
    }
  });
});
