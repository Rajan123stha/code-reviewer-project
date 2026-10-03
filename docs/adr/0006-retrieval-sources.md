# ADR 0006: Embeddings, conventions and past bugs (S2, S5)

- Status: accepted
- Date: 2026-10-03

## Context

Phase 4 completes the strategy set from the spec: S2 (diff + embedding retrieval) as the
"embedding-only" baseline for RQ1, and S5 (S4 + conventions + similar past bugs). Each
retrieval source has to be switchable on its own for the ablations (E7), and all of them
share the one context token budget.

## Decisions

### Config

`StrategyConfig` gains one switch per source: `embeddingTopK` (0 = off) with
`embeddingModel` and `embeddingDimensions`; `useConventions` with `conventionsTokenCap`;
`usePastBugs` with `pastBugsTopK` and `pastBugsTokenCap`. All are part of the config hash.
Presets: S2 sets `embeddingTopK: 10`; S5 is S4 plus both supplements. Budget order: diffs,
conventions (cap 600), past bugs (cap 600), then code. All presets now use prompt
`review/v3`, which explains the new sections.

### Embeddings (S2)

- **Chunks are symbols**: one per function, method, interface, type, enum and multi-line
  module variable; a class is one chunk only if it has no methods. One-line symbols are
  skipped. Chunk text is a `// path :: name` header plus the body, cut at 6,000 characters.
- **Queries**: the current body of each changed symbol; for module-level changes, the added
  lines. A chunk's score is its best cosine similarity to any query. Chunks that overlap the
  changed lines are excluded, because the diff already shows them.
- **Ranking is in memory**, over the head snapshot's chunks. This keeps S2 a function of the
  snapshot (it works for any commit, in the CLI and the eval harness, without a database) and
  is exact; a few thousand vectors need no index.
- **Model**: `gemini-embedding-001` at 768 dimensions. Vectors are normalized to unit length
  on arrival, because the API does not normalize reduced-size vectors.
- **Cache**: content-addressed by hash of (provider, model, size, kind, text). Postgres
  (`embedding_cache`) in production, JSON files for the CLI. A chunk is embedded once, however
  many commits or repositories contain it.
- **Secrets**: chunk text comes from the scrubbed snapshot, so embeddings never see secrets
  that the review prompt would not see either.
- **pgvector**: the `chunks` table stores embeddings for the default-branch index, with
  nearest-neighbor queries in SQL (`nearestChunks`). The index job fills it only when
  `INDEX_EMBEDDINGS=true`. Reviews do not read it; it is there for the dashboard and for
  repositories too large to rank in memory.

### Conventions

Extracted statically, in a fixed order: CONTRIBUTING rules, TypeScript compiler checks that
are on, ESLint rules set to error, whether Prettier or XO is in use, then README sections
about contributing or development. Markdown rules are bullets or sentences with normative
wording, outside code fences. JavaScript config files are scanned as text and never
imported. The optional "mine repeated review comments" source from the spec is not built.

### Past bugs

- **Detection**: a keyword heuristic on the commit subject (`fix`, `bug`, `regression`,
  `crash`, …), excluding docs, chore, CI, typo, lint and merge commits. It is noisy by design;
  Phase 5 uses issue links and SZZ for the benchmark, where precision matters.
- **Similarity**: file overlap. A fix scores 1 per changed file it touched and 0.25 per
  changed file whose directory it touched; ties break by recency. Fixes touching more than
  30 files are ignored.
- **No leakage**: history is an explicit pipeline input, `ReviewInput.fixCommits`, and must
  contain only commits before the change. The CLI walks `git log` from the base commit. The
  worker reads stored fixes dated before the base commit. A review therefore cannot be shown
  the fix for the bug it is supposed to find, which matters for Benchmark A.
- **Storage**: `bug_history`, filled by the index job from the default branch (up to 300
  commits listed per run; file lists fetched for at most 50 new fix commits per run).
  `bug_commit_sha` stays null until SZZ.

## Measurements

On ky commit `8cf26e0` (a merge-logic fix), with real Gemini calls:

| Strategy | Context tokens (est.) | Extra context                                                         | Comments |
| -------- | --------------------: | --------------------------------------------------------------------- | -------: |
| S2       |                 3,074 | 10 similar symbols (similarity 0.74 to 0.78), all merge or clone code |        1 |
| S5       |                 5,237 | 15 graph symbols, 2 conventions, 5 past fixes (4 on merge logic)      |        0 |

One commit is not evidence about quality; that is what the benchmark is for.

## Known limits

- **Free-tier embedding quota** is about 100 texts per minute per key. Embedding ky's 510
  chunks cold took about 6 minutes; later runs take seconds from the cache. Enable
  `INDEX_EMBEDDINGS` or pre-warm the cache before timing S2.
- The heuristics for conventions and fix commits have not been measured for precision.
- Past-bug similarity ignores what the fix was about; embedding the summaries is a possible
  refinement.
