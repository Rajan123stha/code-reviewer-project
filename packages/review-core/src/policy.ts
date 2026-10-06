import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { CATEGORIES, SEVERITIES, SEVERITY_RANK, type Category, type Severity } from './schema.js';

/** Per-repository settings file, read from the repository root. */
export const POLICY_FILE = '.reviewlens.yml';

/** Files larger than this are not parsed; a settings file has no reason to be big. */
const MAX_POLICY_BYTES = 20_000;

/**
 * What a repository's maintainers ask of the reviewer. It narrows what is reviewed and
 * posted; it cannot change the strategy, the model or the prompts, so it never changes
 * what an ablation measures.
 */
export interface RepoPolicy {
  /** False turns reviews off for the repository. */
  enabled: boolean;
  /** Cap on comments per review, on top of the strategy's own cap. Null: no extra cap. */
  maxComments: number | null;
  /** Comments less severe than this are not posted. */
  minSeverity: Severity;
  /** Only these categories are posted. Null: all. */
  categories: Category[] | null;
  /** Glob patterns of paths to leave out of the review entirely. */
  ignore: string[];
}

export const DEFAULT_POLICY: RepoPolicy = {
  enabled: true,
  maxComments: null,
  minSeverity: 'low',
  categories: null,
  ignore: [],
};

const policyFileSchema = z.strictObject({
  enabled: z.boolean().optional(),
  max_comments: z.number().int().min(1).max(50).optional(),
  min_severity: z.enum(SEVERITIES).optional(),
  categories: z.array(z.enum(CATEGORIES)).min(1).optional(),
  ignore: z.array(z.string().min(1).max(200)).max(100).optional(),
});

export interface ParsedPolicy {
  policy: RepoPolicy;
  /** Why the file was not applied. A file with any error is ignored as a whole. */
  errors: string[];
}

/**
 * Parse `.reviewlens.yml`. A missing file means defaults. A file with any mistake is ignored
 * entirely and the mistakes are returned, so a typo cannot half-apply a policy.
 */
export function parsePolicy(text: string | null): ParsedPolicy {
  if (text === null || text.trim() === '') return { policy: DEFAULT_POLICY, errors: [] };
  if (text.length > MAX_POLICY_BYTES) {
    return { policy: DEFAULT_POLICY, errors: [`${POLICY_FILE} is larger than 20 kB`] };
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return { policy: DEFAULT_POLICY, errors: [`${POLICY_FILE} is not valid YAML: ${message}`] };
  }
  const parsed = policyFileSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      policy: DEFAULT_POLICY,
      errors: parsed.error.issues.map(
        (issue) => `${POLICY_FILE}: ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    };
  }
  const file = parsed.data;
  return {
    policy: {
      enabled: file.enabled ?? DEFAULT_POLICY.enabled,
      maxComments: file.max_comments ?? null,
      minSeverity: file.min_severity ?? DEFAULT_POLICY.minSeverity,
      categories: file.categories ?? null,
      ignore: file.ignore ?? [],
    },
    errors: [],
  };
}

/**
 * Translate a glob to a regular expression: `**` crosses directories, `*` and `?` do not.
 * A pattern without a slash matches at any depth (like .gitignore), and a trailing slash
 * matches everything under that directory.
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = glob.trim().replace(/^\.?\//, '');
  if (pattern.endsWith('/')) pattern += '**';
  const anyDepth = !pattern.includes('/');
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*' && pattern[i + 1] === '*') {
      // `**/` also matches zero directories.
      if (pattern[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${anyDepth ? '(?:.*/)?' : ''}${source}$`);
}

/** Decides what a policy leaves out. Build once per review. */
export class PolicyMatcher {
  private readonly ignore: RegExp[];

  constructor(readonly policy: RepoPolicy) {
    this.ignore = policy.ignore.map(globToRegExp);
  }

  ignoresPath(path: string): boolean {
    return this.ignore.some((re) => re.test(path));
  }

  /** Whether a comment of this kind may be posted. */
  allows(comment: { category: Category; severity: Severity }): boolean {
    if (SEVERITY_RANK[comment.severity] > SEVERITY_RANK[this.policy.minSeverity]) return false;
    return this.policy.categories === null || this.policy.categories.includes(comment.category);
  }
}
