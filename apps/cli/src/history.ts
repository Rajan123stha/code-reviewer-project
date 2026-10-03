import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isFixCommit, summarizeCommit, type FixCommit } from '@reviewlens/context-engine';

const exec = promisify(execFile);

/** ASCII record and unit separators: they cannot occur in commit messages or paths. */
const RECORD = '\x1e';
const UNIT = '\x1f';

/** How far back to look for fix commits. */
export const DEFAULT_HISTORY_COMMITS = 2_000;

/**
 * Bug-fix commits reachable from `baseSha`, newest first, with the files each touched.
 * Starting the walk at the base commit is what keeps the history free of the future: the
 * change under review and everything after it are not ancestors of its base.
 */
export async function gitFixCommits(
  repoDir: string,
  baseSha: string,
  limit = DEFAULT_HISTORY_COMMITS,
): Promise<FixCommit[]> {
  const { stdout } = await exec(
    'git',
    [
      '-C',
      repoDir,
      'log',
      baseSha,
      `-n${limit}`,
      '--no-merges',
      '--name-only',
      `--format=${RECORD}%H${UNIT}%cI${UNIT}%B${UNIT}`,
    ],
    { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' },
  );
  return parseGitLog(stdout);
}

/** Parse the output of the `git log` call above. Exported for tests. */
export function parseGitLog(output: string): FixCommit[] {
  const fixes: FixCommit[] = [];
  for (const record of output.split(RECORD)) {
    const [sha, committedAt, message, files] = record.split(UNIT);
    if (!sha || !committedAt || message === undefined) continue;
    if (!isFixCommit(message)) continue;
    fixes.push({
      sha: sha.trim(),
      committedAt: committedAt.trim(),
      summary: summarizeCommit(message),
      files: (files ?? '')
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean),
    });
  }
  return fixes;
}
