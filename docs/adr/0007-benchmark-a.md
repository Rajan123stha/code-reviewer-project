# ADR 0007: Benchmark A construction (fix mining and SZZ)

- Status: accepted
- Date: 2026-10-03

## Context

Every claim the project makes rests on Benchmark A: real changes that introduced a bug, with
the lines a later fix corrected as ground truth. It has to be reproducible from public
history, honest about its noise, and cheap to rebuild.

## Decisions

1. **Python, standard library only** (`eval/benchmark`, package `rlbench`). It runs on 3.10 and
   3.11; the spec says 3.11 and this machine has 3.10. No dependency means nothing to pin for
   reproducibility. pytest, ruff and mypy are development tools only.
2. **Local git history, not the GitHub API.** Repositories are cloned bare with full history
   and mined with `git log`, `git diff` and `git blame`. There is no rate limit, a rebuild is
   deterministic for a given repository head, and no token is needed. The cost is that fix
   detection cannot see issue labels; `rlbench enrich` adds them when `GITHUB_TOKEN` is set,
   with every response cached on disk.
3. **Fix detection is strict.** A fix keyword or `fix:` type in the subject, plus a reference
   to an issue or pull request, minus docs, chore, CI, test, refactor, dependency, typo, lint
   and revert commits. This is stricter than the retrieval heuristic in ADR 0006, because a
   false fix here becomes a false benchmark case.
4. **SZZ variant `szz-blame-v1`**: blame each non-trivial line the fix deleted or replaced, at
   the fix's parent, with `-w -M -C`. The introducing commit is the one owning at least 60% of
   those lines. Fixes that only add lines are skipped.
5. **A case is one commit.** `base_sha` is the introducing commit's parent and `head_sha` the
   commit itself. Most of the chosen repositories squash-merge, so a commit is a pull request;
   the pull request number is recorded when the subject ends in `(#N)`.
6. **Ground truth is restricted to lines the introducing commit added**, expressed as line
   numbers in that commit. Blamed lines outside its diff are discarded, since no reviewer
   could have commented there.
7. **One case per (introducing commit, fix).** Cases sharing an `input_key` are one review
   input with several bugs, so the harness reviews each input once.
8. **Every filter is recorded.** Thresholds live in `BuildConfig` and are written into the
   manifest, along with per-repository counts of fix commits dropped for each reason.
9. **The manifest holds metadata only** (commit ids, paths, line numbers, dates, subjects), so
   it can be published without redistributing source code. Each case carries its repository's
   license.
10. **Dates on every case** (`introduced.committed_at`, `fix.committed_at`) support the
    contamination split: fixed before a model's cutoff, introduced after it, or straddling it.
11. **Manual validation is built in**: a seeded sample taken round-robin across repositories,
    an interactive labeling command, the noise rate with a Wilson interval, and Cohen's kappa
    for a second labeler.
12. **Clones live outside the project** (`~/.cache/reviewlens/repos`, or `REVIEWLENS_CACHE`),
    because they are large and the project directory is synced by OneDrive. `clone` refuses to
    continue below a free-space threshold.
13. **A git call that runs over 60 seconds is abandoned** and the fix is dropped as
    `blame_failed`, so one pathological history cannot stall a build.

## Repository set

22 TypeScript and JavaScript repositories (see `eval/benchmark/repos.json`): single-package or
small, actively maintained, permissively licensed, with commit messages that reference issues
or pull requests. Large monorepos are left out for v1. All 22 clone into about 310 MB.

## Result (manifest v1, built 2026-10-03)

- **1,022 cases** from 22 repositories, covering **859 distinct review inputs**. Cases hash
  `dd725ab4f8e05de1`. The build takes about 15 minutes.
- 3,071 fix commits were considered. 2,049 were dropped:

  | Reason                                               | Fix commits |
  | ---------------------------------------------------- | ----------: |
  | Fix touches no product source (tests, docs, build)   |         596 |
  | Ambiguous provenance (top commit under 60% of lines) |         453 |
  | Fix too large (over 120 changed lines)               |         361 |
  | Nothing to blame (fix only adds lines)               |         317 |
  | Introducing change too large                         |         275 |
  | Fix touches too many files                           |          34 |
  | Introduced by root or merge commit, or date order    |          13 |

- Each repository is capped at 60 cases (newest fixes first); 11 repositories hit the cap.
- Median time from introduction to fix: 197 days. Median ground truth: 1 line per case.
- Relative to a 2026-01-01 cutoff: 772 cases fixed before it, 86 introduced after it, 164
  straddling it.
- A 100-case validation sample is drawn (`validation/sample-seed20261003-n100.json`). It has
  not been labeled yet, so the label-noise rate is unknown. A first look at one case showed a
  cosmetic "fix" (a placeholder URL changed), which is the kind of case labeling will reject.

## Validity threats

- **SZZ is a heuristic.** Blame names the last commit to touch a line, which may be a refactor
  rather than the origin of the bug. The noise rate from manual validation bounds this; it is
  not yet measured.
- **Omission bugs are under-represented**, because add-only fixes have nothing to blame.
- **Keyword fix detection** admits behavior changes described as fixes, and misses fixes with
  plain subjects.
- **Selection bias**: small, focused fixes in well-kept repositories are easier than the
  general population of bugs.
- **Contamination**: these are public repositories. Report results split by date.
- **Line-level ground truth** marks where the fix landed, which is not always where a reviewer
  would naturally comment. The matching rule in the eval harness (Phase 6) has to allow for it.
