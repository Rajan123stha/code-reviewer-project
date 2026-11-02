// Feedback outcomes and the label they imply. No database imports, so the dashboard
// client can use these types too.

/** What happened to a posted comment (spec: `comment_feedback.outcome`). */
export const FEEDBACK_OUTCOMES = [
  'resolved_with_change',
  'dismissed',
  'thumbs_up',
  'thumbs_down',
  'ignored',
] as const;
export type FeedbackOutcome = (typeof FEEDBACK_OUTCOMES)[number];

/**
 * One usefulness label per comment from its observations, or null while nothing is known.
 * An explicit reaction outranks what we infer from pushes and threads; a thumbs-down
 * outranks a thumbs-up, so a contested comment is not counted as useful.
 */
export function feedbackLabel(outcomes: readonly FeedbackOutcome[]): 0 | 1 | null {
  if (outcomes.includes('thumbs_down')) return 0;
  if (outcomes.includes('thumbs_up')) return 1;
  if (outcomes.includes('resolved_with_change')) return 1;
  if (outcomes.includes('dismissed') || outcomes.includes('ignored')) return 0;
  return null;
}
