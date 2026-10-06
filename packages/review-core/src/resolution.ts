import type { FileDiff } from '@reviewlens/github';

/** Lines around a comment within which a later change counts as acting on it. */
export const RESOLUTION_LINE_TOLERANCE = 3;

/**
 * For each file of a later diff, the old-side lines it touched: lines it removed or
 * rewrote, and the line after which it inserted new ones. Keyed by the old path, the
 * coordinates a comment made before that diff refers to.
 */
export function touchedOldLines(files: readonly FileDiff[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const file of files) {
    if (file.oldPath === null || file.binary) continue;
    const lines = new Set<number>();
    for (const hunk of file.hunks) {
      // Old-side position of the line before the current one, for anchoring insertions.
      let previousOld = hunk.oldStart - 1;
      for (const line of hunk.lines) {
        if (line.type === 'del' && line.oldLine !== undefined) {
          lines.add(line.oldLine);
          previousOld = line.oldLine;
        } else if (line.type === 'context' && line.oldLine !== undefined) {
          previousOld = line.oldLine;
        } else if (line.type === 'add') {
          lines.add(Math.max(1, previousOld));
        }
      }
    }
    if (file.status === 'deleted') lines.add(1);
    if (lines.size > 0)
      out.set(
        file.oldPath,
        [...lines].sort((a, b) => a - b),
      );
  }
  return out;
}

/**
 * Whether a later diff changed the code a comment points at: the diff touches the
 * comment's file within `tolerance` lines of it, or deletes the file.
 *
 * This is evidence that the author acted on the comment, not proof: the lines may have
 * changed for another reason.
 *
 * @param later diff from the commit the comment was made on to a later commit
 */
export function changedNear(
  later: readonly FileDiff[],
  comment: { file: string; line: number },
  tolerance = RESOLUTION_LINE_TOLERANCE,
): boolean {
  const file = later.find((f) => f.oldPath === comment.file);
  if (!file) return false;
  if (file.status === 'deleted') return true;
  const touched = touchedOldLines([file]).get(comment.file) ?? [];
  return touched.some((line) => Math.abs(line - comment.line) <= tolerance);
}
