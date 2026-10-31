import { execFile } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

const run = promisify(execFile);

/**
 * Human labeling in the browser. It writes exactly the files the Python tools read, so
 * `rlbench validate` and `rlharness score` see browser labels and terminal labels alike:
 *
 * - benchmark cases: `eval/benchmark/validation/verdicts.jsonl`
 *   (rlbench.validation.Verdict: case_id, verdict, note, labeler, at)
 * - sampled comments: `eval/results/<name>/<hash>/comments/human.jsonl`
 *   (rlharness.comments.append_human: id, verdict, note, labeler, at)
 * - comment-bug pairs: `eval/results/<name>/<hash>/matches/human.jsonl` (same fields)
 *
 * Appending is the only write; the last verdict per item wins, so a labeler corrects a
 * label by labeling again. Git is used read-only on the benchmark's clones to show diffs;
 * nothing from those repositories is executed.
 */
export interface LabelPaths {
  manifest: string;
  /** The seeded validation sample: `{ case_ids: [...] }`. */
  sample: string;
  verdicts: string;
  /** `eval/results`: comment samples live under `<name>/<hash>/comments/`. */
  results: string;
  /** Bare clones made by `rlbench clone`, named `<owner>__<repo>.git`. */
  repos: string;
}

export const CASE_VERDICTS = ['valid', 'invalid', 'unsure'] as const;
export const COMMENT_VERDICTS = ['valid', 'nitpick', 'invalid'] as const;

export const MATCH_VERDICTS = ['same_bug', 'different_issue', 'unclear'] as const;

export const MATCH_GUIDE = {
  same_bug:
    'The comment describes the defect the later fix corrects, even in other words or with another fix.',
  different_issue:
    'It is about something else: another problem, style, or a nearby but different concern.',
  unclear: "The fix's purpose or the comment's meaning cannot be told from what is shown.",
};

export const CASE_GUIDE = {
  valid:
    'The marked lines of the introducing change contain (or directly cause) the defect that the fix corrects.',
  invalid:
    'The marked lines were not wrong when written: the fix is a feature, refactor, behavior or API change; the bug lives elsewhere; or blame landed on a commit that only moved or reformatted the code.',
  unsure: 'Cannot tell from the two diffs.',
};

export const COMMENT_GUIDE = {
  valid: 'A real problem in the changed code that the author should act on.',
  nitpick: 'True, but style, naming, formatting or negligible impact.',
  invalid: 'Wrong, unsupported by the code shown, or too vague to act on.',
};

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CONTEXT_LINES = 3;

interface Case {
  id: string;
  repo: string;
  head_sha: string;
  introduced: { sha: string; committed_at: string; subject: string };
  fix: { sha: string; committed_at: string; subject: string; files: string[] };
  ground_truth: { path: string; lines: number[] }[];
  stats: { days_to_fix: number };
  provenance: { blame_share: number };
}

export function defaultReposDir(): string {
  const root = process.env.REVIEWLENS_CACHE ?? join(homedir(), '.cache', 'reviewlens');
  return join(root, 'repos');
}

async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  try {
    return (await readFile(path, 'utf8'))
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Last verdict per key, as both Python tools read them. */
async function latest(path: string, key: string): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const row of await readJsonl(path)) out.set(String(row[key]), row);
  return out;
}

async function append(path: string, row: Record<string, unknown>) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(row)}\n`);
}

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repoDir, ...args], {
    maxBuffer: 20 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
  });
  return stdout;
}

export interface TruthLine {
  /** Line number in the introducing commit; null marks a gap between excerpts. */
  n: number | null;
  text: string;
  truth: boolean;
}

/** Excerpts of each ground-truth file around its marked lines, as the terminal tool shows. */
export function excerpt(
  content: string,
  lines: readonly number[],
  context = CONTEXT_LINES,
): TruthLine[] {
  const fileLines = content.split('\n');
  const marked = new Set(lines);
  const shown = new Set<number>();
  for (const n of lines) {
    for (let i = Math.max(1, n - context); i <= Math.min(fileLines.length, n + context); i++)
      shown.add(i);
  }
  const out: TruthLine[] = [];
  let previous = 0;
  for (const n of [...shown].sort((a, b) => a - b)) {
    if (previous && n !== previous + 1) out.push({ n: null, text: '…', truth: false });
    out.push({ n, text: fileLines[n - 1] ?? '', truth: marked.has(n) });
    previous = n;
  }
  return out;
}

const verdictBody = (verdicts: readonly string[]) =>
  z.object({
    verdict: z.enum(verdicts as [string, ...string[]]),
    note: z.string().max(2_000).default(''),
    labeler: z.string().trim().min(1).max(100),
  });

export const labelRoutes: FastifyPluginAsync<LabelPaths> = async (app, paths) => {
  let manifestCache: Map<string, Case> | undefined;
  const cases = async () => {
    if (!manifestCache) {
      const manifest = JSON.parse(await readFile(paths.manifest, 'utf8')) as { cases: Case[] };
      manifestCache = new Map(manifest.cases.map((c) => [c.id, c]));
    }
    return manifestCache;
  };
  const sampleIds = async () =>
    (JSON.parse(await readFile(paths.sample, 'utf8')) as { case_ids: string[] }).case_ids;

  // --- Benchmark cases --------------------------------------------------------------------

  app.get('/api/labels/benchmark', async () => {
    const [ids, all, done] = await Promise.all([
      sampleIds(),
      cases(),
      latest(paths.verdicts, 'case_id'),
    ]);
    const counts = { valid: 0, invalid: 0, unsure: 0 };
    const items = ids.map((id) => {
      const verdict = done.get(id)?.verdict as keyof typeof counts | undefined;
      if (verdict) counts[verdict]++;
      return { id, repo: all.get(id)?.repo ?? '?', verdict: verdict ?? null };
    });
    return { guide: CASE_GUIDE, total: ids.length, counts, items };
  });

  app.get<{ Params: { id: string } }>('/api/labels/benchmark/:id', async (req, reply) => {
    const ids = await sampleIds();
    if (!ids.includes(req.params.id))
      return reply.code(404).send({ error: 'not in the validation sample' });
    const c = (await cases()).get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'case not in the manifest' });
    const repoDir = join(paths.repos, `${c.repo.replace('/', '__')}.git`);
    let fixDiff: string;
    try {
      fixDiff = await git(repoDir, [
        'show',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--format=%b',
        `--unified=${CONTEXT_LINES}`,
        c.fix.sha,
        '--',
        ...c.fix.files,
      ]);
    } catch {
      return reply
        .code(409)
        .send({ error: `repository ${c.repo} is not cloned; run \`rlbench clone\` first` });
    }
    const truth = [];
    for (const t of [...c.ground_truth].sort((a, b) => a.path.localeCompare(b.path))) {
      try {
        const content = await git(repoDir, ['show', `${c.head_sha}:${t.path}`]);
        truth.push({ path: t.path, lines: excerpt(content, t.lines) });
      } catch {
        truth.push({ path: t.path, lines: [] });
      }
    }
    const previous = (await latest(paths.verdicts, 'case_id')).get(c.id) ?? null;
    return {
      id: c.id,
      repo: c.repo,
      index: ids.indexOf(c.id),
      total: ids.length,
      daysToFix: c.stats.days_to_fix,
      blameShare: c.provenance.blame_share,
      fix: {
        sha: c.fix.sha,
        date: c.fix.committed_at,
        subject: c.fix.subject,
        diff: fixDiff.trimEnd(),
      },
      introduced: {
        sha: c.head_sha,
        date: c.introduced.committed_at,
        subject: c.introduced.subject,
      },
      truth,
      previous,
    };
  });

  app.post<{ Params: { id: string } }>('/api/labels/benchmark/:id', async (req, reply) => {
    if (!(await sampleIds()).includes(req.params.id)) {
      return reply.code(404).send({ error: 'not in the validation sample' });
    }
    const body = verdictBody(CASE_VERDICTS).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid verdict' });
    const row = {
      case_id: req.params.id,
      verdict: body.data.verdict,
      note: body.data.note,
      labeler: body.data.labeler,
      at: new Date().toISOString(),
    };
    await append(paths.verdicts, row);
    return row;
  });

  // --- Sampled sets: review comments (precision) and comment-bug pairs (matching) -------------

  for (const [kind, set] of Object.entries(SAMPLE_SETS)) {
    const dir = (name: string, hash: string) => join(paths.results, name, hash, set.dir);

    app.get(`/api/labels/${kind}`, async () => {
      const out = [];
      for (const name of await safeDirs(paths.results)) {
        for (const hash of await safeDirs(join(paths.results, name))) {
          const items = await readJsonl(join(dir(name, hash), 'items.jsonl'));
          if (items.length === 0) continue;
          const done = await latest(join(dir(name, hash), 'human.jsonl'), 'id');
          out.push({
            name,
            hash,
            total: items.length,
            labeled: items.filter((i) => done.has(String(i.id))).length,
          });
        }
      }
      return out;
    });

    app.get<{ Params: { name: string; hash: string } }>(
      `/api/labels/${kind}/:name/:hash`,
      async (req, reply) => {
        const { name, hash } = req.params;
        if (!SAFE_NAME.test(name) || !SAFE_NAME.test(hash)) {
          return reply.code(404).send({ error: 'not found' });
        }
        const items = await readJsonl(join(dir(name, hash), 'items.jsonl'));
        if (items.length === 0) return reply.code(404).send({ error: 'nothing sampled' });
        const done = await latest(join(dir(name, hash), 'human.jsonl'), 'id');
        return {
          guide: set.guide,
          verdicts: set.verdicts,
          items: items.map((i) => ({
            ...set.show(i),
            verdict: done.get(String(i.id))?.verdict ?? null,
          })),
        };
      },
    );

    app.post<{ Params: { name: string; hash: string; id: string } }>(
      `/api/labels/${kind}/:name/:hash/:id`,
      async (req, reply) => {
        const { name, hash, id } = req.params;
        if (!SAFE_NAME.test(name) || !SAFE_NAME.test(hash)) {
          return reply.code(404).send({ error: 'not found' });
        }
        const items = await readJsonl(join(dir(name, hash), 'items.jsonl'));
        if (!items.some((i) => String(i.id) === id)) {
          return reply.code(404).send({ error: 'no such item' });
        }
        const body = verdictBody(set.verdicts).safeParse(req.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid verdict' });
        const row = {
          id,
          verdict: body.data.verdict,
          note: body.data.note,
          labeler: body.data.labeler,
          at: new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00'),
        };
        await append(join(dir(name, hash), 'human.jsonl'), row);
        return row;
      },
    );
  }
};

type Item = Record<string, unknown>;

/**
 * Sampled label sets written by the harness under `eval/results/<name>/<hash>/<dir>/`.
 * `show` picks what a labeler sees; for comments the arm, run and input stay hidden, so
 * labels cannot favor a strategy.
 */
const SAMPLE_SETS: Record<
  string,
  {
    dir: string;
    verdicts: readonly string[];
    guide: Record<string, string>;
    show: (item: Item) => Item;
  }
> = {
  comments: {
    dir: 'comments',
    verdicts: COMMENT_VERDICTS,
    guide: COMMENT_GUIDE,
    show: (i) => ({
      id: i.id,
      path: i.path,
      diff: i.diff,
      line: i.line,
      category: i.category,
      severity: i.severity,
      claim: i.claim,
      evidence: i.evidence,
      suggested_fix: i.suggested_fix ?? null,
    }),
  },
  matches: {
    dir: 'matches',
    verdicts: MATCH_VERDICTS,
    guide: MATCH_GUIDE,
    show: (i) => ({
      id: i.id,
      path: i.path,
      line: i.line,
      category: i.category,
      claim: i.claim,
      evidence: i.evidence,
      fix_subject: i.fix_subject,
      fix_diff: i.fix_diff,
      truth_lines: i.truth_lines,
    }),
  },
};

async function safeDirs(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && SAFE_NAME.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
