import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseEnv, postgresUrl, secretString } from './env.js';

const schema = z.object({ DATABASE_URL: postgresUrl, TOKEN: secretString(16) });
const SECRET_LIKE = 'definitely-not-a-url-' + 'S'.repeat(12);

function message(source: Record<string, string | undefined>): string {
  try {
    parseEnv(schema, source);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected parseEnv to fail');
}

describe('parseEnv', () => {
  it('names every missing variable', () => {
    const text = message({});
    expect(text).toContain('DATABASE_URL: is required');
    expect(text).toContain('TOKEN: is required');
  });

  it('never echoes the values it rejects', () => {
    const shortToken = 'tooShortTok';
    const text = message({ DATABASE_URL: SECRET_LIKE, TOKEN: shortToken });
    expect(text).toContain('DATABASE_URL: must be a postgres');
    expect(text).toContain('TOKEN: must be at least 16 characters');
    expect(text).not.toContain(SECRET_LIKE);
    expect(text).not.toContain(shortToken);
  });

  it('rejects placeholder secrets and accepts real-looking ones', () => {
    expect(message({ DATABASE_URL: 'postgresql://u@h/db', TOKEN: 'changeme' })).toContain('TOKEN');
    expect(
      parseEnv(schema, { DATABASE_URL: 'postgresql://u@h/db', TOKEN: 'a'.repeat(32) }).TOKEN,
    ).toHaveLength(32);
  });
});
