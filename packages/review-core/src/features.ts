import type { RepoGraph } from '@reviewlens/context-engine';
import type { FileDiff } from '@reviewlens/github';
import type { StrategyId } from './config.js';
import type { Category, ModelComment, Severity } from './schema.js';
import { normalizeEvidence, normalizePath } from './validate.js';

/**
 * Version of the feature definitions below. The filter service refuses features of another
 * version, so a model is never scored on inputs that mean something else than what it was
 * trained on. Bump it whenever a feature is added, removed or changes meaning.
 */
export const FEATURES_VERSION = 'features/v1';

/**
 * What the usefulness filter knows about a candidate comment. Computed here, once, and
 * stored with the candidate: the training set is built from these stored values and the
 * service scores these same values, so training and serving cannot drift apart.
 *
 * Nothing here depends on the benchmark's ground truth or on what happened after the review.
 */
export interface CandidateFeatures {
  // The comment itself.
  category: Category;
  severity: Severity;
  /** The model's own confidence, 0 to 1. */
  confidence: number;
  claimChars: number;
  evidenceLines: number;
  hasFix: boolean;
  /** The quoted evidence appears in lines this change added (not only elsewhere in the file). */
  evidenceInAddedLines: boolean;

  // Where it points.
  /** Lower-case file extension without the dot, or "" when the file has none. */
  fileExt: string;
  isTest: boolean;
  /** The commented line was added by this change (false: an unchanged context line). */
  lineIsAdded: boolean;
  /** Lines added plus deleted in the commented file. */
  fileChangedLines: number;
  /** Lines added plus deleted across all reviewed files. */
  prChangedLines: number;
  prFiles: number;
  /**
   * Centrality of the enclosing symbol: how many resolved call sites in the repository call
   * it. Null when the strategy built no symbol graph or the line is at module level.
   */
  symbolCallers: number | null;

  // The review it came from.
  strategy: StrategyId;
  /** Valid candidates that are near-duplicates of this one, itself included. */
  duplicateClusterSize: number;
  /** Valid, unique candidates in this review. */
  candidatesInReview: number;
  /** Share of verifier passes that upheld the comment. Null: no verifier ran. */
  verifierAgreement: number | null;

  // The repository.
  /** Past acceptance rate of this category in this repository. Null: no feedback yet. */
  repoCategoryAcceptRate: number | null;
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

function fileExt(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

interface FileFacts {
  added: Set<number>;
  changedLines: number;
  /** Added lines, whitespace-normalized, for locating quoted evidence. */
  addedText: string;
}

/** Computes features for the valid candidates of one review. */
export class FeatureExtractor {
  private readonly files = new Map<string, FileFacts>();
  private readonly prChangedLines: number;

  constructor(
    files: readonly (FileDiff & { newPath: string })[],
    private readonly strategy: StrategyId,
    /** The repository graph when the strategy built one. */
    private readonly graph: RepoGraph | null,
  ) {
    let total = 0;
    for (const file of files) {
      const added = new Set<number>();
      const addedLines: string[] = [];
      let changed = 0;
      for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
          if (line.type === 'context') continue;
          changed++;
          if (line.type === 'add' && line.newLine !== undefined) {
            added.add(line.newLine);
            addedLines.push(line.content);
          }
        }
      }
      total += changed;
      this.files.set(file.newPath, {
        added,
        changedLines: changed,
        addedText: addedLines.join('\n').replace(/\s+/g, ' ').trim(),
      });
    }
    this.prChangedLines = total;
  }

  /**
   * @param comment a candidate that passed validation, so its file is part of the diff
   * @param review counts over the whole review that the comment alone cannot know
   */
  extract(
    comment: ModelComment,
    review: { duplicateClusterSize: number; candidatesInReview: number },
  ): CandidateFeatures {
    const path = normalizePath(comment.file);
    const file = this.files.get(path);
    const evidence = normalizeEvidence(comment.evidence);
    return {
      category: comment.category,
      severity: comment.severity,
      confidence: comment.confidence,
      claimChars: comment.claim.trim().length,
      evidenceLines: comment.evidence.trim().split('\n').length,
      hasFix: (comment.suggested_fix ?? '').trim().length > 0,
      evidenceInAddedLines: evidence.length >= 2 && (file?.addedText.includes(evidence) ?? false),
      fileExt: fileExt(path),
      isTest: isTestPath(path),
      lineIsAdded: file?.added.has(comment.line) ?? false,
      fileChangedLines: file?.changedLines ?? 0,
      prChangedLines: this.prChangedLines,
      prFiles: this.files.size,
      symbolCallers: this.callers(path, comment.line),
      strategy: this.strategy,
      duplicateClusterSize: review.duplicateClusterSize,
      candidatesInReview: review.candidatesInReview,
      verifierAgreement: null,
      repoCategoryAcceptRate: null,
    };
  }

  private callers(path: string, line: number): number | null {
    const symbol = this.graph?.symbolAt(path, line);
    if (!this.graph || !symbol || symbol.kind === 'module') return null;
    return this.graph.incoming(symbol.gid).filter((e) => e.kind === 'calls').length;
  }
}
