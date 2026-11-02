import type { ReviewRun, StrategyConfig } from '@reviewlens/review-core';
import type { FixCommit } from '@reviewlens/context-engine';
import { redactSecrets } from '@reviewlens/shared';
import type { Db } from './client.js';
import { fixCommitsBefore } from './knowledge.js';
import type { Prisma } from './generated/prisma/client.js';

export interface PullRequestContext {
  installation: { githubId: number; account: string };
  repository: { githubId: number; fullName: string };
  pullRequest: { number: number; title: string; headSha: string; baseSha: string };
}

/** Create or update the installation and repository rows; returns the repository row id. */
export async function upsertRepository(
  db: Db,
  ctx: Pick<PullRequestContext, 'installation' | 'repository'>,
): Promise<number> {
  const installation = await db.installation.upsert({
    where: { githubInstallationId: BigInt(ctx.installation.githubId) },
    create: {
      githubInstallationId: BigInt(ctx.installation.githubId),
      account: ctx.installation.account,
    },
    update: {},
  });
  const repository = await db.repository.upsert({
    where: { githubRepoId: BigInt(ctx.repository.githubId) },
    create: {
      githubRepoId: BigInt(ctx.repository.githubId),
      fullName: ctx.repository.fullName,
      installationId: installation.id,
    },
    // Repos can be renamed or transferred between installations.
    update: { fullName: ctx.repository.fullName, installationId: installation.id },
  });
  return repository.id;
}

/** Create or update the installation, repository and PR rows; returns the PR row id. */
export async function upsertPullRequest(db: Db, ctx: PullRequestContext): Promise<number> {
  const repositoryId = await upsertRepository(db, ctx);
  const pr = ctx.pullRequest;
  const row = await db.pullRequest.upsert({
    where: { repositoryId_number: { repositoryId, number: pr.number } },
    create: { repositoryId, ...pr },
    update: { title: pr.title, headSha: pr.headSha, baseSha: pr.baseSha },
  });
  return row.id;
}

export type StartedReview =
  | { reviewId: number; alreadyPosted: false }
  | { reviewId: number; alreadyPosted: true; githubReviewId: bigint | null };
export type StartReviewResult = StartedReview | { limited: 'rate_limited' | 'budget_exceeded' };

export interface StartReviewArgs {
  pullRequestId: number;
  headSha: string;
  config: StrategyConfig;
  configHash: string;
  limits?: StartLimits | undefined;
}

/** Usage caps checked when a new review starts (null: no cap). */
export interface StartLimits {
  githubRepoId: number;
  /** Start of the usage window, e.g. 24 hours ago. */
  since: Date;
  maxReviewsPerRepo: number | null;
  maxCostUsdPerInstallation: number | null;
}

type Tx = Prisma.TransactionClient;

/** Namespace for this module's advisory locks (first key of pg_advisory_xact_lock). */
const USAGE_LOCK_NAMESPACE = 0x52_4c; // "RL"

/**
 * Claim the review row for (PR, head commit, config). A row that was already posted is
 * reported so the caller skips posting again; any other existing row (a failed or
 * interrupted attempt) is reset and reused.
 *
 * With `limits`, a new review is admitted only within them, atomically: the usage count and
 * the new row happen under a per-installation advisory lock, so concurrent jobs cannot all
 * pass the check before any of them is recorded. A retry of an existing row is not a new
 * review and is never limited.
 */
export async function startReview(
  db: Db,
  args: StartReviewArgs & { limits?: undefined },
): Promise<StartedReview>;
export async function startReview(db: Db, args: StartReviewArgs): Promise<StartReviewResult>;
export async function startReview(db: Db, args: StartReviewArgs): Promise<StartReviewResult> {
  return db.$transaction(async (tx) => {
    const key = {
      pullRequestId_headSha_configHash: {
        pullRequestId: args.pullRequestId,
        headSha: args.headSha,
        configHash: args.configHash,
      },
    };
    let existing = await tx.review.findUnique({ where: key });
    if (!existing && args.limits) {
      const pr = await tx.pullRequest.findUniqueOrThrow({
        where: { id: args.pullRequestId },
        select: { repositoryId: true, repository: { select: { installationId: true } } },
      });
      // Serializes starts within one installation until this transaction ends.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${USAGE_LOCK_NAMESPACE}::int, ${pr.repository.installationId}::int)`;
      const limited = await overLimit(
        tx,
        pr.repositoryId,
        pr.repository.installationId,
        args.limits,
      );
      if (limited) return { limited };
      // Another job for the same key may have created it while this one waited.
      existing = await tx.review.findUnique({ where: key });
    }
    if (existing?.status === 'posted') {
      return {
        reviewId: existing.id,
        alreadyPosted: true,
        githubReviewId: existing.githubReviewId,
      };
    }
    const fields = {
      strategy: args.config.strategy,
      strategyConfig: args.config,
      model: args.config.model,
      promptVersion: args.config.promptVersion,
      status: 'running' as const,
      error: null,
      startedAt: new Date(),
      finishedAt: null,
    };
    if (existing) {
      await tx.candidateComment.deleteMany({ where: { reviewId: existing.id } });
      await tx.review.update({ where: { id: existing.id }, data: fields });
      return { reviewId: existing.id, alreadyPosted: false };
    }
    const created = await tx.review.create({
      data: {
        ...fields,
        pullRequestId: args.pullRequestId,
        headSha: args.headSha,
        configHash: args.configHash,
      },
    });
    return { reviewId: created.id, alreadyPosted: false };
  });
}

async function overLimit(
  tx: Tx,
  repositoryId: number,
  installationId: number,
  limits: StartLimits,
): Promise<'rate_limited' | 'budget_exceeded' | null> {
  if (limits.maxReviewsPerRepo !== null) {
    const reviews = await tx.review.count({
      where: { startedAt: { gte: limits.since }, pullRequest: { repositoryId } },
    });
    if (reviews >= limits.maxReviewsPerRepo) return 'rate_limited';
  }
  if (limits.maxCostUsdPerInstallation !== null) {
    const cost = await tx.review.aggregate({
      where: { startedAt: { gte: limits.since }, pullRequest: { repository: { installationId } } },
      _sum: { costUsd: true },
    });
    if (Number(cost._sum.costUsd ?? 0) >= limits.maxCostUsdPerInstallation)
      return 'budget_exceeded';
  }
  return null;
}

/** Store the pipeline result: run metadata on the review, every candidate as a row. */
export async function completeReview(db: Db, reviewId: number, run: ReviewRun): Promise<void> {
  const llm = run.llm;
  await db.$transaction([
    db.review.update({
      where: { id: reviewId },
      data: {
        status: 'completed',
        servedModel: llm?.servedModel ?? null,
        fallbackUsed: llm?.fallbackUsed ?? false,
        promptHash: run.prompt.contentHash,
        schemaName: run.schemaName,
        contextStats: run.context as unknown as Prisma.InputJsonValue,
        redactions: run.redactions,
        tokensIn: llm?.usage.inputTokens ?? 0,
        tokensOut: llm?.usage.outputTokens ?? 0,
        cacheReadTokens: llm?.usage.cacheReadInputTokens ?? 0,
        cacheWriteTokens: llm?.usage.cacheCreationInputTokens ?? 0,
        costUsd: llm?.costUsd ?? (llm ? null : 0),
        latencyMs: llm ? Math.round(llm.latencyMs) : 0,
        llmAttempts: llm?.attempts ?? 0,
        llmRequestId: llm?.requestId ?? null,
        featuresVersion: run.featuresVersion,
        ...(run.verifier ? { verifier: run.verifier as unknown as Prisma.InputJsonValue } : {}),
        filterModel: run.filter?.modelVersion ?? null,
        finishedAt: new Date(run.finishedAt),
      },
    }),
    db.candidateComment.createMany({
      data: run.candidates.map((c) => ({
        reviewId,
        index: c.index,
        filePath: c.file,
        line: c.line,
        category: c.category,
        severity: c.severity,
        claim: c.claim,
        evidence: c.evidence,
        suggestedFix: c.suggested_fix,
        body: c.body,
        llmConfidence: c.confidence,
        filterScore: c.filterScore,
        verifierAgreement: c.verifierAgreement,
        ...(c.verifierVerdicts.length > 0 ? { verifierVerdicts: c.verifierVerdicts } : {}),
        ...(c.features ? { features: c.features as unknown as Prisma.InputJsonValue } : {}),
        status: c.status,
        rejectReason: c.rejectReason,
        duplicateOfIndex: c.duplicateOf,
        rank: c.rank,
      })),
    }),
  ]);
}

/**
 * Record delivery: the review is final and its selected candidates are live. A null
 * GitHub id means there was nothing to post; the review is still final.
 */
export async function markPosted(
  db: Db,
  reviewId: number,
  githubReviewId: number | null,
): Promise<void> {
  await db.$transaction([
    db.review.update({
      where: { id: reviewId },
      data: {
        status: 'posted',
        githubReviewId: githubReviewId === null ? null : BigInt(githubReviewId),
      },
    }),
    db.candidateComment.updateMany({
      where: { reviewId, status: 'selected' },
      data: { posted: true },
    }),
  ]);
}

export async function markFailed(db: Db, reviewId: number, error: unknown): Promise<void> {
  // Stored and shown in the dashboard: strip anything credential-shaped first.
  const message = redactSecrets(
    error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  );
  await db.review.update({
    where: { id: reviewId },
    data: { status: 'failed', error: message.slice(0, 4_000), finishedAt: new Date() },
  });
}

/** The persistence operations the review worker needs; lets tests use an in-memory fake. */
export interface ReviewStore {
  upsertPullRequest(ctx: PullRequestContext): Promise<number>;
  startReview(args: StartReviewArgs): Promise<StartReviewResult>;
  completeReview(reviewId: number, run: ReviewRun): Promise<void>;
  markPosted(reviewId: number, githubReviewId: number | null): Promise<void>;
  markFailed(reviewId: number, error: unknown): Promise<void>;
  /** Stored fix commits of a repository (by GitHub id) committed before a date. */
  fixCommitsBefore(githubRepoId: number, before: Date): Promise<FixCommit[]>;
}

export function createReviewStore(db: Db): ReviewStore {
  return {
    upsertPullRequest: (ctx) => upsertPullRequest(db, ctx),
    startReview: (args) => startReview(db, args),
    completeReview: (id, run) => completeReview(db, id, run),
    markPosted: (id, ghId) => markPosted(db, id, ghId),
    markFailed: (id, err) => markFailed(db, id, err),
    fixCommitsBefore: (repoId, before) => fixCommitsBefore(db, repoId, before),
  };
}
