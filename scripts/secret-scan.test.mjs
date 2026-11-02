import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readEnvSecrets, scanText, SERVER_ONLY_NAMES } from './secret-scan.mjs';

// Synthetic values assembled at runtime, so this file holds no secret-shaped literal.
const KEY = 'AIza' + 'R'.repeat(35);
const PEM = '-----BEGIN ' + 'PRIVATE KEY-----';

describe('secret-scan', () => {
  it('finds known secret formats and reports where, never what', () => {
    const findings = scanText(`a
const k = "${KEY}";
${PEM}
url = "postgres://u:${'Z'.repeat(12)}@h/db"`);
    expect(findings.map((f) => [f.rule, f.line])).toEqual([
      ['google-api-key', 2],
      ['private-key', 3],
      ['url-credentials', 4],
    ]);
    expect(JSON.stringify(findings)).not.toContain(KEY);
  });

  it('allows placeholders and lines marked gitleaks:allow', () => {
    expect(scanText('postgresql://app:changeme@localhost/db')).toEqual([]);
    expect(scanText('postgresql://app:${POSTGRES_PASSWORD}@postgres/db')).toEqual([]);
    expect(scanText(`"${KEY}" // gitleaks:allow`)).toEqual([]);
  });

  it('finds exact .env secret values and server-only names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scan-'));
    const env = join(dir, '.env');
    writeFileSync(
      env,
      `GEMINI_API_KEYS=one-${'1'.repeat(10)}, two-${'2'.repeat(10)}
LOG_LEVEL=info
GITHUB_APP_PRIVATE_KEY_PATH=./k.pem
`,
    );
    const secrets = readEnvSecrets(env);
    expect(secrets.map((s) => s.name)).toEqual(['GEMINI_API_KEYS', 'GEMINI_API_KEYS']);
    expect(scanText(`x two-${'2'.repeat(10)} y`, secrets).map((f) => f.rule)).toEqual([
      'env-value:GEMINI_API_KEYS',
    ]);
    expect(
      scanText('fetch(process.env.DATABASE_URL)', [], SERVER_ONLY_NAMES).map((f) => f.rule),
    ).toEqual(['server-only-name:DATABASE_URL']);
  });
});

describe('secret-scan command', () => {
  const script = fileURLToPath(new URL('./secret-scan.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

  it('scans only the given paths, not the env file it reads values from', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
    const env = join(dir, '.env');
    writeFileSync(
      env,
      `DATABASE_URL=postgresql://u:${'Q'.repeat(16)}@h/db
`,
    );
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'app.js'), 'console.log("hello")');
    const clean = run('--paths', join(dir, 'dist'), '--deny-names', '--env', env);
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain('0 finding(s)');
  });

  it('fails when a bundle mentions a server-only setting or holds a secret value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
    const env = join(dir, '.env');
    const value = 'K'.repeat(20);
    writeFileSync(
      env,
      `GEMINI_API_KEYS=${value}
`,
    );
    mkdirSync(join(dir, 'dist'));
    writeFileSync(
      join(dir, 'dist', 'app.js'),
      `const a = process.env.DATABASE_URL; const b = "${value}";`,
    );
    const result = run('--paths', join(dir, 'dist'), '--deny-names', '--env', env);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('server-only-name:DATABASE_URL');
    expect(result.stdout).toContain('env-value:GEMINI_API_KEYS');
    expect(result.stdout).not.toContain(value);
  });
});
