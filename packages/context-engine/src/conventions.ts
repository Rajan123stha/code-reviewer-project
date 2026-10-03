/**
 * Repository conventions, extracted statically from documentation and tool configs.
 * Nothing is executed: JavaScript config files are scanned as text, never imported.
 */
export interface Convention {
  ruleText: string;
  /** File the rule came from. */
  source: string;
  kind: 'contributing' | 'readme' | 'typescript' | 'lint' | 'format';
  evidence: { line?: number; key?: string };
}

const DOC_FILES: { path: string; kind: 'contributing' | 'readme' }[] = [
  { path: 'CONTRIBUTING.md', kind: 'contributing' },
  { path: '.github/CONTRIBUTING.md', kind: 'contributing' },
  { path: 'docs/CONTRIBUTING.md', kind: 'contributing' },
  { path: 'contributing.md', kind: 'contributing' },
  { path: 'README.md', kind: 'readme' },
  { path: 'readme.md', kind: 'readme' },
];

const ESLINT_FILES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.yml',
  '.eslintrc.yaml',
];
const PRETTIER_FILES = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  'prettier.config.js',
  'prettier.config.mjs',
];

/** README sections worth mining; everything in CONTRIBUTING is in scope. */
const RELEVANT_HEADING =
  /contribut|style|convention|guideline|standard|coding|code quality|pull request|commit|testing|development/i;
/** A sentence that tells contributors what to do. */
const NORMATIVE =
  /\b(must|should|always|never|do not|don't|please|avoid|prefer|required?|ensure|make sure|use|run|add|write|keep)\b/i;
const MAX_RULE_CHARS = 240;
const MAX_RULES_PER_DOC = 30;

/** Compiler options that change what counts as correct code. */
const TS_FLAGS = [
  'strict',
  'noImplicitAny',
  'strictNullChecks',
  'noUncheckedIndexedAccess',
  'exactOptionalPropertyTypes',
  'noImplicitReturns',
  'noFallthroughCasesInSwitch',
  'noImplicitOverride',
  'useUnknownInCatchVariables',
];

/**
 * Collect conventions from a snapshot. Order is fixed (contributing docs, TypeScript,
 * lint, formatting, README) and so is the order within each source, so the result is
 * deterministic.
 */
export async function extractConventions(
  readFile: (path: string) => Promise<string | null>,
): Promise<Convention[]> {
  const out: Convention[] = [];
  const seen = new Set<string>();
  const add = (c: Convention) => {
    const key = c.ruleText.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };

  const docs: { path: string; kind: 'contributing' | 'readme'; text: string }[] = [];
  const seenDocs = new Set<string>();
  for (const doc of DOC_FILES) {
    const text = await readFile(doc.path);
    // Case-insensitive file systems return the same file for README.md and readme.md.
    if (text === null || seenDocs.has(text)) continue;
    seenDocs.add(text);
    docs.push({ ...doc, text });
  }

  for (const doc of docs.filter((d) => d.kind === 'contributing')) {
    for (const c of rulesFromMarkdown(doc.text, doc.path, 'contributing')) add(c);
  }

  const tsconfig = await readFile('tsconfig.json');
  if (tsconfig !== null) {
    const flags = TS_FLAGS.filter((f) => new RegExp(`"${f}"\\s*:\\s*true`).test(tsconfig));
    if (flags.length) {
      add({
        ruleText: `TypeScript compiler checks enabled: ${flags.join(', ')}. Code must type-check under them.`,
        source: 'tsconfig.json',
        kind: 'typescript',
        evidence: { key: flags.join(',') },
      });
    }
  }

  const pkg = await readFile('package.json');
  for (const path of ESLINT_FILES) {
    const text = await readFile(path);
    if (text === null) continue;
    const rules = errorRules(text);
    if (rules.length) {
      add({
        ruleText: `ESLint reports these rules as errors: ${rules.join(', ')}.`,
        source: path,
        kind: 'lint',
        evidence: { key: 'rules' },
      });
    }
    break;
  }
  if (pkg !== null && /"xo"\s*:/.test(pkg)) {
    add({
      ruleText: 'The project is linted with XO (strict ESLint preset).',
      source: 'package.json',
      kind: 'lint',
      evidence: { key: 'xo' },
    });
  }

  let formatter: string | null = null;
  for (const path of PRETTIER_FILES) {
    if ((await readFile(path)) !== null) {
      formatter = path;
      break;
    }
  }
  if (!formatter && pkg !== null && /"prettier"\s*:/.test(pkg)) formatter = 'package.json';
  if (formatter) {
    add({
      ruleText: 'Formatting is enforced by Prettier. Do not comment on formatting.',
      source: formatter,
      kind: 'format',
      evidence: { key: 'prettier' },
    });
  }

  for (const doc of docs.filter((d) => d.kind === 'readme')) {
    for (const c of rulesFromMarkdown(doc.text, doc.path, 'readme')) add(c);
  }
  return out;
}

/** Normative bullets and sentences; for READMEs only under contribution-related headings. */
function rulesFromMarkdown(
  text: string,
  source: string,
  kind: 'contributing' | 'readme',
): Convention[] {
  const rules: Convention[] = [];
  let relevant = kind === 'contributing';
  let inFence = false;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const [i, raw] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(raw);
    if (heading) {
      if (kind === 'readme') relevant = RELEVANT_HEADING.test(heading[1]!);
      continue;
    }
    if (!relevant) continue;
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(raw);
    const candidate = (bullet ? bullet[1]! : raw).trim();
    if (candidate.length < 15 || !NORMATIVE.test(candidate)) continue;
    // Plain paragraphs qualify only when they read as a rule, not as narrative.
    if (!bullet && !/\b(must|should|always|never|do not|don't)\b/i.test(candidate)) continue;
    const ruleText = cleanMarkdown(candidate);
    rules.push({
      ruleText:
        ruleText.length > MAX_RULE_CHARS ? `${ruleText.slice(0, MAX_RULE_CHARS)}…` : ruleText,
      source,
      kind,
      evidence: { line: i + 1 },
    });
    if (rules.length >= MAX_RULES_PER_DOC) break;
  }
  return rules;
}

function cleanMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Rule names configured as errors, from JSON, YAML or JavaScript config text. */
function errorRules(config: string): string[] {
  const found = new Set<string>();
  // "rule": "error" | 2 | ["error", ...] | [2, ...], with or without quotes around the key.
  const pattern = /["']?([@a-z][\w@/-]*)["']?\s*:\s*(?:\[\s*)?(?:["']error["']|2\b)/gi;
  for (const match of config.matchAll(pattern)) {
    const name = match[1]!;
    if (name.includes('-') || name.includes('/')) found.add(name);
  }
  return [...found].sort().slice(0, 40);
}
