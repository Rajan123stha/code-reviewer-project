# ADR 0014: Secret management

- Status: accepted
- Date: 2026-11-02

## Context

The services handle a GitHub App private key and webhook secret, model API keys, a database
connection string and a dashboard password. An audit (2026-11-02) scanned tracked files, every
line ever added in git history (all refs), build output, local run logs and the LLM response
cache for known secret formats and for the exact values in the local `.env`. Nothing real was
found: `.env` has never been committed, and the only matches were synthetic test fixtures.

## Decisions

1. **Secrets live only in `.env` (or a platform secret store).** `.env`, `.env.*` (except
   `.env.example`), `*.pem`, `*.key`, `*.p12` and `*.pfx` are gitignored and excluded from
   Docker build contexts. `.env.example` holds placeholders and non-secret defaults only.
2. **No hardcoded credentials, even for local development.** The Docker Postgres password
   comes from `POSTGRES_PASSWORD` in `.env`; compose fails without it. Postgres, Redis, the API,
   the dashboard and Jaeger are published on loopback only.
3. **Startup validation, by name.** Each service validates its configuration with a schema
   before it opens a port or a connection, and exits naming every missing or malformed
   variable without printing its value. Secrets have a minimum length and placeholder values
   are rejected; the worker requires the model key its provider needs.
4. **Logs never carry secrets.** The shared logger censors known secret fields at any depth
   and passes every string, error messages and stacks included, through `redactSecrets` (API
   keys, tokens, private keys, URL passwords). Error text stored in the database and the CLI's
   diagnostic lines get the same treatment. Gemini keys are only ever named by label (`key#2`).
5. **Nothing server-side in the browser.** The dashboard client reads no configuration; Vite
   is built with `envDir: false`, so no `.env` file is loaded into the bundle. CI scans the
   built client for secret patterns and for server-only variable names.
6. **Scanning in CI**: gitleaks over the full history (redacted output), and
   `scripts/secret-scan.mjs` over tracked files and history. The script never prints a matched
   value; synthetic fixtures are marked `gitleaks:allow`.

## Known limits

- The local scan used the repository's own pattern scanner; gitleaks runs only in CI.
- Pattern scanning cannot recognize every secret format; exact-value checks need the `.env`.
- The project directory is synced by OneDrive, so the local `.env` is copied to that cloud
  account. Moving the working copy out of a synced folder removes that exposure.
- Rows written before this change (failed-review messages) were stored unredacted; none
  contained credentials in the audit, but they were not rewritten.
