#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  createLLMFromEnv,
  EmbeddingClient,
  FakeEmbeddingProvider,
  FakeProvider,
  FileCache,
  FileEmbeddingCache,
  LLMClient,
  PROVIDER_NAMES,
  type ProviderName,
} from '@reviewlens/llm';
import {
  presetFor,
  STRATEGY_IDS,
  runReview,
  strategyConfigSchema,
  type ReviewInput,
  type StrategyId,
} from '@reviewlens/review-core';
import { buildRepoGraph, FileParseCache, MemoryParseCache } from '@reviewlens/context-engine';
import { gitFixCommits } from './history.js';
import { directorySnapshot, gitDiff, gitRevParse, gitSnapshot } from './snapshot.js';
import { summarize } from './summary.js';

const USAGE = `Usage:
  reviewlens review --diff <file.diff> --repo <dir>     review a diff against a working tree
  reviewlens review --git <repo> --base <rev> --head <rev>   review a commit range of a local repo
  reviewlens index --git <repo> [--head <rev>]           index a commit; print graph stats
  reviewlens index --repo <dir>                          index a working tree

Options:
  --strategy S0..S5     context strategy (default S1); see README for what each adds
  --parse-cache <dir>  on-disk parse cache for graph strategies and indexing
  --embed-cache <dir>  on-disk embedding cache (S2)
  --provider <name>    gemini (default) or anthropic; default from LLM_PROVIDER
  --model <id>         override the provider's default model
  --fallback-models <ids>  comma-separated models to try if the model is overloaded ("" = none)
  --budget <tokens>    override the context token budget
  --title <text>       PR title (default: "Local review")
  --body <text>        PR description
  --cache-dir <dir>    on-disk LLM response cache
  --salt <text>        cache salt, e.g. a run index for repeated eval runs
  --dry-run            print the prompt; make no LLM call
  --out <file>         write the full run as JSON (default: stdout)

Environment (read from .env at the repo root if present):
  GEMINI_API_KEYS      comma-separated keys, rotated when one is rate-limited
  ANTHROPIC_API_KEY    when --provider anthropic`;

/** Load .env from the repo root (or cwd) when present; real env vars win. */
function loadDotEnv() {
  for (const path of ['.env', new URL('../../../.env', import.meta.url)]) {
    try {
      process.loadEnvFile(path);
      return;
    } catch {
      // Not there; try the next location.
    }
  }
}

async function main() {
  loadDotEnv();
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      diff: { type: 'string' },
      repo: { type: 'string' },
      git: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      strategy: { type: 'string', default: 'S1' },
      provider: { type: 'string' },
      model: { type: 'string' },
      'fallback-models': { type: 'string' },
      budget: { type: 'string' },
      title: { type: 'string', default: 'Local review' },
      body: { type: 'string' },
      'cache-dir': { type: 'string' },
      'parse-cache': { type: 'string' },
      'embed-cache': { type: 'string' },
      salt: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const command = positionals[0];
  if (values.help || (command !== 'review' && command !== 'index')) {
    console.error(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  const parseCache = values['parse-cache']
    ? new FileParseCache(values['parse-cache'])
    : new MemoryParseCache();

  if (command === 'index') {
    const snapshot = values.git
      ? gitSnapshot(values.git, await gitRevParse(values.git, values.head ?? 'HEAD'))
      : values.repo
        ? directorySnapshot(values.repo)
        : undefined;
    if (!snapshot?.listFiles) throw new Error('index needs --git <repo> or --repo <dir>');
    const { graph, stats } = await buildRepoGraph(
      { listFiles: () => snapshot.listFiles!(), readFile: (p) => snapshot.readFile(p) },
      parseCache,
    ).finally(() => (snapshot as { close?: () => void }).close?.());
    const inDegree = graph.symbols
      .filter((s) => s.kind !== 'module')
      .map((s) => ({ s, n: graph.incoming(s.gid).filter((e) => e.kind === 'calls').length }))
      .sort((a, b) => b.n - a.n || a.s.gid - b.s.gid)
      .slice(0, 10);
    const kinds: Record<string, number> = {};
    for (const s of graph.symbols) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
    console.log(
      JSON.stringify(
        {
          commit: snapshot.sha,
          index: stats,
          graph: graph.stats,
          symbolKinds: kinds,
          mostCalled: inDegree.map(({ s, n }) => `${s.path}:${s.qualifiedName} (${n} callers)`),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!STRATEGY_IDS.includes(values.strategy as StrategyId)) {
    throw new Error(
      `unknown strategy ${values.strategy}; expected one of ${STRATEGY_IDS.join(', ')}`,
    );
  }

  const providerName = (values.provider ?? process.env.LLM_PROVIDER ?? 'gemini') as ProviderName;
  if (!PROVIDER_NAMES.includes(providerName)) throw new Error(`unknown provider ${providerName}`);
  const config = strategyConfigSchema.parse({
    ...presetFor(values.strategy as StrategyId, {
      provider: providerName,
      ...(values.model ? { model: values.model } : {}),
      ...(values['fallback-models'] !== undefined
        ? {
            fallbackModels: values['fallback-models']
              .split(',')
              .map((m) => m.trim())
              .filter(Boolean),
          }
        : {}),
    }),
    ...(values.budget ? { contextTokenBudget: Number(values.budget) } : {}),
  });

  let input: ReviewInput;
  const pr = {
    owner: 'local',
    repo: 'local',
    number: 0,
    title: values.title,
    body: values.body ?? null,
  };
  if (values.git) {
    if (!values.base || !values.head) throw new Error('--git needs --base and --head');
    const repoDir = values.git;
    const baseSha = await gitRevParse(values.git, values.base);
    const headSha = await gitRevParse(values.git, values.head);
    input = {
      pr: { ...pr, baseSha, headSha },
      diff: await gitDiff(values.git, baseSha, headSha),
      head: gitSnapshot(values.git, headSha),
      fixCommits: () => gitFixCommits(repoDir, baseSha),
    };
  } else if (values.diff && values.repo) {
    input = {
      pr: { ...pr, baseSha: 'unknown', headSha: 'working-tree' },
      diff: await readFile(values.diff, 'utf8'),
      head: directorySnapshot(values.repo),
    };
  } else {
    throw new Error('give either --diff and --repo, or --git with --base and --head');
  }

  // Dry run: capture the request the pipeline would send, answer with no comments.
  let captured: { system: string; prompt: string } | undefined;
  const cache = values['cache-dir'] ? new FileCache(values['cache-dir']) : undefined;
  const onCall = (call: unknown) => console.error(`[llm] ${JSON.stringify(call)}`);
  const embeddingCache = values['embed-cache']
    ? new FileEmbeddingCache(values['embed-cache'])
    : undefined;
  const real = values['dry-run']
    ? undefined
    : createLLMFromEnv(process.env, {
        provider: config.provider,
        cache,
        onCall,
        embeddingCache,
        onKeyEvent: (e) => console.error(`[keys] ${JSON.stringify(e)}`),
        onModelEvent: (e) => console.error(`[model] ${JSON.stringify(e)}`),
      });
  const embeddings =
    real?.embeddings ??
    new EmbeddingClient({ provider: new FakeEmbeddingProvider(), cache: embeddingCache });
  const llm = !real
    ? new LLMClient({
        provider: new FakeProvider(
          (req) => {
            captured = { system: req.system, prompt: req.prompt };
            return { comments: [] };
          },
          { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        ),
        cache,
        onCall,
      })
    : real.llm;

  const run = await runReview(input, config, {
    llm,
    parseCache,
    embeddings,
    ...(values.salt ? { cacheSalt: values.salt } : {}),
  });

  if (captured) {
    console.log(`===== SYSTEM =====\n${captured.system}\n\n===== USER =====\n${captured.prompt}`);
  }
  console.error(summarize(run));
  const json = JSON.stringify(run, null, 2);
  if (values.out) await writeFile(values.out, json);
  else if (!captured) console.log(json);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
