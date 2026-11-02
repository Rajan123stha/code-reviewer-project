# ADR 0011: Dashboard

- Status: accepted
- Date: 2026-10-15

## Context

The spec calls for a Next.js dashboard showing reviews, feedback and experiment results.
The development machine has about 1.2 GB of free disk. Next.js 16 with its compiler is about
300 MB installed, plus a build cache of a few hundred more; Vite with React is about 40 MB.

## Decisions

1. **Vite + React single-page client, served by a small Fastify server** (`apps/dashboard`),
   instead of Next.js. Disk is the reason; nothing in the dashboard needs server-side
   rendering. The server is a JSON API over `@reviewlens/db` plus static files, so moving the
   client to Next.js later replaces only `src/client`.
2. **Read-only.** The dashboard reads the database and `eval/results`; it never writes.
   Queries live in `packages/db/src/dashboard.ts` and are tested against PGlite with the real
   migrations. Their response types (`@reviewlens/db/dashboard-types`) have no database
   imports, so the browser client shares them instead of redeclaring them.
3. **Every number comes from stored rows or result files.** Experiment pages render the
   harness's `summary.json` as written; nothing is recomputed in the browser. Pages with
   under 30 scored cases say that the sample is too small to rank strategies.
4. **Private by default.** It listens on 127.0.0.1. Listening on any other address requires
   `DASHBOARD_PASSWORD` (HTTP basic auth, compared in constant time), because review data
   contains code from the reviewed repositories. Responses carry a restrictive
   Content-Security-Policy; inline style attributes are allowed, scripts only from the app.
5. **Demo mode** (`pnpm dashboard:demo`) starts an in-memory Postgres (PGlite), applies the
   migrations, writes synthetic reviews through the same store functions the worker uses,
   and shows a "Demo data" banner on every page. It never touches a configured database.
6. **Charts follow fixed rules**: one series per chart, one axis, columns at most 24 px with
   rounded data ends, text in ink colors rather than series colors, a tooltip on hover and
   keyboard focus, and a table view of the same data. A state (review status, comment
   status, feedback outcome) always pairs its color with a distinct shape and a word.
   Charts are drawn at the measured pixel width so their text does not scale.
7. **Light and dark are both designed**, not inverted, and follow the system setting unless
   the viewer picks one.
8. **Quoted code is shown without font ligatures.** The evidence a comment quotes must read
   exactly as written; ligature fonts render `<=` as `≤`.

## Known limits

- **Basic auth is a single shared password**, not per-user accounts or GitHub sign-in.
- **No live updates**: pages fetch on load and on navigation.
- **Per-repository queries** run one set of aggregates per repository, fine for tens of
  repositories, not thousands.
- **Checked by screenshots in headless Edge** at 1400 px and 492 px (the smallest window it
  allows), light and dark. Not checked with a screen reader or on a real phone.
- **No Docker image or deployment yet.**
