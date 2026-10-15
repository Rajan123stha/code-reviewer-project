// Shapes returned by the dashboard queries and served by the dashboard API. Kept free of
// database imports so the browser client can import them as types.
import type { FeedbackOutcome } from './outcomes.js';

export interface DailyCount {
  /** UTC day, YYYY-MM-DD. */
  date: string;
  reviews: number;
  comments: number;
}

export interface OverviewStats {
  repositories: number;
  pullRequests: number;
  reviews: { total: number; posted: number; failed: number; running: number };
  comments: { candidates: number; posted: number };
  /** Posted comments with at least one feedback observation that yields a label. */
  feedback: { labeled: number; useful: number; outcomes: Record<FeedbackOutcome, number> };
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  /** Over the latest 1,000 finished reviews with an LLM call. Null without any. */
  latencyMs: { p50: number | null; p95: number | null };
  /** The last `days` UTC days, oldest first, including days with no reviews. */
  daily: DailyCount[];
}

export interface RepositorySummary {
  id: number;
  fullName: string;
  reviews: number;
  postedComments: number;
  labeled: number;
  useful: number;
  costUsd: number;
  lastReviewAt: string | null;
}

export interface ReviewSummary {
  id: number;
  repository: string;
  pullNumber: number;
  pullTitle: string;
  headSha: string;
  strategy: string;
  model: string;
  servedModel: string | null;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  latencyMs: number | null;
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  candidates: number;
  posted: number;
  error: string | null;
}

export interface CandidateDetail {
  index: number;
  file: string;
  line: number;
  category: string;
  severity: string;
  claim: string;
  evidence: string;
  suggestedFix: string | null;
  status: string;
  rejectReason: string | null;
  duplicateOf: number | null;
  rank: number | null;
  llmConfidence: number;
  filterScore: number | null;
  posted: boolean;
  githubCommentId: number | null;
  outcomes: FeedbackOutcome[];
  label: 0 | 1 | null;
}

export interface ReviewDetail extends ReviewSummary {
  configHash: string;
  config: unknown;
  promptVersion: string;
  promptHash: string | null;
  schemaName: string | null;
  featuresVersion: string | null;
  filterModel: string | null;
  fallbackUsed: boolean;
  cacheReadTokens: number | null;
  llmAttempts: number | null;
  contextStats: unknown;
  redactions: unknown;
  githubReviewId: number | null;
  candidateList: CandidateDetail[];
}

export interface GroupAcceptance {
  key: string;
  posted: number;
  labeled: number;
  useful: number;
}

export interface FeedbackEvent {
  id: number;
  repository: string;
  pullNumber: number;
  reviewId: number;
  file: string;
  line: number;
  category: string;
  claim: string;
  outcome: FeedbackOutcome;
  source: string;
  observedAt: string;
}

export interface FeedbackSummary {
  byCategory: GroupAcceptance[];
  bySeverity: GroupAcceptance[];
  recent: FeedbackEvent[];
}

export interface ReviewQuery {
  repositoryId?: number | undefined;
  status?: string | undefined;
  /** Case-insensitive match on the PR title or the repository name. */
  search?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}
