import { parseUnifiedDiff } from '@reviewlens/github';
import { FakeProvider, LLMClient } from '@reviewlens/llm';
import { describe, expect, it } from 'vitest';
import { PRESETS } from './config.js';
import { comment, sampleInput } from './fixtures.js';
import { runReview } from './pipeline.js';
import { DEFAULT_POLICY, globToRegExp, parsePolicy, PolicyMatcher } from './policy.js';
import { changedNear, touchedOldLines } from './resolution.js';

const llmWith = (comments: unknown[]) =>
  new LLMClient({
    provider: new FakeProvider(() => ({ comments })),
    sleep: () => Promise.resolve(),
  });

describe('parsePolicy', () => {
  it('uses defaults when the file is missing or empty', () => {
    expect(parsePolicy(null)).toEqual({ policy: DEFAULT_POLICY, errors: [] });
    expect(parsePolicy('  \n')).toEqual({ policy: DEFAULT_POLICY, errors: [] });
    expect(parsePolicy('# nothing set\n')).toEqual({ policy: DEFAULT_POLICY, errors: [] });
  });

  it('reads every setting', () => {
    const { policy, errors } = parsePolicy(
      [
        'enabled: true',
        'max_comments: 3',
        'min_severity: medium',
        'categories: [bug, security]',
        'ignore:',
        '  - "docs/**"',
        '  - "*.generated.ts"',
      ].join('\n'),
    );
    expect(errors).toEqual([]);
    expect(policy).toEqual({
      enabled: true,
      maxComments: 3,
      minSeverity: 'medium',
      categories: ['bug', 'security'],
      ignore: ['docs/**', '*.generated.ts'],
    });
  });

  it('ignores the whole file when any part of it is wrong', () => {
    const typo = parsePolicy('min_severity: medium\nmax_coments: 3\n');
    expect(typo.policy).toEqual(DEFAULT_POLICY);
    expect(typo.errors.join(' ')).toContain('max_coments');

    expect(parsePolicy('min_severity: urgent').errors[0]).toContain('min_severity');
    expect(parsePolicy('max_comments: 0').errors).toHaveLength(1);
    expect(parsePolicy('- just\n- a list').policy).toEqual(DEFAULT_POLICY);
    expect(parsePolicy('enabled: [unclosed').errors[0]).toContain('not valid YAML');
    expect(parsePolicy(`ignore: ["${'x'.repeat(30_000)}"]`).errors[0]).toContain('larger than');
  });
});

describe('globToRegExp', () => {
  const matches = (glob: string, path: string) => globToRegExp(glob).test(path);

  it('matches like .gitignore', () => {
    expect(matches('docs/**', 'docs/a/b.md')).toBe(true);
    expect(matches('docs/', 'docs/a/b.md')).toBe(true);
    expect(matches('docs/**', 'src/docs/a.md')).toBe(false);
    expect(matches('*.generated.ts', 'src/api/client.generated.ts')).toBe(true);
    expect(matches('*.generated.ts', 'src/api/client.ts')).toBe(false);
    expect(matches('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/*.ts', 'src/deep/a.ts')).toBe(false);
    expect(matches('src/**/*.test.ts', 'src/a.test.ts')).toBe(true);
    expect(matches('src/**/*.test.ts', 'src/x/y/a.test.ts')).toBe(true);
    expect(matches('file?.js', 'file1.js')).toBe(true);
    expect(matches('a.b', 'aXb')).toBe(false);
  });
});

describe('policy in the pipeline', () => {
  const loop = comment({ severity: 'high' });
  const discount = comment({
    severity: 'low',
    category: 'maintainability',
    line: 15,
    claim: 'Discount no longer divides by 100.',
    evidence: 'return sum - sum * pct;',
  });

  it('suppresses comments below the minimum severity or outside the categories', async () => {
    const bySeverity = await runReview(
      sampleInput({ policy: { ...DEFAULT_POLICY, minSeverity: 'medium' } }),
      PRESETS.S0,
      { llm: llmWith([loop, discount]) },
    );
    expect(bySeverity.candidates.map((c) => c.status)).toEqual(['selected', 'suppressed']);
    expect(bySeverity.selected).toHaveLength(1);
    expect(bySeverity.policy.minSeverity).toBe('medium');

    const byCategory = await runReview(
      sampleInput({ policy: { ...DEFAULT_POLICY, categories: ['maintainability'] } }),
      PRESETS.S0,
      { llm: llmWith([loop, discount]) },
    );
    expect(byCategory.candidates.map((c) => c.status)).toEqual(['suppressed', 'selected']);
  });

  it('caps comments at the lower of the policy and the strategy', async () => {
    const run = await runReview(
      sampleInput({ policy: { ...DEFAULT_POLICY, maxComments: 1 } }),
      PRESETS.S0,
      { llm: llmWith([loop, discount]) },
    );
    expect(run.candidates.map((c) => c.status)).toEqual(['selected', 'over_cap']);
  });

  it('leaves ignored paths out of the prompt and makes no call when nothing is left', async () => {
    const provider = new FakeProvider(() => ({ comments: [loop] }));
    const run = await runReview(
      sampleInput({ policy: { ...DEFAULT_POLICY, ignore: ['src/**'] } }),
      PRESETS.S0,
      { llm: new LLMClient({ provider }) },
    );
    expect(run.llm).toBeNull();
    expect(provider.requests).toHaveLength(0);
    expect(run.context.diffFiles.included).toEqual([]);
  });

  it('with no policy behaves as before', async () => {
    const run = await runReview(sampleInput(), PRESETS.S0, { llm: llmWith([loop, discount]) });
    expect(run.policy).toEqual(DEFAULT_POLICY);
    expect(run.candidates.every((c) => c.status === 'selected')).toBe(true);
  });

  it('matcher treats severity as a floor', () => {
    const matcher = new PolicyMatcher({ ...DEFAULT_POLICY, minSeverity: 'high' });
    expect(matcher.allows({ category: 'bug', severity: 'critical' })).toBe(true);
    expect(matcher.allows({ category: 'bug', severity: 'high' })).toBe(true);
    expect(matcher.allows({ category: 'bug', severity: 'medium' })).toBe(false);
  });
});

describe('changedNear', () => {
  // A later push to a 20-line file: rewrites line 8, inserts after line 14, deletes old.ts.
  const later = parseUnifiedDiff(`diff --git a/src/cart.ts b/src/cart.ts
index 1..2 100644
--- a/src/cart.ts
+++ b/src/cart.ts
@@ -7,3 +7,3 @@
 let sum = 0;
-for (let i = 0; i <= items.length; i++) {
+for (let i = 0; i < items.length; i++) {
 sum += items[i].price;
@@ -13,3 +13,4 @@
 }

+// note
 export function discount() {
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 1..0
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const a = 1;
-export const b = 2;
`);

  it('finds the old-side lines a diff touched', () => {
    expect(touchedOldLines(later).get('src/cart.ts')).toEqual([8, 14]);
  });

  it('is true within the tolerance of a rewritten or inserted line', () => {
    expect(changedNear(later, { file: 'src/cart.ts', line: 8 })).toBe(true);
    expect(changedNear(later, { file: 'src/cart.ts', line: 5 })).toBe(true);
    expect(changedNear(later, { file: 'src/cart.ts', line: 4 })).toBe(false);
    expect(changedNear(later, { file: 'src/cart.ts', line: 17 })).toBe(true);
    expect(changedNear(later, { file: 'src/cart.ts', line: 18 })).toBe(false);
    expect(changedNear(later, { file: 'src/cart.ts', line: 8 }, 0)).toBe(true);
    expect(changedNear(later, { file: 'src/cart.ts', line: 9 }, 0)).toBe(false);
  });

  it('is true for a deleted file and false for an untouched one', () => {
    expect(changedNear(later, { file: 'src/old.ts', line: 40 })).toBe(true);
    expect(changedNear(later, { file: 'src/other.ts', line: 8 })).toBe(false);
  });
});
