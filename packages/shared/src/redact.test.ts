import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { redactSecrets, redactValue } from './redact.js';

// Synthetic values, built at runtime so no secret-shaped literal sits in the source.
const GOOGLE = 'AIza' + 'Q'.repeat(35);
const GITHUB = 'ghp_' + 'z'.repeat(36);
const ANTHROPIC = 'sk-ant-' + 'k'.repeat(30);
const DB_PASSWORD = 'pw' + 'X'.repeat(20);
const DB_URL = `postgresql://app:${DB_PASSWORD}@db.example.com:5432/app`;
const PEM = ['-----BEGIN', 'RSA PRIVATE KEY-----\nMIIE', 'abc\n-----END RSA PRIVATE KEY-----'].join(
  ' ',
);

function capture(): { lines: () => string; stream: Writable } {
  let out = '';
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      out += chunk.toString();
      done();
    },
  });
  return { lines: () => out, stream };
}

describe('redactSecrets', () => {
  it('removes keys, tokens, private keys and URL passwords, and keeps the rest', () => {
    const text = `key=${GOOGLE} gh=${GITHUB} claude=${ANTHROPIC} db=${DB_URL}\n${PEM}`;
    const out = redactSecrets(text);
    for (const secret of [GOOGLE, GITHUB, ANTHROPIC, DB_PASSWORD, 'MIIE']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('postgresql://app:[redacted]@db.example.com:5432/app');
    expect(redactSecrets('nothing secret here: redis://localhost:6379')).toBe(
      'nothing secret here: redis://localhost:6379',
    );
  });

  it('censors secret fields at any depth and redacts strings inside objects', () => {
    expect(
      redactValue({
        config: { apiKey: 'plain-but-secret', model: 'm' },
        env: { DATABASE_URL: 'anything' },
        note: `uses ${GOOGLE}`,
        list: [{ token: 't' }],
      }),
    ).toEqual({
      config: { apiKey: '[redacted]', model: 'm' },
      env: { DATABASE_URL: '[redacted]' },
      note: 'uses [redacted]',
      list: [{ token: '[redacted]' }],
    });
  });
});

describe('logger', () => {
  it('never writes secrets, whether in fields, messages or errors', () => {
    const out = capture();
    const logger = createLogger('test', { level: 'info' }, out.stream);
    logger.info({ databaseUrl: DB_URL, nested: { apiKey: GOOGLE } }, `connecting with ${GITHUB}`);
    logger.error({ err: new Error(`connect failed for ${DB_URL} using ${ANTHROPIC}`) }, 'failed');
    logger.warn({
      req: { headers: { authorization: 'Bearer abc.def', 'x-goog-api-key': GOOGLE } },
    });
    const text = out.lines();
    for (const secret of [DB_PASSWORD, GOOGLE, GITHUB, ANTHROPIC, 'abc.def']) {
      expect(text).not.toContain(secret);
    }
    // Useful context survives.
    expect(text).toContain('connect failed for postgresql://app:[redacted]@db.example.com');
    expect(text).toContain('"service":"test"');
  });
});
