import { posix } from 'node:path';

/** A commit that fixed a bug, as mined from history. */
export interface FixCommit {
  sha: string;
  /** ISO 8601 commit date. */
  committedAt: string;
  /** Subject plus the first line of the body, trimmed. */
  summary: string;
  files: string[];
}

const FIX_WORDS =
  /\b(fix(e[sd]|ing)?|bug(fix)?|regression|crash(es|ed)?|leak(s|ed)?|incorrect(ly)?|wrong(ly)?|broken|hotfix)\b/i;
/** Commits that mention "fix" but do not fix behavior. */
const NOT_A_BUG =
  /\b(typo|lint|linting|format(ting)?|readme|docs?|documentation|comment|changelog|ci|workflow|deps?|dependenc(y|ies)|bump|release|merge)\b/i;
const NON_FIX_TYPES = /^(docs|chore|ci|style|build|test|refactor)(\(.+\))?!?:/i;
/** Fixes touching more files than this say little about any one file. */
export const MAX_FIX_FILES = 30;
const MAX_SUMMARY_CHARS = 300;

/**
 * Whether a commit message describes a bug fix. A keyword heuristic on the subject line:
 * cheap, deterministic and noisy by nature. Phase 5 replaces it for the benchmark with
 * issue links and SZZ; for retrieval, a few false positives only cost context tokens.
 */
export function isFixCommit(message: string): boolean {
  const subject = message.split('\n', 1)[0]!.trim();
  if (NON_FIX_TYPES.test(subject)) return false;
  if (/^fix(\(.+\))?!?:/i.test(subject)) return !/\b(typo|lint|docs?)\b/i.test(subject);
  return FIX_WORDS.test(subject) && !NOT_A_BUG.test(subject);
}

export function summarizeCommit(message: string): string {
  const lines = message.split('\n').map((l) => l.trim());
  const subject = lines[0] ?? '';
  const body = lines
    .slice(1)
    .find((l) => l && !/^(co-authored-by|signed-off-by|fixes|closes|refs?)\b/i.test(l));
  const text = body ? `${subject} — ${body}` : subject;
  return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS)}…` : text;
}

export interface PastBug extends FixCommit {
  score: number;
  /** Changed files this fix also touched. */
  sharedFiles: string[];
}

/**
 * Past fixes most related to a change, by file overlap: a fix scores 1 for each changed
 * file it touched and 0.25 for each changed file whose directory it touched. Ties break by
 * recency, then sha. Fixes with no overlap are not returned.
 *
 * `history` must only contain commits that precede the change under review (reachable
 * from its base commit), or the retrieval leaks the future.
 */
export function similarPastBugs(
  history: readonly FixCommit[],
  changedPaths: readonly string[],
  topK: number,
): PastBug[] {
  const changed = new Set(changedPaths);
  const changedDirs = new Set(changedPaths.map((p) => posix.dirname(p)));
  const scored: PastBug[] = [];
  for (const fix of history) {
    if (fix.files.length === 0 || fix.files.length > MAX_FIX_FILES) continue;
    const sharedFiles = fix.files.filter((f) => changed.has(f));
    const sharedDirs = new Set(
      fix.files
        .filter((f) => !changed.has(f))
        .map((f) => posix.dirname(f))
        .filter((d) => changedDirs.has(d)),
    );
    const score = sharedFiles.length + 0.25 * sharedDirs.size;
    if (score > 0) scored.push({ ...fix, score, sharedFiles });
  }
  return scored
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.committedAt < b.committedAt ? 1 : a.committedAt > b.committedAt ? -1 : 0) ||
        (a.sha < b.sha ? -1 : 1),
    )
    .slice(0, topK);
}
