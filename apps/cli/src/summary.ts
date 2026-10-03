import type { ReviewRun } from '@reviewlens/review-core';

/** Human-readable summary of a run, printed to stderr. */
export function summarize(run: ReviewRun): string {
  const counts: Record<string, number> = {};
  for (const c of run.candidates) counts[c.status] = (counts[c.status] ?? 0) + 1;
  const { context: ctx, llm } = run;
  const lines = [
    `strategy ${run.config.strategy} · config ${run.configHash} · prompt ${run.prompt.version}@${run.prompt.contentHash}`,
    `context: ~${ctx.estimatedTokens}/${ctx.budget} tokens; diffs ${ctx.diffFiles.included.length} in / ${ctx.diffFiles.omitted.length} out; files ${ctx.fullFiles.included.length} in / ${ctx.fullFiles.omitted.length} out`,
  ];

  if (ctx.conventions) {
    lines.push(
      `conventions: ${ctx.conventions.included}/${ctx.conventions.found} rules, ~${ctx.conventions.tokens} tokens`,
    );
  }
  if (ctx.pastBugs) {
    lines.push(
      ctx.pastBugs.available
        ? `past bugs: ${ctx.pastBugs.included} shown of ${ctx.pastBugs.matched} overlapping (${ctx.pastBugs.history} fix commits in history), ~${ctx.pastBugs.tokens} tokens`
        : 'past bugs: no history available for this input',
    );
  }
  if (ctx.graph) {
    const g = ctx.graph;
    lines.push(
      `graph: ${g.index.filesIndexed} files (${g.index.parsed} parsed, ${g.index.fromCache} cached) in ${g.index.durationMs} ms; ${g.symbols} symbols, ${g.edges} edges, calls resolved ${g.callsResolved}/${g.callsTotal}`,
      `changed symbols: ${g.changedSymbols.join(', ') || '(none)'}`,
    );
  }
  if (ctx.symbols) {
    lines.push(
      `symbols: ${ctx.symbols.included.length} shown (${ctx.symbols.signatureOnly} signature-only), ${ctx.symbols.omitted} omitted, ~${ctx.symbols.tokens} tokens`,
      ...ctx.symbols.included.map(
        (s) =>
          `  ${s.distance} ${s.role.padEnd(9)} ${s.mode === 'full' ? '' : `(${s.mode}) `}${s.name}`,
      ),
    );
  }
  if (ctx.embeddings) {
    const e = ctx.embeddings;
    lines.push(
      `embeddings: ${e.model}; ${e.chunks} chunks, ${e.queries} queries (${e.embedded} embedded, ${e.fromCache} cached); ${e.included.length} shown, ~${e.tokens} tokens`,
      ...e.included.map(
        (s) => `  ${s.score.toFixed(3)} ${s.mode === 'full' ? '' : `(${s.mode}) `}${s.name}`,
      ),
    );
  }

  lines.push(
    llm
      ? `llm: ${llm.servedModel}${llm.fallbackUsed ? ' (fallback)' : ''} · ${llm.usage.inputTokens} in / ${llm.usage.outputTokens} out · $${llm.costUsd?.toFixed(4) ?? '?'} · ${(llm.latencyMs / 1000).toFixed(1)}s${llm.cached ? ' (cached)' : ''}`
      : 'llm: not called (nothing reviewable)',
    ...(run.filter
      ? [
          `filter: ${run.filter.modelVersion} at threshold ${run.filter.threshold}; dropped ${run.filter.dropped} of ${run.filter.scored}`,
        ]
      : []),
    `candidates: ${run.candidates.length} ${JSON.stringify(counts)}`,
    ...run.selected.map(
      (c) => `  #${c.rank} ${c.file}:${c.line} [${c.severity} ${c.category}] ${c.claim}`,
    ),
    ...run.candidates
      .filter((c) => c.status === 'invalid')
      .map((c) => `  rejected ${c.file}:${c.line} (${c.rejectReason}) ${c.claim}`),
  );
  return lines.join('\n');
}
