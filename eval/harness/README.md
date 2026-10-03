# Eval harness

Runs strategy configurations over Benchmark A and scores them. The reviews themselves are done
by the TypeScript CLI (`apps/cli`), which calls the same `runReview()` as the production worker;
this package (`rlharness`, Python) only orchestrates, scores and reports.

## Quick start

```sh
pnpm build                                   # the harness runs apps/cli/dist/main.js
export PYTHONPATH=eval/harness/src:eval/benchmark/src     # ';' instead of ':' on Windows

python -m rlharness.smoke                    # end-to-end check, no model needed (make eval-smoke)
python -m rlharness.cli run eval/harness/experiments/pilot.yaml
python -m rlharness.cli score eval/harness/experiments/pilot.yaml --cutoff 2026-01-01
```

`run` needs the repositories cloned by `rlbench clone` and model credentials in `.env`.

## Experiments

One YAML file per ablation in `experiments/`, matching the plan in `docs/spec.md`:

| File                   | Varies                                   | Status                                         |
| ---------------------- | ---------------------------------------- | ---------------------------------------------- |
| `E1-strategies.yaml`   | Context strategy S0 to S5                | runnable                                       |
| `E2-token-budget.yaml` | Context budget 4k / 8k / 16k / 32k on S4 | runnable                                       |
| `E3-graph-depth.yaml`  | Call-graph depth 0 to 3 on S4            | runnable                                       |
| `E4-verifier.yaml`     | Verifier pass on / off                   | waits for the verifier                         |
| `E5-filter.yaml`       | Learned filter thresholds                | waits for the filter (Phase 7)                 |
| `E6-models.yaml`       | Two LLMs on S4                           | runnable; second arm needs `ANTHROPIC_API_KEY` |
| `E7-past-bugs.yaml`    | Past-bug retrieval on / off in S5        | runnable                                       |
| `pilot.yaml`           | S0 vs S4, 6 inputs, 1 run                | small live check                               |

A spec lists `arms` (a strategy plus config overrides), `base` overrides shared by every arm,
`runs` (repeats per arm), the case sample, `k` values and the matching tolerance. A spec that
`requires` a feature the pipeline lacks is refused instead of silently running without it. The
CLI rejects unknown config keys, so a misspelled override fails instead of testing nothing.

Every experiment pins one model with no fallback (`fallbackModels: []`), so all results are
attributable to that model, and uses `effort: low` to keep sweeps affordable.

## Running

- **Resumable.** Each review is one JSON file under
  `eval/results/<name>/<spec hash>/runs/<arm>/run<N>/`. Re-running skips finished reviews and
  retries failed ones.
- **Quota-aware.** When the model is rate-limited or unavailable the CLI exits with code 3; the
  harness stops and tells you to run the same command again later.
- **Ordered for pairing.** Work goes run by run, input by input, arm by arm, so whatever is
  finished is finished in every arm.
- **Cached.** LLM responses, parsed files and embeddings are cached under
  `~/.cache/reviewlens/eval`. Each repeat uses its own cache salt, so repeats are independent
  samples while a re-run of the same repeat costs nothing.
- **`--workers N`** runs reviews in parallel (default 1, which suits free-tier quotas).
  **`--limit N`** stops after N reviews.
- The results directory is keyed by the spec's hash: changing a spec never mixes old and new runs.

## Matching rules

A review "catches" a benchmark bug when a comment it would post lands on the lines the later fix
changed. The exact rules are the docstring of [`matching.py`](src/rlharness/matching.py); in short:

1. Only `selected` comments count (validated, deduplicated, within `maxComments`), in rank order.
2. File-level hit: the comment's file is a ground-truth file.
3. Line-level hit: a file-level hit within `line_tolerance` lines (default 3) of a ground-truth line.
4. The comment's text is not checked. A comment near the bug about something else still
   counts; the judge and human labels measure that separately.
5. `recall@k` uses the first k comments. Cases sharing a review input are scored separately.
6. Arms are compared only on cases that every arm completed in every run.

## Metrics

| Metric                                   | Meaning                                                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Recall@k                                 | Share of bugs with a line-level hit in the first k comments                                                            |
| 95% CI                                   | Percentile bootstrap over cases (2,000 resamples, seeded); each case is its mean over runs                             |
| Run SD                                   | Standard deviation of recall between repeats of a config                                                               |
| File recall                              | Share of bugs whose file got a comment                                                                                 |
| Localization                             | Line-level recall divided by file-level recall                                                                         |
| Comments / review                        | Mean comments posted: the noise proxy                                                                                  |
| GT precision                             | Share of posted comments on a known bug. A lower bound on precision                                                    |
| Context tokens                           | Estimated tokens of repository context sent                                                                            |
| Tokens in / out, cost, p50 / p95 latency | From the model's own usage report; cached responses are left out of latency                                            |
| Paired comparison                        | Recall difference from the baseline arm on identical cases, with a paired bootstrap interval and an exact McNemar test |

## Comment precision

Recall says nothing about whether the other comments are any good. To measure that:

```sh
python -m rlharness.cli comments experiments/E1-strategies.yaml --size 200   # sample posted comments
python -m rlharness.cli label experiments/E1-strategies.yaml                 # you: valid / nitpick / invalid
python -m rlharness.cli judge experiments/E1-strategies.yaml                 # LLM judge, same items
python -m rlharness.cli score experiments/E1-strategies.yaml                 # adds precision + calibration
```

The sample is stratified by arm and the labeling screen hides the arm. `score` then reports the
valid, nitpick and invalid rates from human labels and from the judge, per arm, and how well the
judge agrees with you (agreement and Cohen's kappa). Report judge-based numbers only alongside
that calibration. The judge prompt is `packages/review-core/prompts/judge/v1`; it sees the diff
of the commented file and the comment, never the later fix.

## Outputs

`score` writes `summary.json` (every number), `report.md` (the tables) and `pareto.png` into the
results directory. [`eval/notebooks/ablation.ipynb`](../notebooks/ablation.ipynb) renders the same
tables and plot from the same scoring code.

## Development

```sh
cd eval/harness
../.venv/Scripts/python -m pytest -q      # metrics and statistics on synthetic cases
../.venv/Scripts/python -m ruff check . && ../.venv/Scripts/python -m mypy
```
