# ADR 0012: Verifier pass

- Status: accepted
- Date: 2026-10-31

## Context

Spec step 4: "optional verifier prompt that tries to refute each candidate". Experiment E4
measures whether it removes wrong comments without removing caught bugs.

## Decisions

1. **One call per pass covers every comment of a review**, each numbered by id, rather
   than one call per comment. On free-tier quotas a review then costs one extra call, not
   ten. The trade: comments in one call can influence each other's verdicts.
2. **The verifier sees exactly what the reviewer saw** (title, description, the same
   context sections) plus the comments. It can only remove comments; it never sees the
   later fix or anything else the reviewer did not have.
3. **The prompt asks it to refute** (`verify/v1`): look for why each comment is wrong before
   accepting it, and treat style preferences as refuted. Verdicts are `upheld`, `refuted`
   or `uncertain`, each with a one-sentence reason that is stored.
4. **Agreement is the mean verdict score over passes** (upheld 1, uncertain 0.5, refuted 0).
   A pass that returns no verdict for a comment counts as uncertain, so a malformed answer
   neither keeps nor drops a comment by itself. Comments below `verifierThreshold`
   (default 0.5) get status `refuted` and are not posted. With one pass, only an explicit
   `refuted` drops a comment.
5. **Passes are independent samples**: each has its own cache salt (`<run salt>|verify-<n>`),
   so three passes are three model answers, while a rerun of the same review costs nothing.
6. **Order in the pipeline**: validate, dedupe, verify, then features, filter, rank and cap.
   The filter scores only what the verifier kept, and `verifierAgreement` becomes a filter
   feature (`features/v1` already reserved it).
7. **Config keys** `verifierPasses` (0 = off), `verifierPromptVersion`, `verifierThreshold`
   are part of the strategy config and its hash. Default off.
8. **Its cost is the review's cost.** The run records each verifier call's usage, cost and
   latency; the harness adds them to the review's tokens, cost and latency, so E4 compares
   arms at their true price.
9. **E4 arms** share one cached review call per input and run, so they are compared on
   identical candidate comments: no verifier, one pass, three passes.

## Verified

- Unit tests: refuting, averaging passes, missing and repeated verdicts, cache salts, no
  call when off or empty, interaction with the filter.
- One live run on the example change (`gemini-3.5-flash` requested): both planted bugs
  upheld with correct reasons.

## Known limits

- **The verifier is the same model as the reviewer.** Its errors are correlated with the
  reviewer's; a different model would be a stronger check and is a later ablation.
- **It can refute true comments.** E4's recall columns measure exactly that cost.
- **Not yet run at scale**: E4 waits on the same Gemini quota as every other experiment.
