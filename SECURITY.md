# Security

Reviewlens reads untrusted code and untrusted pull request text, sends some of it to a language
model, and posts the model's answer back to GitHub. This document lists the threats that follow
from that, what defends against each one, and which tests check the defense. Design decisions
are recorded in [ADR 0014](docs/adr/0014-secret-management.md) (secrets),
[ADR 0015](docs/adr/0015-trust-boundaries.md) (input validation and rate limits) and
[ADR 0016](docs/adr/0016-ai-security.md) (model-specific threats).

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Use GitHub's private vulnerability reporting on
this repository (Security tab, "Report a vulnerability"). Include the affected component, a way
to reproduce it and the impact you expect. Expect a first reply within 7 days.

## Trust model

| Source                                         | Trusted?                | Notes                                                          |
| ---------------------------------------------- | ----------------------- | -------------------------------------------------------------- |
| Operator configuration (`.env`, strategy YAML) | Yes                     | Validated at startup; secrets never logged.                    |
| GitHub webhook body                            | After signature check   | HMAC over the raw bytes; every field used is schema-checked.   |
| Pull request title, description, diff, files   | No                      | Anyone who can open a pull request controls them.              |
| `.reviewlens.yml` in the reviewed repository   | No                      | Size-capped, strict schema; can only narrow what is reviewed.  |
| Model output                                   | No                      | The model may have followed instructions planted in the input. |
| Reactions on posted comments                   | Only from the PR author | They become training labels.                                   |
| Dashboard requests                             | Local operator only     | Bound to loopback, Host allowlist, token, lockout.             |

Reviewed code is never executed: repositories are parsed with tree-sitter and read through git,
never built, installed or run.

## Model threats (OWASP Top 10 for LLM applications, 2025)

| Risk                                   | Exposure in Reviewlens                              | Defense                                                                                                                                                                                                      | Tests                                                                |
| -------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| LLM01 Prompt injection                 | PR text and code comments can carry instructions.   | Untrusted text sits inside tagged blocks, and the prompt's own tag names are escaped in it, so it cannot close a block. Output is validated: a comment must point at a changed line and quote real evidence. | `ai-security.test.ts`, `scripts/redteam.mjs`                         |
| LLM02 Sensitive information disclosure | Diffs and files may contain credentials.            | Secrets are redacted from the diff, title, description and every file before any model call; logs redact secret fields and secret-shaped strings.                                                            | `ai-security.test.ts`, `redact.test.ts`, `redteam.mjs` (secret case) |
| LLM03 Supply chain                     | npm and PyPI dependencies; the model provider.      | Lockfiles, `pnpm audit --prod --audit-level high` in CI, pinned scanner image. Model and prompt versions are recorded with every review.                                                                     | CI `audit` job                                                       |
| LLM04 Data and model poisoning         | Reactions and outcomes train the usefulness filter. | Only the PR author's reactions count; bots and other accounts are ignored. Resolution labels come from code changes, not from votes.                                                                         | `feedback.test.ts`                                                   |
| LLM05 Improper output handling         | Model text is posted as GitHub markdown.            | Prose is made inert (no mentions, images, links or HTML); quoted code goes in a fence longer than any backtick run in it; lengths are capped.                                                                | `ai-security.test.ts`, `redteam.mjs` (markdown case)                 |
| LLM06 Excessive agency                 | The app can write to pull requests.                 | The model has no tools. It returns JSON; code decides what to post. Permissions are pull requests read/write, contents read-only. No auto-fix, no approvals, no merges.                                      | `pipeline.test.ts` (schema validation)                               |
| LLM07 System prompt leakage            | The prompt could be echoed into a comment.          | The prompt holds no secrets and is public in this repository, so leaking it reveals nothing.                                                                                                                 | n/a                                                                  |
| LLM08 Vector and embedding weaknesses  | S2 ranks code by embedding similarity.              | Retrieval ranks only symbols from the reviewed snapshot. The embedding cache is keyed by a hash of the text and model, so a hit returns a vector, never another repository's text.                           | By construction                                                      |
| LLM09 Misinformation                   | Wrong review comments.                              | Evidence must exist in the diff or file, an optional verifier pass can refute comments, and the learned filter drops low-value ones. Every claim is measured on Benchmark A.                                 | `verify.test.ts`, eval harness                                       |
| LLM10 Unbounded consumption            | Huge PRs or bodies; repeated webhooks.              | Diff byte, line and file caps; title and body truncation; context token budget; per-repository and per-installation review and cost caps (atomic); webhook and dashboard rate limits.                        | `ai-security.test.ts`, `limits` tests, `rate-limit.test.ts`          |

## Red-team script

`node scripts/redteam.mjs` builds five small repositories, each with one planted bug and one
attack (instructions in the description, instructions in a code comment, a credential the PR asks
the model to quote, tags that try to close the prompt's blocks, and a request for a tracking image,
link and mention). Without flags it checks only the prompt and runs in CI. With `--live` it also
calls the configured model and checks that a per-run canary never appears in a posted comment,
that no secret does, and that posted comments carry no live markdown. It records whether the
planted bug was still found. Results go to `eval/results/security/`.

## Residual risks

- A model that follows injected instructions can still write misleading but inert text on a
  valid changed line. Validation limits where a comment goes and what it renders, not what it says.
- The PR author's own reactions still decide that PR's labels. An author can rate comments on
  their own pull request dishonestly.
- The Redis-backed rate limiter is tested with a fake client only.
- The Docker images and Compose setup are built in CI but not exercised end to end.
- Secret redaction is pattern-based; a credential with no recognizable shape is not caught.
