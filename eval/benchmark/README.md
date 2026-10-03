# Benchmark A: bug-introducing changes from real fix history

Each case is a real change that introduced a bug, together with the lines that a later fix
removed or rewrote. A reviewer is given the change; it scores a hit when it comments on those
lines. The builder is `rlbench`, a dependency-free Python package.

The manifest holds metadata only: commit ids, paths, line numbers, dates and commit subjects.
Source code stays in the upstream repositories under their own licenses.

## Build it

```sh
python -m venv ../.venv && ../.venv/Scripts/pip install pytest ruff mypy   # once
export PYTHONPATH=src                                                      # or `pip install -e .`

python -m rlbench.cli clone      # bare clones into ~/.cache/reviewlens/repos (override: REVIEWLENS_CACHE)
python -m rlbench.cli build      # writes manifests/benchmark-a.v1.json
python -m rlbench.cli stats --cutoff 2026-01-01
```

Clones are kept outside the project because they are large and must not be committed.
`clone` stops when free disk space falls below `--min-free-gb` (default 1.5).

## How a case is made

1. **Find fix commits.** A non-merge commit whose subject has a fix keyword (`fix`, `bug`,
   `regression`, `crash`, …) or a `fix:` type, and whose message references an issue or pull
   request (`#N`). Docs, chore, CI, test, refactor, dependency, typo, lint and revert commits
   are rejected. See `fixes.py`.
2. **Keep small, focused fixes.** The fix must change product source (not only tests, docs,
   fixtures or build output), in at most 5 source files and 120 changed lines.
3. **SZZ (`szz-blame-v1`).** For each line the fix deleted or replaced, skipping blank,
   comment-only and punctuation-only lines, `git blame -w -M -C` at the fix's parent names the
   commit that last changed it. `-w` ignores whitespace-only edits; `-M -C` follows moved and
   copied lines.
4. **Pick the introducing commit.** The commit that owns the largest share of the blamed lines,
   if that share is at least 60%. Otherwise the case is dropped as ambiguous.
5. **Check the introducing commit.** It must be a non-merge, non-root commit, at most 30 files
   and 1,500 changed lines.
6. **Ground truth.** The blamed lines that the introducing commit itself added, as line numbers
   in that commit. Lines that are not in its diff are discarded, because a reviewer could not
   have commented on them.

The case's review input is `base_sha...head_sha`, where `head_sha` is the introducing commit and
`base_sha` its parent. Cases with the same `input_key` are the same review with different bugs.

Every threshold is in `BuildConfig` (`cases.py`) and is written into the manifest, with the
count of fix commits dropped for each reason per repository.

## Known weaknesses

Blame-based SZZ is a heuristic. The manual validation below measures how often it is wrong.

- **Fixes that only add code** (a missing check) have nothing to blame and are skipped, so the
  benchmark under-represents omission bugs.
- **Blame names the last commit to touch a line.** A refactor that reworded buggy logic gets
  the blame instead of the commit that wrote the bug.
- **A fix can change lines that were not wrong** (a behavior change described as a fix, or a
  cleanup done alongside the fix).
- **Fix detection is keyword-based.** Without a GitHub token the builder cannot confirm that
  the referenced issue was labeled as a bug.
- **Squash merges** make one commit equal one pull request, which is what we want. In
  repositories that merge without squashing, a case is a single commit of a larger pull request.

## Validate a sample

```sh
python -m rlbench.cli sample --size 100 --seed 20261003
python -m rlbench.cli label --sample validation/sample-seed20261003-n100.json --labeler alice
python -m rlbench.cli report
```

`sample` is seeded and takes cases round-robin across repositories, so one large repository
cannot dominate. `label` shows the fix diff, then the introducing change with ground-truth
lines marked `>>`, and appends your verdict to `validation/verdicts.jsonl`:

- **valid**: the marked lines contain or directly cause the defect that the fix corrects.
- **invalid**: the lines were not wrong when written (the fix is a feature, refactor or
  behavior change; the bug lives elsewhere; or blame landed on a commit that only moved code).
- **unsure**: cannot tell from the two diffs.

`report` prints the label-noise rate, `invalid / (valid + invalid)`, with a 95% Wilson
interval, per labeler, and Cohen's kappa when two labelers share cases.

## Contamination

Every case carries `introduced.committed_at` and `fix.committed_at`. `stats --cutoff DATE`
splits cases into those fixed before the date (a model may have seen both the bug and its fix),
those introduced on or after it (unseen), and those that straddle it. Report results per group.

## Development

```sh
../.venv/Scripts/python -m pytest -q     # tests build small git repositories with known bugs
../.venv/Scripts/python -m ruff check . && ../.venv/Scripts/python -m mypy
```
