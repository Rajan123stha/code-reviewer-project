# ADR 0008: Eval harness, matching rules and statistics

- Status: accepted
- Date: 2026-10-03

## Context

The harness turns the benchmark and the pipeline into the ablation tables the project is
judged on. It has to run the production pipeline unchanged, survive quota limits, and make
every scoring assumption explicit.

## Decisions

### Orchestration

1. **Python orchestrates; the TypeScript CLI reviews.** One subprocess per review calls
   `apps/cli/dist/main.js review`, which runs `runReview()` exactly as the worker does. The
   harness never re-implements pipeline logic.
2. **Arms are a strategy preset plus `--config-json` overrides.** The strategy config schema
   is strict, so an unknown or misspelled key is an error rather than a silent no-op.
3. **Experiments that need missing features are refused.** E4 (verifier) and E5 (filter)
   declare `requires`; the harness will not run them until those exist.
4. **One pinned model, no fallback, in every experiment** (`gemini-3.5-flash`,
   `fallbackModels: []`), at `effort: low`. Results are attributable to one model. Headline runs
   can raise the effort or change the model in the spec's `base` block.
5. **Resumable by construction.** One JSON file per (arm, run, input); a failure leaves an
   `.error.json`. Work is ordered run, then input, then arm, so a partial experiment is complete
   across arms for the inputs it reached.
6. **Quota is a distinct outcome.** The CLI exits 3 for rate limits and unavailable models;
   the harness stops and can be resumed, instead of recording failures.
7. **Repeats are independent samples.** Each run index is a cache salt. The LLM cache makes a
   re-run of the same repeat free and a new repeat a fresh call.
8. **Results are keyed by spec hash**, and each run file carries its strategy config hash, the
   prompt version and hash, and the model that served it.

### Scoring

9. **Location-only matching** (rules in `matching.py`): a posted comment within
   `line_tolerance` lines (default 3) of a line the fix changed, in the same file. The text of
   the claim is not checked. This is model-free and reproducible, and it over-credits comments
   that are near the bug but about something else. The precision workflow measures that.
10. **Invalid benchmark cases are excluded** when the builder's validation file marks them
    invalid, so label noise found by a human does not count against a strategy.
11. **Comparisons use complete cases only**: cases every arm finished in every run.
12. **Statistics**: percentile bootstrap intervals over cases (each case averaged over its
    runs, so repeats do not narrow the interval), paired bootstrap for differences from the
    baseline, exact McNemar on majority-of-runs outcomes, and the standard deviation of recall
    across runs. All are seeded and use only the standard library.
13. **Precision is measured separately**: a seeded, arm-stratified sample of posted comments,
    labeled blind by a human as valid, nitpick or invalid, and by an LLM judge. The judge's
    agreement with the human (agreement, kappa, confusion matrix) is reported next to any
    judge-based number. The judge never sees the fix.
14. **Ground-truth precision** (comments on a known bug / all comments) is reported as a lower
    bound and labeled as such.

### Verification

15. **`make eval-smoke`** builds a ten-bug repository, makes a manifest with the real builder,
    reviews it through the real CLI with scripted comments (`--fake-llm`), and checks the
    metrics against exact expected values: recall 50%, file recall 60%, localization 83.3%.
    It needs no model and runs in CI.

## Known limits

- **Throughput on free-tier keys.** A review takes tens of seconds, and daily quotas are
  small. E1 as specified (60 inputs, 6 arms, 3 runs) is 1,080 reviews. Run it in resumable
  sessions, lower `cases.sample`, or use paid keys.
- **Location matching misses correct comments placed elsewhere** (for example on the caller
  that exposes the bug) and credits wrong comments placed nearby.
- **A fix can change lines that were not wrong.** Until the validation sample is labeled, the
  benchmark's label-noise rate is unknown and recall figures inherit that uncertainty.
- **The judge is uncalibrated** until human labels exist for the same comments.

## Bug found while building this

Two identical files in a repository have one blob id. Parsed concurrently against a cold
cache, both wrote the same temporary file name and one rename failed. All cache writes now go
through `writeFileAtomic` (unique temporary name, retry on Windows sharing errors).
