import type { Usage } from '@reviewlens/db';

/** Caps that keep one repository or installation from consuming the whole service. */
export interface ReviewLimits {
  /** Reviews started per repository in any 24 hours. Null: no cap. */
  maxReviewsPerRepoPerDay: number | null;
  /** LLM cost per installation in any 24 hours, in USD. Null: no cap. */
  maxCostUsdPerInstallationPerDay: number | null;
  /** Changed lines (added plus deleted) above which a pull request is not reviewed. */
  maxChangedLines: number | null;
  /** Changed files above which a pull request is not reviewed. */
  maxChangedFiles: number | null;
}

export const NO_LIMITS: ReviewLimits = {
  maxReviewsPerRepoPerDay: null,
  maxCostUsdPerInstallationPerDay: null,
  maxChangedLines: null,
  maxChangedFiles: null,
};

export const USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type LimitReason = 'rate_limited' | 'budget_exceeded' | 'too_large';

/** The limit recent usage has reached, if any. */
export function usageLimitReached(
  limits: ReviewLimits,
  usage: { repository: Usage; installation: Usage },
): LimitReason | null {
  if (
    limits.maxReviewsPerRepoPerDay !== null &&
    usage.repository.reviews >= limits.maxReviewsPerRepoPerDay
  ) {
    return 'rate_limited';
  }
  if (
    limits.maxCostUsdPerInstallationPerDay !== null &&
    usage.installation.costUsd >= limits.maxCostUsdPerInstallationPerDay
  ) {
    return 'budget_exceeded';
  }
  return null;
}

/** Whether a change is too big to review within the limits. */
export function tooLarge(limits: ReviewLimits, size: { files: number; lines: number }): boolean {
  return (
    (limits.maxChangedFiles !== null && size.files > limits.maxChangedFiles) ||
    (limits.maxChangedLines !== null && size.lines > limits.maxChangedLines)
  );
}
