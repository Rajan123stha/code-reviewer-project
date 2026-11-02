#!/usr/bin/env node
// Secret scanner with no dependencies. It never prints a matched value: only the rule, the
// location and the match length. CI also runs gitleaks; this script is for places gitleaks
// does not cover by default (built bundles, logs, caches) and for checking that the exact
// values in a local .env file appear nowhere else.
//
//   node scripts/secret-scan.mjs                    tracked files in the working tree
//   node scripts/secret-scan.mjs --history          every line ever added, in all of git history
//   node scripts/secret-scan.mjs --paths dir ...    any files or directories (bundles, logs)
//   node scripts/secret-scan.mjs --env .env ...     also look for the exact secret values in .env
//   node scripts/secret-scan.mjs --paths dist --deny-names
//                                                   also fail on server-only variable names (bundles)
//
// Exit code 1 when anything is found.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const RULES = [
  { id: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/g },
  { id: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g },
  { id: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { id: 'stripe-live-key', re: /\b[rs]k_live_[A-Za-z0-9]{20,}/g },
  {
    id: 'private-key',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  // user:password@ in a URL. Local development placeholders are allowed below.
  { id: 'url-credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"`]+:([^\s@/'"`]{6,})@/gi },
];

/** Passwords that are placeholders or local-only defaults, not secrets. */
const PLACEHOLDER_PASSWORDS = new Set([
  'password',
  'postgres',
  'secret',
  'changeme',
  'change_me',
  'example',
  'xxxxxx',
  'placeholder',
]);

/** Server-only configuration names that must never appear in code shipped to browsers. */
export const SERVER_ONLY_NAMES = [
  'DATABASE_URL',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_APP_PRIVATE_KEY',
  'DASHBOARD_PASSWORD',
  'REDIS_URL',
];

/** Environment variable names whose values are treated as secrets for --env. */
const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|PASS|PRIVATE|DATABASE_URL|CREDENTIAL/i;

/** Files never worth scanning: binaries and generated lockfiles. */
const SKIP =
  /\.(png|jpe?g|gif|ico|wasm|zip|gz|woff2?|ttf|pdf|ipynb)$|(^|\/)(pnpm-lock\.yaml|package-lock\.json)$/i;

export function scanText(text, envSecrets = [], denyNames = []) {
  const findings = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    // Same opt-out as gitleaks, for synthetic fixtures (for example scrubber tests).
    if (line.includes('gitleaks:allow')) return;
    for (const rule of RULES) {
      for (const m of line.matchAll(rule.re)) {
        if (rule.id === 'url-credentials' && PLACEHOLDER_PASSWORDS.has(m[1].toLowerCase()))
          continue;
        // Interpolations (${VAR}), <placeholders>, [redacted] markers and masks.
        if (rule.id === 'url-credentials' && /^\$\{|^<|^\[|^\*+$/.test(m[1])) continue;
        findings.push({ rule: rule.id, line: i + 1, length: m[0].length });
      }
    }
    for (const name of denyNames) {
      if (line.includes(name))
        findings.push({ rule: `server-only-name:${name}`, line: i + 1, length: name.length });
    }
    for (const { name, value } of envSecrets) {
      if (line.includes(value))
        findings.push({ rule: `env-value:${name}`, line: i + 1, length: value.length });
    }
  });
  return findings;
}

/** Secret-looking values from a .env file, kept in memory only. */
export function readEnvSecrets(path) {
  const out = [];
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const name = line.slice(0, eq).trim();
    let value = line
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
    // Paths and file names point at secrets; they are not secrets themselves.
    if (!SECRET_NAME.test(name) || /_(PATH|FILE|DIR)$/.test(name)) continue;
    // A key list is several secrets.
    for (const part of name === 'GEMINI_API_KEYS' ? value.split(/[\s,]+/) : [value]) {
      if (part.length >= 8) out.push({ name, value: part });
    }
  }
  return out;
}

function* walk(path) {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isFile()) yield path;
  else if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (entry === 'node_modules' || entry === '.git') continue;
      yield* walk(join(path, entry));
    }
  }
}

function scanFiles(files, envSecrets, root, denyNames = []) {
  const findings = [];
  for (const file of files) {
    const shown = relative(root, file).replaceAll('\\', '/');
    if (SKIP.test(shown)) continue;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const f of scanText(text, envSecrets, denyNames))
      findings.push({ ...f, where: `${shown}:${f.line}` });
  }
  return findings;
}

/** Every added line in all of history: anything ever committed, even if later deleted. */
function scanHistory(envSecrets) {
  const log = execFileSync(
    'git',
    ['log', '-p', '--all', '--no-color', '--no-ext-diff', '--format=commit %H'],
    {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 1024,
    },
  );
  const findings = [];
  let commit = '';
  let file = '';
  for (const line of log.split('\n')) {
    if (line.startsWith('commit ')) commit = line.slice(7, 17);
    else if (line.startsWith('+++ b/')) file = line.slice(6);
    else if (line.startsWith('+') && !line.startsWith('+++')) {
      if (SKIP.test(file)) continue;
      for (const f of scanText(line.slice(1), envSecrets))
        findings.push({ ...f, where: `${commit}:${file}` });
    }
  }
  return findings;
}

/**
 * Reviewed findings that are not secrets (for example a local-only default password in an
 * old commit). One "rule<TAB>location" per line, exactly as this script prints them.
 */
function readAllowlist(root) {
  try {
    return new Set(
      readFileSync(join(root, '.secret-scan-allow'), 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.startsWith('#')),
    );
  } catch {
    return new Set();
  }
}

function main(argv) {
  const root = process.cwd();
  const allow = readAllowlist(root);
  const envIndex = argv.indexOf('--env');
  const envSecrets = envIndex >= 0 ? readEnvSecrets(argv[envIndex + 1]) : [];
  let findings;
  let scope;
  if (argv.includes('--history')) {
    scope = 'git history (all added lines, all refs)';
    findings = scanHistory(envSecrets);
  } else if (argv.includes('--paths')) {
    // Paths are the arguments after --paths up to the next flag.
    const paths = [];
    for (let i = argv.indexOf('--paths') + 1; i < argv.length && !argv[i].startsWith('--'); i++) {
      paths.push(argv[i]);
    }
    scope = paths.join(', ');
    const deny = argv.includes('--deny-names') ? SERVER_ONLY_NAMES : [];
    findings = scanFiles(
      paths.flatMap((p) => [...walk(p)]),
      envSecrets,
      root,
      deny,
    );
  } else {
    scope = 'tracked files';
    const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
    findings = scanFiles(
      tracked.map((f) => join(root, f)),
      envSecrets,
      root,
    );
  }
  const before = findings.length;
  findings = findings.filter((f) => !allow.has(`${f.rule}\t${f.where}`));
  const allowed = before - findings.length;
  const extra = envSecrets.length
    ? `, plus ${envSecrets.length} exact value(s) from the env file`
    : '';
  const note = allowed ? ` (${allowed} reviewed and allowlisted in .secret-scan-allow)` : '';
  for (const f of findings) console.log(`${f.rule}\t${f.where}\t(match length ${f.length})`);
  console.log(`secret-scan: ${findings.length} finding(s) in ${scope}${extra}${note}`);
  return findings.length ? 1 : 0;
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('secret-scan.mjs')
) {
  process.exit(main(process.argv.slice(2)));
}
