/**
 * Removes credentials from text before it is logged, stored or shown: API keys and tokens of
 * well-known formats, private key blocks, and passwords in URLs (`scheme://user:pass@host`).
 * The same rules back `scripts/secret-scan.mjs`.
 *
 * This guards logs and error messages; it is not the scrubber for code sent to a model,
 * which is `scrubSecrets` in review-core and covers more cases.
 */
const PATTERNS: readonly RegExp[] = [
  /AIza[0-9A-Za-z_-]{35}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b[rs]k_live_[A-Za-z0-9]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
];

/** `scheme://user:password@` keeps scheme and user, drops the password. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/'"`]+:)[^\s@/'"`]+@/gi;

export const REDACTED = '[redacted]';

export function redactSecrets(text: string): string {
  let out = text.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/** Field names whose values are never logged, wherever they appear in a log object. */
export const SECRET_FIELDS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apiKey',
  'apiKeys',
  'api_key',
  'privateKey',
  'private_key',
  'authorization',
  'cookie',
  'connectionString',
  'databaseUrl',
  'DATABASE_URL',
  'GEMINI_API_KEYS',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_WEBHOOK_SECRET',
  'DASHBOARD_PASSWORD',
] as const;

/** Deep copy of a value with secret fields removed and secret-shaped strings redacted. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value instanceof Error || isSerializedError(value)) {
    // Error fields are not enumerable: copy them explicitly, then the rest.
    const err = value as Error & Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of ['type', 'name', 'message', 'stack', 'code']) {
      if (err[key] !== undefined) out[key] = redactValue(err[key], depth + 1);
    }
    for (const [key, v] of Object.entries(err))
      if (!(key in out)) out[key] = redactValue(v, depth + 1);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = (SECRET_FIELDS as readonly string[]).includes(key)
      ? REDACTED
      : redactValue(v, depth + 1);
  }
  return out;
}

function isSerializedError(value: object): boolean {
  const v = value as { message?: unknown; stack?: unknown };
  return typeof v.message === 'string' && typeof v.stack === 'string';
}
