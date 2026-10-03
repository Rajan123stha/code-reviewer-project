import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeProvider, LLMClient } from '@reviewlens/llm';
import { describe, expect, it } from 'vitest';
import { configHash, PRESETS, strategyConfigSchema } from './config.js';
import { FEATURES_VERSION, isTestPath, type CandidateFeatures } from './features.js';
import { HttpCommentScorer, type CommentScorer } from './filter.js';
import { comment, sampleInput } from './fixtures.js';
import { runReview } from './pipeline.js';

const llmWith = (comments: unknown[]) =>
  new LLMClient({
    provider: new FakeProvider(() => ({ comments })),
    sleep: () => Promise.resolve(),
  });

/** Scores by the model's confidence, so tests can steer scores through the comment. */
function confidenceScorer(modelVersion = 'test-1'): CommentScorer & {
  seen: CandidateFeatures[][];
} {
  const seen: CandidateFeatures[][] = [];
  return {
    seen,
    score: (items) => {
      seen.push([...items]);
      return Promise.resolve({
        modelVersion,
        featuresVersion: FEATURES_VERSION,
        scores: items.map((f) => f.confidence),
      });
    },
  };
}

const loop = comment({ severity: 'low', confidence: 0.9 });
const discount = comment({
  severity: 'critical',
  line: 15,
  claim: 'Discount no longer divides by 100.',
  evidence: 'return sum - sum * pct;',
  suggested_fix: null,
  confidence: 0.4,
});
const loopAgain = comment({
  severity: 'low',
  confidence: 0.6,
  claim: 'Loop runs one past the end of items, so .price throws.',
});

describe('candidate features', () => {
  it('describes each valid candidate from the diff, and leaves invalid ones without', async () => {
    const run = await runReview(sampleInput(), PRESETS.S0, {
      llm: llmWith([loop, discount, loopAgain, comment({ line: 3, evidence: 'qty: number;' })]),
    });

    expect(run.featuresVersion).toBe(FEATURES_VERSION);
    expect(run.candidates[0]!.features).toEqual({
      category: 'bug',
      severity: 'low',
      confidence: 0.9,
      claimChars: loop.claim.length,
      evidenceLines: 1,
      hasFix: true,
      evidenceInAddedLines: true,
      fileExt: 'ts',
      isTest: false,
      lineIsAdded: true,
      fileChangedLines: 4,
      prChangedLines: 4,
      prFiles: 1,
      symbolCallers: null,
      strategy: 'S0',
      duplicateClusterSize: 2,
      candidatesInReview: 2,
      verifierAgreement: null,
      repoCategoryAcceptRate: null,
    } satisfies CandidateFeatures);
    expect(run.candidates[1]!.features).toMatchObject({ hasFix: false, duplicateClusterSize: 1 });
    // The duplicate shares its cluster's size; the invalid candidate has no features.
    expect(run.candidates[2]!.features).toMatchObject({ duplicateClusterSize: 2 });
    expect(run.candidates[3]!.features).toBeNull();
    expect(run.filter).toBeNull();
    expect(run.candidates.every((c) => c.filterScore === null)).toBe(true);
  });

  it('recognizes test files', () => {
    expect(isTestPath('test/cart.js')).toBe(true);
    expect(isTestPath('src/__tests__/cart.ts')).toBe(true);
    expect(isTestPath('src/cart.spec.tsx')).toBe(true);
    expect(isTestPath('src/contest/cart.ts')).toBe(false);
    expect(isTestPath('src/latest.ts')).toBe(false);
  });
});

describe('learned filter step', () => {
  it('drops comments below the threshold and ranks the rest by score', async () => {
    const scorer = confidenceScorer();
    const config = { ...PRESETS.S0, filterThreshold: 0.5 };
    const run = await runReview(sampleInput(), config, {
      llm: llmWith([loop, discount, loopAgain]),
      scorer,
    });

    expect(run.candidates.map((c) => [c.status, c.rank, c.filterScore])).toEqual([
      ['selected', 1, 0.9],
      ['filtered', null, 0.4],
      ['duplicate', null, null],
    ]);
    expect(run.selected.map((c) => c.index)).toEqual([0]);
    expect(run.filter).toEqual({ modelVersion: 'test-1', threshold: 0.5, scored: 2, dropped: 1 });
    // Only valid, unique candidates are sent for scoring, in severity order.
    expect(scorer.seen).toHaveLength(1);
    expect(scorer.seen[0]!.map((f) => f.severity)).toEqual(['critical', 'low']);
  });

  it('at threshold 0 keeps everything and only re-ranks', async () => {
    const off = await runReview(sampleInput(), PRESETS.S0, { llm: llmWith([loop, discount]) });
    const on = await runReview(
      sampleInput(),
      { ...PRESETS.S0, filterThreshold: 0 },
      { llm: llmWith([loop, discount]), scorer: confidenceScorer() },
    );
    // Without the filter the critical comment leads; with it, the higher score leads.
    expect(off.selected.map((c) => c.index)).toEqual([1, 0]);
    expect(on.selected.map((c) => c.index)).toEqual([0, 1]);
    expect(on.filter?.dropped).toBe(0);
  });

  it('does not call the scorer when the filter is off', async () => {
    const scorer = confidenceScorer();
    await runReview(sampleInput(), PRESETS.S0, { llm: llmWith([loop]), scorer });
    expect(scorer.seen).toHaveLength(0);
  });

  it('fails instead of posting unfiltered when the filter is on but cannot run', async () => {
    const config = { ...PRESETS.S0, filterThreshold: 0.5 };
    await expect(runReview(sampleInput(), config, { llm: llmWith([loop]) })).rejects.toThrow(
      /no filter scorer/,
    );
    const failing: CommentScorer = { score: () => Promise.reject(new Error('service down')) };
    await expect(
      runReview(sampleInput(), config, { llm: llmWith([loop]), scorer: failing }),
    ).rejects.toThrow(/service down/);
  });

  it('rejects a scorer serving another model or feature version than expected', async () => {
    await expect(
      runReview(
        sampleInput(),
        { ...PRESETS.S0, filterThreshold: 0.5, filterModel: 'lr-pinned' },
        { llm: llmWith([loop]), scorer: confidenceScorer('lr-other') },
      ),
    ).rejects.toThrow(/pins filter model lr-pinned/);

    const stale: CommentScorer = {
      score: (items) =>
        Promise.resolve({
          modelVersion: 'm',
          featuresVersion: 'features/v0',
          scores: items.map(() => 0.5),
        }),
    };
    await expect(
      runReview(
        sampleInput(),
        { ...PRESETS.S0, filterThreshold: 0.5 },
        { llm: llmWith([loop]), scorer: stale },
      ),
    ).rejects.toThrow(/features\/v0/);
  });

  it('is part of the config hash and validated', () => {
    expect(configHash({ ...PRESETS.S4, filterThreshold: 0.5 })).not.toBe(configHash(PRESETS.S4));
    expect(() => strategyConfigSchema.parse({ ...PRESETS.S4, filterThreshold: 1.5 })).toThrow();
  });
});

describe('HttpCommentScorer', () => {
  it('posts features to /score and reads the scores back', async () => {
    const bodies: unknown[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw) as { items: unknown[] };
        bodies.push({ url: req.url, ...body });
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            model_version: 'lr-1',
            features_version: FEATURES_VERSION,
            scores: body.items.map(() => 0.25),
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const run = await runReview(
        sampleInput(),
        { ...PRESETS.S0, filterThreshold: 0.2 },
        {
          llm: llmWith([loop]),
          scorer: new HttpCommentScorer({ url: `http://127.0.0.1:${port}/` }),
        },
      );
      expect(run.selected[0]!.filterScore).toBe(0.25);
      expect(run.filter?.modelVersion).toBe('lr-1');
      expect(bodies).toEqual([
        { url: '/score', features_version: FEATURES_VERSION, items: [run.selected[0]!.features] },
      ]);
    } finally {
      server.close();
    }
  });

  it('turns an error response into a failure', async () => {
    const scorer = new HttpCommentScorer({
      url: 'http://filter.invalid',
      fetch: () => Promise.resolve(new Response('unknown features version', { status: 409 })),
    });
    await expect(scorer.score([])).rejects.toThrow(/409: unknown features version/);
  });
});
