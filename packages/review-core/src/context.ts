import type { IndexStats } from '@reviewlens/context-engine';
import type { FileDiff } from '@reviewlens/github';
import type { StrategyId } from './config.js';
import { renderFile, renderFileDiff } from './render.js';
import { estimateTokens, TokenBudget } from './tokens.js';

/** Paths never sent as context: lockfiles, build output, minified and vendored code. */
const IGNORED_PATHS = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|npm-shrinkwrap\.json|bun\.lockb?)$/,
  /(^|\/)(dist|build|out|coverage|node_modules|vendor)\//,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.snap$/,
];

export function isIgnoredPath(path: string): boolean {
  return IGNORED_PATHS.some((re) => re.test(path));
}

/** A diff file the pipeline can review: text, not deleted, not ignored. */
export function isReviewable(file: FileDiff): file is FileDiff & { newPath: string } {
  return (
    !file.binary && file.newPath !== null && !isIgnoredPath(file.newPath) && file.hunks.length > 0
  );
}

export interface ContextSection {
  kind: 'diff' | 'file' | 'symbol' | 'conventions' | 'past_bugs';
  path: string;
  text: string;
  tokens: number;
}

export interface ContextStats {
  strategy: StrategyId;
  budget: number;
  estimatedTokens: number;
  diffFiles: { included: string[]; omitted: string[] };
  fullFiles: { included: string[]; omitted: string[] };
  /** Set when the strategy built the repository symbol graph. */
  graph?: GraphSummary;
  /** Call-graph symbols added (S3, S4, S5). */
  symbols?: SymbolContextSummary;
  /** Embedding matches added (S2). */
  embeddings?: EmbeddingContextSummary;
  conventions?: { found: number; included: number; tokens: number };
  pastBugs?: {
    /** False when the input carried no history, so nothing could be retrieved. */
    available: boolean;
    history: number;
    matched: number;
    included: number;
    tokens: number;
  };
}

export interface GraphSummary {
  index: IndexStats;
  symbols: number;
  edges: number;
  callsResolved: number;
  callsTotal: number;
  changedSymbols: string[];
}

export interface SymbolContextSummary {
  included: { name: string; role: string; distance: number; mode: string }[];
  signatureOnly: number;
  omitted: number;
  tokens: number;
}

export interface EmbeddingContextSummary {
  model: string;
  /** Candidate chunks ranked (changed code excluded). */
  chunks: number;
  queries: number;
  embedded: number;
  fromCache: number;
  included: { name: string; score: number; mode: string }[];
  tokens: number;
}

export interface BuiltContext {
  sections: ContextSection[];
  stats: ContextStats;
}

export interface ContextSources {
  /** Reviewable files of the diff, in diff order. */
  files: (FileDiff & { newPath: string })[];
  /** Head contents of those files (already scrubbed); null when unavailable. */
  headContents: ReadonlyMap<string, string | null>;
}

/**
 * Assemble repository context for a strategy within a token budget. Deterministic: the
 * same sources and budget always give the same sections in the same order.
 *
 * - S0: the diff only.
 * - S1: the diff, then full head versions of the changed files.
 *
 * Diffs always come first, so every strategy sees the same diff when it fits; extra
 * context only spends what the diff left over. Pieces that do not fit are left out whole
 * and listed in the stats, never truncated mid-way.
 */
export function buildContext(
  strategy: StrategyId,
  sources: ContextSources,
  budgetTokens: number,
): BuiltContext {
  const budget = new TokenBudget(budgetTokens);
  const sections: ContextSection[] = [];
  const stats: ContextStats = {
    strategy,
    budget: budgetTokens,
    estimatedTokens: 0,
    diffFiles: { included: [], omitted: [] },
    fullFiles: { included: [], omitted: [] },
  };

  for (const file of sources.files) {
    const text = renderFileDiff(file);
    const tokens = estimateTokens(text);
    if (budget.tryTake(tokens)) {
      sections.push({ kind: 'diff', path: file.newPath, text, tokens });
      stats.diffFiles.included.push(file.newPath);
    } else {
      stats.diffFiles.omitted.push(file.newPath);
    }
  }

  // Graph strategies (S3, S4) add symbol sections afterwards, from the remaining budget.
  if (strategy === 'S1') {
    for (const path of stats.diffFiles.included) {
      const content = sources.headContents.get(path);
      if (content == null) {
        stats.fullFiles.omitted.push(path);
        continue;
      }
      const text = renderFile(path, content);
      const tokens = estimateTokens(text);
      if (budget.tryTake(tokens)) {
        sections.push({ kind: 'file', path, text, tokens });
        stats.fullFiles.included.push(path);
      } else {
        stats.fullFiles.omitted.push(path);
      }
    }
  }

  stats.estimatedTokens = budget.spent;
  return { sections, stats };
}
