import type { Db } from './client.js';
import type {
  CandidateDetail,
  DailyCount,
  FeedbackSummary,
  GroupAcceptance,
  OverviewStats,
  RepositorySummary,
  ReviewDetail,
  ReviewQuery,
  ReviewSummary,
} from './dashboard-types.js';
import { feedbackLabel, FEEDBACK_OUTCOMES, type FeedbackOutcome } from './outcomes.js';

export type * from './dashboard-types.js';
import type { Prisma } from './generated/prisma/client.js';

// Read-only queries behind the dashboard. Every number is computed from stored rows;
// nothing is estimated or filled in.

const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function overviewStats(db: Db, days = 30, now = new Date()): Promise<OverviewStats> {
  const [repositories, pullRequests, statusGroups, candidates, posted, totals, latencies] =
    await Promise.all([
      db.repository.count(),
      db.pullRequest.count(),
      db.review.groupBy({ by: ['status'], _count: true }),
      db.candidateComment.count(),
      db.candidateComment.count({ where: { posted: true } }),
      db.review.aggregate({ _sum: { costUsd: true, tokensIn: true, tokensOut: true } }),
      db.review.findMany({
        where: { latencyMs: { gt: 0 }, finishedAt: { not: null } },
        select: { latencyMs: true },
        orderBy: { finishedAt: 'desc' },
        take: 1_000,
      }),
    ]);
  const byStatus = Object.fromEntries(statusGroups.map((g) => [g.status, g._count]));

  const outcomes = Object.fromEntries(FEEDBACK_OUTCOMES.map((o) => [o, 0])) as Record<
    FeedbackOutcome,
    number
  >;
  const feedbackRows = await db.commentFeedback.findMany({
    select: { candidateCommentId: true, outcome: true },
  });
  const perComment = new Map<number, FeedbackOutcome[]>();
  for (const row of feedbackRows) {
    const outcome = row.outcome as FeedbackOutcome;
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    perComment.set(row.candidateCommentId, [
      ...(perComment.get(row.candidateCommentId) ?? []),
      outcome,
    ]);
  }
  let labeled = 0;
  let useful = 0;
  for (const list of perComment.values()) {
    const label = feedbackLabel(list);
    if (label === null) continue;
    labeled++;
    useful += label;
  }

  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const recent = await db.review.findMany({
    where: { startedAt: { gte: start } },
    select: { startedAt: true, _count: { select: { candidates: { where: { posted: true } } } } },
  });
  const daily = new Map<string, DailyCount>();
  for (let i = 0; i < days; i++) {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + i);
    daily.set(utcDay(day), { date: utcDay(day), reviews: 0, comments: 0 });
  }
  for (const review of recent) {
    const entry = daily.get(utcDay(review.startedAt));
    if (!entry) continue;
    entry.reviews++;
    entry.comments += review._count.candidates;
  }

  const sorted = latencies.map((l) => l.latencyMs!).sort((a, b) => a - b);
  return {
    repositories,
    pullRequests,
    reviews: {
      total: statusGroups.reduce((n, g) => n + g._count, 0),
      posted: byStatus.posted ?? 0,
      failed: byStatus.failed ?? 0,
      running: byStatus.running ?? 0,
    },
    comments: { candidates, posted },
    feedback: { labeled, useful, outcomes },
    costUsd: num(totals._sum.costUsd),
    tokensIn: num(totals._sum.tokensIn),
    tokensOut: num(totals._sum.tokensOut),
    latencyMs: { p50: percentile(sorted, 50), p95: percentile(sorted, 95) },
    daily: [...daily.values()],
  };
}

export async function listRepositories(db: Db): Promise<RepositorySummary[]> {
  const repos = await db.repository.findMany({ orderBy: { fullName: 'asc' } });
  const out: RepositorySummary[] = [];
  for (const repo of repos) {
    const inRepo = { review: { pullRequest: { repositoryId: repo.id } } };
    const [reviews, postedComments, lastReview, labeledRows] = await Promise.all([
      db.review.aggregate({
        where: { pullRequest: { repositoryId: repo.id } },
        _count: true,
        _sum: { costUsd: true },
      }),
      db.candidateComment.count({ where: { ...inRepo, posted: true } }),
      db.review.findFirst({
        where: { pullRequest: { repositoryId: repo.id } },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
      }),
      db.candidateComment.findMany({
        where: { ...inRepo, posted: true, feedback: { some: {} } },
        select: { feedback: { select: { outcome: true } } },
      }),
    ]);
    let labeled = 0;
    let useful = 0;
    for (const row of labeledRows) {
      const label = feedbackLabel(row.feedback.map((f) => f.outcome as FeedbackOutcome));
      if (label === null) continue;
      labeled++;
      useful += label;
    }
    out.push({
      id: repo.id,
      fullName: repo.fullName,
      reviews: reviews._count,
      postedComments,
      labeled,
      useful,
      costUsd: num(reviews._sum.costUsd),
      lastReviewAt: lastReview?.startedAt.toISOString() ?? null,
    });
  }
  return out;
}

const reviewInclude = {
  pullRequest: {
    select: { number: true, title: true, repository: { select: { fullName: true } } },
  },
  _count: { select: { candidates: true } },
} satisfies Prisma.ReviewInclude;

type ReviewRow = Prisma.ReviewGetPayload<{ include: typeof reviewInclude }>;

function toSummary(row: ReviewRow, posted: number): ReviewSummary {
  return {
    id: row.id,
    repository: row.pullRequest.repository.fullName,
    pullNumber: row.pullRequest.number,
    pullTitle: row.pullRequest.title,
    headSha: row.headSha,
    strategy: row.strategy,
    model: row.model,
    servedModel: row.servedModel,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    latencyMs: row.latencyMs,
    costUsd: row.costUsd === null ? null : Number(row.costUsd),
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    candidates: row._count.candidates,
    posted,
    error: row.error,
  };
}

export async function listReviews(
  db: Db,
  query: ReviewQuery = {},
): Promise<{ items: ReviewSummary[]; total: number }> {
  const search = query.search?.trim();
  const where: Prisma.ReviewWhereInput = {
    ...(query.status ? { status: query.status as Prisma.ReviewWhereInput['status'] } : {}),
    pullRequest: {
      ...(query.repositoryId !== undefined ? { repositoryId: query.repositoryId } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' } },
              { repository: { fullName: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    },
  };
  const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
  const [rows, total] = await Promise.all([
    db.review.findMany({
      where,
      include: reviewInclude,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      skip: Math.max(query.offset ?? 0, 0),
    }),
    db.review.count({ where }),
  ]);
  const postedCounts = await db.candidateComment.groupBy({
    by: ['reviewId'],
    where: { reviewId: { in: rows.map((r) => r.id) }, posted: true },
    _count: true,
  });
  const posted = new Map(postedCounts.map((p) => [p.reviewId, p._count]));
  return { items: rows.map((r) => toSummary(r, posted.get(r.id) ?? 0)), total };
}

export async function reviewDetail(db: Db, id: number): Promise<ReviewDetail | null> {
  const row = await db.review.findUnique({
    where: { id },
    include: {
      ...reviewInclude,
      candidates: {
        orderBy: { index: 'asc' },
        include: { feedback: { select: { outcome: true } } },
      },
    },
  });
  if (!row) return null;
  const candidateList: CandidateDetail[] = row.candidates.map((c) => {
    const outcomes = c.feedback.map((f) => f.outcome as FeedbackOutcome);
    return {
      index: c.index,
      file: c.filePath,
      line: c.line,
      category: c.category,
      severity: c.severity,
      claim: c.claim,
      evidence: c.evidence,
      suggestedFix: c.suggestedFix,
      status: c.status,
      rejectReason: c.rejectReason,
      duplicateOf: c.duplicateOfIndex,
      rank: c.rank,
      llmConfidence: c.llmConfidence,
      filterScore: c.filterScore,
      posted: c.posted,
      githubCommentId: c.githubCommentId === null ? null : Number(c.githubCommentId),
      outcomes,
      label: feedbackLabel(outcomes),
    };
  });
  return {
    ...toSummary(row, candidateList.filter((c) => c.posted).length),
    configHash: row.configHash,
    config: row.strategyConfig,
    promptVersion: row.promptVersion,
    promptHash: row.promptHash,
    schemaName: row.schemaName,
    featuresVersion: row.featuresVersion,
    filterModel: row.filterModel,
    fallbackUsed: row.fallbackUsed,
    cacheReadTokens: row.cacheReadTokens,
    llmAttempts: row.llmAttempts,
    contextStats: row.contextStats,
    redactions: row.redactions,
    githubReviewId: row.githubReviewId === null ? null : Number(row.githubReviewId),
    candidateList,
  };
}

export async function feedbackSummary(db: Db, recentLimit = 25): Promise<FeedbackSummary> {
  const posted = await db.candidateComment.findMany({
    where: { posted: true },
    select: { category: true, severity: true, feedback: { select: { outcome: true } } },
  });
  const group = (keyOf: (c: (typeof posted)[number]) => string): GroupAcceptance[] => {
    const groups = new Map<string, GroupAcceptance>();
    for (const c of posted) {
      const key = keyOf(c);
      const g = groups.get(key) ?? { key, posted: 0, labeled: 0, useful: 0 };
      g.posted++;
      const label = feedbackLabel(c.feedback.map((f) => f.outcome as FeedbackOutcome));
      if (label !== null) {
        g.labeled++;
        g.useful += label;
      }
      groups.set(key, g);
    }
    return [...groups.values()].sort((a, b) => b.posted - a.posted || a.key.localeCompare(b.key));
  };
  const recent = await db.commentFeedback.findMany({
    orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
    take: recentLimit,
    include: {
      candidateComment: {
        select: {
          filePath: true,
          line: true,
          category: true,
          claim: true,
          review: {
            select: {
              id: true,
              pullRequest: {
                select: { number: true, repository: { select: { fullName: true } } },
              },
            },
          },
        },
      },
    },
  });
  return {
    byCategory: group((c) => c.category),
    bySeverity: group((c) => c.severity),
    recent: recent.map((f) => ({
      id: f.id,
      repository: f.candidateComment.review.pullRequest.repository.fullName,
      pullNumber: f.candidateComment.review.pullRequest.number,
      reviewId: f.candidateComment.review.id,
      file: f.candidateComment.filePath,
      line: f.candidateComment.line,
      category: f.candidateComment.category,
      claim: f.candidateComment.claim,
      outcome: f.outcome as FeedbackOutcome,
      source: f.source,
      observedAt: f.observedAt.toISOString(),
    })),
  };
}

/** The queries the dashboard server needs; lets its tests use a fake. */
export interface DashboardStore {
  overview(): Promise<OverviewStats>;
  repositories(): Promise<RepositorySummary[]>;
  reviews(query: ReviewQuery): Promise<{ items: ReviewSummary[]; total: number }>;
  review(id: number): Promise<ReviewDetail | null>;
  feedback(): Promise<FeedbackSummary>;
}

export function createDashboardStore(db: Db): DashboardStore {
  return {
    overview: () => overviewStats(db),
    repositories: () => listRepositories(db),
    reviews: (query) => listReviews(db, query),
    review: (id) => reviewDetail(db, id),
    feedback: () => feedbackSummary(db),
  };
}
