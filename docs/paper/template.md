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
on Benchmark A: {{benchmark.cases}} bug-introducing changes from {{benchmark.repo_count}}
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
(`{{benchmark.szz}}`). A case is the introducing commit's diff from its parent, reviewed against the repository at
that commit, with the fixed lines as ground truth. Fixes larger than {{benchmark.max_fix_changed_lines}} changed
lines, fixes not touching product source, and fixes whose blame points mostly elsewhere (less
than {{benchmark.min_blame_share}} on one commit) are dropped, each with a recorded reason. At
most {{benchmark.max_cases_per_repo}} cases are kept per repository.

**Size.** {{benchmark.cases}} cases from {{benchmark.inputs}} distinct changes in
{{benchmark.repo_count}} repositories (manifest `{{benchmark.hash}}`).
{{benchmark.signal_explicit}} cases come from conventional-commit fix types and
{{benchmark.signal_keyword}} from fix keywords. The median time from introduction to fix is
{{benchmark.median_days_to_fix}} days.

{{table benchmark.repos}}

**Label noise.** A fix can rewrite lines that were not wrong. A seeded sample of 100 cases is
set aside for manual validation; the noise rate is {{benchmark.noise}}.

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

{{experiment E1-strategies}}

### 5.2 Token budget (RQ2, E2)

{{experiment E2-token-budget}}

### 5.3 Call-graph depth (RQ2, E3)

{{experiment E3-graph-depth}}

### 5.4 Verifier pass (RQ3, E4)

{{experiment E4-verifier}}

### 5.5 Learned filter (RQ3, E5)

Training, by leave-one-repo-out cross-validation on the training repositories:

{{filter}}

Effect on held-out repositories:

{{experiment E5-filter}}

### 5.6 Model (E6) and past-bug retrieval (E7)

{{experiment E6-models}}

{{experiment E7-past-bugs}}

### 5.7 Pilot

A small live check of the harness, kept for transparency:

{{experiment pilot}}

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

{{provenance}}
