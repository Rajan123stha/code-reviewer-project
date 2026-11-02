import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDashboard } from './app.js';
import { excerpt, type LabelPaths } from './labels.js';

type Row = Record<string, unknown>;
interface CaseBody {
  fix: { diff: string };
  truth: { lines: { n: number | null; text: string; truth: boolean }[] }[];
}

const noExperiments = { list: async () => [], read: async () => null };

let dir: string;
let paths: LabelPaths;
let intro: string;
let fix: string;

function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'labels-'));
  // A repository where one commit introduces a bug on line 3 and a later commit fixes it.
  const work = join(dir, 'work');
  await mkdir(work);
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'core.autocrlf', 'false');
  await writeFile(
    join(work, 'a.js'),
    'function f(xs) {\n  let s = 0;\n  for (const x of xs) s += x;\n  return s;\n}\n',
  );
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'add f');
  await writeFile(
    join(work, 'a.js'),
    'function f(xs) {\n  let s = 0;\n  for (let i = 0; i <= xs.length; i++) s += xs[i];\n  return s;\n}\n',
  );
  git(work, 'commit', '-q', '-am', 'refactor loop');
  intro = git(work, 'rev-parse', 'HEAD');
  await writeFile(
    join(work, 'a.js'),
    'function f(xs) {\n  let s = 0;\n  for (let i = 0; i < xs.length; i++) s += xs[i];\n  return s;\n}\n',
  );
  git(work, 'commit', '-q', '-am', 'fix: off by one');
  fix = git(work, 'rev-parse', 'HEAD');
  await mkdir(join(dir, 'repos'));
  execFileSync('git', ['clone', '-q', '--bare', work, join(dir, 'repos', 'o__a.git')]);

  const kase = {
    id: 'case-1',
    repo: 'o/a',
    head_sha: intro,
    introduced: { sha: intro, committed_at: '2026-01-01T00:00:00Z', subject: 'refactor loop' },
    fix: {
      sha: fix,
      committed_at: '2026-02-01T00:00:00Z',
      subject: 'fix: off by one',
      files: ['a.js'],
    },
    ground_truth: [{ path: 'a.js', lines: [3] }],
    stats: { days_to_fix: 31 },
    provenance: { blame_share: 1 },
  };
  const missing = { ...kase, id: 'case-2', repo: 'o/not-cloned' };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ cases: [kase, missing] }));
  await writeFile(join(dir, 'sample.json'), JSON.stringify({ case_ids: ['case-1', 'case-2'] }));
  const comments = join(dir, 'results', 'E1', 'abc', 'comments');
  await mkdir(comments, { recursive: true });
  await writeFile(
    join(comments, 'items.jsonl'),
    `${JSON.stringify({ id: 'c1', arm: 'S4', run: 1, input_key: 'o/a@x', path: 'a.js', diff: '@@ -1 +1 @@\n-a\n+b', line: 1, category: 'bug', severity: 'high', claim: 'x', evidence: 'b', suggested_fix: null })}\n`,
  );
  paths = {
    manifest: join(dir, 'manifest.json'),
    sample: join(dir, 'sample.json'),
    verdicts: join(dir, 'validation', 'verdicts.jsonl'),
    results: join(dir, 'results'),
    repos: join(dir, 'repos'),
  };
}, 60_000);
afterAll(() => rm(dir, { recursive: true, force: true }));

const app = () => buildDashboard({ store: null, experiments: noExperiments, labels: paths });
const post = (url: string, payload: unknown) =>
  app().inject({ method: 'POST', url, payload: payload as Record<string, unknown> });

describe('labeling API', { timeout: 30_000 }, () => {
  it('reports labeling mode and that there is no database', async () => {
    const a = app();
    expect((await a.inject('/api/meta')).json()).toEqual({
      demo: false,
      labeling: true,
      database: false,
    });
    expect((await a.inject('/api/overview')).statusCode).toBe(503);
  });

  it('shows a case with the fix diff and the marked lines of the introducing commit', async () => {
    const res = await app().inject('/api/labels/benchmark/case-1');
    const body = res.json<CaseBody>();
    expect(res.json<Row>()).toMatchObject({ id: 'case-1', index: 0, total: 2, previous: null });
    expect(body.fix.diff).toContain('-  for (let i = 0; i <= xs.length; i++) s += xs[i];');
    expect(body.fix.diff).toContain('+  for (let i = 0; i < xs.length; i++) s += xs[i];');
    expect(body.truth[0]!.lines.find((l) => l.n === 3)).toEqual({
      n: 3,
      text: '  for (let i = 0; i <= xs.length; i++) s += xs[i];',
      truth: true,
    });
    expect((await app().inject('/api/labels/benchmark/case-2')).statusCode).toBe(409);
    expect((await app().inject('/api/labels/benchmark/not-sampled')).statusCode).toBe(404);
  });

  it('appends verdicts in the format rlbench reads, latest wins', async () => {
    expect(
      (await post('/api/labels/benchmark/case-1', { verdict: 'maybe', labeler: 'r' })).statusCode,
    ).toBe(400);
    expect((await post('/api/labels/benchmark/case-1', { verdict: 'valid' })).statusCode).toBe(400);
    await post('/api/labels/benchmark/case-1', { verdict: 'invalid', labeler: 'rajan' });
    await post('/api/labels/benchmark/case-1', {
      verdict: 'valid',
      note: 'real bug',
      labeler: 'rajan',
    });
    const rows = (await readFile(paths.verdicts, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Row);
    expect(rows).toHaveLength(2);
    // rlbench.validation.Verdict(**row) needs exactly these keys.
    expect(Object.keys(rows[1]!).sort()).toEqual(['at', 'case_id', 'labeler', 'note', 'verdict']);
    const list = (await app().inject('/api/labels/benchmark')).json<{
      counts: Row;
      items: Row[];
    }>();
    expect(list.counts).toEqual({ valid: 1, invalid: 0, unsure: 0 });
    expect(list.items).toEqual([
      { id: 'case-1', repo: 'o/a', verdict: 'valid' },
      { id: 'case-2', repo: 'o/not-cloned', verdict: null },
    ]);
  });

  it('serves sampled comments blind and records verdicts as rlharness does', async () => {
    const sets = (await app().inject('/api/labels/comments')).json<Row[]>();
    expect(sets).toEqual([{ name: 'E1', hash: 'abc', total: 1, labeled: 0 }]);
    const items = (await app().inject('/api/labels/comments/E1/abc')).json<{ items: Row[] }>()
      .items;
    expect(items[0]).not.toHaveProperty('arm');
    expect(items[0]).not.toHaveProperty('input_key');
    expect(
      (await post('/api/labels/comments/E1/abc/nope', { verdict: 'valid', labeler: 'r' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await post('/api/labels/comments/E1/abc/c1', { verdict: 'unsure', labeler: 'r' }))
        .statusCode,
    ).toBe(400);
    await post('/api/labels/comments/E1/abc/c1', { verdict: 'nitpick', labeler: 'r' });
    const row = JSON.parse(
      await readFile(join(paths.results, 'E1', 'abc', 'comments', 'human.jsonl'), 'utf8'),
    ) as Row;
    expect(row).toMatchObject({ id: 'c1', verdict: 'nitpick', note: '', labeler: 'r' });
    expect(row.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
    expect((await app().inject('/api/labels/comments/..%2F..%2Fetc/abc')).statusCode).toBe(404);
  });

  it('labels comment-bug pairs with the fix shown and match verdicts', async () => {
    const dir = join(paths.results, 'E1', 'abc', 'matches');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'items.jsonl'),
      `${JSON.stringify({ id: 'p1', case_id: 'case-1', path: 'a.js', line: 3, category: 'bug', claim: 'reads past the end', evidence: 'i <= xs.length', fix_subject: 'fix: off by one', fix_diff: '@@ -3 +3 @@', truth_lines: [3] })}
`,
    );
    const set = (await app().inject('/api/labels/matches/E1/abc')).json<{
      verdicts: string[];
      items: Row[];
    }>();
    expect(set.verdicts).toEqual(['same_bug', 'different_issue', 'unclear']);
    expect(set.items[0]).toMatchObject({
      fix_subject: 'fix: off by one',
      truth_lines: [3],
      verdict: null,
    });
    expect(
      (await post('/api/labels/matches/E1/abc/p1', { verdict: 'valid', labeler: 'r' })).statusCode,
    ).toBe(400);
    await post('/api/labels/matches/E1/abc/p1', { verdict: 'same_bug', labeler: 'r' });
    const row = JSON.parse(await readFile(join(dir, 'human.jsonl'), 'utf8')) as Row;
    expect(row).toMatchObject({ id: 'p1', verdict: 'same_bug', labeler: 'r' });
    expect((await app().inject('/api/labels/matches')).json<Row[]>()).toEqual([
      { name: 'E1', hash: 'abc', total: 1, labeled: 1 },
    ]);
  });

  it('is absent unless enabled', async () => {
    const plain = buildDashboard({ store: null, experiments: noExperiments });
    expect((await plain.inject('/api/labels/benchmark')).statusCode).toBe(404);
  });
});

describe('excerpt', () => {
  it('shows marked lines with context and gaps between them', () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const out = excerpt(content, [2, 15], 1);
    expect(out.map((l) => l.n)).toEqual([1, 2, 3, null, 14, 15, 16]);
    expect(out.filter((l) => l.truth).map((l) => l.n)).toEqual([2, 15]);
  });
});
