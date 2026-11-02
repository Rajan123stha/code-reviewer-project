import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { gitDiff, gitRevParse } from './snapshot.js';

// Revisions reach git as arguments. One that starts with "-" is read as an option, and
// git diff --output=<file> writes a file wherever it is told.

let repo: string;
let first: string;
let second: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'git-args-'));
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  first = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  git('commit', '-q', '-am', 'two');
  second = git('rev-parse', 'HEAD');
});

describe('git arguments', () => {
  it('diffs and resolves ordinary revisions', async () => {
    expect(await gitRevParse(repo, 'HEAD~1')).toBe(first);
    expect(await gitRevParse(repo, 'main')).toBe(second);
    expect(await gitDiff(repo, first, second)).toContain('+two');
  });

  it('never lets a revision become a git option', async () => {
    const out = mkdtempSync(join(tmpdir(), 'git-out-'));
    const target = join(out, 'written-by-git');
    await expect(gitDiff(repo, `--output=${target}`, second)).rejects.toThrow(/revision/);
    expect(existsSync(target) || readdirSync(out).length > 0).toBe(false);
    await expect(gitRevParse(repo, '--output=x')).rejects.toThrow(/revision/);
    await expect(gitRevParse(repo, '')).rejects.toThrow(/revision/);
  });
});
