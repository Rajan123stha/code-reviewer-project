#!/usr/bin/env node
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { buildRepoGraph, FileParseCache, MemoryParseCache } from '@reviewlens/context-engine';
import {
  createLLMFromEnv,
  DEFAULT_FALLBACK_MODELS,
  DEFAULT_MODELS,
  EmbeddingClient,
  FakeEmbeddingProvider,
  FakeProvider,
  FileCache,
  FileEmbeddingCache,
  LLMClient,
  LLMError,
  PROVIDER_NAMES,
  type LLMCallRecord,
  type ProviderName,
} from '@reviewlens/llm';
import {
  judgeComment,
  presetFor,
  STRATEGY_IDS,
  runReview,
  strategyConfigSchema,
  type JudgeItem,
  type ReviewInput,
  type StrategyId,
} from '@reviewlens/review-core';
import { gitFixCommits } from './history.js';
import { directorySnapshot, gitDiff, gitRevParse, gitSnapshot } from './snapshot.js';
import { summarize } from './summary.js';

const USAGE = `Usage:
  reviewlens review --diff <file.diff> --repo <dir>     review a diff against a working tree
  reviewlens review --git <repo> --base <rev> --head <rev>   review a commit range of a local repo
  reviewlens index --git <repo> [--head <rev>]           index a commit; print graph stats
  reviewlens index --repo <dir>                          index a working tree
  reviewlens judge --in <items.jsonl> --out <verdicts.jsonl>   LLM-judge review comments

Review options:
  --strategy S0..S5     context strategy (default S1); see README for what each adds
  --config-json <json>  strategy config overrides, e.g. '{"graphDepth":3,"effort":"low"}'
  --provider <name>     gemini (default) or anthropic; default from LLM_PROVIDER
  --model <id>          override the provider's default model
  --fallback-models <ids>  comma-separated models to try if the model is overloaded ("" = none)
  --budget <tokens>     override the context token budget
  --title <text>        PR title (default: "Local review")
  --body <text>         PR description
  --salt <text>         cache salt, e.g. a run index for repeated eval runs
  --dry-run             print the prompt; make no LLM call
  --fake-llm <file>     answer with the comments in this JSON file instead of calling a model
  --out <file>          write the full run as JSON (default: stdout)

Caches (all optional):
  --cache-dir <dir>     LLM responses
  --parse-cache <dir>   parsed files, for graph strategies and indexing
  --embed-cache <dir>   embeddings (S2)

Exit codes: 0 ok, 1 error, 2 usage, 3 the LLM was rate-limited or unavailable (retry later).

Environment (read from .env at the repo root if present):
  GEMINI_API_KEYS      comma-separated keys, rotated when one is rate-limited
  ANTHROPIC_API_KEY    when --provider anthropic`;

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

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

function parse() {
  return parseArgs({
    allowPositionals: true,
    options: {
      diff: { type: 'string' },
      repo: { type: 'string' },
      git: { type: 'string' },
      base: { type: 'string' },
      head: { type: 'string' },
      strategy: { type: 'string', default: 'S1' },
      'config-json': { type: 'string' },
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
      'fake-llm': { type: 'string' },
      in: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}
type Values = ReturnType<typeof parse>['values'];

const splitList = (value: string) =>
  value
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

function providerName(values: Values): ProviderName {
  const name = (values.provider ?? process.env.LLM_PROVIDER ?? 'gemini') as ProviderName;
  if (!PROVIDER_NAMES.includes(name)) throw new Error(`unknown provider ${name}`);
  return name;
}

const onCall = (call: LLMCallRecord) => console.error(`[llm] ${JSON.stringify(call)}`);

async function index(values: Values) {
  const snapshot = values.git
    ? gitSnapshot(values.git, await gitRevParse(values.git, values.head ?? 'HEAD'))
    : values.repo
      ? directorySnapshot(values.repo)
      : undefined;
  if (!snapshot?.listFiles) throw new Error('index needs --git <repo> or --repo <dir>');
  const parseCache = values['parse-cache']
    ? new FileParseCache(values['parse-cache'])
    : new MemoryParseCache();
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
}

async function review(values: Values) {
  if (!STRATEGY_IDS.includes(values.strategy as StrategyId)) {
    throw new Error(
      `unknown strategy ${values.strategy}; expected one of ${STRATEGY_IDS.join(', ')}`,
    );
  }
  const overrides = values['config-json']
    ? (JSON.parse(values['config-json']) as Record<string, unknown>)
    : {};
  const config = strategyConfigSchema.parse({
    ...presetFor(values.strategy as StrategyId, {
      provider: providerName(values),
      ...(values.model ? { model: values.model } : {}),
      ...(values['fallback-models'] !== undefined
        ? { fallbackModels: splitList(values['fallback-models']) }
        : {}),
    }),
    ...(values.budget ? { contextTokenBudget: Number(values.budget) } : {}),
    ...overrides,
  });

  const pr = {
    owner: 'local',
    repo: 'local',
    number: 0,
    title: values.title,
    body: values.body ?? null,
  };
  let input: ReviewInput;
  if (values.git) {
    if (!values.base || !values.head) throw new Error('--git needs --base and --head');
    const repoDir = values.git;
    const baseSha = await gitRevParse(repoDir, values.base);
    const headSha = await gitRevParse(repoDir, values.head);
    input = {
      pr: { ...pr, baseSha, headSha },
      diff: await gitDiff(repoDir, baseSha, headSha),
      head: gitSnapshot(repoDir, headSha),
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

  const cache = values['cache-dir'] ? new FileCache(values['cache-dir']) : undefined;
  const embeddingCache = values['embed-cache']
    ? new FileEmbeddingCache(values['embed-cache'])
    : undefined;

  // Three ways to answer: a scripted fake (harness tests), a dry run (print the prompt and
  // answer with no comments), or the real provider.
  let captured: { system: string; prompt: string } | undefined;
  let llm: LLMClient;
  let embeddings: EmbeddingClient;
  if (values['fake-llm'] || values['dry-run']) {
    const scripted = values['fake-llm']
      ? (JSON.parse(await readFile(values['fake-llm'], 'utf8')) as unknown)
      : [];
    const comments = Array.isArray(scripted)
      ? scripted
      : (scripted as { comments: unknown }).comments;
    llm = new LLMClient({
      provider: new FakeProvider((req) => {
        if (values['dry-run']) captured = { system: req.system, prompt: req.prompt };
        return { comments };
      }, ZERO_USAGE),
      cache,
      onCall,
    });
    embeddings = new EmbeddingClient({
      provider: new FakeEmbeddingProvider(),
      cache: embeddingCache,
    });
  } else {
    const real = createLLMFromEnv(process.env, {
      provider: config.provider,
      cache,
      onCall,
      embeddingCache,
      onKeyEvent: (e) => console.error(`[keys] ${JSON.stringify(e)}`),
      onModelEvent: (e) => console.error(`[model] ${JSON.stringify(e)}`),
    });
    llm = real.llm;
    embeddings =
      real.embeddings ??
      new EmbeddingClient({ provider: new FakeEmbeddingProvider(), cache: embeddingCache });
  }

  const run = await runReview(input, config, {
    llm,
    parseCache: values['parse-cache']
      ? new FileParseCache(values['parse-cache'])
      : new MemoryParseCache(),
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

/** Judge comments from a JSONL file; appends one verdict per line, skipping ids already done. */
async function judge(values: Values) {
  if (!values.in || !values.out) throw new Error('judge needs --in <items.jsonl> and --out <file>');
  const items = (await readFile(values.in, 'utf8'))
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as JudgeItem);
  const done = new Set<string>();
  try {
    for (const line of (await readFile(values.out, 'utf8')).split('\n')) {
      if (line.trim()) done.add((JSON.parse(line) as { id: string }).id);
    }
  } catch {
    // No output yet.
  }
  const provider = providerName(values);
  const llm = values['fake-llm']
    ? new LLMClient({
        provider: new FakeProvider(() => ({ verdict: 'valid', reason: 'scripted' }), ZERO_USAGE),
      })
    : createLLMFromEnv(process.env, {
        provider,
        cache: values['cache-dir'] ? new FileCache(values['cache-dir']) : undefined,
        onCall,
        onModelEvent: (e) => console.error(`[model] ${JSON.stringify(e)}`),
      }).llm;
  const fallbackModels =
    values['fallback-models'] !== undefined
      ? splitList(values['fallback-models'])
      : DEFAULT_FALLBACK_MODELS[provider];
  let judged = 0;
  for (const item of items) {
    if (done.has(item.id)) continue;
    const result = await judgeComment(
      item,
      { model: values.model ?? DEFAULT_MODELS[provider], fallbackModels },
      llm,
    );
    await appendFile(values.out, `${JSON.stringify(result)}\n`);
    judged++;
  }
  console.error(`judged ${judged} comments (${done.size} already done) -> ${values.out}`);
}

async function main() {
  loadDotEnv();
  const { positionals, values } = parse();
  const command = positionals[0];
  if (values.help || !['review', 'index', 'judge'].includes(command ?? '')) {
    console.error(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  if (command === 'index') return index(values);
  if (command === 'judge') return judge(values);
  return review(values);
}

main().catch((error: unknown) => {
  // The last stderr line is machine-readable, so the eval harness can tell quota
  // exhaustion (stop and resume later) from a failure of this one case.
  const kind = error instanceof LLMError ? error.kind : 'error';
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[error] ${JSON.stringify({ kind, message })}`);
  const transient = kind === 'rate_limit' || kind === 'server' || kind === 'connection';
  process.exit(transient ? 3 : 1);
});
