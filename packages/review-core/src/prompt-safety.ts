/**
 * Handling of untrusted text on its way into a prompt and of model text on its way to GitHub.
 *
 * Into the prompt: the pipeline wraps repository and pull-request text in tags (`<diff>`,
 * `<file>`, `<pull_request>`, ...) and tells the model that tag contents are data. Text that
 * contains one of those tags could close the block early and pose as instructions, so every
 * tag the prompts use is neutralized inside untrusted text (`</diff>` becomes `&lt;/diff>`).
 *
 * Out to GitHub: model output is rendered as Markdown in a public review. Mentions would ping
 * people, images would load from any server (and could carry data in their URL), raw HTML and
 * links could disguise a destination. Outside code spans these are made inert; the words stay.
 */

/** Every tag name a prompt template or prompt builder in this package uses, plus role names. */
const PROMPT_TAGS = [
  'pull_request',
  'title',
  'description',
  'diff',
  'file',
  'symbol',
  'conventions',
  'past_bugs',
  'comments',
  'comment',
  'fix',
  'system',
  'user',
  'assistant',
  'instructions',
];
const TAG = new RegExp(`<(/?)(${PROMPT_TAGS.join('|')})(?=[\\s>/])`, 'gi');

export function neutralizePromptTags(text: string): string {
  return text.replace(TAG, '&lt;$1$2');
}

/** Cut text to a length, saying so, so attacker-sized input cannot size the prompt. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated]`;
}

const ZWSP = '​';

/**
 * Markdown prose from the model, made inert: no mentions, images, links or raw HTML outside
 * inline code. Inline code spans are left as they are; GitHub renders them literally.
 */
export function inertMarkdown(text: string): string {
  return text
    .split(/(`+[^`]*?`+)/g)
    .map((part, i) => (i % 2 === 1 && /^(`+)[^`]*\1$/.test(part) ? part : inertProse(part)))
    .join('');
}

function inertProse(text: string): string {
  return (
    text
      // Raw HTML and <autolinks>.
      .replace(/</g, '&lt;')
      // @user and @org/team mentions.
      .replace(/@(?=[A-Za-z0-9])/g, `@${ZWSP}`)
      // ![image](url) and [text](url) / [text][ref]: break the syntax, keep the text and URL.
      .replace(/!\[/g, `!${ZWSP}[`)
      .replace(/\]\(/g, `]${ZWSP}(`)
      .replace(/\]\[/g, `]${ZWSP}[`)
  );
}

/** A code fence longer than any backtick run inside the code, so the code cannot close it. */
export function codeFence(code: string): string {
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}\n${code}\n${ticks}`;
}
