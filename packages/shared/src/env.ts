import { z } from 'zod';

/**
 * Parse process.env (or a provided record) against a schema.
 * Fails fast with a readable message listing every invalid variable.
 */
/**
 * Messages name the variable and the rule it broke, never its value: configuration errors
 * are printed at startup and often end up in logs.
 */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

export const redisEnv = {
  REDIS_URL: z.url().default('redis://localhost:6379'),
};

export const logEnv = {
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
};

/** A Postgres connection string. Checked by shape only; its contents are never echoed. */
export const postgresUrl = z
  .string({ error: 'is required' })
  .regex(/^postgres(ql)?:\/\/\S+$/, 'must be a postgres:// or postgresql:// connection string');

/** A shared secret such as a webhook secret or password. */
export const secretString = (minLength: number) =>
  z
    .string({ error: 'is required' })
    .min(
      minLength,
      `must be at least ${minLength} characters; use a random value (openssl rand -hex 32)`,
    )
    .refine(
      (v) => !/^(changeme|change_me|secret|password|example)$/i.test(v),
      'is a placeholder value',
    );
