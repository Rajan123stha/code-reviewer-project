import { parseUnifiedDiff } from '@reviewlens/github';
import type { LLMClient, TokenUsage } from '@reviewlens/llm';
import type { ParseCache, RepoGraph } from '@reviewlens/context-engine';
import type { EmbeddingClient } from '@reviewlens/llm';
import { configHash, strategyConfigSchema, type StrategyConfig } from './config.js';
import { buildContext, isReviewable, type ContextStats } from './context.js';
import { compareComments, findDuplicates } from './dedupe.js';
import { FEATURES_VERSION, FeatureExtractor, type CandidateFeatures } from './features.js';
import { assertScoreResult, type CommentScorer } from './filter.js';
import { formatCommentBody } from './format.js';
import { addExtraContext } from './graph-context.js';
import type { ReviewInput } from './input.js';
import { loadPrompt, renderTemplate } from './prompts.js';
import { REVIEW_SCHEMA_NAME, reviewOutputSchema, type ModelComment } from './schema.js';
import { scrubSecrets } from './scrub.js';
import { DiffIndex, normalizePath, type RejectReason } from './validate.js';

/**
 * - selected: valid, kept after dedupe, within maxComments; this is what gets posted.
 * - over_cap: valid and unique, but ranked below the maxComments cut.
 * - filtered: valid and unique, but scored below the usefulness filter's threshold.
 * - duplicate: valid, but a near-duplicate of a higher-priority comment.
 * - invalid: failed validation (see rejectReason).
 */
export type CandidateStatus = 'selected' | 'over_cap' | 'filtered' | 'duplicate' | 'invalid';

export interface Candidate extends ModelComment {
  /** Position in the model's output, stable across processing. */
  index: number;
  status: CandidateStatus;
  rejectReason: RejectReason | null;
  /** For duplicates: index of the candidate this one duplicates. */
  duplicateOf: number | null;
  /** 1-based rank among valid, unique candidates that passed the filter; null otherwise. */
  rank: number | null;
  /** Filter inputs. Null for invalid candidates, which are never scored or posted. */
  features: CandidateFeatures | null;
  /** Usefulness score from the learned filter; null when the filter is off or did not score it. */
  filterScore: number | null;
  /** Rendered GitHub comment body. */
  body: string;
}

export interface LLMCallSummary {
  provider: string;
  requestedModel: string;
  servedModel: string;
  fallbackUsed: boolean;
  usage: TokenUsage;
  costUsd: number | null;
  latencyMs: number;
  attempts: number;
  cached: boolean;
  requestId: string | null;
}

export interface ReviewRun {
  config: StrategyConfig;
  configHash: string;
  prompt: { version: string; contentHash: string };
  schemaName: string;
  context: ContextStats;
  /** Redaction counts by secret type, across the diff and every file read. */
  redactions: Record<string, number>;
  /** Null when the PR had nothing reviewable, so no call was made. */
  llm: LLMCallSummary | null;
  featuresVersion: string;
  /** The filter that scored this review; null when the filter is off or had nothing to score. */
  filter: { modelVersion: string; threshold: number; scored: number; dropped: number } | null;
  candidates: Candidate[];
  /** Selected candidates in rank order: the comments to post. */
  selected: Candidate[];
  startedAt: string;
  finishedAt: string;
}

export interface ReviewDeps {
  llm: LLMClient;
  /** Parse cache for graph strategies; content-addressed, so it never changes results. */
  parseCache?: ParseCache | undefined;
  /** Embedding client for strategies that retrieve by similarity (S2). */
  embeddings?: EmbeddingClient | undefined;
  /** Extra LLM cache-key material, e.g. the run index when an eval repeats a config. */
  cacheSalt?: string;
  /** Usefulness filter; required when the config sets `filterThreshold`. */
  scorer?: CommentScorer | undefined;
}

/**
 * The review pipeline: a function of (input, config) and the LLM's answer. Production
 * workers and the eval harness both call exactly this.
 */
export async function runReview(
  input: ReviewInput,
  config: StrategyConfig,
  deps: ReviewDeps,
): Promise<ReviewRun> {
  const startedAt = new Date().toISOString();
  strategyConfigSchema.parse(config);
  if (config.filterThreshold !== null && !deps.scorer) {
    throw new Error('config sets filterThreshold but no filter scorer was provided');
  }
  if (deps.llm.providerName !== config.provider && deps.llm.providerName !== 'fake') {
    throw new Error(
      `config expects provider ${config.provider} but the LLM client uses ${deps.llm.providerName}`,
    );
  }
  const redactions: Record<string, number> = {};
  const scrub = (text: string) => {
    const result = scrubSecrets(text);
    for (const [k, n] of Object.entries(result.redactions))
      redactions[k] = (redactions[k] ?? 0) + n;
    return result.text;
  };

  // 1. Ingest: scrub first, so nothing downstream (prompt, validation, storage) sees secrets.
  const files = parseUnifiedDiff(scrub(input.diff)).filter(isReviewable);
  const scrubbedReads = new Map<string, Promise<string | null>>();
  const readScrubbed = (path: string) => {
    let read = scrubbedReads.get(path);
    if (!read) {
      read = input.head.readFile(path).then((c) => (c === null ? null : scrub(c)));
      scrubbedReads.set(path, read);
    }
    return read;
  };
  const headContents = new Map<string, string | null>();
  for (const file of files) headContents.set(file.newPath, await readScrubbed(file.newPath));

  // 2. Context for this strategy: diffs first, then strategy-specific extras.
  const context = buildContext(config.strategy, { files, headContents }, config.contextTokenBudget);
  let graph: RepoGraph | null = null;
  if (context.sections.length > 0) {
    const included = new Set(context.stats.diffFiles.included);
    graph = await addExtraContext(context, {
      scrub,
      embeddings: deps.embeddings,
      fixCommits: input.fixCommits,
      config,
      head: input.head,
      files: files.filter((f) => included.has(f.newPath)),
      readScrubbed,
      parseCache: deps.parseCache,
    });
  }
  const prompt = await loadPrompt(config.promptVersion);
  const base = {
    config,
    configHash: configHash(config),
    prompt: { version: prompt.version, contentHash: prompt.contentHash },
    schemaName: REVIEW_SCHEMA_NAME,
    context: context.stats,
    redactions,
    featuresVersion: FEATURES_VERSION,
  };
  if (context.sections.length === 0) {
    return {
      ...base,
      llm: null,
      filter: null,
      candidates: [],
      selected: [],
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  // 3. Generate candidates.
  const user = renderTemplate(prompt.user, {
    title: scrub(input.pr.title),
    description: scrub(input.pr.body?.trim() || '(no description)'),
    context: context.sections.map((s) => s.text).join('\n\n'),
    notes: omittedNote(context.stats),
  });
  const result = await deps.llm.generate({
    model: config.model,
    effort: config.effort,
    system: prompt.system,
    prompt: user,
    schema: reviewOutputSchema,
    schemaName: REVIEW_SCHEMA_NAME,
    maxOutputTokens: config.maxOutputTokens,
    fallbackModels: config.fallbackModels,
    refusalFallback: config.refusalFallback,
    cacheSalt: deps.cacheSalt,
  });

  // 4. Validate and dedupe.
  const index = new DiffIndex(files, headContents);
  const comments = result.output.comments.map((c) => ({ ...c, file: normalizePath(c.file) }));
  const reasons = comments.map((c) => index.validate(c));
  const validIdx = comments.map((_, i) => i).filter((i) => reasons[i] === null);
  const dupOf = findDuplicates(validIdx.map((i) => comments[i]!));
  const unique = validIdx.filter((_, k) => dupOf[k] === null);
  unique.sort((i, j) => compareComments(comments[i]!, comments[j]!));

  const candidates: Candidate[] = comments.map((c, i) => ({
    ...c,
    index: i,
    status: 'invalid',
    rejectReason: reasons[i] ?? null,
    duplicateOf: null,
    rank: null,
    features: null,
    filterScore: null,
    body: formatCommentBody(c),
  }));
  validIdx.forEach((i, k) => {
    const d = dupOf[k];
    if (d !== null && d !== undefined) {
      candidates[i]!.status = 'duplicate';
      candidates[i]!.duplicateOf = validIdx[d]!;
    }
  });

  // 5. Features for every valid candidate (duplicates too: they are training data), then
  // the learned filter over the unique ones.
  const clusterSize = new Map<number, number>();
  validIdx.forEach((i, k) => {
    const d = dupOf[k];
    const kept = d === null || d === undefined ? i : validIdx[d]!;
    clusterSize.set(kept, (clusterSize.get(kept) ?? 0) + 1);
  });
  const extractor = new FeatureExtractor(files, config.strategy, graph);
  for (const i of validIdx) {
    const kept = candidates[i]!.duplicateOf ?? i;
    candidates[i]!.features = extractor.extract(comments[i]!, {
      duplicateClusterSize: clusterSize.get(kept) ?? 1,
      candidatesInReview: unique.length,
    });
  }

  let filter: ReviewRun['filter'] = null;
  let ranked = unique;
  if (config.filterThreshold !== null && deps.scorer && unique.length > 0) {
    const threshold = config.filterThreshold;
    const scored = await deps.scorer.score(unique.map((i) => candidates[i]!.features!));
    assertScoreResult(scored, { count: unique.length, model: config.filterModel });
    unique.forEach((i, k) => (candidates[i]!.filterScore = scored.scores[k]!));
    const score = (i: number) => candidates[i]!.filterScore!;
    // `unique` is already in severity/confidence order, and the sort is stable, so equal
    // scores keep that order.
    ranked = unique.filter((i) => score(i) >= threshold).sort((i, j) => score(j) - score(i));
    for (const i of unique) if (score(i) < threshold) candidates[i]!.status = 'filtered';
    filter = {
      modelVersion: scored.modelVersion,
      threshold,
      scored: unique.length,
      dropped: unique.length - ranked.length,
    };
  }

  // 6. Rank and cap.
  ranked.forEach((i, r) => {
    candidates[i]!.rank = r + 1;
    candidates[i]!.status = r < config.maxComments ? 'selected' : 'over_cap';
  });

  return {
    ...base,
    llm: {
      provider: result.provider,
      requestedModel: result.requestedModel,
      servedModel: result.servedModel,
      fallbackUsed: result.fallbackUsed,
      usage: result.usage,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      attempts: result.attempts,
      cached: result.cached,
      requestId: result.requestId ?? null,
    },
    filter,
    candidates,
    selected: ranked.slice(0, config.maxComments).map((i) => candidates[i]!),
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

function omittedNote(stats: ContextStats): string {
  const omitted = [...stats.diffFiles.omitted];
  if (omitted.length === 0) return '';
  return `\nThese changed files were left out to fit the context budget, so you cannot comment on them: ${omitted.join(', ')}.\n`;
}
