import {
  assembleSymbolContext,
  buildChunks,
  buildRepoGraph,
  changedSymbols,
  chunkText,
  extractConventions,
  MemoryParseCache,
  rankChunks,
  similarPastBugs,
  type ChangedSymbol,
  type FixCommit,
  type ParseCache,
  type RepoGraph,
} from '@reviewlens/context-engine';
import type { FileDiff } from '@reviewlens/github';
import type { EmbeddingClient } from '@reviewlens/llm';
import { usesCallGraph, type StrategyConfig } from './config.js';
import type { BuiltContext } from './context.js';
import type { RepoSnapshot } from './input.js';
import { estimateTokens } from './tokens.js';

type ReviewableFile = FileDiff & { newPath: string };

export interface ExtraContextArgs {
  config: StrategyConfig;
  head: RepoSnapshot;
  /** Diff files whose diffs made it into the context. */
  files: ReviewableFile[];
  readScrubbed: (path: string) => Promise<string | null>;
  scrub: (text: string) => string;
  parseCache?: ParseCache | undefined;
  embeddings?: EmbeddingClient | undefined;
  /** Bug-fix commits that precede the change (reachable from its base). */
  fixCommits?: (() => Promise<FixCommit[]>) | undefined;
}

const remaining = (context: BuiltContext) => context.stats.budget - context.stats.estimatedTokens;

/**
 * Everything a strategy adds beyond diffs and full files, spending only what is left of
 * the budget, in this order: conventions, past bugs (both small and capped), then code
 * (call-graph symbols or embedding matches). All of it is derived from the snapshot and
 * the history before the change, so it stays a function of the pipeline's inputs.
 *
 * Returns the repository graph when the strategy built one, for reuse downstream.
 */
export async function addExtraContext(
  context: BuiltContext,
  args: ExtraContextArgs,
): Promise<RepoGraph | null> {
  const { config } = args;
  if (config.useConventions) await addConventions(context, args);
  if (config.usePastBugs) await addPastBugs(context, args);

  const graphNeeded = usesCallGraph(config.strategy) || config.embeddingTopK > 0;
  if (!graphNeeded) return null;
  if (!args.head.listFiles) {
    throw new Error(`strategy ${config.strategy} needs a snapshot that can list files`);
  }
  const { graph, stats: index } = await buildRepoGraph(
    { listFiles: () => args.head.listFiles!(), readFile: (p) => args.head.readFile(p) },
    args.parseCache ?? new MemoryParseCache(),
  );
  const changed = changedSymbols(graph, args.files);
  context.stats.graph = {
    index,
    symbols: graph.stats.symbols,
    edges: graph.edges.length,
    callsResolved: graph.stats.calls.resolved,
    callsTotal: graph.stats.calls.total,
    changedSymbols: changed.map((c) => `${c.symbol.path}:${c.symbol.qualifiedName}`),
  };

  if (usesCallGraph(config.strategy)) await addSymbols(context, args, graph, changed);
  if (config.embeddingTopK > 0) await addSimilarCode(context, args, graph, changed);
  return graph;
}

async function addConventions(context: BuiltContext, args: ExtraContextArgs) {
  const all = await extractConventions(args.readScrubbed);
  const cap = Math.min(args.config.conventionsTokenCap, remaining(context));
  const open = '<conventions>';
  const close = '</conventions>';
  let used = estimateTokens(`${open}\n${close}`);
  const lines: string[] = [];
  for (const c of all) {
    const line = `- ${c.ruleText} (${c.source})`;
    const tokens = estimateTokens(`${line}\n`);
    if (used + tokens > cap) break;
    lines.push(line);
    used += tokens;
  }
  context.stats.conventions = { found: all.length, included: lines.length, tokens: 0 };
  if (lines.length === 0) return;
  const text = `${open}\n${lines.join('\n')}\n${close}`;
  const tokens = estimateTokens(text);
  context.sections.push({ kind: 'conventions', path: '', text, tokens });
  context.stats.estimatedTokens += tokens;
  context.stats.conventions.tokens = tokens;
}

async function addPastBugs(context: BuiltContext, args: ExtraContextArgs) {
  const history = args.fixCommits ? await args.fixCommits() : [];
  const matches = similarPastBugs(
    history,
    args.files.map((f) => f.newPath),
    args.config.pastBugsTopK,
  );
  const cap = Math.min(args.config.pastBugsTokenCap, remaining(context));
  const open = '<past_bugs>';
  const close = '</past_bugs>';
  let used = estimateTokens(`${open}\n${close}`);
  const lines: string[] = [];
  for (const bug of matches) {
    const where = bug.sharedFiles.length ? bug.sharedFiles.join(', ') : 'same directory';
    const line = `- ${bug.committedAt.slice(0, 10)} ${bug.sha.slice(0, 7)}: ${args.scrub(bug.summary)} (touched ${where})`;
    const tokens = estimateTokens(`${line}\n`);
    if (used + tokens > cap) break;
    lines.push(line);
    used += tokens;
  }
  context.stats.pastBugs = {
    available: args.fixCommits !== undefined,
    history: history.length,
    matched: matches.length,
    included: lines.length,
    tokens: 0,
  };
  if (lines.length === 0) return;
  const text = `${open}\n${lines.join('\n')}\n${close}`;
  const tokens = estimateTokens(text);
  context.sections.push({ kind: 'past_bugs', path: '', text, tokens });
  context.stats.estimatedTokens += tokens;
  context.stats.pastBugs.tokens = tokens;
}

async function addSymbols(
  context: BuiltContext,
  args: ExtraContextArgs,
  graph: RepoGraph,
  changed: ChangedSymbol[],
) {
  const { config } = args;
  const depth =
    config.strategy === 'S3'
      ? { calleeDepth: 1, callerDepth: 0 }
      : { calleeDepth: config.graphDepth, callerDepth: config.graphDepth };
  const { sections, stats } = await assembleSymbolContext(graph, changed, {
    ...depth,
    budgetTokens: remaining(context),
    maxFullSymbolTokens: config.maxSymbolTokens,
    readFile: args.readScrubbed,
    estimateTokens,
  });
  for (const s of sections) {
    context.sections.push({ kind: 'symbol', path: s.path, text: s.text, tokens: s.tokens });
  }
  context.stats.estimatedTokens += stats.tokens;
  context.stats.symbols = {
    included: sections.map((s) => ({
      name: `${s.path}:${s.qualifiedName}`,
      role: s.role,
      distance: s.distance,
      mode: s.mode,
    })),
    signatureOnly: stats.signatureOnly,
    omitted: stats.omitted,
    tokens: stats.tokens,
  };
}

/** S2: the code most similar to the change, by embedding. */
async function addSimilarCode(
  context: BuiltContext,
  args: ExtraContextArgs,
  graph: RepoGraph,
  changed: ChangedSymbol[],
) {
  const { config, embeddings } = args;
  if (!embeddings) throw new Error(`strategy ${config.strategy} needs an embedding client`);

  const chunks = await buildChunks(graph, args.readScrubbed);
  // The change itself is already in the diff: leave out chunks that overlap it.
  const changedLines = new Map<string, number[]>();
  for (const c of changed) {
    changedLines.set(c.symbol.path, [...(changedLines.get(c.symbol.path) ?? []), ...c.lines]);
  }
  const candidates = chunks.filter((chunk) => {
    const lines = changedLines.get(chunk.path);
    return !lines?.some((l) => l >= chunk.startLine && l <= chunk.endLine);
  });

  // One query per changed symbol (its current body); module-level changes use added lines.
  const queries: string[] = [];
  const byGid = new Map(chunks.map((c) => [c.gid, c]));
  for (const c of changed) {
    const chunk = byGid.get(c.symbol.gid);
    if (chunk) queries.push(chunk.text);
  }
  for (const file of args.files) {
    const hasSymbolQuery = changed.some(
      (c) => c.symbol.path === file.newPath && byGid.has(c.symbol.gid),
    );
    if (hasSymbolQuery) continue;
    const added = file.hunks.flatMap((h) =>
      h.lines.filter((l) => l.type === 'add').map((l) => l.content),
    );
    if (added.length) queries.push(chunkText(file.newPath, 'changed lines', added.join('\n')));
  }

  const summary = {
    model: config.embeddingModel,
    chunks: candidates.length,
    queries: queries.length,
    embedded: 0,
    fromCache: 0,
    included: [] as { name: string; score: number; mode: string }[],
    tokens: 0,
  };
  context.stats.embeddings = summary;
  if (candidates.length === 0 || queries.length === 0) return;

  const request = { model: config.embeddingModel, dimensions: config.embeddingDimensions };
  const docs = await embeddings.embed({
    ...request,
    kind: 'document',
    texts: candidates.map((c) => c.text),
  });
  const qs = await embeddings.embed({ ...request, kind: 'query', texts: queries });
  summary.embedded = docs.stats.embedded + qs.stats.embedded;
  summary.fromCache = docs.stats.fromCache + qs.stats.fromCache;

  const ranked = rankChunks(candidates, docs.vectors, qs.vectors).slice(0, config.embeddingTopK);
  const fileLines = new Map<string, string[]>();
  for (const { chunk, score } of ranked) {
    if (!fileLines.has(chunk.path)) {
      const content = await args.readScrubbed(chunk.path);
      fileLines.set(chunk.path, (content ?? '').replace(/\r\n/g, '\n').split('\n'));
    }
    const symbol = graph.symbols[chunk.gid]!;
    const relation = `similar to the changed code (similarity ${score.toFixed(2)})`;
    const head = (shown: string) =>
      `<symbol path="${attr(chunk.path)}" name="${attr(chunk.qualifiedName)}" kind="${symbol.kind}" lines="${chunk.startLine}-${chunk.endLine}" relation="${relation}"${shown}>`;
    const width = String(chunk.endLine).length;
    const body = fileLines
      .get(chunk.path)!
      .slice(chunk.startLine - 1, chunk.endLine)
      .map((l, i) => `${String(chunk.startLine + i).padStart(width)}| ${l}`)
      .join('\n');
    const full = `${head('')}\n${body}\n</symbol>`;
    const signature = `${head(' shown="signature only"')}\n${String(chunk.startLine).padStart(width)}| ${symbol.signature} …\n</symbol>`;
    const fullTokens = estimateTokens(full);
    const fits = fullTokens <= config.maxSymbolTokens && fullTokens <= remaining(context);
    const text = fits ? full : signature;
    const tokens = fits ? fullTokens : estimateTokens(signature);
    if (tokens > remaining(context)) continue;
    context.sections.push({ kind: 'symbol', path: chunk.path, text, tokens });
    context.stats.estimatedTokens += tokens;
    summary.tokens += tokens;
    summary.included.push({
      name: `${chunk.path}:${chunk.qualifiedName}`,
      score: Number(score.toFixed(4)),
      mode: fits ? 'full' : 'signature',
    });
  }
}

function attr(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
