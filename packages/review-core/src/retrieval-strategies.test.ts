import type { FixCommit } from '@reviewlens/context-engine';
import { EmbeddingClient, FakeEmbeddingProvider, FakeProvider, LLMClient } from '@reviewlens/llm';
import { describe, expect, it } from 'vitest';
import { configHash, PRESETS, type StrategyConfig } from './config.js';
import { memorySnapshot, type ReviewInput } from './input.js';
import { runReview } from './pipeline.js';

const FILES: Record<string, string> = {
  'src/coupon.ts': `export function applyCoupon(sum: number, pct: number): number {
  const discount = sum * pct;
  return sum - discount;
}
`,
  'src/voucher.ts': `export function applyVoucher(sum: number, pct: number): number {
  const discount = (sum * pct) / 100;
  return sum - discount;
}
`,
  'src/server.ts': `export function listen(port: number) {
  const server = createServer();
  return server.listen(port);
}
`,
  'CONTRIBUTING.md':
    '# Contributing\n- Always add a regression test for bug fixes.\n- Never use floating point for money.\n',
  'tsconfig.json': '{ "compilerOptions": { "strict": true } }',
};

const DIFF = `diff --git a/src/coupon.ts b/src/coupon.ts
--- a/src/coupon.ts
+++ b/src/coupon.ts
@@ -1,4 +1,4 @@
 export function applyCoupon(sum: number, pct: number): number {
-  const discount = (sum * pct) / 100;
+  const discount = sum * pct;
   return sum - discount;
 }
`;

const HISTORY: FixCommit[] = [
  {
    sha: 'a'.repeat(40),
    committedAt: '2026-05-01T10:00:00Z',
    summary: 'Fix coupon percent applied as a fraction',
    files: ['src/coupon.ts'],
  },
  {
    sha: 'b'.repeat(40),
    committedAt: '2026-04-01T10:00:00Z',
    summary: 'Fix port parsing',
    files: ['lib/net.ts'],
  },
];

function input(extra: Partial<ReviewInput> = {}): ReviewInput {
  return {
    pr: {
      owner: 'o',
      repo: 'r',
      number: 1,
      title: 'Simplify discount',
      body: null,
      baseSha: 'b',
      headSha: 'h',
    },
    diff: DIFF,
    head: memorySnapshot('h', FILES),
    ...extra,
  };
}

async function run(config: StrategyConfig, extra: Partial<ReviewInput> = {}) {
  const provider = new FakeProvider(() => ({ comments: [] }));
  const embedProvider = new FakeEmbeddingProvider();
  const result = await runReview(input(extra), config, {
    llm: new LLMClient({ provider }),
    embeddings: new EmbeddingClient({ provider: embedProvider }),
  });
  return {
    prompt: provider.requests[0]!.prompt,
    system: provider.requests[0]!.system,
    run: result,
    embedProvider,
  };
}

describe('S2: embedding retrieval', () => {
  it('adds the most similar code, most similar first, and never the changed code itself', async () => {
    const { prompt, run: r } = await run({ ...PRESETS.S2, embeddingDimensions: 256 });
    const included = r.context.embeddings!.included.map((s) => s.name);
    expect(included).toEqual(['src/voucher.ts:applyVoucher', 'src/server.ts:listen']);
    expect(included).not.toContain('src/coupon.ts:applyCoupon');
    expect(prompt).toMatch(
      /<symbol path="src\/voucher.ts" name="applyVoucher" kind="function" lines="1-4" relation="similar to the changed code \(similarity 0\.\d\d\)">/,
    );
    expect(r.context.embeddings).toMatchObject({ chunks: 2, queries: 1, embedded: 3 });
    expect(r.context.symbols).toBeUndefined();
  });

  it('honors embeddingTopK and the token budget', async () => {
    const top1 = await run({ ...PRESETS.S2, embeddingDimensions: 256, embeddingTopK: 1 });
    expect(top1.run.context.embeddings!.included.map((s) => s.name)).toEqual([
      'src/voucher.ts:applyVoucher',
    ]);

    const tight = await run({ ...PRESETS.S2, embeddingDimensions: 256, contextTokenBudget: 120 });
    expect(tight.run.context.estimatedTokens).toBeLessThanOrEqual(120);
  });

  it('sends scrubbed code to the embedding provider', async () => {
    const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    const files = {
      ...FILES,
      'src/voucher.ts': FILES['src/voucher.ts']!.replace('/ 100;', `/ 100; // ${key}`),
    };
    const { embedProvider } = await run(
      { ...PRESETS.S2, embeddingDimensions: 64 },
      { head: memorySnapshot('h', files) },
    );
    const sent = embedProvider.requests.flatMap((r) => r.texts).join('\n');
    expect(sent).not.toContain(key);
    expect(sent).toContain('[REDACTED:aws-access-key]');
  });

  it('requires an embedding client', async () => {
    const llm = new LLMClient({ provider: new FakeProvider(() => ({ comments: [] })) });
    await expect(runReview(input(), PRESETS.S2, { llm })).rejects.toThrow('embedding client');
  });
});

describe('S5: conventions and past bugs', () => {
  it('adds conventions and overlapping past fixes on top of call-graph context', async () => {
    const { prompt, system, run: r } = await run(PRESETS.S5, { fixCommits: async () => HISTORY });
    expect(prompt).toContain(
      '<conventions>\n- Always add a regression test for bug fixes. (CONTRIBUTING.md)\n- Never use floating point for money. (CONTRIBUTING.md)\n- TypeScript compiler checks enabled: strict. Code must type-check under them. (tsconfig.json)\n</conventions>',
    );
    expect(prompt).toContain(
      '<past_bugs>\n- 2026-05-01 aaaaaaa: Fix coupon percent applied as a fraction (touched src/coupon.ts)\n</past_bugs>',
    );
    expect(prompt).toContain('<symbol path="src/coupon.ts" name="applyCoupon"');
    expect(system).toContain('<past_bugs>');
    expect(r.context.conventions).toMatchObject({ found: 3, included: 3 });
    expect(r.context.pastBugs).toMatchObject({
      available: true,
      history: 2,
      matched: 1,
      included: 1,
    });
    expect(r.context.embeddings).toBeUndefined();
  });

  it('each source can be switched off on its own (ablation E7)', async () => {
    const noBugs = await run(
      { ...PRESETS.S5, usePastBugs: false },
      { fixCommits: async () => HISTORY },
    );
    expect(noBugs.prompt).toContain('<conventions>');
    expect(noBugs.prompt).not.toContain('<past_bugs>');
    expect(noBugs.run.context.pastBugs).toBeUndefined();

    const noConventions = await run(
      { ...PRESETS.S5, useConventions: false },
      { fixCommits: async () => HISTORY },
    );
    expect(noConventions.prompt).not.toContain('<conventions>');
    expect(noConventions.prompt).toContain('<past_bugs>');
    expect(configHash({ ...PRESETS.S5, usePastBugs: false })).not.toBe(configHash(PRESETS.S5));
  });

  it('reports missing history instead of failing', async () => {
    const { prompt, run: r } = await run(PRESETS.S5);
    expect(prompt).not.toContain('<past_bugs>');
    expect(r.context.pastBugs).toMatchObject({ available: false, included: 0 });
  });

  it('caps the supplements and stays inside the budget', async () => {
    const capped = await run(
      { ...PRESETS.S5, conventionsTokenCap: 40 },
      { fixCommits: async () => HISTORY },
    );
    expect(capped.run.context.conventions).toMatchObject({ found: 3, included: 1 });
    const tight = await run(
      { ...PRESETS.S5, contextTokenBudget: 150 },
      { fixCommits: async () => HISTORY },
    );
    expect(tight.run.context.estimatedTokens).toBeLessThanOrEqual(150);
  });

  it('S4 and S5 differ only by the supplements', async () => {
    const s4 = await run(PRESETS.S4);
    const s5 = await run(PRESETS.S5);
    expect(s5.run.context.symbols!.included).toEqual(s4.run.context.symbols!.included);
  });
});
