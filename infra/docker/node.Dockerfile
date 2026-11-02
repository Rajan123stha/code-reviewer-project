# syntax=docker/dockerfile:1
# Builds one Node app from the monorepo. Usage (from the repo root):
#   docker build -f infra/docker/node.Dockerfile --build-arg APP=api .
# APP is api, worker or dashboard. The dashboard image starts with its own command
# (node dist/server/main.js); see infra/docker-compose.yml.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/shared/package.json packages/shared/
COPY packages/github/package.json packages/github/
COPY packages/llm/package.json packages/llm/
COPY packages/review-core/package.json packages/review-core/
COPY packages/db/package.json packages/db/
COPY packages/context-engine/package.json packages/context-engine/
COPY apps/cli/package.json apps/cli/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
# Prisma's client is generated code, not checked in.
RUN pnpm --filter @reviewlens/db generate && pnpm -r build
ARG APP
# Self-contained production bundle: the app, its built workspace deps, prod node_modules only.
RUN pnpm --filter "@reviewlens/${APP}" deploy --prod --legacy /out

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out .
USER node
CMD ["node", "--import", "./dist/instrumentation.js", "dist/main.js"]
