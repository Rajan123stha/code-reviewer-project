# ADR 0016: Model-specific security (prompt injection, output handling, label poisoning)

- Status: accepted
- Date: 2026-11-02

## Context

ADR 0015 covers classic input validation. A model in the loop adds threats of its own: the
input can carry instructions, the output is attacker-influenced text that the app posts under
its own name, and user reactions to that output become training data. An audit against the
OWASP Top 10 for LLM applications found five issues, each first reproduced by a failing test in
`packages/review-core/src/ai-security.test.ts` (5 of 8 failed before the fix), plus one in
feedback collection (`apps/worker/src/feedback.test.ts`).

| Finding                                                                                                                          | Fix                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A PR title, description, diff or file could contain `</diff>` or `</pull_request>` and continue as if outside the data           | `neutralizePromptTags` escapes the prompt's own tag names (`<` to `&lt;`) in every untrusted field            |
| The same breakout worked through comment fields fed to the verifier and the judge                                                | Same escaping in `verify.ts` and `judge.ts`                                                                   |
| Model prose was posted as live markdown: `@mentions` notified people, `![](url)` loaded tracking images, links and HTML rendered | `inertMarkdown` breaks mentions, images and links with a zero-width space and escapes `<`, outside code spans |
| Evidence containing three backticks closed its fence and the rest rendered as markdown                                           | `codeFence` uses a fence one longer than the longest backtick run                                             |
| Title and body were unbounded (a 1 MB body went into the prompt)                                                                 | Title capped at 300 characters, body at 6,000, with a `[truncated]` marker                                    |
| Any account's reactions on a public repository became filter labels                                                              | Only the PR author's reactions count; the closed-PR job carries the author's login                            |

## Decisions

- **Escape our tag names, not all markup.** Diffs legitimately contain `<div>` and generics like
  `Array<string>`. Escaping only the fixed set of tag names the prompt uses keeps code readable
  to the model while making every closing tag in untrusted text distinguishable from a real one.
  Random per-request delimiters were considered; they hurt prompt caching and reproducibility
  (the pipeline is a pure function of its inputs) for no gain over escaping.
- **Make output inert rather than strip it.** Removing `@` or `](` would change code-like text
  in claims. A zero-width space keeps the text readable while GitHub no longer links it. Code
  spans and fences are left untouched because GitHub already renders them inert.
- **Validation is the main injection defense.** No prompt wording reliably stops a model from
  following injected text. What limits damage is structural: the model has no tools, a comment
  must point at a changed line with real evidence, and the posted text is inert.
- **Author-only feedback.** Counting only the PR author makes labels cheap to trust and matches
  who the comment addresses. Maintainer reactions are lost; a later version could add accounts
  with write access, at the cost of one permission lookup per reactor.

## Verification

`scripts/redteam.mjs` runs five attack cases through the real CLI. Offline (in CI) it checks
that attack text reaches the prompt, that planted secrets do not, and that tag breakouts are
escaped. With `--live` it also calls the model and checks that a per-run canary, the secrets and
live markdown never reach a posted comment. Results are kept in `eval/results/security/`.

## Consequences

- An injected instruction can still change what a valid comment says. That residual risk is
  listed in `SECURITY.md`.
- Comments addressed to people (`@user`) no longer notify them; that is intended.
