import { parseEnv } from '@reviewlens/shared';
import { describe, expect, it } from 'vitest';
import { dashboardEnvSchema } from './env.js';

const DB = 'postgresql://user@localhost:5432/db';
const failure = (source: Record<string, string | undefined>) => {
  try {
    parseEnv(dashboardEnvSchema, source);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
};

describe('dashboard configuration', () => {
  it('runs on loopback without a password', () => {
    expect(parseEnv(dashboardEnvSchema, { DATABASE_URL: DB }).DASHBOARD_HOST).toBe('127.0.0.1');
  });

  it('refuses to listen beyond loopback without a strong password', () => {
    expect(failure({ DATABASE_URL: DB, DASHBOARD_HOST: '0.0.0.0' })).toContain(
      'DASHBOARD_PASSWORD: is required when DASHBOARD_HOST is not a loopback address',
    );
    const weak = 'short1';
    const text = failure({ DATABASE_URL: DB, DASHBOARD_HOST: '0.0.0.0', DASHBOARD_PASSWORD: weak });
    expect(text).toContain('DASHBOARD_PASSWORD: must be at least 12 characters');
    expect(text).not.toContain(weak);
    expect(
      parseEnv(dashboardEnvSchema, {
        DATABASE_URL: DB,
        DASHBOARD_HOST: '0.0.0.0',
        DASHBOARD_PASSWORD: 'x'.repeat(20),
      }).DASHBOARD_HOST,
    ).toBe('0.0.0.0');
  });
});
