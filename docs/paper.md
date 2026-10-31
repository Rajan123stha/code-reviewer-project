<!-- Template for docs/paper.md. Edit this file, then run `make paper`; never edit paper.md by
hand. Directives in double braces are replaced with numbers read from result files. -->

# Reviewlens: measuring what repository context buys an LLM code reviewer

> This report is generated. Every number in it is read from a file in the repository at
> generation time (see Provenance at the end). Sections whose experiments have not been run
> say so instead of showing numbers.

## Abstract

Reviewlens is a GitHub App that reviews pull requests with a large language model and decides
which of the model's comments to post. It varies how much repository context the model sees,
from the diff alone to a call graph, conventions and past bug fixes, and it can pass each
comment through a refuting second look and a learned usefulness filter. Each choice is measured
on Benchmark A: 1,022 bug-introducing changes from 22
open-source TypeScript and JavaScript repositories, located from their later fixes with
blame-based SZZ. The measure is whether a posted comment lands on the lines that were later
fixed. This report describes the system, the benchmark and the evaluation method; the results
sections below report each ablation as far as it has been run.

## 1. Questions

- **RQ1.** How does bug-catch recall change as the reviewer sees more structural repository
  context: the changed files, similar code, the changed symbols and their callees, callers out
  to a call-graph depth, and repository conventions plus past bugs?
- **RQ2.** At a fixed context strategy, how do the token budget and call-graph depth trade
  recall against cost?
- **RQ3.** Can a learned usefulness filter, and separately a refuting verifier pass, cut
  low-value comments while keeping most of the true-bug recall?

## 2. System

A review is a pure function of the pull request's diff, a read-only snapshot of the
repository at its head commit, and a versioned strategy configuration. The production worker
and the evaluation harness call the same function. No code from a reviewed repository is
ever executed; secrets are scrubbed from every text before it reaches a model.

1. **Context.** The diff is always included. Strategies add, within one token budget:
   S1 the full changed files; S2 the code most similar to the change by embedding; S3 the
   changed symbols and the definitions they call, from a tree-sitter symbol graph; S4 S3 plus
   callers and callees out to a configurable depth; S5 S4 plus repository conventions and
   summaries of earlier bug fixes to the same files, restricted to fixes committed before the
   change.
2. **Generation.** The model returns structured comments: file, line, category, severity,
   claim, quoted evidence, suggested fix and its own confidence.
3. **Validation.** A comment is rejected unless its line is one the diff shows and its quoted
   evidence occurs in the code. Near-duplicates are merged.
4. **Verifier (optional).** One more model call per pass checks every remaining comment
   against the same context and is asked to refute it. Comments it does not uphold are dropped.
5. **Filter (optional).** A logistic-regression or gradient-boosted model scores each comment
   from features computed in the pipeline (comment, location, review and centrality features);
   comments below a threshold are dropped and the rest are ranked by score.
6. **Posting.** At most a fixed number of comments are posted as one review. What happens to
   them afterwards (changed lines, resolved threads, reactions) is recorded as feedback.

## 3. Benchmark A

**Construction.** For each repository, commits whose message marks a fix (a conventional
`fix` type, or a fix keyword with an issue reference) are traced back with blame: the lines a
fix removed or rewrote are attributed to the commits that introduced them
(`szz-blame-v1`). A case is the introducing commit's diff from its parent, reviewed against the repository at
that commit, with the fixed lines as ground truth. Fixes larger than 120 changed
lines, fixes not touching product source, and fixes whose blame points mostly elsewhere (less
than 60% on one commit) are dropped, each with a recorded reason. At
most 60 cases are kept per repository.

**Size.** 1,022 cases from 859 distinct changes in
22 repositories (manifest `dd725ab4f8e05de1`).
649 cases come from conventional-commit fix types and
373 from fix keywords. The median time from introduction to fix is
197 days.

| Repository | Language | Commits scanned | Fix commits | Cases |
| --- | --- | ---: | ---: | ---: |
| `fastify/fastify` | JavaScript | 4,886 | 173 | 60 |
| `expressjs/express` | JavaScript | 6,000 | 127 | 60 |
| `yargs/yargs` | TypeScript | 1,871 | 168 | 60 |
| `axios/axios` | JavaScript | 2,207 | 183 | 60 |
| `nodejs/undici` | JavaScript | 4,299 | 173 | 60 |
| `iamkun/dayjs` | JavaScript | 1,657 | 175 | 60 |
| `immerjs/immer` | TypeScript | 1,571 | 112 | 60 |
| `markedjs/marked` | TypeScript | 3,864 | 118 | 60 |
| `knex/knex` | JavaScript | 3,212 | 226 | 60 |
| `mochajs/mocha` | JavaScript | 4,208 | 224 | 60 |
| `Automattic/mongoose` | JavaScript | 6,000 | 155 | 60 |
| `colinhacks/zod` | TypeScript | 3,247 | 239 | 58 |
| `pmndrs/zustand` | TypeScript | 1,382 | 145 | 49 |
| `hapijs/hapi` | JavaScript | 5,804 | 137 | 45 |
| `pinojs/pino` | JavaScript | 2,012 | 127 | 42 |
| `sindresorhus/execa` | JavaScript | 848 | 133 | 37 |
| `sindresorhus/got` | TypeScript | 1,742 | 145 | 33 |
| `sindresorhus/ky` | TypeScript | 549 | 77 | 30 |
| `node-fetch/node-fetch` | JavaScript | 640 | 61 | 23 |
| `cheeriojs/cheerio` | TypeScript | 4,414 | 77 | 22 |
| `koajs/koa` | JavaScript | 1,311 | 53 | 13 |
| `tj/commander.js` | JavaScript | 1,517 | 43 | 10 |

**Label noise.** A fix can rewrite lines that were not wrong. A seeded sample of 100 cases is
set aside for manual validation; the noise rate is not yet measured: none of the 100 sampled cases has been labeled, so recall figures carry an unknown share of label noise.

## 4. Evaluation method

- **Hit.** A posted comment in a ground-truth file within 3 lines of a ground-truth line. The
  comment's text is not checked, so this over-credits nearby comments about something else;
  comment precision is measured separately on a labeled sample.
- **Metrics.** Recall@k over each review's first k posted comments; file-level recall;
  comments per review (the noise proxy); ground-truth precision (a lower bound); tokens, cost
  and latency from the model's own usage reports, including verifier calls.
- **Statistics.** Each case is averaged over repeated runs; 95% percentile bootstrap intervals
  over cases; paired bootstrap differences against a baseline arm on identical cases; exact
  McNemar tests on majority-of-runs outcomes; run-to-run standard deviation.
- **Control.** One pinned model with no fallback in every arm; cached model responses make a
  repeat of the same run free while each run index is an independent sample. Arms that differ
  only after generation (verifier, filter) share one cached review per input and run.
- **Separation.** The learned filter is trained on 15 repositories and evaluated (E5) on 7
  others, fixed before any training; the harness refuses to evaluate a model on a repository it
  was trained on.

## 5. Results

### 5.1 Context strategies (RQ1, E1)

> **Not yet run.** No scored results for `E1-strategies` exist in `eval/results`. Run `make eval EXPERIMENT=E1-strategies` and regenerate this report.

### 5.2 Token budget (RQ2, E2)

> **Not yet run.** No scored results for `E2-token-budget` exist in `eval/results`. Run `make eval EXPERIMENT=E2-token-budget` and regenerate this report.

### 5.3 Call-graph depth (RQ2, E3)

> **Not yet run.** No scored results for `E3-graph-depth` exist in `eval/results`. Run `make eval EXPERIMENT=E3-graph-depth` and regenerate this report.

### 5.4 Verifier pass (RQ3, E4)

> **Not yet run.** No scored results for `E4-verifier` exist in `eval/results`. Run `make eval EXPERIMENT=E4-verifier` and regenerate this report.

### 5.5 Learned filter (RQ3, E5)

Training, by leave-one-repo-out cross-validation on the training repositories:

> **Not yet trained.** No filter training report exists in `services/filter/reports`. Collect training reviews (`make eval EXPERIMENT=F1-filter-data`), then `make filter-train`, and regenerate this report.

Effect on held-out repositories:

> **Not yet run.** No scored results for `E5-filter` exist in `eval/results`. Run `make eval EXPERIMENT=E5-filter` and regenerate this report.

### 5.6 Model (E6) and past-bug retrieval (E7)

> **Not yet run.** No scored results for `E6-models` exist in `eval/results`. Run `make eval EXPERIMENT=E6-models` and regenerate this report.

> **Not yet run.** No scored results for `E7-past-bugs` exist in `eval/results`. Run `make eval EXPERIMENT=E7-past-bugs` and regenerate this report.

### 5.7 Pilot

A small live check of the harness, kept for transparency:

*Small live check of the harness: two strategies, one run, six review inputs.* 7 cases from 6 changes, 1 run(s) per arm; a hit is a posted comment within 3 lines of a line the fix changed. Source: `eval/results/pilot/0da722a2b9e2/summary.json`.

> **Small sample (7 cases).** The intervals below are too wide to rank arms; this result shows that the experiment ran, not which arm is better.

| Arm | Recall@1 | Recall@10 [95% CI] | File recall | Comments / review | GT precision | Tokens in | p50 time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| S0 (baseline) | 14.3% | 14.3% [0.0%, 42.9%] | 42.9% | 0.83 | 20.0% | 6,664 | 35 s |
| S4 | 28.6% | 28.6% [0.0%, 57.1%] | 28.6% | 1.00 | 33.3% | 9,117 | 19 s |

| Paired, recall@10 | Difference | 95% CI | Caught only by arm / baseline | McNemar p |
| --- | ---: | ---: | ---: | ---: |
| S4 vs S0 | +14.3% | [0.0%, 42.9%] | 1 / 0 | 1.000 |

## 6. Threats to validity

- **Construct.** Location-only matching rewards comments near the bug for the wrong reason and
  misses correct comments placed on the caller that exposes it.
- **Labels.** SZZ attributes fixed lines to the last commit that touched them, which is not
  always the commit that introduced the bug; the noise rate above bounds this once measured.
- **Contamination.** The repositories are public and may be in the model's training data. The
  harness can split recall by whether a case was fixed before or after a cutoff date
  (`date_split` in each summary); this report does not show that split yet.
- **Model drift.** A hosted model name can be served by different versions over time; every
  run records the model that actually served it.
- **Scale.** Free-tier quotas limited how many reviews could be run; sections with fewer than
  30 scored cases say so.

## 7. Reproducing

```sh
make eval-smoke                         # end-to-end check with scripted model output
make eval EXPERIMENT=E1-strategies      # run or resume an experiment, then score it
make paper                              # regenerate this report
```

## References

- J. Śliwerski, T. Zimmermann, A. Zeller. When do changes induce fixes? MSR 2005. (The SZZ
  algorithm, of which the benchmark uses a blame-based variant.)

## Provenance

Generated 2026-10-31 09:50 UTC at commit `ba09845` by `python -m rlharness.cli paper` from:

- `eval/benchmark/manifests/benchmark-a.v1.json`
- `eval/results/pilot/0da722a2b9e2/summary.json`
