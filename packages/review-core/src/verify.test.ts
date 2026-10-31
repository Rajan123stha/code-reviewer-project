import { FakeProvider, LLMClient, type GenerateRequest } from '@reviewlens/llm';
import { describe, expect, it } from 'vitest';
import { PRESETS } from './config.js';
import { FEATURES_VERSION, type CandidateFeatures } from './features.js';
import type { CommentScorer } from './filter.js';
import { comment, sampleInput } from './fixtures.js';
import { runReview } from './pipeline.js';
import { REVIEW_SCHEMA_NAME } from './schema.js';
import { VERIFY_SCHEMA_NAME } from './verify.js';

const loop = comment({ severity: 'high' });
const discount = comment({
  severity: 'medium',
  line: 15,
  claim: 'Discount no longer divides by 100.',
  evidence: 'return sum - sum * pct;',
});
const style = comment({
  severity: 'low',
  category: 'maintainability',
  line: 9,
  claim: 'Prefer for...of here.',
  evidence: 'sum += items[i].price * items[i].qty;',
});

type Verdicts = { id: number; verdict: 'upheld' | 'refuted' | 'uncertain'; reason: string }[];

/** Reviewer returns `comments`; each verifier pass returns the next entry of `passes`. */
function setup(comments: unknown[], passes: Verdicts[]) {
  let pass = 0;
  const provider = new FakeProvider((req: GenerateRequest<unknown>) =>
    req.schemaName === VERIFY_SCHEMA_NAME ? { verdicts: passes[pass++] ?? [] } : { comments },
  );
  return { provider, llm: new LLMClient({ provider, sleep: () => Promise.resolve() }) };
}

describe('verifier pass', () => {
  it('drops comments it refutes and keeps the rest in order', async () => {
    // Unique comments reach the verifier in priority order: loop (high), discount, style.
    const { llm, provider } = setup(
      [style, loop, discount],
      [
        [
          { id: 0, verdict: 'upheld', reason: 'i <= length reads past the end' },
          { id: 1, verdict: 'uncertain', reason: 'depends on how pct is passed' },
          { id: 2, verdict: 'refuted', reason: 'style preference' },
        ],
      ],
    );
    const run = await runReview(sampleInput(), { ...PRESETS.S0, verifierPasses: 1 }, { llm });

    expect(run.candidates.map((c) => [c.index, c.status, c.verifierAgreement])).toEqual([
      [0, 'refuted', 0],
      [1, 'selected', 1],
      [2, 'selected', 0.5],
    ]);
    expect(run.selected.map((c) => c.index)).toEqual([1, 2]);
    expect(run.candidates[0]!.verifierVerdicts).toEqual([
      { verdict: 'refuted', reason: 'style preference' },
    ]);
    expect(run.verifier).toMatchObject({
      promptVersion: 'verify/v1',
      passes: 1,
      threshold: 0.5,
      verified: 3,
      refuted: 1,
    });
    expect(run.verifier!.calls).toHaveLength(1);
    // The verifier sees the reviewer's context and the comments, numbered by id.
    const request = provider.requests.find((r) => r.schemaName === VERIFY_SCHEMA_NAME)!;
    expect(request.prompt).toContain('<diff path="src/cart.ts"');
    expect(request.prompt).toContain('<comment id="2">');
    expect(request.prompt).toContain('Prefer for...of here.');
    // Features carry the agreement, for the filter.
    expect(run.candidates[2]!.features?.verifierAgreement).toBe(0.5);
  });

  it('averages passes, each as an independent sample, and treats missing verdicts as uncertain', async () => {
    const { llm, provider } = setup(
      [loop, discount],
      [
        [
          { id: 0, verdict: 'upheld', reason: 'a' },
          { id: 1, verdict: 'refuted', reason: 'b' },
        ],
        [
          { id: 0, verdict: 'refuted', reason: 'c' },
          { id: 7, verdict: 'upheld', reason: 'no such id' },
        ],
        [
          { id: 0, verdict: 'upheld', reason: 'd' },
          { id: 0, verdict: 'refuted', reason: 'repeat is ignored' },
          { id: 1, verdict: 'refuted', reason: 'e' },
        ],
      ],
    );
    const run = await runReview(
      sampleInput(),
      { ...PRESETS.S0, verifierPasses: 3, verifierThreshold: 0.6 },
      { llm, cacheSalt: 'run-1' },
    );
    // loop: upheld, refuted, upheld = 2/3. discount: refuted, (missing = 0.5), refuted = 1/6.
    expect(run.candidates.map((c) => c.verifierAgreement)).toEqual([2 / 3, 1 / 6]);
    expect(run.candidates.map((c) => c.status)).toEqual(['selected', 'refuted']);
    const salts = provider.requests
      .filter((r) => r.schemaName === VERIFY_SCHEMA_NAME)
      .map((r) => r.cacheSalt);
    expect(salts).toEqual(['run-1|verify-0', 'run-1|verify-1', 'run-1|verify-2']);
  });

  it('makes no extra call when off or when nothing survived validation', async () => {
    const off = setup([loop], []);
    await runReview(sampleInput(), PRESETS.S0, { llm: off.llm });
    expect(off.provider.requests.map((r) => r.schemaName)).toEqual([REVIEW_SCHEMA_NAME]);

    const empty = setup([comment({ line: 3, evidence: 'qty: number;' })], []);
    const run = await runReview(
      sampleInput(),
      { ...PRESETS.S0, verifierPasses: 2 },
      { llm: empty.llm },
    );
    expect(empty.provider.requests).toHaveLength(1);
    expect(run.verifier).toBeNull();
  });

  it('runs before the filter, which scores only what the verifier kept', async () => {
    const { llm } = setup(
      [loop, discount],
      [
        [
          { id: 0, verdict: 'upheld', reason: 'a' },
          { id: 1, verdict: 'refuted', reason: 'b' },
        ],
      ],
    );
    const seen: CandidateFeatures[][] = [];
    const scorer: CommentScorer = {
      score: (items) => {
        seen.push([...items]);
        return Promise.resolve({
          modelVersion: 'm',
          featuresVersion: FEATURES_VERSION,
          scores: items.map(() => 0.9),
        });
      },
    };
    const run = await runReview(
      sampleInput(),
      { ...PRESETS.S0, verifierPasses: 1, filterThreshold: 0.5 },
      { llm, scorer },
    );
    expect(seen[0]!.map((f) => f.severity)).toEqual(['high']);
    expect(run.filter).toMatchObject({ scored: 1, dropped: 0 });
    expect(run.candidates.map((c) => c.status)).toEqual(['selected', 'refuted']);
  });
});
