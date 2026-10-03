# pilot

Small live check of the harness: two strategies, one run, six review inputs.

- Cases scored: **7** (of 7 selected, 6 review inputs), complete in every arm and run
- Runs per arm: 1; a hit is a posted comment within 3 lines of a line the fix changed
- Spec `0da722a2b9e2`, manifest cases `dd725ab4f8e05de1`, scored 2026-10-03T10:58:44+00:00

## Results

| Arm | Recall@1 | Recall@3 | Recall@5 | Recall@10 | 95% CI (@10) | Run SD | File recall | Localization | Comments / review | GT precision | Context tokens | Tokens in | Tokens out | Cost / review | p50 s | p95 s |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| S0 | 14.3% | 14.3% | 14.3% | 14.3% | 0.0% to 42.9% | 0.0% | 42.9% | 33.3% | 0.83 | 20.0% | 5,252 | 6,664 | 1,465 | $0.0000 | 34.7 | 58.0 |
| S4 | 28.6% | 28.6% | 28.6% | 28.6% | 0.0% to 57.1% | 0.0% | 28.6% | 100.0% | 1.00 | 33.3% | 7,252 | 9,117 | 2,004 | $0.0000 | 19.2 | 33.6 |

## Paired comparison with `S0` (recall@10, same cases)

| Arm | Recall difference | 95% CI | Caught only by arm | Caught only by baseline | McNemar p |
|---|---:|---:|---:|---:|---:|
| S4 | +14.3 pts | +0.0 to +42.9 pts | 1 | 0 | 1.000 |

## Notes

- Recall@k is the share of benchmark bugs with a posted comment on or near the lines the fix later changed, using the first k comments. The claim's text is not checked.
- Localization is line-level recall divided by file-level recall: of the bugs whose file was flagged, how many were flagged on the right lines.
- GT precision is a lower bound: a comment on a real problem that is not a benchmark bug counts as a miss.
- Run SD is the spread of recall between repeats of the same config.
- Reviews failed: 0; not yet run: 0.
