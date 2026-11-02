import { parseEnv } from '@reviewlens/shared';
import { describe, expect, it } from 'vitest';
import { workerEnvSchema } from './env.js';

const VALID = {
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY_PATH: './key.pem',
  DATABASE_URL: 'postgresql://user@localhost:5432/db',
  GEMINI_API_KEYS: 'k'.repeat(39),
};

const failure = (source: Record<string, string | undefined>) => {
  try {
    parseEnv(workerEnvSchema, source);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
};

describe('worker configuration', () => {
  it('starts with a complete configuration', () => {
    expect(parseEnv(workerEnvSchema, VALID).GITHUB_APP_ID).toBe('12345');
  });

  it('fails at startup, by name, when a secret is missing', () => {
    expect(failure({ ...VALID, GITHUB_APP_PRIVATE_KEY_PATH: undefined })).toContain(
      'GITHUB_APP_PRIVATE_KEY_PATH: set GITHUB_APP_PRIVATE_KEY_PATH',
    );
    expect(failure({ ...VALID, GEMINI_API_KEYS: ' ' })).toContain(
      'GEMINI_API_KEYS: is required when LLM_PROVIDER is gemini',
    );
    expect(failure({ ...VALID, LLM_PROVIDER: 'anthropic' })).toContain('ANTHROPIC_API_KEY');
    expect(failure({ ...VALID, DATABASE_URL: undefined })).toContain('DATABASE_URL: is required');
    expect(failure({ ...VALID, REVIEW_FILTER_THRESHOLD: '0.3' })).toContain('FILTER_URL');
  });

  it('does not echo a malformed secret', () => {
    const wrong = 'mysql://root:' + 'P'.repeat(16) + '@db/app';
    const text = failure({ ...VALID, DATABASE_URL: wrong });
    expect(text).toContain('DATABASE_URL: must be a postgres');
    expect(text).not.toContain('P'.repeat(16));
  });
});
