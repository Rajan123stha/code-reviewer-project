# Reviewlens

A GitHub App that reviews pull requests using structural repository context (AST, symbol and call
graph, conventions, past bugs) and filters its own comments with a learned usefulness model. Every
design choice is measured against a benchmark built from real bug-fix history.

> **Status: Phase 6, eval harness.** Six context strategies review pull requests, Benchmark A
> (1,022 bug-introducing changes) is built, and the harness runs and scores ablations over it.
> No ablation has been run at full size yet. The learned filter comes next. See
> [docs/spec.md](docs/spec.md).

| Strategy | Context sent with the diff                                       |
| -------- | ---------------------------------------------------------------- |
| S0       | Nothing else                                                     |
| S1       | Full changed files                                               |
| S2       | The 10 symbols most similar to the change, by embedding          |
| S3       | The changed symbols and the definitions they call                |
| S4       | S3 plus callers and callees to a configurable call-graph depth   |
| S5       | S4 plus repository conventions and past bug fixes in those files |

Every strategy gets the same token budget, and each retrieval source is a separate switch in
the strategy config.

## How it works today

```
GitHub ──pull_request webhook──▶ api (Fastify)
                                   │ verify X-Hub-Signature-256 on raw bytes
                                   │ enqueue job, id = pr-<repoId>-<prNumber>-<headSha>
                                   ▼
                                 Redis (BullMQ "review" queue)
                                   │
                                   ▼
                                 worker
                                   │ skip if the PR head moved on or the PR is closed
                                   │ fetch the diff for base...head, read head files
                                   ▼
                                 runReview()  (packages/review-core, same code as the CLI)
                                   │ scrub secrets → build S0/S1 context within a token budget
                                   │ → Gemini/Claude, structured output → validate → dedupe → rank → cap
                                   ▼
                                 Postgres (review + every candidate comment)
                                   │
                                   ▼
                                 POST one COMMENT review with the selected inline comments
```

A comment survives only if it sits on a line the diff shows and quotes evidence that exists in
the code. The worker posts nothing when no comment survives. Each (PR head commit, strategy
config) pair is reviewed at most once. [ADR 0003](docs/adr/0003-llm-layer-and-review-pipeline.md)
has the details.

Only the `opened` and `synchronize` actions on `pull_request` start a review. The API answers
`ping` and ignores all other events.

## Repository layout

| Path                             | Contents                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `apps/api`                       | Fastify webhook receiver (`/webhooks/github`, `/healthz`)                               |
| `apps/worker`                    | BullMQ consumer that runs the pipeline and posts reviews                                |
| `apps/cli`                       | `reviewlens review`: the same pipeline on a local diff or git range                     |
| `packages/review-core`           | Strategies, prompts, validation, dedupe: `runReview()`                                  |
| `packages/context-engine`        | tree-sitter parsing, symbol graph, diff mapping, context assembly                       |
| `packages/llm`                   | Provider interface, Claude provider, retries, cache, cost                               |
| `packages/db`                    | Prisma schema, migrations, review persistence                                           |
| `packages/shared`                | Env parsing, logger, OpenTelemetry setup, queue contract, hashing                       |
| `packages/github`                | Octokit App client, PR/compare/contents calls, unified-diff parser                      |
| `eval/benchmark`                 | Benchmark A builder (Python): fix mining, SZZ, manifests, validation                    |
| `eval/harness`                   | Eval harness (Python): experiment specs, runner, matching, metrics, statistics, reports |
| `eval/notebooks`, `eval/results` | Ablation notebook; versioned experiment outputs                                         |
| `infra/`                         | docker-compose, Dockerfile, Postgres init                                               |
| `docs/`                          | Spec and ADRs                                                                           |

Later phases add `services/filter` and `apps/dashboard`.

## Prerequisites

- Node 22 (`.nvmrc`) and pnpm 10 (`corepack enable`)
- Docker, for Postgres and Redis. Any Redis 7 instance works if you run without Docker.
- A tunnel that forwards raw request bytes, for example `cloudflared` or `ngrok`
- One or more Gemini API keys (`GEMINI_API_KEYS`), or an Anthropic key with `LLM_PROVIDER=anthropic`

## Register the GitHub App

1. Start a tunnel to the API port and note the public URL:
   ```sh
   cloudflared tunnel --url http://localhost:3000
   # or: ngrok http 3000
   ```
   Do not use a proxy that re-serializes the JSON body. The signature covers the exact bytes
   that GitHub sends, so a re-serialized body fails verification.
2. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**.
3. Fill in the fields:
   - **Webhook URL**: `https://<your-tunnel-host>/webhooks/github`
   - **Webhook secret**: a long random string, for example from `openssl rand -hex 32`.
     Put the same value in `GITHUB_WEBHOOK_SECRET`.
4. Set **Repository permissions**. Leave all other permissions at "No access".
   - Pull requests: **Read and write**
   - Contents: **Read-only**
   - Metadata: **Read-only** (GitHub makes this mandatory)
5. Under **Subscribe to events**, select **Pull request**, **Pull request review comment** and
   **Push**. Push events to the default branch keep the repository's symbol index current.
6. Create the app. Note the **App ID**.
7. Generate a private key and save the `.pem` file as `reviewlens.private-key.pem` in the repo
   root. `*.pem` files are gitignored.
8. Install the app on a test repository: **Install App → Only select repositories**.

## Run locally

```sh
pnpm install
cp .env.example .env          # then fill in DATABASE_URL, the GitHub App values and GEMINI_API_KEYS
pnpm infra:up                 # Postgres (with pgvector) and Redis in Docker
pnpm db:migrate               # apply database migrations

pnpm dev:api                  # terminal 1: http://localhost:3000
pnpm dev:worker               # terminal 2
```

Open or push to a pull request in the test repository. The worker log shows `review complete`
with the token count, cost and context stats. If any comment survives validation, the PR gets one
review from the app with inline comments. In the app
settings, **Advanced → Recent Deliveries** shows each webhook and lets you redeliver it.

To run everything in containers, use
`docker compose -f infra/docker-compose.yml --profile app up --build`.

### Tracing

Tracing is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set. To view traces locally:

```sh
docker compose -f infra/docker-compose.yml --profile tracing up -d
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm dev:api
```

Then open the Jaeger UI at http://localhost:16686. The HTTP server, Redis calls and BullMQ jobs
are traced. Trace context travels with the job from the API to the worker. Every log line includes
`trace_id` and `span_id` when a span is active.

## Review a diff locally

The CLI runs the same `runReview()` as the worker, with no GitHub App, queue or database. It
reads `.env` from the repo root:

```sh
# Print the exact prompt the model would see; no API call, no cost
pnpm review --diff apps/cli/examples/cart/change.diff --repo apps/cli/examples/cart/repo --dry-run

# Real review (needs GEMINI_API_KEYS in .env); the full run is written as JSON
pnpm review --diff apps/cli/examples/cart/change.diff --repo apps/cli/examples/cart/repo   --strategy S1 --out run.json

# A commit range in any local git repository, with call-graph context
pnpm review --git ../some-repo --base HEAD~1 --head HEAD --strategy S4 --parse-cache .cache/parse

# Embedding retrieval; the embedding cache makes later runs fast
pnpm review --git ../some-repo --base HEAD~1 --head HEAD --strategy S2 \
  --parse-cache .cache/parse --embed-cache .cache/embed

# Conventions and past bug fixes (history is read up to the base commit only)
pnpm review --git ../some-repo --base HEAD~1 --head HEAD --strategy S5 --parse-cache .cache/parse

# Index a repository and print symbol/edge counts, timing and the most-called symbols
pnpm reviewlens index --git ../some-repo --parse-cache .cache/parse
```

For S3/S4 the summary also lists every symbol added to the context, with its relation to the
change (enclosing, callee, caller) and its graph distance.

The summary goes to stderr and lists each selected comment and each rejected one with its
reason.

## Benchmark A

Real changes that introduced a bug, with the lines a later fix corrected as ground truth. It is
built from local git history by `rlbench`, a dependency-free Python package:

```sh
cd eval/benchmark
export PYTHONPATH=src
python -m rlbench.cli clone      # bare clones of the repositories in repos.json
python -m rlbench.cli build      # mine fixes, run SZZ, write manifests/benchmark-a.v1.json
python -m rlbench.cli stats --cutoff 2026-01-01
python -m rlbench.cli sample --size 100 && python -m rlbench.cli label --sample validation/<file>
```

[eval/benchmark/README.md](eval/benchmark/README.md) explains how a case is made, the known
weaknesses of blame-based SZZ, and how to validate a sample.
[ADR 0007](docs/adr/0007-benchmark-a.md) records the design.

## Evaluation

The harness runs strategy configurations over Benchmark A through the same pipeline as the
worker, and scores them: bug-catch recall@k with bootstrap confidence intervals, paired
comparisons between strategies, localization, comments per review, tokens, cost and latency.

```sh
make eval-smoke                          # synthetic end-to-end check; no model or network
make eval EXPERIMENT=E1-strategies       # run or resume an experiment, then score it
```

Experiments E1 to E7 are YAML files in `eval/harness/experiments`. Runs are resumable and stop
cleanly when the model's quota runs out. Results (`summary.json`, `report.md`, `pareto.png`) go
to `eval/results/<experiment>/<spec hash>/`, and `eval/notebooks/ablation.ipynb` renders them.
[eval/harness/README.md](eval/harness/README.md) has the matching rules and metric definitions;
[ADR 0008](docs/adr/0008-eval-harness.md) records the design.

## Development

```sh
pnpm test        # vitest, all packages
pnpm typecheck   # tsc against package sources
pnpm lint        # eslint + prettier --check
pnpm build       # tsc emit, in dependency order
```

CI (`.github/workflows/ci.yml`) runs the same four commands on every push and pull request.

## Configuration

| Variable                      | Used by | Default                  | Notes                                                     |
| ----------------------------- | ------- | ------------------------ | --------------------------------------------------------- |
| `GITHUB_WEBHOOK_SECRET`       | api     | (required)               | Must match the App's webhook secret                       |
| `GITHUB_APP_ID`               | worker  | (required)               |                                                           |
| `GITHUB_APP_PRIVATE_KEY_PATH` | worker  |                          | Path to the `.pem` file                                   |
| `GITHUB_APP_PRIVATE_KEY`      | worker  |                          | Inline key; `\n` escapes allowed; preferred over the path |
| `REDIS_URL`                   | both    | `redis://localhost:6379` |                                                           |
| `PORT`, `HOST`                | api     | `3000`, `0.0.0.0`        |                                                           |
| `WORKER_CONCURRENCY`          | worker  | `4`                      |                                                           |
| `DATABASE_URL`                | worker  | (required)               | Postgres connection string                                |
| `LLM_PROVIDER`                | worker  | `gemini`                 | `gemini` or `anthropic`                                   |
| `GEMINI_API_KEYS`             | worker  | (required for gemini)    | Comma-separated; rotated when a key is rate-limited       |
| `GEMINI_FREE_TIER`            | worker  | `true`                   | Record cost as 0                                          |
| `ANTHROPIC_API_KEY`           | worker  | (required for anthropic) |                                                           |
| `REVIEW_STRATEGY`             | worker  | `S1`                     | `S0` to `S5` (see the table at the top)                   |
| `INDEX_EMBEDDINGS`            | worker  | `false`                  | Embed indexed symbols into pgvector on each push          |
| `REVIEW_MODEL`                | worker  | provider default         | `gemini-3.8-flash` or `claude-opus-5-5`                   |
| `REVIEW_FALLBACK_MODELS`      | worker  | `gemini-3.5-flash`       | Comma-separated; tried when the model is overloaded       |
| `LLM_CACHE_DIR`               | worker  | (unset)                  | On-disk LLM response cache                                |
| `LOG_LEVEL`                   | both    | `info`                   |                                                           |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | both    | (unset, so tracing off)  | OTLP/HTTP base URL                                        |
