# Learned usefulness filter

Scores each candidate review comment with the probability that it is useful, so the pipeline
can drop low-value comments and post the rest in score order. This package (`rlfilter`, Python)
builds the training set, trains and evaluates the models, and serves the scores over HTTP.

> **No model has been trained on real data yet.** The training reviews (`F1-filter-data`)
> stopped after 2 of 120 when the free-tier Gemini quota ran out. Everything below is
> implemented and tested on synthetic data; there are no filter results to report.

## How it fits

```
review-core (TypeScript)                      services/filter (Python)
  validate, dedupe
  features for each candidate  ── POST /score ──▶  encode features, model.predict
  drop below threshold, rank   ◀── scores ───────
```

- **Features are computed once, in the pipeline** (`packages/review-core/src/features.ts`,
  version `features/v1`) and stored with every candidate. The training set reads those stored
  values and the service scores those same values, so training and serving cannot drift apart.
  The service refuses any other features version.
- **The filter is part of the strategy config**: `filterThreshold` (null = off) and
  `filterModel` (pin a model version). A review with the filter on fails if the service is
  unreachable; it never falls back to posting unfiltered comments.
- **A model version is a hash of the model file.** Each review records the version that scored it.

## Quick start

```sh
export PYTHONPATH=services/filter/src:eval/harness/src:eval/benchmark/src   # ';' on Windows

python -m rlfilter.smoke                    # CLI and service end to end, synthetic model (make filter-smoke)

# 1. Collect candidate comments from the training repositories (calls the LLM; resumable)
python -m rlharness.cli run eval/harness/experiments/F1-filter-data.yaml
# 2. Build the training set, train, and write the report
python -m rlfilter.cli dataset
python -m rlfilter.cli train
python -m rlfilter.cli check                # training and evaluation data are disjoint
# 3. Serve, then measure the filter on repositories it never saw
python -m rlfilter.cli serve                # http://127.0.0.1:8000
FILTER_URL=http://127.0.0.1:8000 python -m rlharness.cli run eval/harness/experiments/E5-filter.yaml
```

Step 2 is `make filter-train`; step 3's server is `make filter-serve`.

## Labels

One row per valid, non-duplicate candidate from a training repository.

| Source      | Label                                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `human`     | A person's verdict from `rlharness label`: valid = 1; nitpick or invalid = 0                                                                       |
| `benchmark` | 1 if the comment is within 3 lines of a line the later bug fix changed, else 0                                                                     |
| `feedback`  | From real pull requests (`pnpm export:feedback`, then `dataset --feedback`): lines changed or thumbs-up = 1; dismissed, ignored or thumbs-down = 0 |

A human label overrides the benchmark label for the same comment. Benchmark zeros are noisy:
a comment about a real problem that the benchmark does not know is labeled 0, so the filter
learns "points at the known bug", which is narrower than "useful".

Not built: labels from historical human review comments (the spec's bootstrap source). See [ADR 0009](../../docs/adr/0009-learned-filter.md).

## Features (`features/v1`)

| Group    | Features                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Comment  | category, severity, model confidence, claim length, evidence lines, has a fix, evidence quoted from added lines                                   |
| Location | file extension, test file, commented line was added, lines changed in the file and the PR, files in the PR, callers of the enclosing symbol       |
| Review   | strategy, duplicate-cluster size, candidates in the review                                                                                        |
| Reserved | verifier agreement, repository acceptance rate per category: always null until the verifier and the feedback loop exist, and not model inputs yet |

## Train/test separation

- `eval/benchmark/splits/filter-split.v1.json` assigns whole repositories to train (15) or
  test (7), with a seeded shuffle made before any model was trained.
- The dataset builder drops rows from test repositories. Training refuses a dataset that has any.
- Metrics come from leave-one-repo-out cross-validation within the training repositories.
- E5 reviews test repositories only. Before it runs, the harness asks the service which
  repositories its model was trained on and stops if one of them is under review.
- `rlfilter check` and the tests fail if the split file, the experiment files, the dataset or
  a saved model disagree with any of this.

## Models and metrics

Logistic regression first, then LightGBM; LightGBM replaces it only if its leave-one-repo-out
AUROC is higher. `train` writes `reports/<dataset hash>/report.md` with, for both models and
for a no-learning baseline (rank by the reviewing model's own confidence):

- AUROC with a 95% interval (bootstrap over repositories) and average precision
- precision@1/3/5 within each review
- calibration: Brier score, expected calibration error, reliability table
- a threshold sweep: share of comments and of useful comments kept at each threshold
- the thresholds that keep 75%, 50% and 25% of comments, to use as E5's arms

The report states when the dataset is too small (under 300 comments or 30 useful ones) for
its numbers to mean anything.

Models are saved as JSON (coefficients, or LightGBM's text format), not pickles.

## Service

| Endpoint      | Body                                             | Returns                                                                   |
| ------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| `GET /health` |                                                  | model version and kind, features version, training repositories           |
| `POST /score` | `{"features_version", "items": [features, ...]}` | `{"model_version", "features_version", "scores"}`, one per item, in order |

`409` for another features version, `422` for malformed features. `FILTER_MODEL` (or
`--model`) selects a model file; the default is the one `models/current.json` names.

## Development

```sh
cd services/filter
../../eval/.venv/Scripts/python -m pytest -q
../../eval/.venv/Scripts/python -m ruff check . && ../../eval/.venv/Scripts/python -m mypy
```
