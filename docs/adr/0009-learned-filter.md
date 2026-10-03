# ADR 0009: Learned usefulness filter

- Status: accepted
- Date: 2026-10-03

## Context

RQ3 asks whether a learned filter can cut low-value comments while keeping most of the
true-bug recall. The filter must run inside the same pipeline in production and in the eval
harness, and its evaluation must not be contaminated by its training data.

## Decisions

### Pipeline

1. **Features are computed in the pipeline, not in the service.** `review-core/src/features.ts`
   produces a `CandidateFeatures` object (version `features/v1`) for every valid candidate
   and stores it in the run output and the database. The dataset builder reads those stored
   values; the service scores those same values. There is one implementation, so no
   train/serve skew. The service only encodes them (one-hot, log scaling).
2. **The filter is two config keys**: `filterThreshold` (null = off) and `filterModel` (pin a
   version; null = any). Both are in the config hash. With the filter on, unique valid
   candidates scoring below the threshold get status `filtered`, and the rest are ranked by
   score instead of by severity and confidence. Threshold 0 re-ranks without dropping.
3. **The scorer is injected** (`ReviewDeps.scorer`), like the LLM client. The pipeline records
   the model version that scored each review, so the run stays a function of its inputs plus
   a named model.
4. **Fail closed.** If the filter is on and the service is down, answers with another
   features version, or serves a model other than the pinned one, the review fails (and the
   queue retries it). Posting unfiltered comments silently would make production behave
   differently from what was measured.
5. **Features never use ground truth** or anything that happens after the review.

### Training data

6. **Labels come from the benchmark and from people.** A candidate is positive if it lands
   within the experiment's line tolerance of a line the later fix changed (the harness's own
   matching function), unless a person labeled it in the precision workflow, in which case
   that verdict wins (valid = 1; nitpick, invalid = 0).
7. **The spec's bootstrap source is not used**: historical human review comments labeled by
   whether a later commit changed the commented lines. Those comments were not produced by
   the pipeline, so most features (model confidence, category, severity, evidence, duplicate
   cluster) do not exist for them, and a model trained on them would learn a different
   distribution from the one it scores. Online accept/dismiss feedback is the right second
   source and arrives with the feedback listeners (Phase 8); `repoCategoryAcceptRate` is
   reserved for it.
8. **Rows are valid, non-duplicate candidates**, whether or not they were posted. Identical
   comments that reach several experiments through the LLM cache are counted once.

### Split hygiene

9. **Fixed repository split**, made with a seeded shuffle before any model existed:
   15 training repositories (707 cases), 7 test repositories (315 cases), in
   `eval/benchmark/splits/filter-split.v1.json`.
10. **Model selection uses training repositories only**, by leave-one-repo-out
    cross-validation. The rule is fixed in advance: LightGBM replaces logistic regression
    only if its out-of-fold AUROC is higher.
11. **E5 reviews test repositories only.** Enforced three times: the dataset builder drops
    test-repository rows and training refuses them; the harness asks the service which
    repositories the served model was trained on and refuses an overlap; and `rlfilter check`
    plus the test suite compare the split file, both experiment files, the dataset and every
    saved model.
12. **E5 pins the model.** The harness writes the served model version to `filter.json` in the
    results directory and refuses to resume with a different one.

### Models and reporting

13. **Logistic regression, then LightGBM**, both unweighted so scores stay probabilities.
    LightGBM uses small trees (7 leaves, at least 10 rows per leaf) because the dataset is
    hundreds of rows.
14. **Reported**: AUROC with a repository-level bootstrap interval, average precision,
    precision@k within a review, Brier score, expected calibration error, a reliability table,
    and a threshold sweep. Every figure is out-of-fold. Ranking by the reviewing model's own
    confidence is reported beside them as the no-learning baseline.
15. **E5 thresholds are operating points**, not round numbers: the scores that keep 75%, 50%
    and 25% of comments, read from the training report. Useful comments are rare, so
    calibrated scores are mostly small and thresholds such as 0.5 would drop nearly everything.
16. **Models are JSON**, not pickles: readable, diffable, and loading one runs no code. The
    version is a hash of the file's parameters; an edited file is refused.

## Status of results

No model has been trained on real data. `F1-filter-data` (60 changes from training
repositories, strategies S1 and S4) stopped after 2 of 120 reviews when the free-tier Gemini
daily quota for `gemini-3.5-flash` ran out; it resumes with the same command. The code paths
are verified on synthetic data: unit tests, and `make filter-smoke`, which trains a synthetic
model, serves it, and checks that the real CLI's scores equal that model's scores.

E5's thresholds in `E5-filter.yaml` are placeholders until the first training report exists.

## Known limits

- **Benchmark negatives are noisy.** A correct comment about a problem the benchmark does not
  know is labeled 0. The filter therefore learns "points at the known bug". Human labels on a
  sample are the remedy, and the builder already prefers them.
- **Small data.** 60 inputs yield a few hundred candidates and perhaps a few dozen positives.
  The report flags datasets under 300 comments or 30 positives as too small for conclusions.
- **Two features are always null** until the verifier and feedback exist, and are not model
  inputs. Giving them columns will be a new model, with the features version unchanged.
- **Symbol centrality is null for S0 to S2**, which build no call graph.
- **The filter adds a network call per review** and a second service to deploy.
