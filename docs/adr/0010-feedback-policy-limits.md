# ADR 0010: Feedback capture, repository policy and usage limits

- Status: accepted
- Date: 2026-10-06

## Context

Three things the app needs before other people install it: a record of what happened to
each comment it posted (the online label source for the filter), a way for a repository to
tune or switch off reviews, and caps so one repository cannot consume the service.

## Decisions

### Feedback capture

1. **Observations, not a single verdict.** `comment_feedback` holds one row per
   (comment, outcome, source). A comment can collect several. Writes are upserts on that
   triple, so redelivered webhooks and retried jobs change nothing.
2. **Four signals, from three events**, handled by a `feedback` queue and worker:

   | Event                                 | Outcome recorded                                                               |
   | ------------------------------------- | ------------------------------------------------------------------------------ |
   | `pull_request.synchronize`            | `resolved_with_change` for comments whose lines changed since they were posted |
   | `pull_request_review_thread.resolved` | `dismissed`, unless the comment already has `resolved_with_change`             |
   | `pull_request.closed`                 | `thumbs_up` / `thumbs_down` from reactions; `ignored` if nothing else happened |

   GitHub sends no webhook for reactions, so they are read once, when the pull request closes.

3. **"Changed" means within 3 lines**: the later diff removes or rewrites a line within 3
   lines of the comment, inserts next to it, or deletes the file. The diff is taken from the
   commit the comment was made on to the new head, so line numbers match across several
   pushes. The tolerance equals the benchmark's.
4. **Nothing is recorded after a force-push.** If the old commit is not an ancestor of the new
   head, its line numbers cannot be mapped onto the diff. A missing observation is better
   than a wrong one.
5. **One label per comment** (`feedbackLabel`): thumbs-down = 0, else thumbs-up = 1, else
   resolved with change = 1, else dismissed or ignored = 0, else no label yet. An explicit
   reaction outranks what is inferred.
6. **Posted comments are linked to GitHub's ids** right after posting, by path and body.
   A failure to link is logged and does not fail the job: the review is already posted, and
   retrying would post it twice.
7. **Feedback reaches the filter as training rows**: `pnpm export:feedback` writes labeled
   comments with their stored features; `rlfilter dataset --feedback` merges them, dropping
   any from a benchmark test repository.

### Repository policy (`.reviewlens.yml`)

8. **Read from the base commit**, never the pull request's head: a pull request cannot
   switch off or loosen its own review.
9. **It narrows; it does not reconfigure.** Keys: `enabled`, `max_comments`, `min_severity`,
   `categories`, `ignore` (globs). Strategy, model and prompts are not settable, so a policy
   cannot change what an ablation measures. The policy is part of the pipeline's input
   (`ReviewInput.policy`) and is stored in the run.
10. **An invalid file is ignored as a whole** and logged; the review runs with defaults.
    Unknown keys are errors, so a typo cannot silently half-apply.
11. **Suppressed comments are kept** with status `suppressed`, not discarded, so the effect of
    a policy is visible in the data.

### Usage limits

12. **Checked before any LLM call**: reviews per repository and LLM cost per installation
    over the last 24 hours (from the `reviews` table), and the size of the change (files,
    changed lines). A review over a limit is skipped with a reason; nothing is posted.
13. **Defaults**: 100 reviews per repository per day, 5,000 changed lines, 200 files, no cost
    cap. Each is an environment variable; 0 switches a limit off.

## Known limits

- **`resolved_with_change` over-counts**: lines near a comment can change for unrelated
  reasons. **`ignored` under-counts usefulness**: an author can fix a problem in a later pull
  request. Feedback labels are noisy in both directions.
- **Thread resolution needs the App to subscribe** to "Pull request review thread" events.
- **Reactions are read once**, at close; later reactions are missed.
- **The cost cap does nothing on free-tier keys**, whose cost is recorded as 0.
- **Limits are not atomic**: concurrent jobs can each pass the check and exceed a cap by up
  to the worker's concurrency.
- **Not verified against GitHub**: the App credentials are not configured here, so these
  paths are covered by tests with a fake GitHub client only.
- **`repoCategoryAcceptRate`** (a filter feature) is still null; computing it from this
  feedback is future work.
