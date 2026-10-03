import { describe, expect, it } from 'vitest';
import { isFixCommit, similarPastBugs, summarizeCommit, type FixCommit } from './bug-history.js';
import { buildChunks, rankChunks } from './chunks.js';
import { extractConventions } from './conventions.js';
import { memorySource, REPO } from './fixtures.js';
import { buildRepoGraph, MemoryParseCache } from './indexer.js';

describe('buildChunks', () => {
  it('makes one chunk per function, method and multi-line declaration', async () => {
    const { graph } = await buildRepoGraph(memorySource(), new MemoryParseCache());
    const chunks = await buildChunks(graph, async (p) => REPO[p] ?? null);
    expect(chunks.map((c) => `${c.path}:${c.qualifiedName}`)).toEqual([
      'lib/legacy.js:fmt',
      'lib/legacy.js:helper',
      'src/app.tsx:App',
      'src/app.tsx:Total',
      'src/base.ts:Base.validate',
      'src/cart.ts:Line',
      'src/cart.ts:Cart.add',
      'src/cart.ts:Cart.total',
      'src/cart.ts:Cart.ok',
      'src/money.ts:round',
      'src/money.ts:Money.add',
    ]);
    const round = chunks.find((c) => c.qualifiedName === 'round')!;
    expect(round.text).toBe(
      '// src/money.ts :: round\nexport function round(n: number): number {\n  return Math.round(n * 100) / 100;\n}',
    );
  });
});

describe('rankChunks', () => {
  const chunk = (gid: number) => ({
    gid,
    path: 'p',
    qualifiedName: `s${gid}`,
    startLine: 1,
    endLine: 2,
    text: '',
  });
  it('ranks by best similarity to any query, ties by graph order', () => {
    const ranked = rankChunks(
      [chunk(0), chunk(1), chunk(2), chunk(3)],
      [
        [1, 0],
        [0, 1],
        [0.6, 0.8],
        [0, 1],
      ],
      [
        [1, 0],
        [0, 1],
      ],
    );
    expect(ranked.map((r) => [r.chunk.gid, r.score])).toEqual([
      [0, 1],
      [1, 1],
      [3, 1],
      [2, 0.8],
    ]);
  });
});

describe('extractConventions', () => {
  const files: Record<string, string> = {
    'CONTRIBUTING.md': [
      '# Contributing',
      'Thanks for helping out. We are happy you are here.',
      '',
      '## Pull requests',
      '- Always add a test for bug fixes.',
      '- Keep changes focused; avoid unrelated refactors.',
      '- See [the docs](https://example.com) and **never** commit `dist/`.',
      '- Short.',
      '',
      '```sh',
      '- must not be read from code blocks',
      '```',
      'Errors must be thrown as `HTTPError`, not plain objects.',
    ].join('\n'),
    'README.md': [
      '# Project',
      '- You should install it with npm.',
      '## Usage',
      '- Always call `init()` first.',
      '## Development',
      '- Run `npm test` before pushing.',
    ].join('\n'),
    'tsconfig.json':
      '{\n  // comment\n  "compilerOptions": { "strict": true, "noUncheckedIndexedAccess": true, "noEmit": true }\n}',
    'eslint.config.js':
      "export default [{ rules: { 'no-console': 'error', '@typescript-eslint/no-floating-promises': ['error'], 'prefer-const': 'warn', eqeqeq: 2 } }];",
    '.prettierrc': '{ "singleQuote": true }',
  };

  it('extracts rules in a fixed order with their sources', async () => {
    const conventions = await extractConventions(async (p) => files[p] ?? null);
    expect(conventions.map((c) => [c.kind, c.source, c.ruleText])).toEqual([
      ['contributing', 'CONTRIBUTING.md', 'Always add a test for bug fixes.'],
      ['contributing', 'CONTRIBUTING.md', 'Keep changes focused; avoid unrelated refactors.'],
      ['contributing', 'CONTRIBUTING.md', 'See the docs and never commit `dist/`.'],
      [
        'contributing',
        'CONTRIBUTING.md',
        'Errors must be thrown as `HTTPError`, not plain objects.',
      ],
      [
        'typescript',
        'tsconfig.json',
        'TypeScript compiler checks enabled: strict, noUncheckedIndexedAccess. Code must type-check under them.',
      ],
      [
        'lint',
        'eslint.config.js',
        'ESLint reports these rules as errors: @typescript-eslint/no-floating-promises, no-console.',
      ],
      [
        'format',
        '.prettierrc',
        'Formatting is enforced by Prettier. Do not comment on formatting.',
      ],
      ['readme', 'README.md', 'Run `npm test` before pushing.'],
    ]);
    expect(conventions[0]!.evidence).toEqual({ line: 5 });
  });

  it('returns nothing for a repository with no conventions', async () => {
    expect(await extractConventions(async () => null)).toEqual([]);
  });
});

describe('bug history', () => {
  it.each([
    ['Fix stale array entries when merging JSON objects', true],
    ['fix(parser): handle empty input', true],
    ['Resolve crash when body is null', true],
    ['Handle regression in retry timing', true],
    ['Fix typo in README', false],
    ['docs: fix broken link', false],
    ['chore: bump deps to fix audit', false],
    ['Add maxResponseSize option', false],
    ['fix: lint errors', false],
    ['Merge pull request #12 from x/fix-thing', false],
  ])('isFixCommit(%s) = %s', (message, expected) => {
    expect(isFixCommit(message)).toBe(expected);
  });

  it('summarizes with the first meaningful body line', () => {
    expect(
      summarizeCommit('Fix retry\n\nCo-authored-by: X\nThe timer was never cleared.\nMore.'),
    ).toBe('Fix retry — The timer was never cleared.');
    expect(summarizeCommit('Fix retry')).toBe('Fix retry');
  });

  const fix = (sha: string, committedAt: string, files: string[]): FixCommit => ({
    sha,
    committedAt,
    summary: sha,
    files,
  });
  it('ranks past fixes by file overlap, then directory, then recency', () => {
    const history = [
      fix('old-same-file', '2026-01-01T00:00:00Z', ['src/merge.ts']),
      fix('new-same-file', '2026-06-01T00:00:00Z', ['src/merge.ts', 'test/merge.ts']),
      fix('same-dir', '2026-07-01T00:00:00Z', ['src/other.ts']),
      fix('both-files', '2026-02-01T00:00:00Z', ['src/merge.ts', 'src/retry.ts']),
      fix('unrelated', '2026-08-01T00:00:00Z', ['docs/x.md']),
      fix(
        'huge',
        '2026-08-01T00:00:00Z',
        Array.from({ length: 40 }, (_, i) => (i ? `f${i}` : 'src/merge.ts')),
      ),
    ];
    const result = similarPastBugs(history, ['src/merge.ts', 'src/retry.ts'], 4);
    expect(result.map((r) => [r.sha, r.score])).toEqual([
      ['both-files', 2],
      ['new-same-file', 1],
      ['old-same-file', 1],
      ['same-dir', 0.25],
    ]);
    expect(result[0]!.sharedFiles).toEqual(['src/merge.ts', 'src/retry.ts']);
  });
});
