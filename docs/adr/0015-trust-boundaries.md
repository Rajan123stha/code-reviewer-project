# ADR 0015: Trust boundaries, input validation and rate limiting

- Status: accepted
- Date: 2026-11-02

## Context

A review touches several kinds of untrusted input: webhook requests from the internet,
repository contents (diffs, file names, `.reviewlens.yml`), model output, and dashboard
requests from browsers. This records the boundary checks and the rate limits after an audit
in which each finding was first reproduced by a failing test.

## Boundaries and what is enforced

| Boundary               | Input                              | Enforcement                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook (`apps/api`)   | Signed JSON body; unsigned headers | Signature over the raw bytes first. Every field used downstream is validated: ids are positive safe integers, SHAs are 40 hex characters, logins and repository names follow GitHub's formats and lengths. `X-GitHub-Delivery` and `X-GitHub-Event` are not covered by the signature, so they are validated too (a `:` in the delivery id used to make BullMQ throw on every replay). |
| Diffs from GitHub      | Text of any size                   | `MAX_PR_DIFF_BYTES` (5 MB) checked before parsing; line and file limits after.                                                                                                                                                                                                                                                                                                        |
| Repository files       | `.reviewlens.yml`                  | 20 kB cap, YAML alias limit, strict schema (rejects unknown keys, including `__proto__`).                                                                                                                                                                                                                                                                                             |
| Model output           | Structured comments                | Schema-validated; lines must be in the diff, evidence must exist, and claim, evidence and fix have length limits (a 70,000-character claim used to be selected and would fail the GitHub post).                                                                                                                                                                                       |
| Filter service         | JSON over HTTP                     | 1 MB body cap enforced while reading (with or without Content-Length), 500 items, features validated by name, type and allowed values, version checked.                                                                                                                                                                                                                               |
| Dashboard              | Browser requests                   | Host header allowlist (stops DNS rebinding against the loopback dashboard), zod schemas for query, path and body, 64 kB body limit, strict JSON parsing (`__proto__` rejected).                                                                                                                                                                                                       |
| CLI git calls          | Revisions                          | Revision-shaped values only; one starting with `-` would become a git option (`git diff --output=<file>` wrote a file). Commands use argument lists, never a shell.                                                                                                                                                                                                                   |
| Database               | All of the above                   | Prisma APIs and tagged-template raw SQL only; no string-built queries.                                                                                                                                                                                                                                                                                                                |
| Links in the dashboard | Repository names, file paths       | Repository names checked against GitHub's format; path segments URL-encoded, so a file named `a?x#y` cannot change the link. React escapes all text; no raw HTML is rendered.                                                                                                                                                                                                         |

SSRF: no URL in any request or repository is ever fetched. Outbound calls go to GitHub's API
(paths built by Octokit from validated identifiers), the configured model provider, and the
configured filter service.

## Errors

Both HTTP servers answer 4xx with a short statement of what was wrong with the request and 5xx
with `{"error":"internal error"}` only. Details (database hosts, Redis addresses, stack
traces) go to the redacted log. Previously Fastify's default handler returned the internal
error message.

## Rate limiting

| Where                            | Limit (default)                                                                                                                     | Key                      | Store                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------- |
| Webhook requests                 | 600 per minute (`RATE_LIMIT_PER_MINUTE`)                                                                                            | client address           | Redis, shared by all API processes |
| Failed webhook signatures        | 20 per 10 minutes (`SIGNATURE_FAILURES_PER_10_MIN`); then the client is refused, even with a valid signature, until the window ends | client address           | Redis                              |
| Dashboard requests               | 300 per minute                                                                                                                      | client address           | memory (single process)            |
| Wrong dashboard passwords        | 10 per 15 minutes; then locked out                                                                                                  | client address           | memory                             |
| Reviews                          | per repository per day, cost per installation per day                                                                               | repository, installation | Postgres, **atomic**               |
| Changed lines, files, diff bytes | per pull request                                                                                                                    | pull request             | checked before any model call      |

- **Atomic usage caps.** The usage count and the new review row are written in one
  transaction under a per-installation advisory lock. Before, the worker counted, then created
  the row later, so concurrent jobs all passed the check (5 started against a cap of 2 in the
  regression test). A retried job reuses its row and is not counted again.
- **Client addresses behind a proxy.** Limits key on the client address, so `TRUST_PROXY`
  must name the reverse proxy (for example `loopback`, or the Docker network's range when the
  proxy runs on the host). Never trust every address when the service is reachable directly:
  clients could then choose their own address.
- **Failure behaviour.** If Redis is unreachable the webhook returns 500 and GitHub redelivers
  later, the same as when the job queue is down: the limit fails closed.
- `/healthz` is exempt from limits and host checks.

## Known limits

- The dashboard's limiters are per process; it is meant to run as one instance.
- Limits are per address. GitHub delivers from a published set of addresses, so a burst from
  GitHub shares one budget per address; the defaults leave wide margins.
- An attacker who has one validly signed delivery can replay it; replays only produce
  duplicate, idempotent jobs, and the request rate limit bounds them.
