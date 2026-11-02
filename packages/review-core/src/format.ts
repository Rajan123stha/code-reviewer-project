import { codeFence, inertMarkdown } from './prompt-safety.js';
import type { ModelComment } from './schema.js';

const CATEGORY_LABEL: Record<ModelComment['category'], string> = {
  bug: 'Bug',
  security: 'Security',
  performance: 'Performance',
  'error-handling': 'Error handling',
  concurrency: 'Concurrency',
  'api-misuse': 'API misuse',
  maintainability: 'Maintainability',
  testing: 'Testing',
};

/**
 * Asks for the one signal GitHub cannot infer: whether the comment helped. Reactions are
 * read when the pull request closes and become the comment's feedback label.
 */
export const FEEDBACK_HINT = '<sub>Was this useful? React with 👍 or 👎 to tell Reviewlens.</sub>';

/**
 * Markdown body of one inline review comment. Model text is untrusted: prose is made inert
 * (no mentions, images, links or HTML) and quoted code goes in a fence it cannot close.
 */
export function formatCommentBody(comment: ModelComment): string {
  const parts = [
    `**${CATEGORY_LABEL[comment.category]} (${comment.severity})**: ${inertMarkdown(comment.claim.trim())}`,
  ];
  const evidence = comment.evidence.trim();
  if (evidence) {
    parts.push(
      evidence.includes('\n') ? codeFence(evidence) : `> \`${evidence.replace(/`/g, "'")}\``,
    );
  }
  if (comment.suggested_fix?.trim())
    parts.push(`**Suggested fix:** ${inertMarkdown(comment.suggested_fix.trim())}`);
  parts.push(FEEDBACK_HINT);
  return parts.join('\n\n');
}

export function formatReviewBody(
  posted: number,
  meta: { strategy: string; model: string },
): string {
  const summary =
    posted === 0
      ? 'Reviewlens found no issues to flag in this change.'
      : `Reviewlens left ${posted} comment${posted === 1 ? '' : 's'}.`;
  return `${summary}\n\n<sub>strategy ${meta.strategy} · model ${meta.model}</sub>`;
}
