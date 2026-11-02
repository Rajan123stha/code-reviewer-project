import type { FileDiff } from '@reviewlens/github';
import type { ModelComment } from './schema.js';

export type RejectReason =
  | 'file_not_in_diff'
  | 'line_not_in_diff'
  | 'evidence_not_found'
  | 'empty_claim'
  | 'confidence_out_of_range'
  | 'too_long';

/**
 * Upper bounds on model-written fields. The model's output is untrusted input: GitHub rejects
 * comment bodies over 65,536 characters (failing the whole review), and nobody reads a claim
 * longer than a page. A comment over any limit is rejected, not truncated.
 */
export const FIELD_LIMITS = { claim: 2_000, evidence: 4_000, suggested_fix: 4_000 } as const;

interface FileIndex {
  /** New-file lines GitHub accepts inline comments on: added and context lines. */
  commentable: Set<number>;
  /** Searchable text: every diff line (all sides) plus the head file, whitespace-normalized. */
  haystack: string;
}

/**
 * Lookup structure for validating model comments against the actual change. It is built
 * from the same scrubbed diff and head files for every strategy, so validation never
 * favors a strategy that happened to show the model more code.
 */
export class DiffIndex {
  private readonly files = new Map<string, FileIndex>();

  constructor(
    files: (FileDiff & { newPath: string })[],
    headContents: ReadonlyMap<string, string | null>,
  ) {
    for (const file of files) {
      const commentable = new Set<number>();
      const lines: string[] = [];
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          lines.push(line.content);
          if (line.type !== 'del' && line.newLine !== undefined) commentable.add(line.newLine);
        }
      }
      const head = headContents.get(file.newPath) ?? '';
      this.files.set(file.newPath, {
        commentable,
        haystack: normalizeCode(`${lines.join('\n')}\n${head}`),
      });
    }
  }

  validate(comment: ModelComment): RejectReason | null {
    const file = this.files.get(normalizePath(comment.file));
    if (!file) return 'file_not_in_diff';
    if (!file.commentable.has(comment.line)) return 'line_not_in_diff';
    if (!comment.claim.trim()) return 'empty_claim';
    if (
      comment.claim.length > FIELD_LIMITS.claim ||
      comment.evidence.length > FIELD_LIMITS.evidence ||
      (comment.suggested_fix?.length ?? 0) > FIELD_LIMITS.suggested_fix
    ) {
      return 'too_long';
    }
    if (comment.confidence < 0 || comment.confidence > 1) return 'confidence_out_of_range';
    const evidence = normalizeEvidence(comment.evidence);
    if (evidence.length < 2 || !file.haystack.includes(evidence)) return 'evidence_not_found';
    return null;
  }
}

export function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/^\.?\//, '')
    .replace(/^[ab]\//, '');
}

/** Collapse all whitespace runs, so indentation and wrapping differences do not matter. */
function normalizeCode(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Undo the decorations a model commonly adds when quoting: surrounding backticks or code
 * fences, our `R<line>` labels and diff `+`/`-` markers.
 */
export function normalizeEvidence(evidence: string): string {
  let text = evidence.trim();
  text = text.replace(/^```[\w-]*\n?/, '').replace(/\n?```$/, '');
  if (/^`[^`]+`$/.test(text)) text = text.slice(1, -1);
  text = text
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*R\d+\s?/, '')
        .replace(/^\s*\d+\|\s?/, '')
        .replace(/^[+-]\s*/, ''),
    )
    .join('\n');
  return normalizeCode(text);
}
