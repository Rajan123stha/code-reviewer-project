# Deploying Reviewlens

One small server runs everything: the webhook API, the worker, the dashboard, Redis, and
optionally the learned filter. Postgres can run alongside them or be a managed service with
pgvector (the development database is Neon).

```
GitHub ──HTTPS──▶ reverse proxy (TLS) ──▶ api :3000 ──▶ Redis ──▶ worker ──▶ GitHub reviews
                         │                                           │
                         └──(password)──▶ dashboard :4000 ◀── Postgres ◀─┘
                                                              filter :8000 (optional)
```

## What you need

- A Linux host with Docker and Docker Compose, a public DNS name, and ports 80/443 open.
- A GitHub App (see the README's "Register the GitHub App"): webhook URL
  `https://<your-host>/webhooks/github`, events Pull request, Pull request review comment,
  Pull request review thread and Push.
- A Gemini API key (or several, comma-separated) or an Anthropic key.

## Steps

1. **Configure.** Copy `.env.example` to `.env` (never commit it) and fill in at least
   `POSTGRES_PASSWORD` (a random string), `GITHUB_APP_ID`,
   `GITHUB_WEBHOOK_SECRET`, `GEMINI_API_KEYS` and `DASHBOARD_PASSWORD` (12+ characters).
   Save the App's private key as `reviewlens.private-key.pem` in the repository root.
   For a managed Postgres, set `DATABASE_URL` and remove the `DATABASE_URL` lines from the
   compose services.
2. **Migrate the database** from a machine with the repository and Node 22:

   ```sh
   pnpm install && DATABASE_URL=... pnpm db:migrate
   ```

3. **Start the stack:**

   ```sh
   docker compose --env-file .env -f infra/docker-compose.yml --profile app up -d --build
   ```

   With a trained filter model (`services/filter/models/current.json`), add
   `--profile filter` and set `REVIEW_FILTER_THRESHOLD` in `.env`.

4. **Put TLS in front.** The api and dashboard publish on loopback only. A minimal Caddy
   configuration:

   ```
   reviews.example.com {
     handle /webhooks/* { reverse_proxy 127.0.0.1:3000 }
     handle /healthz    { reverse_proxy 127.0.0.1:3000 }
     handle             { reverse_proxy 127.0.0.1:4000 }
   }
   ```

   The dashboard asks for `DASHBOARD_PASSWORD` (HTTP basic auth, any user name).

5. **Check it.** GitHub's App settings → Advanced → Recent deliveries should show `202` for a
   test pull request; the dashboard should list the review within a minute or two.

## Operating it

- **Limits.** `MAX_REVIEWS_PER_REPO_PER_DAY`, `MAX_COST_USD_PER_INSTALLATION_PER_DAY`,
  `MAX_PR_CHANGED_LINES` and `MAX_PR_CHANGED_FILES` cap usage before any model call.
- **Per-repository settings.** Maintainers can add `.reviewlens.yml` (see the README).
- **Logs** are JSON on stdout (`docker compose logs -f worker`). Set
  `OTEL_EXPORTER_OTLP_ENDPOINT` to send traces; `--profile tracing` starts a local Jaeger.
- **Upgrades.** `git pull`, run `pnpm db:migrate`, then
  `docker compose ... up -d --build`. Migrations are additive.
- **Backups.** Back up Postgres. Redis holds only queued jobs; losing it loses at most
  reviews that had not started.

## Secrets

- Secrets live only in `.env` on the host (or your platform's secret store), never in the
  repository, images or client code. `.env`, `.env.*` and key files are gitignored, and the
  Docker build context excludes them.
- Each service validates its settings at startup and exits naming the missing or malformed
  variable, without printing its value. The dashboard refuses to listen beyond loopback without
  a 12+ character `DASHBOARD_PASSWORD`.
- Logs redact secret fields and secret-shaped strings (keys, tokens, URL passwords), including
  inside error messages; failed-review messages stored in the database are redacted the same way.
- The dashboard client is built without any environment variables, and CI fails if a
  server-only variable name or a secret pattern appears in the bundle. CI also runs gitleaks
  over the full git history.
- To rotate: change the value at the provider (GitHub App settings, Google AI Studio, Neon),
  update `.env`, restart the containers. The webhook secret must match on both sides.

## Not covered

- The images are built in CI but not published to a registry, and this setup has not yet
  been run on a public host.
- One worker process; scaling out means more worker containers against the same Redis.
- No per-user dashboard accounts: one shared password.
