# ADR 0013: Semantic matching with a calibrated judge

- Status: accepted
- Date: 2026-10-31

## Context

Location matching (ADR 0008) counts a posted comment within 3 lines of a fixed line as a hit,
whatever it says. It over-credits nearby comments about something else and misses correct
comments placed elsewhere in the file. The spec asks for a "calibrated LLM judge second".

## Decisions

1. **Candidates are comments in a ground-truth file**, within the first max-k posted
   comments of a review. That includes the location hits and the comments placed elsewhere
   in the same file.
2. **The judge sees the later fix** (its diff limited to ground-truth files, its subject and
   the fixed line numbers) and the comment, and answers `same_bug`, `different_issue` or
   `unclear` (prompt `match/v1`). The precision judge, by contrast, never sees the fix.
3. **Semantic recall@k** counts a case caught in a run when one of its first k comments is
   judged `same_bug`. `unclear` and unjudged pairs count as misses, so with incomplete
   coverage the figure is a lower bound, and the report states the coverage.
4. **Pairs are keyed by content** (case, file, line, claim), not by arm or run. Arms that
   share a cached model response share judgments, and `rlharness match` is resumable.
5. **Calibration is reported with every semantic figure.** A person labels a sample of pairs
   in the dashboard (`pnpm label`, "Bug matching"); the report gives agreement and Cohen's
   kappa with the judge, and says "not calibrated" when there are no labels. The paper
   generator repeats that qualification next to the numbers.
6. **Location recall stays the primary metric.** Semantic recall is reported beside it, not
   instead of it, because it depends on a model.

## Known limits

- The judge is a language model and may share blind spots with the reviewer, especially
  when both are the same model.
- A comment in a different file from the fix (on the caller that exposes the bug) is still
  never credited.
- Judging costs one model call per distinct pair; `rlharness plan` does not count these yet.
